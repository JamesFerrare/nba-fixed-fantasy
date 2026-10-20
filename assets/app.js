(() => {
  "use strict";

  const L = window.LEAGUE;
  const S = L.scoring;
  const LOCK = new Date(L.lockAt);
  const isLocked = () => Date.now() >= LOCK.getTime();

  // Column order of each box-score row in data/games.json (see scripts/update_stats.py)
  const ROW = { id: 0, min: 1, pts: 2, reb: 3, ast: 4, stl: 5, blk: 6, tov: 7, fg3m: 8, fgm: 9, fga: 10, ftm: 11, fta: 12, pf: 13, tech: 14, flag: 15, ej: 16, oreb: 17, dreb: 18 };
  const SERIES = 8;
  const KEYS = { draft: "lockedin.draft", mine: "lockedin.mine", highlight: "lockedin.highlight" };

  const state = {
    players: [], byId: new Map(), floor: 1,
    games: [], updated: null,
    entries: [], entriesSource: "none", entriesError: null,
  };

  // ------------------------------------------------------------------ utils

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt1 = (x) => (Math.round(x * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt0 = (x) => Math.round(x).toLocaleString();
  const compact = (x) => (Math.abs(x) >= 1000 ? `${+(x / 1000).toFixed(x >= 10000 ? 0 : 1)}K` : String(Math.round(x)));
  const signed1 = (x) => `${x < 0 ? "−" : "+"}${fmt1(Math.abs(x))}`;
  const money = (x) => `$${Math.round(x).toLocaleString()}`;
  const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const lockText = () => LOCK.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  function ago(iso) {
    if (!iso) return "never";
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    if (h < 36) return `${h} hr ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  function untilParts(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }

  function headshot(id) {
    return `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=96&h=70&scale=crop`;
  }

  function injuryBadge(p) {
    const s = p.injury;
    if (!s || s === "ACTIVE") return "";
    const label = { OUT: "OUT", DAY_TO_DAY: "DTD", INJURY_RESERVE: "IR", SUSPENSION: "SUSP", QUESTIONABLE: "Q", DOUBTFUL: "D" }[s] || s.slice(0, 4);
    const cls = s === "OUT" || s === "INJURY_RESERVE" || s === "SUSPENSION" ? "inj out" : "inj";
    return `<span class="${cls}" title="${esc(s.replace(/_/g, " ").toLowerCase())}">${esc(label)}</span>`;
  }

  function playerCell(p, extra = "") {
    return `<div class="player"><img src="${headshot(p.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="meta"><strong>${esc(p.name)}${injuryBadge(p)}</strong><span>${esc(p.team)} · ${esc(p.pos)}${extra}</span></div></div>`;
  }

  // ------------------------------------------------------------------ data

  async function getJSON(path) {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }

  const supabaseReady = () => Boolean(L.supabaseUrl && L.supabaseKey);

  async function sb(path, opts = {}) {
    const headers = { apikey: L.supabaseKey, "Content-Type": "application/json", ...(opts.headers || {}) };
    if (L.supabaseKey.startsWith("eyJ")) headers.Authorization = `Bearer ${L.supabaseKey}`;
    const r = await fetch(`${L.supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, { ...opts, headers });
    if (!r.ok) {
      let body = {};
      try { body = await r.json(); } catch { /* empty */ }
      const err = new Error(body.message || `HTTP ${r.status}`);
      err.code = body.code;
      err.status = r.status;
      throw err;
    }
    return r;
  }

  async function load() {
    const [pl, gm, st, en] = await Promise.all([
      getJSON("data/players.json"),
      getJSON("data/games.json").catch(() => ({ games: [] })),
      getJSON("data/status.json").catch(() => ({ players: {} })),
      getJSON("data/entries.json").catch(() => ({ locked: false, entries: [] })),
    ]);
    for (const p of pl.players) {
      const live = st.players?.[p.id];
      if (live) { p.team = live.team; p.injury = live.injury; }
      state.byId.set(p.id, p);
    }
    state.players = pl.players;
    state.floor = Math.min(...pl.players.map((p) => p.price));
    state.games = gm.games || [];
    state.updated = gm.updated || null;

    if (en.locked && en.entries?.length) {
      state.entries = en.entries;
      state.entriesSource = "snapshot";
    } else if (supabaseReady()) {
      try {
        state.entries = await (await sb("rpc/league_entries", { method: "POST", body: "{}" })).json();
        state.entriesSource = "live";
        forgetDeletedEntry();
      } catch (e) {
        state.entriesError = e.message;
      }
    }
  }

  // If the commissioner deleted this device's team, forget it so its owner
  // starts from a clean slate instead of seeing "you already entered".
  function forgetDeletedEntry() {
    const mine = store.get(KEYS.mine, null);
    if (!mine?.team) return;
    const name = mine.team.trim().toLowerCase();
    if (!state.entries.some((e) => e.team_name.trim().toLowerCase() === name)) store.remove(KEYS.mine);
  }

  // ------------------------------------------------------------------ scoring

  function fantasyPoints(r) {
    const oreb = r[ROW.oreb] ?? 0;
    const dreb = r[ROW.dreb] ?? r[ROW.reb] - oreb;
    let v = r[ROW.pts] * S.pts + oreb * S.oreb + dreb * S.dreb + r[ROW.ast] * S.ast + r[ROW.stl] * S.stl
      + r[ROW.blk] * S.blk + r[ROW.tov] * S.tov + r[ROW.fg3m] * S.fg3m;
    const tens = [r[ROW.pts], r[ROW.reb], r[ROW.ast], r[ROW.stl], r[ROW.blk]].filter((x) => x >= 10).length;
    if (tens >= 3) v += S.tripleDouble;
    else if (tens === 2) v += S.doubleDouble;
    v += r[ROW.tech] * S.tech + r[ROW.flag] * S.flagrant + r[ROW.ej] * S.ejection + (r[ROW.pf] >= 6 ? S.foulOut : 0);
    return Math.round(v * 10) / 10;
  }

  // Games that count toward standings: tipped off after the lock.
  const scoringGames = () => state.games.filter((g) => new Date(g.tip) >= LOCK);
  // Games shown on player pages: counted games once locked, everything before that.
  const statGames = () => (isLocked() ? scoringGames() : state.games);

  function playerTotals(games) {
    const out = new Map();
    for (const g of games) {
      for (const r of g.rows) {
        let t = out.get(r[ROW.id]);
        if (!t) { t = { gp: 0, fp: 0, last: null, lastDate: null, tech: 0, ej: 0 }; out.set(r[ROW.id], t); }
        const pts = fantasyPoints(r);
        if (r[ROW.min] > 0) t.gp += 1;
        t.fp += pts;
        t.last = pts;
        t.lastDate = g.date;
        t.tech += r[ROW.tech];
        t.ej += r[ROW.ej];
      }
    }
    return out;
  }

  function validateRoster(ids) {
    const issues = [];
    if (ids.length !== L.rosterSize) issues.push(`${ids.length} players`);
    if (new Set(ids).size !== ids.length) issues.push("duplicate players");
    if (ids.some((id) => !state.byId.has(id))) issues.push("unknown player");
    const cost = ids.reduce((s, id) => s + (state.byId.get(id)?.price || 0), 0);
    if (cost > L.budget) issues.push(`over budget (${money(cost)})`);
    return { cost, issues };
  }

  // ------------------------------------------------------------------ weeks

  const ET_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const etDate = (d) => ET_FMT.format(new Date(d)); // "YYYY-MM-DD" in Eastern time
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekday = (s) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const fmtPts = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 >= 11 && n % 100 <= 13) || n % 10 > 3 ? 0 : n % 10]}`;
  const weekRange = (w) => `${shortDate(w.start)}–${shortDate(w.end)}`;

  // Weeks run Monday-Sunday (Eastern). The first one starts at the lock; if that
  // leaves fewer than 4 days before Sunday it rolls into the next full week.
  function buildWeeks(lastDate) {
    const weeks = [];
    let start = etDate(LOCK);
    let end = addDays(start, (7 - weekday(start)) % 7);
    if ((7 - weekday(start)) % 7 + 1 < 4) end = addDays(end, 7);
    while (start <= lastDate) {
      weeks.push({ n: weeks.length + 1, start, end });
      start = addDays(end, 1);
      end = addDays(start, 6);
    }
    return weeks;
  }

  // Rank one week's scores and hand out league points (all-play by default).
  function awardWeek(rows) {
    const sorted = [...rows].sort((a, b) => b.fp - a.fp || a.team.team_name.localeCompare(b.team.team_name));
    const table = Array.isArray(L.weeklyPoints) ? L.weeklyPoints : null;
    for (const r of sorted) {
      const higher = sorted.filter((o) => o.fp > r.fp).length;
      const ties = sorted.filter((o) => o !== r && o.fp === r.fp).length;
      r.rank = higher + 1;
      r.w = sorted.length - 1 - higher - ties;
      r.l = higher;
      r.t = ties;
      if (table) {
        let sum = 0;
        for (let k = higher; k <= higher + ties; k++) sum += table[k] ?? 0;
        r.pts = Math.round((sum / (ties + 1)) * 100) / 100;
      } else {
        r.pts = r.w + r.t / 2;
      }
    }
    return sorted;
  }

  function computeLeague() {
    const games = scoringGames();
    const byDate = new Map(); // date -> Map(player -> fantasy points)
    for (const g of games) {
      let m = byDate.get(g.date);
      if (!m) { m = new Map(); byDate.set(g.date, m); }
      for (const r of g.rows) m.set(r[ROW.id], (m.get(r[ROW.id]) || 0) + fantasyPoints(r));
    }
    const dates = [...byDate.keys()].sort();
    const today = etDate(Date.now());
    const statsThrough = state.updated ? etDate(state.updated) : null;
    const weeks = isLocked() ? buildWeeks(dates.length && dates[dates.length - 1] > today ? dates[dates.length - 1] : today) : [];

    const all = state.entries.filter((e) => Array.isArray(e.players)).map((e) => {
      const { cost, issues } = validateRoster(e.players);
      const day = new Map();
      for (const d of dates) {
        const m = byDate.get(d);
        let sum = 0;
        for (const id of e.players) sum += m.get(id) || 0;
        day.set(d, Math.round(sum * 10) / 10);
      }
      return { ...e, cost, issues, valid: issues.length === 0, day, weeks: [], leaguePts: 0, prevPts: 0, prevFp: 0, w: 0, l: 0, t: 0, fp: 0, fpDone: 0 };
    });
    const teams = all.filter((t) => t.valid);

    for (const w of weeks) {
      w.dates = dates.filter((d) => d >= w.start && d <= w.end);
      w.complete = Boolean(statsThrough && statsThrough > w.end);
      w.live = !w.complete && w.start <= today;
      const rows = teams.map((t) => ({ team: t, fp: Math.round(w.dates.reduce((s, d) => s + t.day.get(d), 0) * 10) / 10 }));
      w.results = awardWeek(rows);
      for (const r of w.results) {
        r.team.weeks.push({ n: w.n, fp: r.fp, rank: r.rank, pts: r.pts, complete: w.complete });
        r.team.fp += r.fp;
        if (w.complete) {
          r.team.fpDone += r.fp;
          r.team.leaguePts += r.pts;
          r.team.w += r.w;
          r.team.l += r.l;
          r.team.t += r.t;
        }
      }
    }
    const done = weeks.filter((w) => w.complete);
    const last = done[done.length - 1];
    for (const t of teams) {
      t.prevPts = t.leaguePts - (last ? t.weeks[last.n - 1].pts : 0);
      t.prevFp = t.fpDone - (last ? t.weeks[last.n - 1].fp : 0);
      t.liveWeek = weeks.find((w) => w.live) ? t.weeks[weeks.find((w) => w.live).n - 1] : null;
    }
    const rankBy = (pts, fp) => {
      const sorted = [...teams].sort((a, b) => b[pts] - a[pts] || b[fp] - a[fp]);
      const ranks = new Map();
      sorted.forEach((t, i) => {
        const prev = sorted[i - 1];
        ranks.set(t.id, prev && prev[pts] === t[pts] && prev[fp] === t[fp] ? ranks.get(prev.id) : i + 1);
      });
      return ranks;
    };
    const now = rankBy("leaguePts", "fpDone");
    const before = rankBy("prevPts", "prevFp");
    for (const t of teams) { t.rank = now.get(t.id); t.move = done.length > 1 ? before.get(t.id) - t.rank : 0; }
    teams.sort((a, b) => a.rank - b.rank || a.team_name.localeCompare(b.team_name));
    return { weeks, done, dates, teams, invalid: all.filter((t) => !t.valid) };
  }

  function myTeamName() {
    const mine = store.get(KEYS.mine, null);
    return mine?.team ? mine.team.trim().toLowerCase() : null;
  }
  const isMine = (t) => myTeamName() && t.team_name.trim().toLowerCase() === myTeamName();

  // Highlighted teams on the chart keep their color slot as long as they stay highlighted.
  function highlightSlots(teams) {
    let slots = store.get(KEYS.highlight, null);
    const ids = new Set(teams.map((t) => String(t.id)));
    if (slots) {
      for (const k of Object.keys(slots)) if (!ids.has(k)) delete slots[k];
    }
    if (!slots || !Object.keys(slots).length) {
      slots = {};
      const picks = [...teams.filter(isMine), ...teams.filter((t) => !isMine(t))].slice(0, 5);
      picks.forEach((t, i) => { slots[t.id] = i; });
    }
    return slots;
  }

  function toggleHighlight(slots, id) {
    if (id in slots) delete slots[id];
    else {
      const used = new Set(Object.values(slots));
      const free = [...Array(SERIES).keys()].find((i) => !used.has(i));
      if (free === undefined) return false;
      slots[id] = free;
    }
    store.set(KEYS.highlight, slots);
    return true;
  }

  // ------------------------------------------------------------------ chart

  function niceTicks(max, count = 4) {
    if (max <= 0) return [0];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  function lineChart(box, { labels, tipTitle, series, slots, aria, fmt = fmt1 }) {
    const n = labels.length;
    const tooltip = document.createElement("div");
    tooltip.className = "tooltip hidden";
    let geo = null; // geometry from the last draw, reused by the hover layer
    let hoverIdx = null;
    const color = (s) => (s.id in slots ? `var(--s${slots[s.id] + 1})` : null);

    function draw() {
      const W = Math.max(280, box.clientWidth);
      const showLabels = W >= 620;
      const H = Math.round(Math.min(380, Math.max(240, W * 0.42)));
      const m = { t: 12, r: showLabels ? 132 : 14, b: 28, l: 44 };
      const iw = W - m.l - m.r;
      const ih = H - m.t - m.b;
      const yt = niceTicks(Math.max(1, ...series.flatMap((s) => s.values)));
      const yMax = yt[yt.length - 1];
      const x = (i) => m.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
      const y = (v) => m.t + ih - (v / yMax) * ih;
      const lit = series.filter((s) => color(s)).sort((a, b) => slots[a.id] - slots[b.id]);
      const others = series.filter((s) => !color(s));
      geo = { W, m, iw, ih, x, y, lit };

      const parts = [];
      parts.push(`<g class="grid">${yt.map((v) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>`);
      parts.push(`<line class="baseline" x1="${m.l}" x2="${m.l + iw}" y1="${y(0)}" y2="${y(0)}"/>`);
      parts.push(`<g class="axis">${yt.map((v) => `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join("")}</g>`);
      const xTickCount = Math.min(n, Math.max(2, Math.floor(iw / 90)));
      const xIdx = n === 1 ? [0] : [...new Set([...Array(xTickCount).keys()].map((k) => Math.round((k * (n - 1)) / (xTickCount - 1))))];
      const anchor = (i) => (n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle");
      parts.push(`<g class="axis">${xIdx.map((i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor(i)}">${esc(labels[i])}</text>`).join("")}</g>`);

      const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      for (const s of others) {
        parts.push(n > 1 ? `<path class="series other" d="${path(s.values)}"/>` : `<circle cx="${x(0)}" cy="${y(s.values[0])}" r="3" fill="var(--other-line)"/>`);
      }
      for (const s of lit) {
        if (n > 1) parts.push(`<path class="series" stroke="${color(s)}" d="${path(s.values)}"/>`);
        parts.push(`<circle class="enddot" cx="${x(n - 1)}" cy="${y(s.values[n - 1])}" r="4.5" fill="${color(s)}"/>`);
      }
      // Direct end labels only when they don't collide; otherwise the legend + tooltip carry identity.
      if (showLabels && lit.length && lit.length <= 5) {
        const labels = lit.map((s) => ({ s, y: y(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
        if (labels.every((l, i) => i === 0 || l.y - labels[i - 1].y >= 15)) {
          for (const l of labels) {
            const name = l.s.name.length > 15 ? `${l.s.name.slice(0, 14)}…` : l.s.name;
            parts.push(`<text class="endlabel" x="${x(n - 1) + 10}" y="${l.y + 4}">${esc(name)} · ${fmt === fmt1 ? compact(l.s.values[n - 1]) : fmt(l.s.values[n - 1])}</text>`);
          }
        }
      }
      parts.push(`<g class="hover"></g>`);
      parts.push(`<rect class="hit" x="${m.l - 10}" y="${m.t}" width="${iw + 20}" height="${ih}" fill="transparent"/>`);

      box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" height="${H}" tabindex="0" role="img" aria-label="${esc(aria)}. Use the left and right arrow keys to step through.">${parts.join("")}</svg>`;
      box.appendChild(tooltip);
      const svg = box.querySelector("svg");
      svg.addEventListener("pointermove", (ev) => { const i = idxAt(svg, ev.clientX); if (i !== hoverIdx) hover(i); });
      svg.addEventListener("pointerleave", clearHover);
      svg.addEventListener("focus", () => { if (hoverIdx === null) hover(n - 1); });
      svg.addEventListener("blur", clearHover);
      svg.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        ev.preventDefault();
        hover(Math.max(0, Math.min(n - 1, (hoverIdx ?? n - 1) + (ev.key === "ArrowLeft" ? -1 : 1))));
      });
      if (hoverIdx !== null) hover(hoverIdx);
    }

    function idxAt(svg, clientX) {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * geo.W;
      return n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - geo.m.l) / geo.iw) * (n - 1))));
    }

    function clearHover() {
      hoverIdx = null;
      tooltip.classList.add("hidden");
      const g = box.querySelector("g.hover");
      if (g) g.innerHTML = "";
    }

    function hover(i) {
      hoverIdx = i;
      const { x, y, m, ih, lit, W } = geo;
      box.querySelector("g.hover").innerHTML = `<line class="crosshair" x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${m.t + ih}"/>`
        + lit.map((s) => `<circle class="enddot" cx="${x(i)}" cy="${y(s.values[i])}" r="4.5" fill="${color(s)}"/>`).join("");

      const rows = [...series].sort((a, b) => b.values[i] - a.values[i]);
      const shown = rows.slice(0, 10);
      tooltip.innerHTML = "";
      const head = document.createElement("div");
      head.className = "tt-date";
      head.textContent = tipTitle(i);
      tooltip.appendChild(head);
      for (const s of shown) {
        const row = document.createElement("div");
        row.className = "tt-row";
        const key = document.createElement("span");
        key.className = "key";
        if (color(s)) key.style.background = color(s);
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = s.name;
        const v = document.createElement("span");
        v.className = "v";
        v.textContent = fmt(s.values[i]);
        row.append(key, nm, v);
        tooltip.appendChild(row);
      }
      if (rows.length > shown.length) {
        const more = document.createElement("div");
        more.className = "tt-date";
        more.textContent = `+${rows.length - shown.length} more`;
        tooltip.appendChild(more);
      }
      tooltip.classList.remove("hidden");
      const scale = box.querySelector("svg").getBoundingClientRect().width / W;
      const px = x(i) * scale;
      const tw = tooltip.offsetWidth;
      tooltip.style.left = `${px + 14 + tw > box.clientWidth ? Math.max(0, px - tw - 14) : px + 14}px`;
      tooltip.style.top = `${m.t * scale}px`;
    }

    let raf = 0;
    let lastW = 0;
    const ro = new ResizeObserver(() => {
      if (box.clientWidth === lastW) return;
      lastW = box.clientWidth;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    ro.observe(box);
    lastW = box.clientWidth;
    draw();
    return { redraw: draw, destroy: () => ro.disconnect() };
  }

  // ------------------------------------------------------------------ views

  const app = $("#app");
  let cleanup = [];

  function setView(html) {
    cleanup.forEach((f) => f());
    cleanup = [];
    app.innerHTML = html;
  }

  function supabaseNotice() {
    if (supabaseReady()) return state.entriesError ? `<div class="notice">Couldn't reach the signup database: ${esc(state.entriesError)}</div>` : "";
    return `<div class="notice"><strong>Signups aren't connected yet.</strong> Commissioner: create a free Supabase project, run <code>supabase/setup.sql</code>, and paste the URL + key into <code>assets/config.js</code>. See the README.</div>`;
  }

  // ---------- standings

  function renderStandings() {
    if (!isLocked()) return renderPreLock();
    const { weeks, done, teams, invalid } = computeLeague();
    if (!teams.length && !invalid.length) {
      setView(`<div class="page-head"><div><h1>Standings</h1><p>Rosters are locked.</p></div></div>${supabaseNotice()}
        <div class="card"><p class="muted">No teams found yet.${state.entriesSource === "none" ? "" : " Check back after the next stats update."}</p></div>`);
      return;
    }
    const live = weeks.find((w) => w.live) || null;
    const slots = highlightSlots(teams);
    const totals = playerTotals(scoringGames());
    const owned = new Map();
    for (const t of teams) for (const id of t.players) owned.set(id, (owned.get(id) || 0) + 1);
    let topPlayer = null;
    for (const [id] of owned) {
      const tot = totals.get(id);
      if (tot && (!topPlayer || tot.fp > topPlayer.fp)) topPlayer = { id, fp: tot.fp };
    }
    const mostOwned = [...owned.entries()].sort((a, b) => b[1] - a[1])[0];
    const leader = teams[0];
    const liveLeader = live && live.dates.length ? live.results[0] : null;
    const firstEnd = weeks[0] ? shortDate(addDays(weeks[0].end, 1)) : "";

    const keyFor = (t) => (t.id in slots ? `<span class="key" style="display:inline-block;width:14px;height:2px;border-radius:1px;vertical-align:middle;margin-right:6px;background:var(--s${slots[t.id] + 1})"></span>` : "");
    const record = (t) => `${t.w}-${t.l}${t.t ? `-${t.t}` : ""}`;
    const rows = teams.map((t) => `
      <tr class="clickable ${isMine(t) ? "mine" : ""}" data-team="${t.id}">
        <td class="rank">${t.rank}${t.move > 0 ? `<span class="move up">▲${t.move}</span>` : t.move < 0 ? `<span class="move down">▼${-t.move}</span>` : ""}</td>
        <td><div class="teamcell"><strong data-key>${keyFor(t)}${esc(t.team_name)}</strong><span>${esc(t.owner_name)}</span></div></td>
        <td class="num hide-sm">${t.liveWeek && live.dates.length ? `${fmt1(t.liveWeek.fp)} <span class="muted small">${ordinal(t.liveWeek.rank)}</span>` : "—"}</td>
        <td class="num hide-sm">${done.length ? record(t) : "—"}</td>
        <td class="num hide-sm">${fmt1(t.fpDone)}</td>
        <td class="num pts">${fmtPts(t.leaguePts)}</td>
      </tr>`).join("");
    const invalidRows = invalid.length ? `<p class="small muted" style="margin:12px 0 0">Not ranked (invalid roster): ${invalid.map((t) => `${esc(t.team_name)} — ${esc(t.issues.join(", "))}`).join("; ")}</p>` : "";
    const scoringNote = Array.isArray(L.weeklyPoints)
      ? `League points each week by finish: ${L.weeklyPoints.map((v, i) => `${ordinal(i + 1)} ${v}`).join(", ")}.`
      : "Each week you get 1 league point for every team you outscore (all-play).";

    const visibleWeeks = weeks.filter((w) => w.start <= etDate(Date.now()) || w.dates.length);
    let selected = (live && live.dates.length ? live : done[done.length - 1] || visibleWeeks[0] || null);

    setView(`
      <div class="page-head"><div><h1>Standings</h1>
        <p>${teams.length} teams · ${done.length} week${done.length === 1 ? "" : "s"} final${live ? ` · week ${live.n} in progress` : ""} · stats updated ${esc(ago(state.updated))}</p></div>
        <a class="btn" href="#/players">Player points →</a></div>
      <div class="tiles">
        <div class="tile"><div class="label">Leader</div><div class="value">${done.length ? `${fmtPts(leader.leaguePts)} pts` : "—"}</div><div class="sub">${done.length ? esc(leader.team_name) : `Week 1 final ${esc(firstEnd)}`}</div></div>
        <div class="tile"><div class="label">${live ? `Leading week ${live.n}` : "This week"}</div><div class="value">${liveLeader ? fmt0(liveLeader.fp) : "—"}</div><div class="sub">${liveLeader ? esc(liveLeader.team.team_name) : "No games yet"}</div></div>
        <div class="tile"><div class="label">Top rostered player</div><div class="value">${topPlayer ? fmt0(topPlayer.fp) : "—"}</div><div class="sub">${topPlayer ? esc(state.byId.get(topPlayer.id).name) : "No games yet"}</div></div>
        <div class="tile"><div class="label">Most rostered</div><div class="value">${mostOwned ? `${mostOwned[1]}/${teams.length}` : "—"}</div><div class="sub">${mostOwned ? esc(state.byId.get(mostOwned[0])?.name) : ""}</div></div>
      </div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Team</th><th class="num hide-sm">${live ? `Week ${live.n}` : "This week"}</th><th class="num hide-sm" title="Weekly all-play record: teams beaten - teams lost to">Record</th><th class="num hide-sm" title="Fantasy points from finished weeks, the tiebreaker">Fantasy pts</th><th class="num">League pts</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <p class="small muted" style="margin:12px 0 0">${esc(scoringNote)} Standings add up league points from finished weeks; ties go to more fantasy points over those weeks.</p>
        ${invalidRows}
      </div>
      <div class="card">
        <h2>Season race</h2>
        <p class="small muted" style="margin:-6px 0 10px">League points after each finished week. Click a team to highlight it.</p>
        <div class="chart-legend" id="legend"></div>
        <div class="chart-box" id="season-chart"></div>
      </div>
      <div class="card">
        <h2>Week by week</h2>
        <div class="chips scroll" id="week-chips"></div>
        <div id="week-body"></div>
      </div>`);

    app.addEventListener("click", onRowClick);
    cleanup.push(() => app.removeEventListener("click", onRowClick));
    function onRowClick(ev) {
      const tr = ev.target.closest("tr[data-team]");
      if (tr) location.hash = `#/team/${tr.dataset.team}`;
    }

    const charts = [];
    const redrawAll = () => {
      charts.forEach((c) => c.redraw());
      app.querySelectorAll("tr[data-team]").forEach((tr) => {
        const tm = teams.find((x) => String(x.id) === tr.dataset.team);
        if (tm) tr.querySelector("[data-key]").innerHTML = `${keyFor(tm)}${esc(tm.team_name)}`;
      });
    };

    // Season race: cumulative league points by finished week.
    const seasonBox = $("#season-chart");
    if (done.length) {
      const series = teams.map((t) => {
        let run = 0;
        return { id: t.id, name: t.team_name, values: done.map((w) => (run += t.weeks[w.n - 1].pts)) };
      });
      const c = lineChart(seasonBox, {
        labels: done.map((w) => `Wk ${w.n}`), tipTitle: (i) => `After week ${done[i].n} · ${weekRange(done[i])}`,
        series, slots, aria: "League points by team after each week", fmt: fmtPts,
      });
      charts.push(c);
      cleanup.push(c.destroy);
    } else {
      seasonBox.innerHTML = `<div class="empty-chart">The first week is final after ${esc(weeks[0] ? shortDate(weeks[0].end) : lockText())}. League points start then.</div>`;
    }

    // Week by week: that week's ranking + a day-by-day race.
    const chipsEl = $("#week-chips");
    const body = $("#week-body");
    let weekChart = null;
    function drawWeek() {
      const keep = chipsEl.scrollLeft;
      chipsEl.innerHTML = visibleWeeks.map((w) => `<button type="button" class="chip ${w === selected ? "on" : ""}" data-week="${w.n}">Wk ${w.n}${w.live ? " · live" : ""}</button>`).join("");
      chipsEl.scrollLeft = keep || chipsEl.scrollWidth;
      if (weekChart) { weekChart.destroy(); charts.splice(charts.indexOf(weekChart), 1); weekChart = null; }
      if (!selected) { body.innerHTML = `<p class="muted">No weeks yet.</p>`; return; }
      const w = selected;
      const status = w.complete ? "Final" : w.live ? "In progress. League points show what you'd get if it ended now." : "Upcoming";
      const rowsW = w.results.map((r) => `<tr class="clickable ${isMine(r.team) ? "mine" : ""}" data-team="${r.team.id}">
          <td class="rank">${r.rank}</td>
          <td><div class="teamcell"><strong data-key>${keyFor(r.team)}${esc(r.team.team_name)}</strong><span>${esc(r.team.owner_name)}</span></div></td>
          <td class="num hide-sm">${r.w}-${r.l}${r.t ? `-${r.t}` : ""}</td>
          <td class="num">${fmt1(r.fp)}</td>
          <td class="num pts ${w.complete ? "" : "muted"}">+${fmtPts(r.pts)}</td></tr>`).join("");
      body.innerHTML = `<p class="small muted" style="margin:0 0 10px">Week ${w.n} · ${esc(weekRange(w))} · ${esc(status)}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Team</th><th class="num hide-sm">Record</th><th class="num">Fantasy pts</th><th class="num">League pts</th></tr></thead>
          <tbody>${rowsW}</tbody></table></div>
        <h3 style="margin-top:18px">Day by day</h3>
        <div class="chart-box" id="week-chart"></div>`;
      const box = $("#week-chart");
      if (!w.dates.length) { box.innerHTML = `<div class="empty-chart">No games yet this week.</div>`; return; }
      const series = w.results.map((r) => {
        let run = 0;
        return { id: r.team.id, name: r.team.team_name, values: w.dates.map((d) => Math.round((run += r.team.day.get(d)) * 10) / 10) };
      });
      weekChart = lineChart(box, {
        labels: w.dates.map((d) => shortDate(d)), tipTitle: (i) => `Week ${w.n} through ${shortDate(w.dates[i])}`,
        series, slots, aria: `Fantasy points by team during week ${w.n}`,
      });
      charts.push(weekChart);
    }
    chipsEl.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-week]");
      if (!b) return;
      selected = weeks[Number(b.dataset.week) - 1];
      drawWeek();
    });
    cleanup.push(() => weekChart && weekChart.destroy());
    drawWeek();

    const legend = $("#legend");
    const drawLegend = () => {
      legend.innerHTML = "";
      for (const t of teams) {
        const b = document.createElement("button");
        b.className = `legend-item ${t.id in slots ? "on" : ""}`;
        b.type = "button";
        b.title = t.id in slots ? "Click to un-highlight" : "Click to highlight";
        const key = document.createElement("span");
        key.className = "key";
        if (t.id in slots) key.style.background = `var(--s${slots[t.id] + 1})`;
        b.append(key, document.createTextNode(t.team_name));
        b.addEventListener("click", () => {
          if (!toggleHighlight(slots, t.id)) return;
          drawLegend();
          redrawAll();
        });
        legend.appendChild(b);
      }
    };
    drawLegend();
  }

  function renderPreLock() {
    const joined = state.entries;
    const mine = store.get(KEYS.mine, null);
    const myRoster = mine?.players?.map((id) => state.byId.get(id)).filter(Boolean) || [];
    const list = joined.length
      ? `<ul class="plain joined">${joined.map((e) => `<li><span><strong>${esc(e.team_name)}</strong></span><span class="muted">${esc(e.owner_name)}</span></li>`).join("")}</ul>`
      : `<p class="muted">${supabaseReady() ? "Nobody yet — be the first." : "Signups open once the commissioner connects the database."}</p>`;
    setView(`
      ${supabaseReady() ? "" : supabaseNotice()}
      <div class="hero" style="margin-top:${supabaseReady() ? 0 : 16}px">
        <div class="card">
          <h1>${esc(L.name)}</h1>
          <p class="ink2" style="margin:0">${esc(L.tagline)}</p>
          <div class="countdown" id="countdown" aria-live="off"></div>
          <p class="small muted" style="margin:0 0 14px">Rosters lock ${esc(lockText())}. Only games after the lock count.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a class="btn primary" href="#/join">Build your roster →</a>
            <a class="btn" href="#/rules">How scoring works</a>
          </div>
        </div>
        <div class="card">
          <h2>Who's in <span class="muted">(${joined.length})</span></h2>
          <p class="small muted" style="margin-top:-6px">Rosters stay secret until the lock.</p>
          ${list}
        </div>
      </div>
      ${myRoster.length ? `<div class="card"><h2>Your roster · ${esc(mine.team)}</h2>
        <p class="small muted" style="margin-top:-6px">Saved on this device. ${money(myRoster.reduce((s, p) => s + p.price, 0))} spent.</p>
        <div class="table-wrap"><table><tbody>${[...myRoster].sort((a, b) => b.price - a.price).map((p) => `<tr><td>${playerCell(p)}</td><td class="num">${money(p.price)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      <div class="grid-2" style="margin-top:16px">
        <div class="card prose"><h2>How it works</h2><ul>
          <li>Every player has a fixed price built from consensus preseason fantasy rankings.</li>
          <li>Spend up to ${money(L.budget)} on exactly ${L.rosterSize} players.</li>
          <li>After the lock, nothing changes. No trades, no waivers, no lineups.</li>
          <li>Every week you go up against every other team: rank by that week's fantasy points, earn league points for how many teams you beat.</li>
          <li>Most league points at the end of the regular season wins.</li></ul></div>
        <div class="card prose"><h2>Scoring at a glance</h2>
          <p>Point ${S.pts} · Off. rebound ${S.oreb} · Def. rebound ${S.dreb} · Assist ${S.ast} · Steal ${S.stl} · Block ${S.blk} · Turnover ${S.tov} · 3PM bonus ${S.fg3m}</p>
          <p>Double-double +${S.doubleDouble} · Triple-double +${S.tripleDouble} · Technical ${S.tech > 0 ? "+" : ""}${S.tech} · Flagrant ${S.flagrant > 0 ? "+" : ""}${S.flagrant} · Ejection ${S.ejection > 0 ? "+" : ""}${S.ejection} · Foul out ${S.foulOut > 0 ? "+" : ""}${S.foulOut}</p>
          <p><a href="#/rules">Full rules →</a></p></div>
      </div>`);
    const cd = $("#countdown");
    const tick = () => {
      if (isLocked()) { route(); return; }
      const t = untilParts(LOCK - Date.now());
      cd.innerHTML = [["d", "days"], ["h", "hrs"], ["m", "min"], ["s", "sec"]].map(([k, l]) => `<div><b>${String(t[k]).padStart(2, "0")}</b><span>${l}</span></div>`).join("");
    };
    tick();
    const iv = setInterval(tick, 1000);
    cleanup.push(() => clearInterval(iv));
  }

  // ---------- team page

  function renderTeam(id) {
    const { weeks, teams, invalid } = computeLeague();
    const t = [...teams, ...invalid].find((x) => String(x.id) === String(id));
    if (!t) {
      setView(`<p><a href="#/">← Standings</a></p><div class="card"><p class="muted">${isLocked() ? "Team not found." : "Rosters are hidden until the lock."}</p></div>`);
      return;
    }
    const totals = playerTotals(scoringGames());
    const rows = t.players.map((pid) => {
      const p = state.byId.get(pid) || { id: pid, name: `#${pid}`, team: "?", pos: "?", price: 0 };
      const s = totals.get(pid) || { gp: 0, fp: 0, last: null };
      return { p, s };
    }).sort((a, b) => b.s.fp - a.s.fp || b.p.price - a.p.price);
    const mvp = rows[0];
    const finals = t.weeks.filter((w) => w.complete);
    const best = [...finals].sort((a, b) => a.rank - b.rank || b.fp - a.fp)[0];
    const weekRows = t.weeks.filter((w) => weeks[w.n - 1].dates.length || w.complete).map((w) => {
      const wk = weeks[w.n - 1];
      return `<tr><td>Week ${w.n}</td><td class="muted hide-sm">${esc(weekRange(wk))}</td><td class="num">${fmt1(w.fp)}</td>
        <td class="num">${ordinal(w.rank)}${w.complete ? "" : ' <span class="muted small">live</span>'}</td>
        <td class="num pts ${w.complete ? "" : "muted"}">+${fmtPts(w.pts)}</td></tr>`;
    }).join("");
    setView(`
      <p style="margin:0 0 12px"><a href="#/" class="small">← Standings</a></p>
      <div class="page-head"><div><h1>${esc(t.team_name)}</h1>
        <p>${esc(t.owner_name)} · ${t.valid ? `${ordinal(t.rank)} of ${teams.length}` : `<span class="neg">${esc(t.issues.join(", "))}</span>`} · ${money(t.cost)} spent</p></div></div>
      <div class="tiles">
        <div class="tile"><div class="label">League points</div><div class="value">${fmtPts(t.leaguePts)}</div><div class="sub">${t.w}-${t.l}${t.t ? `-${t.t}` : ""} all-play</div></div>
        <div class="tile"><div class="label">Fantasy points</div><div class="value">${fmt1(t.fp)}</div></div>
        <div class="tile"><div class="label">Best week</div><div class="value">${best ? ordinal(best.rank) : "—"}</div><div class="sub">${best ? `Week ${best.n} · ${fmt0(best.fp)} pts` : "No finished weeks"}</div></div>
        <div class="tile"><div class="label">MVP</div><div class="value">${fmt0(mvp.s.fp)}</div><div class="sub">${esc(mvp.p.name)}</div></div>
      </div>
      ${weekRows ? `<div class="card"><h2>Weekly results</h2><div class="table-wrap"><table>
        <thead><tr><th>Week</th><th class="hide-sm">Dates</th><th class="num">Fantasy pts</th><th class="num">Finish</th><th class="num">League pts</th></tr></thead>
        <tbody>${weekRows}</tbody></table></div></div>` : ""}
      <div class="card"><h2>Roster</h2><div class="table-wrap"><table>
        <thead><tr><th>Player</th><th class="num">Price</th><th class="num">GP</th><th class="num hide-sm">Last game</th><th class="num">Pts/G</th><th class="num hide-sm">Pts per $</th><th class="num">Points</th></tr></thead>
        <tbody>${rows.map(({ p, s }) => `<tr>
          <td>${playerCell(p)}</td><td class="num">${money(p.price)}</td><td class="num">${s.gp}</td>
          <td class="num hide-sm">${s.last === null ? "—" : fmt1(s.last)}</td>
          <td class="num">${s.gp ? fmt1(s.fp / s.gp) : "—"}</td>
          <td class="num hide-sm">${p.price ? fmt1(s.fp / p.price) : "—"}</td>
          <td class="num pts">${fmt1(s.fp)}</td></tr>`).join("")}</tbody></table></div></div>`);
  }

  // ---------- roster builder

  function renderJoin() {
    if (isLocked()) {
      setView(`<div class="page-head"><div><h1>Rosters are locked</h1><p>Signups closed ${esc(lockText())}.</p></div></div>
        <div class="card"><p>The season is underway. <a href="#/">See the standings →</a></p></div>`);
      return;
    }
    const draft = store.get(KEYS.draft, { ids: [], owner: "", team: "", email: "" });
    draft.ids = draft.ids.filter((id) => state.byId.has(id));
    const ui = { q: "", pos: "ALL", sort: "price-desc", affordable: false };
    const so = playerTotals(state.games);
    const hasSoFar = so.size > 0;
    const mine = store.get(KEYS.mine, null);

    setView(`
      <div class="page-head"><div><h1>Build your roster</h1>
        <p>Pick exactly ${L.rosterSize} players for ${money(L.budget)} or less. Locks ${esc(lockText())}.</p></div></div>
      ${supabaseNotice()}
      ${mine ? `<div class="notice" style="margin-bottom:12px">You already entered <strong>${esc(mine.team)}</strong> from this device. Submitting again creates a second team.</div>` : ""}
      <div class="builder" style="margin-top:12px">
        <section class="card">
          <div class="toolbar">
            <input class="search" id="q" type="search" placeholder="Search players or teams" autocomplete="off">
            <select id="sort" aria-label="Sort">
              <option value="price-desc">Price: high to low</option>
              <option value="price-asc">Price: low to high</option>
              <option value="proj">Projected pts/game</option>
              <option value="value">Projected pts per $</option>
              <option value="last">Last season pts/game</option>
              ${hasSoFar ? `<option value="sofar">This season pts/game</option>` : ""}
              <option value="name">Name</option>
            </select>
          </div>
          <div class="toolbar">
            <div class="chips" id="pos">${["ALL", "PG", "SG", "SF", "PF", "C"].map((p) => `<button type="button" class="chip ${p === "ALL" ? "on" : ""}" data-pos="${p}">${p === "ALL" ? "All" : p}</button>`).join("")}</div>
            <label class="check"><input type="checkbox" id="afford"> Only what I can afford</label>
          </div>
          <div class="table-wrap"><table class="pool">
            <thead><tr><th>Player</th><th class="num">Price</th><th class="num" title="ESPN projected fantasy points per game, with projected games played">Proj</th><th class="num hide-sm" title="Fantasy points per game last season (2025-26)">Last yr</th>${hasSoFar ? `<th class="num hide-sm" title="Fantasy points per game so far this season">So far</th>` : ""}<th></th></tr></thead>
            <tbody id="pool"></tbody></table></div>
        </section>
        <aside class="card roster-panel" id="panel" aria-label="Your roster">
          <div class="roster-head">
            <div class="budget-row"><div><div class="small muted">Left to spend</div><div class="big" id="left"></div></div>
              <div style="text-align:right"><div class="small muted">Players</div><div style="font-size:20px;font-weight:700" id="count"></div></div></div>
            <div class="meter"><div id="meter"></div></div>
            <div class="small muted" id="per-slot"></div>
            <div style="display:flex;gap:6px;margin-top:10px">
              <button class="btn small" type="button" id="autofill" title="Fill the open slots with random players that fit your budget">🎲 Auto-fill</button>
              <button class="btn small ghost" type="button" id="clear">Clear</button>
              <button class="btn small ghost show-sm" type="button" id="close-panel" style="margin-left:auto">Done</button>
            </div>
          </div>
          <ul class="plain roster-list" id="roster"></ul>
          <form class="roster-form" id="form" autocomplete="on">
            <div class="field"><label for="owner">Your name</label><input id="owner" name="name" maxlength="40" required></div>
            <div class="field"><label for="team">Team name</label><input id="team" maxlength="40" required></div>
            <div class="field"><label for="email">Email <span class="muted">(optional, only the commissioner sees it)</span></label><input id="email" name="email" type="email" maxlength="200"></div>
            <button class="btn primary" type="submit" id="submit">Lock in my team</button>
            <div class="form-msg" id="msg" role="status"></div>
          </form>
        </aside>
      </div>
      <div class="mobile-bar"><div><b id="m-left"></b> <span class="muted small">left</span> · <b id="m-count"></b></div>
        <button class="btn primary small" type="button" id="open-panel">Review roster</button></div>`);

    const els = {
      q: $("#q"), sort: $("#sort"), afford: $("#afford"), pool: $("#pool"), roster: $("#roster"),
      left: $("#left"), count: $("#count"), meter: $("#meter"), perSlot: $("#per-slot"), msg: $("#msg"),
      owner: $("#owner"), team: $("#team"), email: $("#email"), submit: $("#submit"), panel: $("#panel"),
      mLeft: $("#m-left"), mCount: $("#m-count"),
    };
    els.owner.value = draft.owner || "";
    els.team.value = draft.team || "";
    els.email.value = draft.email || "";

    const save = () => store.set(KEYS.draft, draft);
    const spent = () => draft.ids.reduce((s, id) => s + state.byId.get(id).price, 0);
    const maxPrice = () => {
      const open = L.rosterSize - draft.ids.length;
      return open <= 0 ? -1 : L.budget - spent() - state.floor * (open - 1);
    };
    const projSeason = (p) => (p.projFpg && p.projGp ? p.projFpg * p.projGp : 0);
    const soFar = (p) => { const t = so.get(p.id); return t && t.gp ? t.fp / t.gp : null; };

    function poolRows() {
      const q = ui.q.trim().toLowerCase();
      const picked = new Set(draft.ids);
      const cap = maxPrice();
      let list = state.players.filter((p) => (ui.pos === "ALL" || p.pos === ui.pos)
        && (!q || p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q)
        && (!ui.affordable || picked.has(p.id) || p.price <= cap));
      const by = {
        "price-desc": (a, b) => b.price - a.price || a.rank - b.rank,
        "price-asc": (a, b) => a.price - b.price || a.rank - b.rank,
        proj: (a, b) => (b.projFpg || 0) - (a.projFpg || 0),
        value: (a, b) => projSeason(b) / b.price - projSeason(a) / a.price,
        last: (a, b) => (b.lastFpg || 0) - (a.lastFpg || 0),
        sofar: (a, b) => (soFar(b) ?? -99) - (soFar(a) ?? -99),
        name: (a, b) => a.name.localeCompare(b.name),
      }[ui.sort];
      list = list.sort(by);
      return list.map((p) => {
        const isPicked = picked.has(p.id);
        const can = !isPicked && p.price <= cap;
        const sf = soFar(p);
        return `<tr class="${isPicked ? "picked" : ""}">
          <td>${playerCell(p, ` · #${p.rank}`)}</td>
          <td class="num"><strong>${money(p.price)}</strong></td>
          <td class="num">${p.projFpg ? fmt1(p.projFpg) : "—"}${p.projGp ? `<div class="small muted">${p.projGp} gp</div>` : ""}</td>
          <td class="num hide-sm">${p.lastFpg ? fmt1(p.lastFpg) : "—"}</td>
          ${hasSoFar ? `<td class="num hide-sm">${sf === null ? "—" : fmt1(sf)}</td>` : ""}
          <td class="num">${isPicked
            ? `<button class="btn small ghost add" data-remove="${p.id}">Remove</button>`
            : `<button class="btn small add" data-add="${p.id}" ${can ? "" : "disabled"} title="${can ? "Add to roster" : draft.ids.length >= L.rosterSize ? "Roster is full" : "Not enough budget left"}">Add</button>`}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="6" class="muted">No players match.</td></tr>`;
    }

    function renderRoster() {
      const left = L.budget - spent();
      const open = L.rosterSize - draft.ids.length;
      els.left.textContent = money(left);
      els.left.classList.toggle("over", left < 0);
      els.count.textContent = `${draft.ids.length}/${L.rosterSize}`;
      els.mLeft.textContent = money(left);
      els.mCount.textContent = `${draft.ids.length}/${L.rosterSize}`;
      els.meter.style.width = `${Math.min(100, (spent() / L.budget) * 100)}%`;
      els.perSlot.textContent = open > 0 ? `${money(left / open)} per open slot` : left >= 0 ? "Roster full. Name your team and lock it in." : "Over budget";
      const players = draft.ids.map((id) => state.byId.get(id)).sort((a, b) => b.price - a.price);
      els.roster.innerHTML = players.map((p) => `<li>${playerCell(p)}<span class="num" style="font-weight:650">${money(p.price)}</span>
        <button class="x" type="button" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join("")
        + (open > 0 ? `<li class="slot-empty">${open} open slot${open === 1 ? "" : "s"}</li>` : "");
      els.submit.disabled = !supabaseReady() || draft.ids.length !== L.rosterSize || left < 0;
    }

    function refresh() {
      els.pool.innerHTML = poolRows();
      renderRoster();
      save();
    }

    function add(id) {
      const p = state.byId.get(id);
      if (!p || draft.ids.includes(id) || p.price > maxPrice()) return;
      draft.ids.push(id);
      refresh();
    }
    function remove(id) {
      draft.ids = draft.ids.filter((x) => x !== id);
      refresh();
    }

    function autofill() {
      let guard = 0;
      while (draft.ids.length < L.rosterSize && guard++ < 500) {
        const open = L.rosterSize - draft.ids.length;
        const cap = maxPrice();
        const target = (L.budget - spent()) / open;
        const avail = state.players.filter((p) => !draft.ids.includes(p.id) && p.price <= cap);
        if (!avail.length) break;
        const near = avail.filter((p) => p.price >= target * 0.6 && p.price <= target * 1.4);
        const pick = (near.length ? near : avail)[Math.floor(Math.random() * (near.length ? near.length : avail.length))];
        draft.ids.push(pick.id);
      }
      refresh();
    }

    app.addEventListener("click", onClick);
    cleanup.push(() => app.removeEventListener("click", onClick));
    function onClick(ev) {
      const a = ev.target.closest("[data-add]");
      const r = ev.target.closest("[data-remove]");
      if (a) add(Number(a.dataset.add));
      else if (r) remove(Number(r.dataset.remove));
    }
    els.q.addEventListener("input", () => { ui.q = els.q.value; els.pool.innerHTML = poolRows(); });
    els.sort.addEventListener("change", () => { ui.sort = els.sort.value; els.pool.innerHTML = poolRows(); });
    els.afford.addEventListener("change", () => { ui.affordable = els.afford.checked; els.pool.innerHTML = poolRows(); });
    $("#pos").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-pos]");
      if (!b) return;
      ui.pos = b.dataset.pos;
      $("#pos").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b));
      els.pool.innerHTML = poolRows();
    });
    $("#autofill").addEventListener("click", autofill);
    $("#clear").addEventListener("click", () => { if (!draft.ids.length || confirm("Clear your whole roster?")) { draft.ids = []; refresh(); } });
    $("#open-panel").addEventListener("click", () => els.panel.classList.add("open"));
    $("#close-panel").addEventListener("click", () => els.panel.classList.remove("open"));
    for (const k of ["owner", "team", "email"]) els[k].addEventListener("input", () => { draft[k] = els[k].value; save(); });

    $("#form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      els.msg.className = "form-msg";
      const owner = els.owner.value.trim();
      const team = els.team.value.trim();
      const email = els.email.value.trim();
      const { cost, issues } = validateRoster(draft.ids);
      const err = (m) => { els.msg.className = "form-msg err"; els.msg.textContent = m; };
      if (issues.length) return err(`Roster problem: ${issues.join(", ")}.`);
      if (!owner || !team) return err("Add your name and a team name.");
      if (isLocked()) return err("Signups just closed.");
      if (!supabaseReady()) return err("Signups aren't connected yet.");
      els.submit.disabled = true;
      els.msg.textContent = "Submitting…";
      try {
        await sb("entries", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ owner_name: owner, team_name: team, email: email || null, players: draft.ids, total_cost: cost }),
        });
        store.set(KEYS.mine, { team, owner, players: [...draft.ids], at: new Date().toISOString() });
        store.set(KEYS.draft, { ids: [], owner, team: "", email });
        renderSubmitted(team, cost);
      } catch (e) {
        els.submit.disabled = false;
        if (e.code === "23505") err("That team name is taken. Pick another.");
        else if (e.code === "42501" || e.status === 401 || e.status === 403) err("Signups are closed.");
        else err(`Couldn't submit: ${e.message}`);
      }
    });

    refresh();
  }

  function renderSubmitted(team, cost) {
    setView(`<div class="card success-burst" style="max-width:560px;margin:24px auto">
      <div class="ball" aria-hidden="true"></div>
      <h1>You're locked in.</h1>
      <p class="ink2"><strong>${esc(team)}</strong> is entered at ${money(cost)}. Rosters stay hidden until ${esc(lockText())}, then the points start counting.</p>
      <p style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><a class="btn primary" href="#/">See who's in</a><a class="btn" href="#/rules">Read the rules</a></p>
    </div>`);
  }

  // ---------- players

  function renderPlayers() {
    const totals = playerTotals(statGames());
    const locked = isLocked();
    const owners = new Map();
    const rostered = state.entries.filter((e) => Array.isArray(e.players));
    for (const e of rostered) for (const id of e.players) owners.set(id, (owners.get(id) || 0) + 1);
    const hasStats = totals.size > 0;
    const ui = { q: "", pos: "ALL", owned: false, sort: hasStats ? "fp" : "rank", dir: hasStats ? -1 : 1 };

    const cols = [
      { k: "rank", label: "#", num: true, val: (p) => p.rank, cls: "hide-sm" },
      { k: "name", label: "Player", val: (p) => p.name },
      { k: "price", label: "Price", num: true, val: (p) => p.price },
      { k: "gp", label: "GP", num: true, val: (p) => totals.get(p.id)?.gp || 0, cls: "hide-sm" },
      { k: "fpg", label: "Pts/G", num: true, val: (p) => { const t = totals.get(p.id); return t && t.gp ? t.fp / t.gp : 0; } },
      { k: "value", label: "Pts per $", num: true, val: (p) => (totals.get(p.id)?.fp || 0) / p.price, cls: "hide-sm" },
      ...(rostered.length ? [{ k: "owned", label: "Owned", num: true, val: (p) => owners.get(p.id) || 0, cls: "hide-sm" }] : []),
      { k: "fp", label: "Points", num: true, val: (p) => totals.get(p.id)?.fp || 0 },
    ];

    setView(`
      <div class="page-head"><div><h1>Players</h1>
        <p>${locked ? "Fantasy points since the lock." : hasStats ? "Fantasy points so far this season (before the lock, so they don't count yet)." : "Prices for every player in the pool. Points show up once games start."}</p></div></div>
      <div class="card">
        <div class="toolbar">
          <input class="search" id="q" type="search" placeholder="Search players or teams" autocomplete="off">
          <div class="chips" id="pos">${["ALL", "PG", "SG", "SF", "PF", "C"].map((p) => `<button type="button" class="chip ${p === "ALL" ? "on" : ""}" data-pos="${p}">${p === "ALL" ? "All" : p}</button>`).join("")}</div>
          ${rostered.length ? `<label class="check"><input type="checkbox" id="owned"> Rostered only</label>` : ""}
        </div>
        <div class="table-wrap"><table>
          <thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table></div>
      </div>`);

    const head = $("#head");
    const body = $("#rows");
    function draw() {
      head.innerHTML = cols.map((c) => `<th class="sortable ${c.num ? "num" : ""} ${c.cls || ""} ${ui.sort === c.k ? "sorted" : ""}" data-k="${c.k}">${c.label}${ui.sort === c.k ? (ui.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("");
      const q = ui.q.trim().toLowerCase();
      const col = cols.find((c) => c.k === ui.sort);
      const list = state.players
        .filter((p) => (ui.pos === "ALL" || p.pos === ui.pos) && (!q || p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q) && (!ui.owned || owners.has(p.id)))
        .sort((a, b) => {
          const va = col.val(a); const vb = col.val(b);
          return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * ui.dir || a.rank - b.rank;
        });
      body.innerHTML = list.map((p) => {
        const t = totals.get(p.id);
        return `<tr><td class="num muted hide-sm">${p.rank}</td><td>${playerCell(p)}</td><td class="num">${money(p.price)}</td>
          <td class="num hide-sm">${t?.gp || 0}</td><td class="num">${t && t.gp ? fmt1(t.fp / t.gp) : "—"}</td>
          <td class="num hide-sm">${t ? fmt1(t.fp / p.price) : "—"}</td>
          ${rostered.length ? `<td class="num hide-sm">${owners.get(p.id) ? `${owners.get(p.id)}/${rostered.length}` : "—"}</td>` : ""}
          <td class="num pts">${t ? fmt1(t.fp) : "—"}</td></tr>`;
      }).join("") || `<tr><td colspan="${cols.length}" class="muted">No players match.</td></tr>`;
    }
    head.addEventListener("click", (ev) => {
      const th = ev.target.closest("[data-k]");
      if (!th) return;
      if (ui.sort === th.dataset.k) ui.dir *= -1;
      else { ui.sort = th.dataset.k; ui.dir = ["rank", "name"].includes(ui.sort) ? 1 : -1; }
      draw();
    });
    $("#q").addEventListener("input", (e) => { ui.q = e.target.value; draw(); });
    $("#pos").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-pos]");
      if (!b) return;
      ui.pos = b.dataset.pos;
      $("#pos").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b));
      draw();
    });
    $("#owned")?.addEventListener("change", (e) => { ui.owned = e.target.checked; draw(); });
    draw();
  }

  // ---------- rules

  function renderRules() {
    const sign = (v) => `<span class="${v < 0 ? "neg" : "pos"}">${v > 0 ? "+" : ""}${v}</span>`;
    const scoring = [
      ["Point", S.pts], ["Offensive rebound", S.oreb], ["Defensive rebound", S.dreb], ["Assist", S.ast], ["Steal", S.stl], ["Block", S.blk],
      ["Turnover", S.tov], ["3-pointer made (bonus, on top of the points)", S.fg3m],
      ["Double-double (10+ in two of pts / reb / ast / stl / blk)", S.doubleDouble],
      ["Triple-double (replaces the double-double bonus)", S.tripleDouble],
      ["Technical foul", S.tech], ["Flagrant foul", S.flagrant], ["Ejection", S.ejection], ["Fouling out (6 fouls)", S.foulOut],
    ];
    const prices = state.players.map((p) => p.price);
    const tier = (a, b) => `${money(Math.min(...prices.slice(a - 1, b)))}–${money(Math.max(...prices.slice(a - 1, b)))}`;
    setView(`
      <div class="page-head"><div><h1>Rules</h1><p>Set it and forget it. Then trash-talk all season.</p></div></div>
      <div class="grid-2">
        <div class="card">
          <h2>Scoring</h2>
          <table class="rules-table"><tbody>${scoring.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${sign(v)}</td></tr>`).join("")}</tbody></table>
          <p class="small muted" style="margin-bottom:0">Example: 25 pts, 10 reb (3 offensive), 5 ast, 2 stl, 1 blk, 3 turnovers and 3 threes (a double-double) = <strong>${fmt1(fantasyPoints([0, 34, 25, 10, 5, 2, 1, 3, 3, 9, 18, 4, 5, 2, 0, 0, 0, 3, 7]))}</strong> fantasy points.</p>
        </div>
        <div class="stack">
          <div class="card prose">
            <h2>The deal</h2>
            <ul>
              <li>Pick exactly <strong>${L.rosterSize} players</strong> spending <strong>${money(L.budget)}</strong> or less.</li>
              <li>Rosters lock <strong>${esc(lockText())}</strong>. After that they never change.</li>
              <li>Only games that tip off after the lock count, so everyone starts at zero together.</li>
              <li>All ${L.rosterSize} players count every game. No lineups, no bench.</li>
              <li><strong>Every week is all-against-all.</strong> Teams are ranked by the fantasy points their players scored that week (Monday–Sunday, Eastern). ${Array.isArray(L.weeklyPoints) ? `League points by finish: ${L.weeklyPoints.map((v, i) => `${ordinal(i + 1)} ${v}`).join(", ")}.` : "You earn 1 league point for every team you outscore, so 1st of 10 gets 9 and last gets 0."} Ties split the points.</li>
              <li>The first week runs from the lock through ${esc(shortDate(buildWeeks(addDays(etDate(LOCK), 13))[0].end))}.</li>
              <li>Standings are league points added up over every finished week. Tiebreaker: total fantasy points. Regular season only.</li>
              <li>Injuries, trades and DNPs are part of the game. A traded player keeps scoring for you on his new team.</li>
              <li>Rosters stay hidden until the lock so nobody can copy.</li>
            </ul>
          </div>
          <div class="card prose">
            <h2>Where the prices come from</h2>
            <p>Each player's price comes from a consensus of eight preseason fantasy rankings: ESPN points-league ranks, ESPN category ranks, ESPN and Yahoo average draft position, FantasyPros expert consensus, CBS Sports, Hashtag Basketball and Basketball Monster. We average each player's ranks (dropping his best and worst) to get a consensus order.</p>
            <p>Price follows the production you'd expect from that slot in the rankings, so stars-and-scrubs and a balanced roster cost about the same for the same expected points. You win by spotting who beats his price.</p>
            <p class="small">Top 10: ${tier(1, 10)} · 11–50: ${tier(11, 50)} · 51–150: ${tier(51, 150)} · 151–300: ${tier(151, 300)} · deeper: ${money(state.floor)}</p>
          </div>
          <div class="card prose">
            <h2>Stats</h2>
            <p>Box scores come from ESPN and update every morning (about 5am ET), with a second pass midday for stat corrections. Last update: ${esc(ago(state.updated))}.</p>
          </div>
        </div>
      </div>`);
  }

  // ------------------------------------------------------------------ shell

  function updatePill() {
    const pill = $("#lock-pill");
    if (isLocked()) {
      pill.classList.add("locked");
      const days = new Set(scoringGames().map((g) => g.date)).size;
      const wk = buildWeeks(etDate(Date.now())).length;
      pill.lastElementChild.textContent = days && wk ? `Locked · week ${wk}` : "Rosters locked";
    } else {
      pill.classList.remove("locked");
      const t = untilParts(LOCK - Date.now());
      pill.lastElementChild.textContent = `Signups open · ${t.d ? `${t.d}d ${t.h}h` : t.h ? `${t.h}h ${t.m}m` : `${t.m}m`} left`;
    }
  }

  function route() {
    const [, name = "", arg] = location.hash.replace(/^#/, "").split("/");
    const views = { "": renderStandings, join: renderJoin, players: renderPlayers, rules: renderRules, team: renderTeam };
    const view = views[name] || renderStandings;
    const active = name === "team" ? "standings" : name || "standings";
    document.querySelectorAll("nav.tabs a").forEach((a) => a.classList.toggle("active", a.dataset.route === active));
    view(arg);
    updatePill();
  }

  async function start() {
    document.title = `${L.name} Fantasy`;
    $("#league-name").textContent = L.name;
    try {
      await load();
    } catch (e) {
      app.innerHTML = `<div class="notice">Couldn't load league data: ${esc(e.message)}</div>`;
      return;
    }
    $("#footer").innerHTML = `${esc(L.name)} · ${esc(L.season)} season · stats via ESPN, updated ${esc(ago(state.updated))}`;
    window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
    route();
    setInterval(updatePill, 30000);
  }

  start();
})();
