# Locked In: NBA salary-cap fantasy

A season-long NBA fantasy game for friends. Everyone gets **$500** to buy **15 players**, with
prices set from consensus preseason fantasy rankings. Rosters lock once and never change.

Every week is **all-against-all**: teams are ranked by the total fantasy points their players scored
that week (Monday to Sunday, Eastern), and you earn a league point for every team you beat. The
season standings are your league points added up across all the weeks. Standings, weekly
rankings and race charts update every morning.

- **Static site** on GitHub Pages (`index.html` + `assets/`)
- **Signups** go to a free [Supabase](https://supabase.com) table (one SQL file to set up)
- **Stats** come from ESPN box scores via a daily GitHub Action that commits `data/games.json`

## Setup (about 10 minutes)

### 1. Put it on GitHub

Create a new repo (e.g. `nba-fixed-fantasy`), then from this folder run:

```bash
git init -b main && git add . && git commit -m "Locked In fantasy league"
git remote add origin https://github.com/<you>/nba-fixed-fantasy.git
git push -u origin main
```

### 2. Turn on GitHub Pages

Repo **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.
Your site will be at `https://<you>.github.io/nba-fixed-fantasy/`.

### 3. Let the stats Action push

Repo **Settings → Actions → General → Workflow permissions → Read and write permissions** → Save.
Then go to **Actions → Update stats → Run workflow** once to check it works. After that it runs on
its own at about 5am ET and again midday.

### 4. Create the signup database

1. Sign up at [supabase.com](https://supabase.com) and create a new project (free tier is plenty).
2. Open **SQL Editor → New query**, paste all of `supabase/setup.sql`, and click **Run**.
3. Go to **Project Settings → API** (or the **Connect** button) and copy the **Project URL** and the
   **anon / publishable** key.
4. Paste both into `assets/config.js` (`supabaseUrl`, `supabaseKey`), commit and push.

The anon key is designed to be public. The SQL only lets it *insert* entries before the lock, and
the site reads entries through a function that never returns emails and hides rosters until the
lock.

### 5. Send your friends the link

They open the site, hit **Build roster**, pick 15 players, name their team, and lock in.

## League settings

Everything lives in `assets/config.js`:

| Setting | What it does |
| --- | --- |
| `lockAt` | When signups close. Only games tipping off after this count. **Also change it in `supabase/setup.sql` and re-run that file.** |
| `budget`, `rosterSize` | $500 and 15 players by default (also hard-coded as checks in `setup.sql`) |
| `weeklyPoints` | `null` = all-play (1 league point per team you outscore each week). Or a custom table by finish, e.g. `[12, 9, 7, 5, 4, 3, 2, 1]`. |
| `scoring` | Fantasy points per stat. Change before the lock. Standings are always recomputed from raw box scores, so a change applies to the whole season. Then run `python scripts/build_prices.py --projections-only` so the roster builder's projections match (prices stay frozen). |

## How weeks work

- Weeks run Monday to Sunday, Eastern time. The first week starts at the lock; with the default
  Friday lock it runs through the following Sunday (Oct 23 to Nov 1) so nobody's first week is
  only three days long.
- A week becomes final once the morning stats update after its Sunday runs. Until then the site
  shows it as live, with the league points you'd get if it ended right now.
- Tiebreaker in the standings: total fantasy points over the finished weeks.

## Running the commissioner side

- **See entries / emails:** Supabase → Table Editor → `entries`.
- **Remove a duplicate or test entry:** delete the row in the Table Editor.
- **Someone wants to change their roster before the lock:** delete their row and have them submit again.
- **After the lock** the Action saves every roster to `data/entries.json`, so the site keeps
  working even if Supabase pauses a free project.

## How prices were set

`scripts/build_prices.py` pulls eight rankings, matches players by name, and averages each player's
ranks (dropping his best and worst) into a consensus order:

ESPN points-league rank · ESPN categories rank · ESPN ADP · Yahoo ADP (via FantasyPros) ·
FantasyPros expert consensus · CBS Sports top 200 · Hashtag Basketball · Basketball Monster

Price is then a smooth curve over that order, scaled to the production you'd expect at each rank
(top player $150, #50 ≈ $80, #150 ≈ $43, deeper than #300 = $2). Because price tracks expected
production, a stars-and-scrubs roster and a balanced roster have about the same expected total; you
win by finding players who beat their price. Raw ranks for every player are in `data/rankings.csv`.

Prices are a snapshot from October 19, 2026. **Don't re-run the script after people start picking.**

## Local preview

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Files

```
index.html                  the whole site (single page, hash routes)
assets/config.js            league settings
assets/app.js               standings, roster builder, players, rules
assets/style.css
data/players.json           player pool + prices (frozen)
data/rankings.csv           every source rank behind the prices
data/games.json             box scores, updated by the Action
data/status.json            current team + injury status
data/entries.json           roster snapshot, written after the lock
scripts/build_prices.py     one-time price builder
scripts/update_stats.py     daily stats updater (run by the Action)
supabase/setup.sql          signup table + security rules
.github/workflows/update-stats.yml
```
