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
    win: "#3ddc84", lose: "#8a94a3", live: "#FF6A00", track: "#232a33",
    posColors: { QB: "#e0517d", RB: "#3fbf9f", WR: "#4aa8ff", TE: "#f0a83c", K: "#b07cff", DEF: "#8a94a3", FLEX: "#9aa0aa", SFLX: "#c77dff" },
  };
  const SIGMA = 27;   // std dev of a fantasy matchup margin — for the win-probability curve

  let _active = false, _container = null, _timer = null;
  let _players = null, _proj = null, _stats = null, _ctx = null;

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

  // team's projected final = at least what they have now, at least their pre-game projection
  function _projTotal(m) {
    const st = (m && m.starters) || [];
    let proj = 0;
    st.forEach(function (pid) {
      let v = _proj && _proj[pid];
      if (v == null) v = /^[A-Z]{2,3}$/.test(pid) ? 7 : 0;   // DEF default when missing from projections
      proj += v;
    });
    return Math.max((m && m.points) || 0, proj);
  }
  function _erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function _winPct(effMe, effOpp) { const z = (effMe - effOpp) / SIGMA; return Math.max(1, Math.min(99, Math.round(0.5 * (1 + _erf(z / Math.SQRT2)) * 100))); }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function _teamHead(name, record, total, isWin, proj) {
    const w = _el("div", "display:flex;flex-direction:column;align-items:center;gap:0.1vh;min-width:0;flex:1;");
    const n = _el("div", "font-family:'Oswald',sans-serif;font-size:3.4vh;font-weight:700;text-transform:uppercase;letter-spacing:0.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;color:" + (isWin ? P.text : P.dim) + ";");
    n.textContent = name; w.appendChild(n);
    const s = _el("div", "font-family:'Oswald',sans-serif;font-size:5.6vh;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:" + (isWin ? P.win : P.text) + ";");
    s.textContent = (total || 0).toFixed(1); w.appendChild(s);
    const r = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:2.6vh;font-weight:600;color:" + P.dim + ";letter-spacing:0.04em;");
    r.textContent = (record || "") + (proj != null ? "  ·  PROJ " + proj.toFixed(0) : ""); w.appendChild(r);
    return w;
  }

  function _logo(team) {
    if (!team) return _el("div", "width:3.6vh;height:3.6vh;flex-shrink:0;");
    const wrap = _el("div", "width:3.6vh;height:3.6vh;flex-shrink:0;display:flex;align-items:center;justify-content:center;");
    const img = document.createElement("img");
    img.src = "https://a.espncdn.com/i/teamlogos/nfl/500/" + team.toLowerCase() + ".png";
    img.alt = "";
    img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
    img.onerror = function () { wrap.style.visibility = "hidden"; };
    wrap.appendChild(img); return wrap;
  }

  // single line: [POS] [logo] Name  ...(stat line).....  pts   (mirrored for the opponent column)
  function _row(slot, pid, pts, right) {
    const r = _el("div", "display:flex;align-items:center;gap:0.7vw;flex:1 1 0;min-height:0;min-width:0;padding:0 1vw;border-bottom:1px solid " + P.border + ";" + (right ? "flex-direction:row-reverse;" : ""));
    const pl = _resolve(pid);
    const posLabel = slot || pl.pos || "";
    const chip = _el("div", "font-family:'Oswald',sans-serif;font-size:2.9vh;font-weight:700;flex-shrink:0;width:4.6vw;text-align:center;color:#0b0d10;background:" + (P.posColors[posLabel] || P.posColors.FLEX) + ";border-radius:0.4vh;padding:0.2vh 0;");
    chip.textContent = posLabel; r.appendChild(chip);
    r.appendChild(_logo(pl.team));
    const nm = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:3.7vh;font-weight:700;color:" + P.text + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;letter-spacing:0.01em;" + (right ? "text-align:right;" : ""));
    nm.textContent = pl.name; r.appendChild(nm);
    const stat = _statLine(pid, pl.pos || posLabel);
    if (stat) { const sl = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:2.7vh;font-weight:600;color:" + P.dim + ";flex-shrink:0;white-space:nowrap;"); sl.textContent = stat; r.appendChild(sl); }
    const pt = _el("div", "font-family:'Oswald',sans-serif;font-size:3.9vh;font-weight:700;flex-shrink:0;min-width:4.4vw;text-align:" + (right ? "left" : "right") + ";font-variant-numeric:tabular-nums;color:" + (pts > 0 ? P.text : P.dim) + ";");
    pt.textContent = (pts != null ? pts : 0).toFixed(1); r.appendChild(pt);
    return r;
  }

  function _winBar(myPct) {
    const wrap = _el("div", "display:flex;align-items:center;gap:0.8vw;padding:0.7vh 3vw;background:" + P.header + ";border-bottom:1px solid " + P.border + ";flex-shrink:0;");
    const l = _el("div", "font-family:'Oswald',sans-serif;font-size:3.2vh;font-weight:700;color:" + (myPct >= 50 ? P.win : P.dim) + ";flex-shrink:0;min-width:4vw;font-variant-numeric:tabular-nums;");
    l.textContent = myPct + "%"; wrap.appendChild(l);
    const bar = _el("div", "flex:1;height:1.8vh;border-radius:1vh;overflow:hidden;background:" + P.track + ";display:flex;");
    const fill = _el("div", "height:100%;width:" + myPct + "%;background:" + P.win + ";");
    const rest = _el("div", "height:100%;flex:1;background:" + P.live + ";");
    bar.appendChild(fill); bar.appendChild(rest); wrap.appendChild(bar);
    const rt = _el("div", "font-family:'Oswald',sans-serif;font-size:3.2vh;font-weight:700;color:" + (myPct < 50 ? P.live : P.dim) + ";flex-shrink:0;min-width:4vw;text-align:right;font-variant-numeric:tabular-nums;");
    rt.textContent = (100 - myPct) + "%"; wrap.appendChild(rt);
    return wrap;
  }

  function _render(myM, oppM) {
    const c = _container; c.replaceChildren();
    c.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;background:" + P.bg + ";overflow:hidden;box-sizing:border-box;";
    const myTot = (myM && myM.points) || 0, oppTot = (oppM && oppM.points) || 0;
    const effMe = _projTotal(myM), effOpp = oppM ? _projTotal(oppM) : 0;
    const myPct = oppM ? _winPct(effMe, effOpp) : 100;
    const iWin = myTot >= oppTot;

    const bar = _el("div", "display:flex;align-items:center;justify-content:center;gap:2vw;padding:0.7vh 2vw;background:" + P.header + ";border-bottom:2px solid " + P.border + ";flex-shrink:0;");
    bar.appendChild(_teamHead(_ctx.teamName(myM.roster_id), _ctx.record(myM.roster_id), myTot, iWin, effMe));
    const mid = _el("div", "display:flex;flex-direction:column;align-items:center;flex-shrink:0;");
    const wk = _el("div", "font-family:'Barlow Condensed',sans-serif;font-size:2.8vh;font-weight:700;color:" + P.gold + ";letter-spacing:0.1em;");
    wk.textContent = "WEEK " + (_ctx.week || ""); mid.appendChild(wk);
    const vs = _el("div", "font-family:'Oswald',sans-serif;font-size:3vh;font-weight:700;color:" + P.dim + ";"); vs.textContent = "VS"; mid.appendChild(vs);
    bar.appendChild(mid);
    bar.appendChild(_teamHead(oppM ? _ctx.teamName(oppM.roster_id) : "No opponent", oppM ? _ctx.record(oppM.roster_id) : "", oppTot, !iWin, oppM ? effOpp : null));
    c.appendChild(bar);

    // Win-probability bar
    c.appendChild(_winBar(myPct));

    const body = _el("div", "flex:1;display:grid;grid-template-columns:1fr 1fr;min-height:0;");
    const slots = _ctx.rosterPos || [];
    function col(m, right) {
      const cl = _el("div", "display:flex;flex-direction:column;min-height:0;min-width:0;" + (right ? "" : "border-right:1px solid " + P.border + ";"));
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
      await Promise.all([_fetchPlayers(), _fetchProjections(week), _fetchStats(week)]);
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
          const [ms] = await Promise.all([ _json(S + "/league/" + lid + "/matchups/" + _ctx.week), _fetchStats(_ctx.week) ]);
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

  root.mountFantasy = mountFantasy;
  root.stopFantasy = stopFantasy;
}(typeof window !== "undefined" ? window : this));
