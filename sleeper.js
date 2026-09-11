/**
 * sleeper.js — Sleeper fantasy matchup module for the projector scoreboard
 * Renders Carson's live fantasy matchup: his starting lineup vs his opponent's, with per-player
 * points that update as the real NFL games run, a projection-based WIN %, and projected totals.
 *
 * Usage:  mountFantasy(container, { leagueId, userId, onEmpty, onError })
 *         stopFantasy()
 *
 * Sleeper API (all public, no key, CORS-open):
 *   /v1/state/nfl                                    -> { week, display_week }
 *   /v1/league/{lid}                                 -> { name, roster_positions }
 *   /v1/league/{lid}/rosters                         -> [{ roster_id, owner_id, starters, settings }]
 *   /v1/league/{lid}/users                           -> [{ user_id, display_name, metadata:{team_name} }]
 *   /v1/league/{lid}/matchups/{week}                 -> [{ roster_id, matchup_id, points, starters, starters_points }]
 *   /v1/players/nfl                                  -> { pid: {full_name, position, team} }  (~5MB, cached)
 *   api.sleeper.com/projections/nfl/{yr}/{wk}?...    -> [{ player_id, stats:{pts_ppr} }]      (weekly projections)
 *
 * Security: all Sleeper strings assigned via textContent only, never innerHTML.
 */
(function (root) {
  "use strict";

  const S = "https://api.sleeper.app/v1";
  const PROJ = "https://api.sleeper.com/projections/nfl";
  const P = {
    bg: "#08090b", header: "#13181f", border: "#1e242c",
    text: "#ffffff", dim: "#8a94a3", gold: "#FFE84D",
    win: "#3ddc84", lose: "#8a94a3", live: "#FF6A00", red: "#ff4b4b", track: "#232a33",
    posColors: { QB: "#e0517d", RB: "#3fbf9f", WR: "#4aa8ff", TE: "#f0a83c", K: "#b07cff", DEF: "#8a94a3", FLX: "#FF6A00", SFX: "#FF6A00" },
  };
  const SIGMA = 27;   // std dev of a fantasy matchup margin — for the win-probability curve

  let _active = false, _container = null, _timer = null;
  let _players = null, _proj = null, _stats = null, _ctx = null, _gameState = null;
  let _celebrating = false, _lastM = null;                    // scoreboard <-> celebration coordination
  let _seenPlays = {}, _tdBaseline = false, _lastGameScore = {}, _tdTimer = null, _myOff = [];   // ESPN live-scoring watch

  // Sleeper team abbreviations that differ from ESPN's (used for logos + game-state lookup)
  const _ESPN_ABBR = { WAS: "wsh", LAR: "lar", LAC: "lac", LV: "lv", JAX: "jax" };
  function _espnAbbr(team) { return (_ESPN_ABBR[team] || (team || "")).toLowerCase(); }

  function _el(tag, css) { const e = document.createElement(tag); if (css) e.style.cssText = css; return e; }
  async function _json(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error("Sleeper HTTP " + r.status); return r.json(); }

  async function _fetchPlayers() {
    if (_players) return _players;
    const raw = await _json(S + "/players/nfl");
    const slim = {};
    for (const id in raw) { const p = raw[id] || {}; slim[id] = { name: p.full_name || (p.last_name || id), pos: p.position || "", team: p.team || "" }; }
    _players = slim; return slim;
  }
  async function _fetchProjections(week) {
    try {
      const list = await _json(PROJ + "/2026/" + week + "?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF");
      const m = {};
      (list || []).forEach(function (x) { if (x && x.player_id) m[x.player_id] = (x.stats && x.stats.pts_ppr) || 0; });
      _proj = m;
    } catch (_) { _proj = {}; }
    return _proj;
  }

  // Live per-player stat lines (yards/TDs/etc.) — refreshed alongside the matchup scores.
  async function _fetchStats(week) {
    try {
      const list = await _json("https://api.sleeper.com/stats/nfl/2026/" + week + "?season_type=regular&_=" + Date.now());
      const m = {}; (list || []).forEach(function (x) { if (x && x.player_id) m[x.player_id] = x.stats || {}; });
      _stats = m;
    } catch (_) { if (!_stats) _stats = {}; }
    return _stats;
  }
  // Live NFL game state per team, from the ESPN scoreboard (state, quarter, clock, score, opponent,
  // possession, red zone). Keyed by ESPN abbreviation (lowercase).
  async function _fetchGameState() {
    try {
      const d = await _json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?_=" + Date.now());
      const old = _gameState || {};
      const m = {};
      (d.events || []).forEach(function (e) {
        const comp = (e.competitions || [])[0] || {};
        const st = (comp.status || e.status || {}).type || {};
        const state = st.state || "";                       // pre | in | post
        const period = (comp.status || e.status || {}).period || 0;
        const clock = (comp.status || e.status || {}).displayClock || "";
        const sit = comp.situation || {};
        const possId = sit.possession != null ? String(sit.possession) : "";
        const cs = comp.competitors || [];
        cs.forEach(function (c) {
          const t = c.team || {};
          const abbr = (t.abbreviation || "").toLowerCase();
          const other = cs.find(function (o) { return o !== c; }) || {};
          const ot = other.team || {};
          let hasPoss = possId !== "" && String(t.id) === possId;
          let isRZ = !!sit.isRedZone;
          // ESPN blanks possession/red zone between plays, timeouts, reviews — hold the last known
          // state so the on-field / red-zone row tint doesn't flicker off
          if (state === "in" && possId === "" && old[abbr]) { hasPoss = old[abbr].hasPoss; if (sit.isRedZone == null) isRZ = old[abbr].isRZ; }
          m[abbr] = {
            state: state, period: period, clock: clock, date: e.date || "",
            score: parseInt(c.score || 0, 10), oppScore: parseInt(other.score || 0, 10),
            oppAbbr: (ot.abbreviation || "").toUpperCase(), home: c.homeAway === "home",
            hasPoss: hasPoss, isRZ: isRZ,
          };
        });
      });
      _gameState = m;
    } catch (_) { if (!_gameState) _gameState = {}; }
    return _gameState;
  }
  const _DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  function _kick(iso) {
    if (!iso) return "";
    const d = new Date(iso); if (isNaN(d)) return "";
    let h = d.getHours(); const ap = h >= 12 ? "P" : "A"; h = h % 12 || 12;
    const m = d.getMinutes(); const mm = m < 10 ? "0" + m : "" + m;
    return _DOW[d.getDay()] + " " + h + ":" + mm + ap;
  }
  // Per-player game context: unit on the field / in the red zone, and a status chip coloured by state —
  // green while live, yellow for an upcoming (not yet played) game, white when final.
  function _liveFor(team, pos) {
    const gs = _gameState && _gameState[_espnAbbr(team)];
    if (!gs) return null;
    const live = gs.state === "in", pre = gs.state === "pre", post = gs.state === "post";
    const isDef = pos === "DEF";
    const unitUp = isDef ? !gs.hasPoss : gs.hasPoss;         // offense up when we have the ball; DST up when we don't
    const vs = (gs.home ? "vs " : "@ ") + gs.oppAbbr;
    let chip = "", color = P.dim;
    if (live) { chip = "Q" + gs.period + " " + gs.clock + " · " + gs.score + "-" + gs.oppScore + " " + vs; color = P.win; }
    else if (pre) { chip = _kick(gs.date) + " " + vs; color = P.gold; }
    else if (post) { chip = "FINAL " + gs.score + "-" + gs.oppScore + " " + vs; color = P.text; }
    return { live: live, onField: live && unitUp, redZone: live && unitUp && gs.isRZ, chip: chip, color: color };
  }
  function _statLine(pid, pos) {
    const s = _stats && _stats[pid];
    if (!s) return "";
    const r = Math.round, p = [];
    // "3-28 REC" = 3 catches for 28 yards, combined into one token to free room for both yard types
    const rec = function () { return s.rec ? (r(s.rec) + "-" + r(s.rec_yd || 0) + " REC") : (s.rec_yd ? r(s.rec_yd) + " REC" : ""); };
    if (pos === "QB") {
      // only QB distinguishes rush from pass: RTD = rushing TD (6), RYD = rushing yards
      if (s.pass_yd) p.push(r(s.pass_yd) + " YD");
      if (s.pass_td) p.push(r(s.pass_td) + " TD");
      if (s.rush_td) p.push(r(s.rush_td) + " RTD");
      else if (s.rush_yd >= 12) p.push(r(s.rush_yd) + " RYD");
      if (s.pass_int) p.push(r(s.pass_int) + " INT");
    } else if (pos === "RB") {
      if (s.rush_yd != null) p.push(r(s.rush_yd || 0) + " YDS");   // rush yards
      const rc = rec(); if (rc) p.push(rc);                        // rec catches + yards
      const td = (s.rush_td || 0) + (s.rec_td || 0); if (td) p.push(td + " TD");   // all TDs are the same
    } else if (pos === "WR" || pos === "TE") {
      const rc = rec(); if (rc) p.push(rc);
      const td = (s.rec_td || 0) + (s.rush_td || 0); if (td) p.push(td + " TD");
      if (s.rush_yd >= 20) p.push(r(s.rush_yd) + " YDS");
    } else if (pos === "K") { if (s.fgm != null && s.fga != null) p.push(r(s.fgm) + "/" + r(s.fga) + " FG"); if (s.xpm) p.push(r(s.xpm) + " XP"); }
    else if (pos === "DEF") { if (s.sack) p.push(r(s.sack) + " SK"); if (s.int) p.push(r(s.int) + " INT"); if (s.fum_rec) p.push(r(s.fum_rec) + " FR"); if (s.def_td) p.push(r(s.def_td) + " TD"); if (s.pts_allow != null) p.push(r(s.pts_allow) + " PA"); }
    return p.slice(0, 3).join(" · ");
  }
  function _resolve(pid) {
    if (!pid || pid === "0") return { name: "Empty", team: "", pos: "" };
    if (/^[A-Z]{2,3}$/.test(pid)) return { name: pid + " D/ST", team: pid, pos: "DEF" };
    const p = _players && _players[pid];
    return p ? { name: p.name, team: p.team, pos: p.pos } : { name: pid, team: "", pos: "" };
  }
  // "Bijan Robinson" -> "B. Robinson"; leaves D/ST and single-word names alone
  function _shortName(name, pos) {
    if (!name || pos === "DEF" || /D\/ST/.test(name)) return name;
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) return name;
    return parts[0].charAt(0) + ". " + parts.slice(1).join(" ");
  }

  // team's projected final = sum of each starter's projected finish.
  // per-player finish = max(points banked so far, pre-game projection): a player who already beat
  // his projection is credited his actual; a player yet to play is carried at his projection. This
  // converges to the real final as games complete and is far more accurate live than a team-level max.
  function _projTotal(m) {
    const st = (m && m.starters) || [], sp = (m && m.starters_points) || [];
    let total = 0;
    st.forEach(function (pid, i) {
      let proj = _proj && _proj[pid];
      if (proj == null) proj = /^[A-Z]{2,3}$/.test(pid) ? 7 : 0;   // DEF default when missing from projections
      total += Math.max(sp[i] || 0, proj);
    });
    return total;
  }
  function _erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function _winPct(effMe, effOpp) { const z = (effMe - effOpp) / SIGMA; return Math.max(1, Math.min(99, Math.round(0.5 * (1 + _erf(z / Math.SQRT2)) * 100))); }

  // ── Rendering ──────────────────────────────────────────────────────────────

  // far-corner unit: big record with the team name in a fixed-width slot on the inside (ellipsis if long)
  function _cornerEl(rec, name, right) {
    const w = _el("div", "display:flex;align-items:baseline;gap:0.9vw;flex-shrink:0;min-width:0;" + (right ? "flex-direction:row-reverse;" : ""));
    const r = _el("div", "font-family:'Oswald',sans-serif;font-size:4.4vh;font-weight:700;letter-spacing:0.02em;color:" + P.text + ";white-space:nowrap;flex-shrink:0;font-variant-numeric:tabular-nums;");
    r.textContent = rec || "0-0"; w.appendChild(r);
    const n = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.6vh;font-weight:600;text-transform:uppercase;letter-spacing:0.02em;color:" + P.dim + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:21vw;" + (right ? "text-align:right;" : ""));
    n.textContent = name || ""; w.appendChild(n);
    return w;
  }
  // big centred team total (above its score column); right=true → left-align for the opponent side
  function _totalEl(v, right) {
    const e = _el("div", "font-family:'Oswald',sans-serif;font-size:5.4vh;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:" + P.text + ";flex-shrink:0;min-width:6vw;text-align:" + (right ? "left" : "right") + ";");
    e.textContent = (v || 0).toFixed(1); return e;
  }

  // teams whose logos are near-black and vanish on the dark board — give them a thin white outline stroke
  const DARK_LOGOS = { LAR: 1, BAL: 1, WAS: 1, JAX: 1, TB: 1, NYG: 1 };
  function _logo(team) {
    if (!team) return _el("div", "width:3.6vh;height:3.6vh;flex-shrink:0;");
    const wrap = _el("div", "width:3.6vh;height:3.6vh;flex-shrink:0;display:flex;align-items:center;justify-content:center;");
    const img = document.createElement("img");
    img.src = "https://a.espncdn.com/i/teamlogos/nfl/500/" + _espnAbbr(team) + ".png";
    img.alt = "";
    const stroke = DARK_LOGOS[team] ? "filter:drop-shadow(0.9px 0 0 #fff) drop-shadow(-0.9px 0 0 #fff) drop-shadow(0 0.9px 0 #fff) drop-shadow(0 -0.9px 0 #fff);" : "";
    img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;" + stroke;
    img.onerror = function () { wrap.style.visibility = "hidden"; };
    wrap.appendChild(img); return wrap;
  }

  // single line: [POS][logo] B. Name  (Q4 2:59 @SEA) ……… (stat) SCORE — score pinned to the inner edge;
  // row tints light red in the red zone, light blue when the player's unit is on the field.
  function _row(slot, pid, pts, right) {
    const pl = _resolve(pid);
    const posLabel = slot || pl.pos || "";
    const live = _liveFor(pl.team, pl.pos || posLabel);
    const bg = live && live.redZone ? "background:rgba(255,64,64,0.42);box-shadow:inset 0 0 2vh rgba(255,64,64,0.35);"
             : live && live.onField ? "background:rgba(74,150,255,0.34);box-shadow:inset 0 0 2vh rgba(74,150,255,0.22);" : "";
    const r = _el("div", "display:flex;align-items:center;line-height:1;gap:0.6vw;flex:1 1 0;min-height:0;min-width:0;padding:0 0.3vw;border-bottom:1px solid " + P.border + ";" + bg + (right ? "flex-direction:row-reverse;" : ""));
    const chip = _el("div", "font-family:'Oswald',sans-serif;font-size:2.6vh;font-weight:700;flex-shrink:0;width:3.4vw;text-align:center;color:#0b0d10;background:" + (P.posColors[posLabel] || P.posColors.FLX) + ";border-radius:0.4vh;padding:0.2vh 0;");
    chip.textContent = posLabel; r.appendChild(chip);
    r.appendChild(_logo(pl.team));
    const nm = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.8vh;font-weight:700;color:" + P.text + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;letter-spacing:0.01em;flex-shrink:1;");
    nm.textContent = _shortName(pl.name, pl.pos || posLabel); r.appendChild(nm);
    if (live && live.chip) {
      const gc = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.4vh;font-weight:700;flex-shrink:0;white-space:nowrap;color:" + live.color + ";");
      gc.textContent = live.chip; r.appendChild(gc);
    }
    r.appendChild(_el("div", "flex:1 1 auto;min-width:0;"));   // spacer → pushes stat+score to the inner edge
    const stat = _statLine(pid, pl.pos || posLabel);
    if (stat) { const sl = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.4vh;font-weight:600;color:" + P.dim + ";flex-shrink:0;white-space:nowrap;"); sl.textContent = stat; r.appendChild(sl); }
    const pt = _el("div", "font-family:'Oswald',sans-serif;font-size:3.4vh;font-weight:700;flex-shrink:0;min-width:4.6vw;font-variant-numeric:tabular-nums;color:" + (pts > 0 ? P.win : P.dim) + ";text-align:" + (right ? "left" : "right") + ";");
    pt.textContent = (pts != null ? pts : 0).toFixed(1); r.appendChild(pt);
    return r;
  }

  function _render(myM, oppM) {
    const c = _container; c.replaceChildren();
    c.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;background:" + P.bg + ";overflow:hidden;box-sizing:border-box;";
    const myTot = (myM && myM.points) || 0, oppTot = (oppM && oppM.points) || 0;

    // scoreboard band: record + team name in each far corner, both team totals centred at the top
    // (above the player-score columns), no win% / meter
    const band = _el("div", "display:flex;align-items:center;padding:0.6vh 2.4vw;background:" + P.header + ";border-bottom:1px solid " + P.border + ";flex-shrink:0;");
    band.appendChild(_cornerEl(_ctx.record(myM.roster_id), _ctx.teamName(myM.roster_id), false));
    band.appendChild(_el("div", "flex:1 1 0;min-width:0;"));
    band.appendChild(_totalEl(myTot, false));
    band.appendChild(_el("div", "width:1.2vw;flex-shrink:0;"));
    band.appendChild(_totalEl(oppTot, true));
    band.appendChild(_el("div", "flex:1 1 0;min-width:0;"));
    band.appendChild(_cornerEl(oppM ? _ctx.record(oppM.roster_id) : "0-0", oppM ? _ctx.teamName(oppM.roster_id) : "No opponent", true));
    c.appendChild(band);

    // body: two full-width lineups, scores pinned to the shared centre divider
    const body = _el("div", "flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr);min-height:0;");
    const slots = _ctx.rosterPos || [];
    function col(m, right) {
      const cl = _el("div", "display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;" + (right ? "border-left:2px solid " + P.border + ";" : ""));
      const st = (m && m.starters) || [], pts = (m && m.starters_points) || [];
      st.forEach(function (pid, i) { cl.appendChild(_row(slots[i] || "", pid, pts[i], right)); });
      return cl;
    }
    body.appendChild(col(myM, false));
    body.appendChild(col(oppM, true));
    c.appendChild(body);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async function mountFantasy(container, opts) {
    opts = opts || {};
    stopFantasy(); _active = true; _container = container;
    const lid = opts.leagueId, uid = opts.userId;
    container.replaceChildren();
    container.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:" + P.bg + ";";
    const loading = _el("div", "font-family:'Oswald',sans-serif;font-size:3vh;font-weight:700;color:" + P.dim + ";letter-spacing:0.14em;text-transform:uppercase;");
    loading.textContent = "LOADING FANTASY…"; container.appendChild(loading);
    try {
      const [state, league, rosters, users] = await Promise.all([
        _json(S + "/state/nfl"), _json(S + "/league/" + lid),
        _json(S + "/league/" + lid + "/rosters"), _json(S + "/league/" + lid + "/users"),
      ]);
      const week = opts.week || state.display_week || state.week || 1;
      await Promise.all([_fetchPlayers(), _fetchProjections(week), _fetchStats(week), _fetchGameState()]);
      if (!_active) return;
      const rosterPos = (league.roster_positions || []).filter(function (p) { return p !== "BN" && p !== "IR" && p !== "TAXI"; })
        .map(function (p) { return (p === "SUPER_FLEX") ? "SFX" : (p === "REC_FLEX" || p === "WRRB_FLEX" || p === "FLEX") ? "FLX" : p; });
      const myR = rosters.find(function (r) { return String(r.owner_id) === String(uid); });
      if (!myR) { _active = false; if (opts.onError) opts.onError(new Error("roster not found")); return; }
      const userById = {}; users.forEach(function (u) { userById[u.user_id] = u; });
      const rosterById = {}; rosters.forEach(function (r) { rosterById[r.roster_id] = r; });
      const teamName = function (rid) { const r = rosterById[rid]; const u = r && userById[r.owner_id]; return (u && u.metadata && u.metadata.team_name) || (u && u.display_name) || ("Team " + rid); };
      const record = function (rid) { const s = (rosterById[rid] || {}).settings || {}; return (s.wins || 0) + "-" + (s.losses || 0) + (s.ties ? "-" + s.ties : ""); };
      _ctx = { week: week, rosterPos: rosterPos, myRid: myR.roster_id, teamName: teamName, record: record };
      // my offensive/kicker starters (name+team+pos) for matching ESPN scoring plays
      _myOff = ((myR.starters) || []).filter(function (pid) { return pid && pid !== "0" && !/^[A-Z]{2,3}$/.test(pid); })
        .map(function (pid) { const p = _resolve(pid); return { pid: pid, name: p.name, team: p.team, pos: p.pos }; });
      _seenPlays = {}; _tdBaseline = false; _lastGameScore = {};
      _tdTimer = setInterval(_watchTDs, 10000);   // quick, accurate live TD/FG watch off ESPN
      _watchTDs();                                 // establish the baseline of already-scored plays
      async function refresh() {
        if (!_active) return;
        try {
          const [ms] = await Promise.all([ _json(S + "/league/" + lid + "/matchups/" + _ctx.week + "?_=" + Date.now()), _fetchStats(_ctx.week), _fetchGameState() ]);
          if (!_active) return;
          const myM = ms.find(function (m) { return m.roster_id === _ctx.myRid; });
          const oppM = myM ? ms.find(function (m) { return m.matchup_id === myM.matchup_id && m.roster_id !== _ctx.myRid; }) : null;
          if (!myM) { if (opts.onEmpty) opts.onEmpty(); return; }
          _lastM = [myM, oppM];
          if (_celebrating) return;           // a live TD takeover is up — don't wipe it with a re-render
          _render(myM, oppM);
        } catch (_) { /* keep the last render on a transient error */ }
      }
      await refresh();
      _timer = setInterval(refresh, 20000);   // 20s: keep the projector close to Sleeper for live scoring
    } catch (err) { _active = false; if (opts.onError) opts.onError(err); }
  }

  function stopFantasy() { _active = false; _celebrating = false; _lastM = null; _myOff = []; _seenPlays = {}; _tdBaseline = false; _lastGameScore = {}; if (_timer) { clearInterval(_timer); _timer = null; } if (_tdTimer) { clearInterval(_tdTimer); _tdTimer = null; } _container = null; }

  // ── TD-celebration preview: loop through the user's starters with real headshots + team colours ──
  // [primary, secondary, tertiary] — primary is the bg, secondary the accent, all three feed the side stripe
  const NFL_COLORS = {
    ARI: ["#97233F", "#000000", "#FFB612"], ATL: ["#A71930", "#000000", "#A5ACAF"], BAL: ["#241773", "#000000", "#9E7C0C"], BUF: ["#00338D", "#C60C30", "#FFFFFF"],
    CAR: ["#0085CA", "#101820", "#BFC0BF"], CHI: ["#0B162A", "#C83803", "#FFFFFF"], CIN: ["#FB4F14", "#000000", "#FFFFFF"], CLE: ["#311D00", "#FF3C00", "#FFFFFF"],
    DAL: ["#003594", "#869397", "#041E42"], DEN: ["#FB4F14", "#002244", "#FFFFFF"], DET: ["#0076B6", "#B0B7BC", "#000000"], GB: ["#203731", "#FFB612", "#FFFFFF"],
    HOU: ["#03202F", "#A71930", "#FFFFFF"], IND: ["#002C5F", "#A2AAAD", "#FFFFFF"], JAX: ["#006778", "#D7A22A", "#101820"], KC: ["#E31837", "#FFB81C", "#FFFFFF"],
    LV: ["#101820", "#A5ACAF", "#FFFFFF"], LAC: ["#0080C6", "#FFC20E", "#002A5E"], LAR: ["#003594", "#FFA300", "#FFFFFF"], MIA: ["#008E97", "#FC4C02", "#005778"],
    MIN: ["#4F2683", "#FFC62F", "#FFFFFF"], NE: ["#002244", "#C60C30", "#B0B7BC"], NO: ["#101820", "#D3BC8D", "#FFFFFF"], NYG: ["#0B2265", "#A71930", "#FFFFFF"],
    NYJ: ["#125740", "#000000", "#FFFFFF"], PHI: ["#004C54", "#A5ACAF", "#000000"], PIT: ["#101820", "#FFB612", "#C60C30"], SF: ["#AA0000", "#B3995D", "#FFFFFF"],
    SEA: ["#002244", "#69BE28", "#A5ACAF"], TB: ["#D50A0A", "#34302B", "#FF7900"], TEN: ["#0C2340", "#4B92DB", "#C8102E"], WAS: ["#5A1414", "#FFB612", "#FFFFFF"],
  };
  // opaque [width,height] fraction of each 500x500 ESPN logo canvas (measured) — lets the celebration
  // crop the transparent padding so every team logo renders at the same visible height
  const LOGO_BOX = {
    ARI: [0.922, 0.872], ATL: [0.92, 0.872], BAL: [0.922, 0.444], BUF: [0.922, 0.616], CAR: [0.924, 0.496],
    CHI: [0.92, 0.904], CIN: [0.92, 0.648], CLE: [0.92, 0.712], DAL: [0.92, 0.872], DEN: [0.92, 0.548],
    DET: [0.922, 0.7], GB: [0.922, 0.6], HOU: [0.922, 0.836], IND: [0.872, 0.924], JAX: [0.924, 0.684],
    KC: [0.922, 0.6], LV: [0.88, 0.932], LAC: [0.924, 0.412], LAR: [0.92, 0.666], MIA: [0.924, 0.736],
    MIN: [0.732, 0.908], NE: [0.924, 0.444], NO: [0.752, 0.92], NYG: [0.92, 0.716], NYJ: [0.92, 0.29],
    PHI: [0.922, 0.632], PIT: [0.924, 0.924], SF: [0.924, 0.548], SEA: [0.924, 0.412], TB: [0.924, 0.82],
    TEN: [0.92, 0.92], WAS: [0.924, 0.512],
  };
  const _DIST = [4, 9, 15, 22, 31, 44, 55, 7, 18, 63];
  const _FGD = [45, 52, 38, 29, 47, 33, 55];
  function _tdType(pos) { return pos === "QB" ? "PASS TD" : (pos === "WR" || pos === "TE") ? "REC TD" : "RUSH TD"; }

  // Build the celebration payload for one of my players (shared by the preview loop + the live trigger)
  function _playerCelebData(pid, event, o) {
    o = o || {};
    const pl = _resolve(pid), pos = pl.pos || "", isDef = pos === "DEF";
    const col = NFL_COLORS[pl.team] || ["#1a1a2e", "#ffffff", "#8a94a3"];
    return {
      skipFetch: true, event: event, showPoints: true,
      ptsOverride: (typeof o.ptsOverride === "number") ? o.ptsOverride : undefined,
      teamName: pl.team || "", primary: col[0], secondary: col[1], colors: col,
      playerName: pl.name, position: isDef ? "" : pos,
      headshot: isDef ? "" : "https://sleepercdn.com/content/nfl/players/" + pid + ".jpg",
      logo: "https://a.espncdn.com/i/teamlogos/nfl/500/" + _espnAbbr(pl.team) + ".png", logoBox: LOGO_BOX[pl.team] || null,
      tdType: o.tdType || ((event === "TD") ? _tdType(pos) : ""), yards: o.yards || 0,
    };
  }
  function _fireCeleb(pid, event, o) {
    if (!_active || !_container || typeof root.mountTDCelebration !== "function") return;
    _celebrating = true;
    root.mountTDCelebration(_container, Object.assign({ dismissMs: 7500, onDone: function () {
      _celebrating = false;
      if (_active && _lastM) _render(_lastM[0], _lastM[1]);   // restore the scoreboard once the takeover ends
    } }, _playerCelebData(pid, event, o)));
  }

  // ── Live TD/FG watch off ESPN scoring plays (quick + accurate; matched to my roster) ──────────────
  function _normName(s) { return (s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
  function _parsePlay(text) {
    if (!text) return { scorer: "", passer: "", yards: 0, tdType: "RUSH TD", isFG: false };
    const clean = text.replace(/\s*\(.*?\)\s*$/g, "").trim();
    const m = clean.match(/^(.+?)\s+(\d+)\s+Yd\s+(.*)/i);
    let scorer = "", passer = "", yards = 0, tdType = "RUSH TD", isFG = false;
    if (m) {
      scorer = m[1].trim(); yards = parseInt(m[2], 10);
      const verb = m[3].toLowerCase();
      const pm = clean.match(/pass from (.+)$/i);
      if (/field goal/i.test(verb)) { isFG = true; tdType = "FG"; }
      else if (/pass from/i.test(verb)) { tdType = "REC TD"; if (pm) passer = pm[1].trim(); }
      else if (/run|rush/i.test(verb)) tdType = "RUSH TD";
      else if (/pass/i.test(verb)) tdType = "PASS TD";
    }
    return { scorer: scorer, passer: passer, yards: yards, tdType: tdType, isFG: isFG };
  }
  function _matchMine(name, wantK) {
    if (!name) return null;
    const n = _normName(name);
    for (const p of _myOff) {
      if (wantK && p.pos !== "K") continue;
      if (!wantK && p.pos === "K") continue;
      const pn = _normName(p.name);
      if (pn === n || pn.endsWith(n) || n.endsWith(pn)) return p;
    }
    return null;
  }
  async function _watchTDs() {
    if (!_active || _celebrating || !_myOff.length) return;
    try {
      const d = await _json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?_=" + Date.now());
      const myTeams = {}; _myOff.forEach(function (p) { if (p.team) myTeams[_espnAbbr(p.team)] = 1; });
      for (const e of (d.events || [])) {
        const comp = (e.competitions || [])[0] || {};
        if ((((comp.status || e.status || {}).type) || {}).state !== "in") continue;   // live only
        const cs = comp.competitors || [];
        if (!cs.some(function (c) { return myTeams[(c.team && c.team.abbreviation || "").toLowerCase()]; })) continue;
        const total = cs.reduce(function (s, c) { return s + (parseInt(c.score || 0, 10)); }, 0);
        const prev = _lastGameScore[e.id]; _lastGameScore[e.id] = total;
        if (prev != null && total <= prev) continue;   // no new points → skip the summary fetch
        const sum = await _json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=" + e.id + "&_=" + Date.now());
        for (const play of (sum.scoringPlays || [])) {
          const key = e.id + ":" + (play.id || play.sequenceNumber || play.text);
          if (_seenPlays[key]) continue;
          _seenPlays[key] = true;
          if (!_tdBaseline) continue;   // first pass just marks existing plays as seen
          const st = (play.scoringType && play.scoringType.abbreviation) || (play.type && play.type.abbreviation) || "";
          if (st !== "TD" && st !== "FG") continue;
          const pp = _parsePlay(play.text);
          const mScorer = _matchMine(pp.scorer, pp.isFG);
          const mPasser = (!pp.isFG && pp.passer) ? _matchMine(pp.passer, false) : null;
          if (mScorer && !_celebrating) _fireCeleb(mScorer.pid, pp.isFG ? "FG" : "TD", { yards: pp.yards, tdType: pp.isFG ? "" : pp.tdType });
          else if (mPasser && mPasser.pos === "QB" && !_celebrating) _fireCeleb(mPasser.pid, "TD", { yards: pp.yards, tdType: "PASS TD" });
        }
      }
      _tdBaseline = true;
    } catch (_) { /* transient */ }
  }

  let _preview = false, _previewTimer = null;

  async function previewFantasyTD(container, opts) {
    opts = opts || {}; stopPreviewTD();
    const lid = opts.leagueId, uid = opts.userId;
    try {
      await _fetchPlayers();
      const [state, rosters] = await Promise.all([_json(S + "/state/nfl"), _json(S + "/league/" + lid + "/rosters")]);
      const myR = rosters.find(function (r) { return String(r.owner_id) === String(uid); });
      const starters = ((myR && myR.starters) || []).filter(function (pid) { return pid && pid !== "0"; });
      const items = starters.map(function (pid, i) {
        const pl = _resolve(pid);
        const pos = pl.pos || "";
        const isDef = pos === "DEF", isK = pos === "K";
        const col = NFL_COLORS[pl.team] || ["#1a1a2e", "#ffffff", "#8a94a3"];
        return {
          skipFetch: true, event: isK ? "FG" : isDef ? "INT" : "TD", showPoints: true,
          teamName: pl.team || "", primary: col[0], secondary: col[1], colors: col,
          playerName: pl.name, position: isDef ? "" : pos,
          headshot: isDef ? "" : "https://sleepercdn.com/content/nfl/players/" + pid + ".jpg",
          logo: "https://a.espncdn.com/i/teamlogos/nfl/500/" + _espnAbbr(pl.team) + ".png", logoBox: LOGO_BOX[pl.team] || null,
          yards: isK ? _FGD[i % _FGD.length] : isDef ? 0 : _DIST[i % _DIST.length],
          tdType: (isK || isDef) ? "" : _tdType(pos),
        };
      }).filter(function (it) { return it.playerName; });
      if (!items.length || typeof root.mountTDCelebration !== "function") { if (opts.onError) opts.onError(new Error("no starters or no TD module")); return; }
      _preview = true;
      let i = 0;
      (function next() {
        if (!_preview) return;
        const it = items[i % items.length]; i++;
        root.mountTDCelebration(container, Object.assign({ dismissMs: 6000, onDone: function () { if (_preview) _previewTimer = setTimeout(next, 250); } }, it));
      })();
    } catch (err) { if (opts.onError) opts.onError(err); }
  }
  function stopPreviewTD() { _preview = false; if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; } if (typeof root.stopTDCelebration === "function") root.stopTDCelebration(); }

  root.mountFantasy = mountFantasy;
  root.stopFantasy = stopFantasy;
  root.previewFantasyTD = previewFantasyTD;
  root.stopPreviewTD = stopPreviewTD;
}(typeof window !== "undefined" ? window : this));
