"""Pull NBA box scores from ESPN and save per-player game lines.

Runs daily in GitHub Actions (.github/workflows/update-stats.yml):

    python scripts/update_stats.py

- data/games.json    every final regular-season game: one row of raw stats per
                     pool player who appeared. The site turns rows into fantasy
                     points using SCORING in assets/config.js, so scoring tweaks
                     never need a re-download.
- data/status.json   current team + injury status for the player pool.
- data/entries.json  after the lock, a snapshot of every roster from Supabase,
                     so standings keep working even if Supabase is asleep.
"""

import argparse
import json
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SEASON = 2027                 # ESPN's label for 2026-27
SEASON_START = date(2026, 10, 20)
REGULAR_SEASON = 2            # ESPN season type
REFRESH_DAYS = 3              # re-fetch recent games to pick up stat corrections

ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
FANTASY = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/{SEASON}"
TEAM_FIX = {"NY": "NYK", "SA": "SAS", "UTAH": "UTA", "WSH": "WAS", "NO": "NOP", "GS": "GSW"}

# Row layout (keep in sync with ROW in assets/app.js)
ROW = ["id", "min", "pts", "reb", "ast", "stl", "blk", "tov", "fg3m", "fgm", "fga", "ftm", "fta", "pf", "tech", "flag", "ej", "oreb", "dreb"]

session = requests.Session()
session.headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"


def get_json(url, **kw):
    for attempt in range(4):
        try:
            r = session.get(url, timeout=30, **kw)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001 - retry anything transient
            if attempt == 3:
                raise
            print(f"  retry {url}: {e}", file=sys.stderr)
            time.sleep(2 + attempt * 3)


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def made_att(v):
    if not v or "-" not in str(v):
        return 0, 0
    m, a = str(v).split("-", 1)
    return to_int(m), to_int(a)


def parse_game(event_id, pool):
    sm = get_json(f"{ESPN}/summary", params={"event": event_id})

    # Foul events per player, keyed by the moment they happened. ESPN sometimes
    # logs the same technical twice (new play id, same clock and wall time).
    tech_events, flag_events, ejections = {}, {}, set()
    for play in sm.get("plays", []):
        kind = play.get("type", {}).get("text", "")
        ids = [to_int(p.get("athlete", {}).get("id")) for p in play.get("participants", [])]
        if not ids:
            continue
        moment = (kind, play.get("period", {}).get("number"), play.get("clock", {}).get("displayValue"), play.get("wallclock"))
        if kind == "Ejection":
            ejections.add(ids[0])
        elif kind.startswith("Flagrant Foul"):
            flag_events.setdefault(ids[0], []).append(moment)
        elif "Technical" in kind and not kind.startswith("Free Throw") and "3-Second" not in kind and "Delay" not in kind:
            # A double technical charges everyone listed; otherwise the 2nd
            # participant is the player who drew it.
            for pid in (ids if kind.startswith("Double") else ids[:1]):
                tech_events.setdefault(pid, []).append(moment)

    for team in sm["boxscore"].get("players", []):
        for a in team["statistics"][0]["athletes"]:
            if a.get("ejected"):
                ejections.add(to_int(a.get("athlete", {}).get("id")))

    # Collapse same-moment repeats, unless the player really was ejected
    # (two quick techs at once do happen, and they always end in an ejection).
    def count(events):
        return {pid: len(ev) if pid in ejections else len(set(ev)) for pid, ev in events.items()}
    techs, flags = count(tech_events), count(flag_events)

    rows = []
    for team in sm["boxscore"].get("players", []):
        block = team["statistics"][0]
        keys = block["keys"]
        for a in block["athletes"]:
            pid = to_int(a.get("athlete", {}).get("id"))
            if not pid or pid not in pool:
                continue
            played = not a.get("didNotPlay") and a.get("stats")
            if a.get("ejected"):
                ejections.add(pid)
            if not played and pid not in techs and pid not in ejections:
                continue
            s = dict(zip(keys, a.get("stats") or []))
            fgm, fga = made_att(s.get("fieldGoalsMade-fieldGoalsAttempted"))
            fg3m, _ = made_att(s.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted"))
            ftm, fta = made_att(s.get("freeThrowsMade-freeThrowsAttempted"))
            rows.append([
                pid, to_int(s.get("minutes")), to_int(s.get("points")), to_int(s.get("rebounds")),
                to_int(s.get("assists")), to_int(s.get("steals")), to_int(s.get("blocks")),
                to_int(s.get("turnovers")), fg3m, fgm, fga, ftm, fta, to_int(s.get("fouls")),
                techs.get(pid, 0), flags.get(pid, 0), 1 if pid in ejections else 0,
                to_int(s.get("offensiveRebounds")), to_int(s.get("defensiveRebounds")),
            ])
    return rows


def update_games(pool, today):
    path = DATA / "games.json"
    store = json.loads(path.read_text()) if path.exists() else {"games": []}
    games = {g["id"]: g for g in store["games"]}

    done_dates = set(store.get("doneDates", []))  # every game that day was final
    day = SEASON_START
    changed = 0
    while day <= today:
        ds = day.isoformat()
        recent = (today - day).days < REFRESH_DAYS
        if ds in done_dates and not recent:
            day += timedelta(days=1)
            continue
        sb = get_json(f"{ESPN}/scoreboard", params={"dates": day.strftime("%Y%m%d")})
        all_final = True
        for ev in sb.get("events", []):
            if ev.get("season", {}).get("type") != REGULAR_SEASON:
                continue
            status = ev["status"]["type"]
            if not status.get("completed"):
                # postponed games never complete on this date; don't wait on them
                all_final &= status.get("name") == "STATUS_POSTPONED"
                continue
            comp = ev["competitions"][0]
            teams = {c["homeAway"]: c for c in comp["competitors"]}
            game = {
                "id": ev["id"],
                "date": ds,
                "tip": ev["date"],
                "away": TEAM_FIX.get(teams["away"]["team"]["abbreviation"], teams["away"]["team"]["abbreviation"]),
                "home": TEAM_FIX.get(teams["home"]["team"]["abbreviation"], teams["home"]["team"]["abbreviation"]),
                "awayScore": to_int(teams["away"].get("score")),
                "homeScore": to_int(teams["home"].get("score")),
            }
            if ev["id"] in games and not recent:
                continue
            print(f"  {ds} {game['away']} @ {game['home']}")
            game["rows"] = parse_game(ev["id"], pool)
            if games.get(ev["id"]) != game:
                games[ev["id"]] = game
                changed += 1
        if all_final and day < today:
            done_dates.add(ds)
        day += timedelta(days=1)

    ordered = sorted(games.values(), key=lambda g: (g["tip"], g["id"]))
    out = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "row": ROW,
        "doneDates": sorted(done_dates),
        "games": ordered,
    }
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"games.json: {len(ordered)} games ({changed} new/changed)")


def update_status(pool):
    teams = get_json(f"{FANTASY}?view=proTeamSchedules_wl")["settings"]["proTeams"]
    abbr = {t["id"]: TEAM_FIX.get(t["abbrev"], t["abbrev"]) for t in teams}
    filt = {"players": {"limit": 1000, "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": "STANDARD"}}}
    data = get_json(
        f"{FANTASY}/segments/0/leaguedefaults/1?view=kona_player_info",
        headers={"X-Fantasy-Filter": json.dumps(filt)},
    )
    status = {}
    for entry in data.get("players", []):
        p = entry["player"]
        if p["id"] not in pool:
            continue
        status[p["id"]] = {"team": abbr.get(p["proTeamId"], "FA"), "injury": p.get("injuryStatus", "ACTIVE")}
    (DATA / "status.json").write_text(json.dumps(
        {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "players": status},
        separators=(",", ":"),
    ))
    print(f"status.json: {len(status)} players")


def read_config():
    text = (ROOT / "assets" / "config.js").read_text()
    def field(name):
        m = re.search(rf'{name}\s*:\s*"([^"]*)"', text)
        return m.group(1) if m else ""
    return field("supabaseUrl").rstrip("/"), field("supabaseKey"), field("lockAt")


def snapshot_entries():
    url, key, lock_at = read_config()
    if not url or not key:
        print("entries: Supabase not configured, skipping")
        return
    headers = {"apikey": key, "Content-Type": "application/json"}
    if key.startswith("eyJ"):  # legacy JWT anon key also goes in Authorization
        headers["Authorization"] = f"Bearer {key}"
    # Calling the API daily also keeps a free Supabase project from pausing.
    r = session.post(f"{url}/rest/v1/rpc/league_entries", headers=headers, json={}, timeout=30)
    r.raise_for_status()
    entries = r.json()
    locked = datetime.now(timezone.utc) >= datetime.fromisoformat(lock_at.replace("Z", "+00:00"))
    if not locked or any(e.get("players") is None for e in entries):
        print(f"entries: {len(entries)} signed up, rosters hidden until lock")
        return
    (DATA / "entries.json").write_text(json.dumps({
        "locked": True,
        "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "entries": entries,
    }, indent=1))
    print(f"entries.json: {len(entries)} rosters")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-status", action="store_true")
    ap.add_argument("--skip-entries", action="store_true")
    args = ap.parse_args()

    pool = {p["id"] for p in json.loads((DATA / "players.json").read_text())["players"]}
    today = datetime.now(ZoneInfo("America/New_York")).date()
    update_games(pool, today)
    # The extras shouldn't block saving box scores.
    for skip, step in ((args.skip_status, update_status), (args.skip_entries, snapshot_entries)):
        if skip:
            continue
        try:
            step(pool) if step is update_status else step()
        except Exception as e:  # noqa: BLE001
            print(f"WARNING: {step.__name__} failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
