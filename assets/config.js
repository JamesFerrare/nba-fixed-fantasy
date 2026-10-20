// League settings. This is the only file you should need to edit.
window.LEAGUE = {
  name: "Locked In",
  tagline: "15 players. $500. No trades, no waivers, no excuses.",
  season: "2026-27",

  budget: 500,
  rosterSize: 15,

  // Weekly all-play: every week each team is ranked by the fantasy points its
  // players scored that week (Mon-Sun, Eastern). null = you earn one league
  // point for every team you outscored (1st of 10 gets 9, last gets 0).
  // Or give a custom table by finish, e.g. [12, 9, 7, 5, 4, 3, 2, 1].
  // Ties split the points. Standings = league points summed over all weeks.
  weeklyPoints: null,

  // Signups close at this moment (UTC). Only games that tip off after it count,
  // so everyone starts from zero at the same time. Keep it in sync with
  // league_lock_at() in supabase/setup.sql.
  lockAt: "2026-10-23T22:00:00Z", // Fri Oct 23, 6:00pm ET

  // From your Supabase project: Project Settings -> API (or "Connect").
  // The anon / publishable key is meant to be public, so it's fine to commit.
  supabaseUrl: "https://mqbjbbtkbtbzgmeotxji.supabase.co",
  supabaseKey: "sb_publishable_x6uTl2qfIxwfcliKoAeLVw_TSjKFq6T",

  // Fantasy points per stat. If you change these before the season, also
  // update fantasy_points() in scripts/build_prices.py and re-run it so the
  // projections on the roster builder match.
  scoring: {
    pts: 1,             // point scored
    oreb: 2,            // offensive rebound
    dreb: 1,            // defensive rebound
    ast: 1.5,           // assist
    stl: 3,             // steal
    blk: 3,             // block
    tov: -2,            // turnover
    fg3m: 0.5,          // bonus per 3-pointer made
    doubleDouble: 5,    // 10+ in two of pts/reb/ast/stl/blk
    tripleDouble: 10,   // 10+ in three (replaces the double-double bonus)
    tech: 5,            // technical foul (yes, a bonus)
    flagrant: 5,        // flagrant foul
    ejection: 20,       // tossed from the game
    foulOut: 5,         // six personal fouls
  },

};
