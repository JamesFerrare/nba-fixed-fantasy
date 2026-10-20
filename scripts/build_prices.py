"""Build the player pool and prices from aggregated preseason fantasy rankings.

Run once before the season (prices are frozen after that):

    python scripts/build_prices.py

Sources (each gives a rank; we average them into a consensus rank):
  - ESPN points-league rank      (ESPN fantasy API, "STANDARD")
  - ESPN categories rank         (ESPN fantasy API, "ROTO")
  - ESPN average draft position  (live ESPN drafts)
  - Yahoo average draft position (via FantasyPros ADP page)
  - FantasyPros expert consensus (ECR)
  - CBS Sports top 200
  - Hashtag Basketball           (last season 9-cat value)
  - Basketball Monster           (last season 9-cat value)

The consensus rank is then mapped to a dollar price with a smooth curve
(see `price_for_rank`). Writes data/players.json and data/rankings.csv.
"""

import csv
import json
import math
import re
import unicodedata
from io import StringIO
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SEASON = 2027  # ESPN labels the 2026-27 season as 2027
POOL_SIZE = 400

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
session = requests.Session()
session.headers["User-Agent"] = UA

ESPN_TEAM_FIX = {"NY": "NYK", "SA": "SAS", "UTAH": "UTA", "WSH": "WAS", "NO": "NOP", "GS": "GSW"}
ESPN_POS = {1: "PG", 2: "SG", 3: "SF", 4: "PF", 5: "C"}


def norm(name):
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = name.lower().replace(".", "").replace("'", "").replace("-", " ")
    name = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", name)
    return re.sub(r"\s+", " ", name).strip()


# Nicknames / spellings that differ between sites -> ESPN spelling
ALIASES = {
    "nicolas claxton": "nic claxton",
    "cameron thomas": "cam thomas",
    "herb jones": "herbert jones",
    "kenyon martin": "kj martin",
    "alexandre sarr": "alex sarr",
    "carlton carrington": "bub carrington",
    "ronald holland": "ron holland",
    "moe wagner": "moritz wagner",
    "gg jackson": "gregory jackson",
}


def key(name):
    k = norm(name)
    return ALIASES.get(k, k)


# ---------------------------------------------------------------- ESPN

def fetch_espn():
    teams = session.get(
        f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/{SEASON}?view=proTeamSchedules_wl",
        timeout=30,
    ).json()["settings"]["proTeams"]
    team_abbr = {t["id"]: ESPN_TEAM_FIX.get(t["abbrev"], t["abbrev"]) for t in teams}

    filt = {"players": {"limit": 700, "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": "STANDARD"}}}
    url = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/{SEASON}/segments/0/leaguedefaults/1?view=kona_player_info"
    players = session.get(url, headers={"X-Fantasy-Filter": json.dumps(filt)}, timeout=60).json()["players"]

    out = []
    for entry in players:
        p = entry["player"]
        ranks = p.get("draftRanksByRankType", {})
        own = p.get("ownership", {}) or {}
        proj, last = {}, {}
        for st in p.get("stats", []):
            if st["statSplitTypeId"] != 0:
                continue
            if st["seasonId"] == SEASON and st["statSourceId"] == 1:
                proj = st.get("averageStats") or st.get("stats") or {}
            if st["seasonId"] == SEASON - 1 and st["statSourceId"] == 0:
                last = st.get("averageStats") or st.get("stats") or {}
        adp = own.get("averageDraftPosition")
        out.append({
            "id": p["id"],
            "name": p["fullName"],
            "team": team_abbr.get(p["proTeamId"], "FA"),
            "pos": ESPN_POS.get(p["defaultPositionId"], "?"),
            "injury": p.get("injuryStatus", "ACTIVE"),
            "espn_points": ranks.get("STANDARD", {}).get("rank") or None,
            "espn_cats": ranks.get("ROTO", {}).get("rank") or None,
            "espn_adp": adp if adp and adp < 170 else None,  # ADP past ~170 is noise
            "proj": proj,
            "last": last,
        })
    return out


# ---------------------------------------------------------------- other sites

def get(url):
    r = session.get(url, timeout=40)
    r.raise_for_status()
    return r.text


def fetch_fantasypros_ecr():
    html = get("https://www.fantasypros.com/nba/rankings/overall.php")
    data = json.loads(re.search(r"var ecrData = (\{.*?\});", html).group(1))
    return {key(p["player_name"]): int(p["rank_ecr"]) for p in data["players"]}


def fetch_yahoo_adp():
    html = get("https://www.fantasypros.com/nba/adp/overall.php")
    table = max(pd.read_html(StringIO(html)), key=len)
    out = {}
    for _, row in table.iterrows():
        name = re.sub(r"\s*\(.*\)\s*$", "", str(row["Player"]))
        if pd.notna(row.get("Yahoo")):
            out[key(name)] = float(row["Yahoo"])
    # turn ADP into a rank order
    return {k: i + 1 for i, (k, _) in enumerate(sorted(out.items(), key=lambda kv: kv[1]))}


def fetch_cbs():
    html = get("https://www.cbssports.com/fantasy/basketball/rankings/h2h/top200/")
    table = max(pd.read_html(StringIO(html)), key=len)
    out = {}
    for _, row in table.iterrows():
        # CBS renders "Luka L. DoncicPG" -> drop the abbreviated token and position
        name = re.sub(r"\s[A-Z][A-Za-z]*\.(?=\s)", "", str(row["PLAYER"]))
        name = re.sub(r"(?<=[a-z.])(PG|SG|SF|PF|C|G|F)$", "", name)
        out[key(name)] = int(row["RK"])
    return out


def split_hashtag_name(text):
    # "Nikola JokicN.Jokic" -> "Nikola Jokic"
    for m in re.finditer(r"[A-Z][a-z]?\.", text):
        i = m.start()
        rest = text[m.end():]
        if i > 0 and rest and text[:i].replace(" ", "").endswith(rest.replace(" ", "")):
            return text[:i]
    return text


def fetch_hashtag():
    html = get("https://hashtagbasketball.com/fantasy-basketball-rankings")
    table = max(pd.read_html(StringIO(html)), key=len)
    out = {}
    for _, row in table.iterrows():
        m = re.match(r"\s*(\d+)", str(row["R#"]))  # "18  38" = rank + movement
        if not m:
            continue  # repeated header rows
        rank = int(m.group(1))
        out[key(split_hashtag_name(str(row["PLAYER"])))] = rank
    return out


def fetch_bbm():
    html = get("https://basketballmonster.com/playerrankings.aspx")
    table = max(pd.read_html(StringIO(html)), key=len)
    out = {}
    for _, row in table.iterrows():
        try:
            rank = int(row["Rank"])
        except (ValueError, TypeError):
            continue
        out[key(str(row["Name"]))] = rank
    return out


# ---------------------------------------------------------------- scoring / pricing

def fantasy_points(avg, last=None):
    """Per-game fantasy points from ESPN stat ids, using the league's scoring.

    Must stay in sync with SCORING in assets/config.js.
    0 PTS, 1 BLK, 2 STL, 3 AST, 4 OREB, 5 DREB, 6 REB, 7 EJ, 8 FF, 10 TF, 11 TO,
    12 DQ, 17 3PM, 37 DD, 38 TD

    ESPN projections only give total rebounds and skip the bonus/foul stats, so
    `last` (last season's per-game line) fills in the offensive-board share and
    the double-double / technical / ejection rates.
    """
    last = last or {}
    g = lambda k: float(avg.get(str(k), 0) or 0)
    h = lambda k: float(avg.get(str(k), last.get(str(k), 0)) or 0)
    reb = g(6)
    if str(4) in avg:
        oreb = g(4)
    else:
        lr, lo = float(last.get("6", 0) or 0), float(last.get("4", 0) or 0)
        oreb = reb * (lo / lr if lr > 0 else 0.22)
    dd, td = h(37), h(38)
    return (
        g(0) * 1 + oreb * 2 + (reb - oreb) * 1 + g(3) * 1.5 + g(2) * 3 + g(1) * 3 + g(11) * -2 + g(17) * 0.5
        + (dd - td) * 5 + td * 10 + h(10) * 5 + h(8) * 5 + h(7) * 20 + h(12) * 5
    )


TOP_PRICE = 150    # price of the #1 player
FLOOR_PRICE = 2    # cheapest a player can be
FLOOR_RANK = 300   # consensus rank where prices bottom out


def price_curve(season_fp):
    """Consensus rank -> price, linear in the expected production at that rank.

    `season_fp` is each pool player's expected season fantasy points, in
    consensus-rank order. We fit a smooth decreasing curve of production vs
    rank, fp(r) = a + b*ln(r) + c*r, and make price linear in that curve.
    Linear pricing means a full $1000 roster has about the same expected
    total whether you buy stars or depth -- the game is finding players who
    beat their price, not exploiting the curve.
    """
    import numpy as np

    ranks = np.arange(1, len(season_fp) + 1, dtype=float)
    y = np.array(season_fp, dtype=float)
    ok = y > 0
    basis = lambda r: np.column_stack([np.ones_like(r), np.log(r), r])
    coef, *_ = np.linalg.lstsq(basis(ranks[ok]), y[ok], rcond=None)
    fit = np.minimum.accumulate(basis(ranks) @ coef)
    slope = (TOP_PRICE - FLOOR_PRICE) / (fit[0] - fit[FLOOR_RANK - 1])
    return [max(FLOOR_PRICE, int(round(FLOOR_PRICE + slope * (f - fit[FLOOR_RANK - 1])))) for f in fit], fit


def main():
    espn = fetch_espn()
    print(f"ESPN: {len(espn)} players")
    sources = {
        "fantasypros": fetch_fantasypros_ecr(),
        "yahoo_adp": fetch_yahoo_adp(),
        "cbs": fetch_cbs(),
        "hashtag": fetch_hashtag(),
        "bbm": fetch_bbm(),
    }
    for name, ranks in sources.items():
        print(f"{name}: {len(ranks)} ranked")

    espn_lists = {
        "espn_points": max(p["espn_points"] or 0 for p in espn),
        "espn_cats": max(p["espn_cats"] or 0 for p in espn),
        "espn_adp": 170,
    }
    source_len = {**espn_lists, **{k: max(v.values()) for k, v in sources.items()}}

    matched = {k: 0 for k in sources}
    rows = []
    for p in espn:
        k = key(p["name"])
        ranks = {"espn_points": p["espn_points"], "espn_cats": p["espn_cats"], "espn_adp": p["espn_adp"]}
        for src, table in sources.items():
            ranks[src] = table.get(k)
            if ranks[src] is not None:
                matched[src] += 1
        present = [v for v in ranks.values() if v is not None]
        if not present:
            continue
        prelim = sum(present) / len(present)
        # A source that ranks deeper than this player's level but left him out
        # gets a penalty rank of (list length + 1); shallower lists are skipped.
        used = []
        for src, v in ranks.items():
            if v is not None:
                used.append(v)
            elif prelim < source_len[src]:
                used.append(source_len[src] + 1)
        # Trimmed mean: drop the single best and worst rank so one odd source
        # (or a name we failed to match) can't swing a player.
        used.sort()
        trimmed = used[1:-1] if len(used) >= 5 else used
        p["ranks"] = ranks
        p["avg_rank"] = sum(trimmed) / len(trimmed)
        p["n_sources"] = len(present)
        rows.append(p)
    print("matched to ESPN:", matched)

    rows.sort(key=lambda p: (p["avg_rank"], -p["n_sources"]))
    rows = rows[:POOL_SIZE]

    season_fp = []
    for p in rows:
        p["proj_fpg"] = fantasy_points(p["proj"], p["last"]) if p["proj"] else None
        p["proj_gp"] = float(p["proj"].get("42", 0) or 0) if p["proj"] else 0
        p["last_fpg"] = fantasy_points(p["last"]) if p["last"] else None
        p["last_gp"] = int(float(p["last"].get("42", 0) or 0)) if p["last"] else 0
        if p["proj_fpg"] and p["proj_gp"]:
            season_fp.append(p["proj_fpg"] * p["proj_gp"])
        elif p["last_fpg"] and p["last_gp"]:
            season_fp.append(p["last_fpg"] * p["last_gp"])
        else:
            season_fp.append(0)
    prices, fit = price_curve(season_fp)

    players = []
    for i, p in enumerate(rows, start=1):
        proj_fpg, proj_gp, last_fpg, last_gp = p["proj_fpg"], p["proj_gp"], p["last_fpg"], p["last_gp"]
        players.append({
            "id": p["id"],
            "name": p["name"],
            "team": p["team"],
            "pos": p["pos"],
            "rank": i,
            "avgRank": round(p["avg_rank"], 1),
            "price": prices[i - 1],
            "projFpg": round(proj_fpg, 1) if proj_fpg else None,
            "projGp": round(proj_gp) if proj_gp else None,
            "lastFpg": round(last_fpg, 1) if last_fpg is not None and last_gp else None,
            "lastGp": last_gp or None,
            "injury": p["injury"],
        })

    DATA.mkdir(exist_ok=True)
    (DATA / "players.json").write_text(json.dumps({"season": "2026-27", "players": players}, separators=(",", ":")))

    cols = ["espn_points", "espn_cats", "espn_adp", "yahoo_adp", "fantasypros", "cbs", "hashtag", "bbm"]
    with open(DATA / "rankings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rank", "price", "id", "name", "team", "pos", "avg_rank", *cols])
        for pl, p in zip(players, rows):
            w.writerow([pl["rank"], pl["price"], p["id"], p["name"], p["team"], p["pos"], pl["avgRank"],
                        *[("" if p["ranks"][c] is None else round(p["ranks"][c], 1)) for c in cols]])

    print(f"wrote {len(players)} players")
    for n in (1, 5, 10, 20, 30, 50, 75, 100, 150, 200, 250, 300, 400):
        if n <= len(players):
            pl = players[n - 1]
            print(f"#{n:>3} ${pl['price']:>3}  {pl['name']:<28} proj {pl['projFpg']}x{pl['projGp']}  last {pl['lastFpg']}  curve {fit[n-1]:.0f}")
    print("top 15 cost:", sum(p["price"] for p in players[:15]))


if __name__ == "__main__":
    main()
