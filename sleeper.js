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
    posColors: { QB: "#e0517d", RB: "#3fbf9f", WR: "#4aa8ff", TE: "#f0a83c", K: "#b07cff", DEF: "#8a94a3", FLEX: "#FF6A00", SFLX: "#FF6A00" },
  };
  const SIGMA = 27;   // std dev of a fantasy matchup margin — for the win-probability curve

  let _active = false, _container = null, _timer = null;
  let _players = null, _proj = null, _stats = null, _ctx = null, _gameState = null;

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
      const list = await _json("https://api.sleeper.com/stats/nfl/2026/" + week + "?season_type=regular");
      const m = {}; (list || []).forEach(function (x) { if (x && x.player_id) m[x.player_id] = x.stats || {}; });
      _stats = m;
    } catch (_) { if (!_stats) _stats = {}; }
    return _stats;
  }
  // Live NFL game state per team, from the ESPN scoreboard (state, quarter, clock, score, opponent,
  // possession, red zone). Keyed by ESPN abbreviation (lowercase).
  async function _fetchGameState() {
    try {
      const d = await _json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
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
          const other = cs.find(function (o) { return o !== c; }) || {};
          const ot = other.team || {};
          m[(t.abbreviation || "").toLowerCase()] = {
            state: state, period: period, clock: clock, date: e.date || "",
            score: parseInt(c.score || 0, 10), oppScore: parseInt(other.score || 0, 10),
            oppAbbr: (ot.abbreviation || "").toUpperCase(), home: c.homeAway === "home",
            hasPoss: possId !== "" && String(t.id) === possId,
            isRZ: !!sit.isRedZone,
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
    if (pos === "QB") { if (s.pass_yd) p.push(r(s.pass_yd) + " YD"); if (s.pass_td) p.push(r(s.pass_td) + " TD"); if (s.pass_int) p.push(r(s.pass_int) + " INT"); if (s.rush_yd >= 10) p.push(r(s.rush_yd) + " RUSH"); }
    else if (pos === "RB") { if (s.rush_yd != null) p.push(r(s.rush_yd || 0) + " YD"); if (s.rush_td) p.push(r(s.rush_td) + " TD"); if (s.rec) p.push(r(s.rec) + " REC"); }
    else if (pos === "WR" || pos === "TE") { if (s.rec) p.push(r(s.rec) + " REC"); if (s.rec_yd != null) p.push(r(s.rec_yd || 0) + " YD"); if (s.rec_td) p.push(r(s.rec_td) + " TD"); }
    else if (pos === "K") { if (s.fgm != null && s.fga != null) p.push(r(s.fgm) + "/" + r(s.fga) + " FG"); if (s.xpm) p.push(r(s.xpm) + " XP"); }
    else if (pos === "DEF") { if (s.sack) p.push(r(s.sack) + " SK"); if (s.def_int) p.push(r(s.def_int) + " INT"); if (s.def_td) p.push(r(s.def_td) + " TD"); if (s.pts_allow != null) p.push(r(s.pts_allow) + " PA"); }
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

  // team record for a far corner of the scoreboard band
  function _recordEl(rec) {
    const e = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:2.4vh;font-weight:600;letter-spacing:0.04em;color:" + P.dim + ";white-space:nowrap;flex-shrink:0;");
    e.textContent = rec || "0-0"; return e;
  }
  // big centred team total (above its score column); right=true → left-align for the opponent side
  function _totalEl(v, right) {
    const e = _el("div", "font-family:'Oswald',sans-serif;font-size:5.4vh;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:" + P.text + ";flex-shrink:0;min-width:8vw;text-align:" + (right ? "left" : "right") + ";");
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
    const bg = live && live.redZone ? "background:rgba(255,75,75,0.20);"
             : live && live.onField ? "background:rgba(74,168,255,0.16);" : "";
    const r = _el("div", "display:flex;align-items:center;line-height:1;gap:0.6vw;flex:1 1 0;min-height:0;min-width:0;padding:0 1vw;border-bottom:1px solid " + P.border + ";" + bg + (right ? "flex-direction:row-reverse;" : ""));
    const chip = _el("div", "font-family:'Oswald',sans-serif;font-size:2.7vh;font-weight:700;flex-shrink:0;width:4vw;text-align:center;color:#0b0d10;background:" + (P.posColors[posLabel] || P.posColors.FLEX) + ";border-radius:0.4vh;padding:0.2vh 0;");
    chip.textContent = posLabel; r.appendChild(chip);
    r.appendChild(_logo(pl.team));
    const nm = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.8vh;font-weight:700;color:" + P.text + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;letter-spacing:0.01em;flex-shrink:1;");
    nm.textContent = _shortName(pl.name, pl.pos || posLabel); r.appendChild(nm);
    if (live && live.chip) {
      const gc = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.2vh;font-weight:700;flex-shrink:0;white-space:nowrap;color:" + live.color + ";");
      gc.textContent = live.chip; r.appendChild(gc);
    }
    r.appendChild(_el("div", "flex:1 1 auto;min-width:0;"));   // spacer → pushes stat+score to the inner edge
    const stat = _statLine(pid, pl.pos || posLabel);
    if (stat) { const sl = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.2vh;font-weight:600;color:" + P.dim + ";flex-shrink:0;white-space:nowrap;"); sl.textContent = stat; r.appendChild(sl); }
    const pt = _el("div", "font-family:'Oswald',sans-serif;font-size:3.2vh;font-weight:700;flex-shrink:0;min-width:4.6vw;font-variant-numeric:tabular-nums;color:" + (pts > 0 ? P.win : P.dim) + ";text-align:" + (right ? "left" : "right") + ";");
    pt.textContent = (pts != null ? pts : 0).toFixed(1); r.appendChild(pt);
    return r;
  }

  function _render(myM, oppM) {
    const c = _container; c.replaceChildren();
    c.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;background:" + P.bg + ";overflow:hidden;box-sizing:border-box;";
    const myTot = (myM && myM.points) || 0, oppTot = (oppM && oppM.points) || 0;

    // scoreboard band: records in the far corners, both team totals centred at the top (above the
    // player-score columns), no win% / meter
    const band = _el("div", "display:flex;align-items:center;padding:0.6vh 3vw;background:" + P.header + ";border-bottom:1px solid " + P.border + ";flex-shrink:0;");
    band.appendChild(_recordEl(_ctx.record(myM.roster_id)));
    band.appendChild(_el("div", "flex:1 1 0;min-width:0;"));
    band.appendChild(_totalEl(myTot, false));
    band.appendChild(_el("div", "width:3vw;flex-shrink:0;"));
    band.appendChild(_totalEl(oppTot, true));
    band.appendChild(_el("div", "flex:1 1 0;min-width:0;"));
    band.appendChild(_recordEl(oppM ? _ctx.record(oppM.roster_id) : "0-0"));
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
        .map(function (p) { return (p === "SUPER_FLEX") ? "SFLX" : (p === "REC_FLEX" || p === "WRRB_FLEX") ? "FLEX" : p; });
      const myR = rosters.find(function (r) { return String(r.owner_id) === String(uid); });
      if (!myR) { _active = false; if (opts.onError) opts.onError(new Error("roster not found")); return; }
      const userById = {}; users.forEach(function (u) { userById[u.user_id] = u; });
      const rosterById = {}; rosters.forEach(function (r) { rosterById[r.roster_id] = r; });
      const teamName = function (rid) { const r = rosterById[rid]; const u = r && userById[r.owner_id]; return (u && u.metadata && u.metadata.team_name) || (u && u.display_name) || ("Team " + rid); };
      const record = function (rid) { const s = (rosterById[rid] || {}).settings || {}; return (s.wins || 0) + "-" + (s.losses || 0) + (s.ties ? "-" + s.ties : ""); };
      _ctx = { week: week, rosterPos: rosterPos, myRid: myR.roster_id, teamName: teamName, record: record };
      async function refresh() {
        if (!_active) return;
        try {
          const [ms] = await Promise.all([ _json(S + "/league/" + lid + "/matchups/" + _ctx.week), _fetchStats(_ctx.week), _fetchGameState() ]);
          if (!_active) return;
          const myM = ms.find(function (m) { return m.roster_id === _ctx.myRid; });
          const oppM = myM ? ms.find(function (m) { return m.matchup_id === myM.matchup_id && m.roster_id !== _ctx.myRid; }) : null;
          if (!myM) { if (opts.onEmpty) opts.onEmpty(); return; }
          _render(myM, oppM);
        } catch (_) { /* keep the last render on a transient error */ }
      }
      await refresh();
      _timer = setInterval(refresh, 45000);
    } catch (err) { _active = false; if (opts.onError) opts.onError(err); }
  }

  function stopFantasy() { _active = false; if (_timer) { clearInterval(_timer); _timer = null; } _container = null; }

  // ── TD-celebration preview: loop through the user's starters with real headshots + team colours ──
  const NFL_COLORS = {
    ARI: ["#97233F", "#FFB612"], ATL: ["#A71930", "#000000"], BAL: ["#241773", "#9E7C0C"], BUF: ["#00338D", "#C60C30"],
    CAR: ["#0085CA", "#101820"], CHI: ["#0B162A", "#C83803"], CIN: ["#FB4F14", "#000000"], CLE: ["#311D00", "#FF3C00"],
    DAL: ["#003594", "#869397"], DEN: ["#FB4F14", "#002244"], DET: ["#0076B6", "#B0B7BC"], GB: ["#203731", "#FFB612"],
    HOU: ["#03202F", "#A71930"], IND: ["#002C5F", "#A2AAAD"], JAX: ["#006778", "#D7A22A"], KC: ["#E31837", "#FFB81C"],
    LV: ["#101820", "#A5ACAF"], LAC: ["#0080C6", "#FFC20E"], LAR: ["#003594", "#FFA300"], MIA: ["#008E97", "#FC4C02"],
    MIN: ["#4F2683", "#FFC62F"], NE: ["#002244", "#C60C30"], NO: ["#101820", "#D3BC8D"], NYG: ["#0B2265", "#A71930"],
    NYJ: ["#125740", "#FFFFFF"], PHI: ["#004C54", "#A5ACAF"], PIT: ["#101820", "#FFB612"], SF: ["#AA0000", "#B3995D"],
    SEA: ["#002244", "#69BE28"], TB: ["#D50A0A", "#34302B"], TEN: ["#0C2340", "#4B92DB"], WAS: ["#5A1414", "#FFB612"],
  };
  const _DIST = [4, 9, 15, 22, 31, 44, 55, 7, 18, 63];
  function _tdType(pos) { return pos === "QB" ? "PASS TD" : (pos === "WR" || pos === "TE") ? "REC TD" : "RUSH TD"; }
  let _preview = false, _previewTimer = null;

  async function previewFantasyTD(container, opts) {
    opts = opts || {}; stopPreviewTD();
    const lid = opts.leagueId, uid = opts.userId;
    try {
      await _fetchPlayers();
      const [state, rosters] = await Promise.all([_json(S + "/state/nfl"), _json(S + "/league/" + lid + "/rosters")]);
      const myR = rosters.find(function (r) { return String(r.owner_id) === String(uid); });
      const starters = ((myR && myR.starters) || []).filter(function (pid) { return pid && pid !== "0" && !/^[A-Z]{2,3}$/.test(pid); });
      const items = starters.map(function (pid, i) {
        const pl = _resolve(pid);
        const col = NFL_COLORS[pl.team] || ["#1a1a2e", "#ffffff"];
        return {
          skipFetch: true, teamName: pl.team || "", primary: col[0], secondary: col[1],
          playerName: pl.name, position: pl.pos || "", headshot: "https://sleepercdn.com/content/nfl/players/" + pid + ".jpg",
          yards: _DIST[i % _DIST.length], tdType: _tdType(pl.pos || ""),
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
