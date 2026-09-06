/**
 * schedule.js — ESPN CFB full-season schedule module
 * Projector Scoreboard | Vanilla JS, no frameworks
 *
 * Usage:
 *   mountSchedule(container, teamName, { onEmpty, onError })
 *   stopSchedule()
 *
 * Data path (both endpoints are CORS-open, Access-Control-Allow-Origin: *):
 *   1. Team lookup:
 *      https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000
 *      -> sports[0].leagues[0].teams[] each has .team.{id, location, displayName, abbreviation}
 *      Match teamName case-insensitively against location, displayName, abbreviation.
 *
 *   2. Schedule:
 *      https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/<ID>/schedule
 *      -> .team.{displayName, recordSummary}
 *      -> .events[]  each with:
 *           .week.number            — week number (bye weeks simply absent from events[])
 *           .date                   — ISO 8601 UTC string, e.g. "2026-09-04T00:00Z"
 *           .timeValid              — false when kickoff TBD
 *           .competitions[0]:
 *             .status.type.{state, description, shortDetail}
 *                 state: "pre" | "in" | "post"
 *                 shortDetail: human-readable time+tz for upcoming (e.g. "9/12 - 3:30 PM EDT")
 *             .competitors[]  each has:
 *                 .homeAway          — "home" | "away"
 *                 .team.{id, displayName, abbreviation, logo}
 *                 .score.displayValue — final/live score string
 *                 .winner            — bool, only set for state=="post"
 *                 .curatedRank.current — AP rank, 99 = unranked
 *             .broadcasts[]  first entry .media.shortName — TV network
 *
 * Security: all ESPN-sourced strings assigned via textContent only, never innerHTML.
 *
 * Verified against: Colorado (id=38), 2026 season, 12 games, bye on week 6.
 */

(function (root) {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────
  const TEAMS_URL    = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000";
  const SCHEDULE_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/";
  const LOGO_BASE    = "https://a.espncdn.com/i/teamlogos/ncaa/500/";

  // Projector palette — matches highlights.js / playerstats.js
  const P = {
    bg:       "#08090b",
    surface:  "#0f1318",
    surface2: "#12171e",
    border:   "#1e242c",
    label:    "#FFE84D",   // gold
    text:     "#ffffff",
    dim:      "#7a8290",
    live:     "#FF6A00",   // live/in-progress accent
    win:      "#3ddc84",   // W result
    loss:     "#ff4d6a",   // L result
    header:   "#13181f",
    current:  "#1a2030",   // highlight row for current/next game
    rank:     "#FFE84D",
  };

  // Maximum number of rows per column (two-column layout kicks in when > this)
  const SINGLE_COL_MAX = 8;

  // ── Module state ───────────────────────────────────────────────────────────
  let _container = null;
  let _active    = false;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _norm(s) {
    return (s || "").toLowerCase().trim();
  }

  function _el(tag, css, cls) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (cls) e.className = cls;
    return e;
  }

  // Safe text helper — never innerHTML with API data
  function _t(str) {
    return document.createTextNode(
      str === null || str === undefined ? "" : String(str)
    );
  }

  // ── Team resolution ────────────────────────────────────────────────────────

  async function _resolveTeam(teamName) {
    const res = await fetch(TEAMS_URL);
    if (!res.ok) throw new Error("ESPN teams HTTP " + res.status);
    const data = await res.json();

    const needle = _norm(teamName);
    const sports = data.sports || [];
    let allTeams = [];
    for (const sport of sports) {
      for (const league of (sport.leagues || [])) {
        allTeams = allTeams.concat(league.teams || []);
      }
    }

    // Try exact abbreviation first, then location, then displayName substring
    let match = null;

    // Pass 1: exact abbreviation
    for (const entry of allTeams) {
      const t = entry.team || {};
      if (_norm(t.abbreviation) === needle) { match = t; break; }
    }

    // Pass 2: exact location
    if (!match) {
      for (const entry of allTeams) {
        const t = entry.team || {};
        if (_norm(t.location) === needle) { match = t; break; }
      }
    }

    // Pass 3: displayName contains needle
    if (!match) {
      for (const entry of allTeams) {
        const t = entry.team || {};
        if (_norm(t.displayName).includes(needle)) { match = t; break; }
      }
    }

    // Pass 4: location contains needle
    if (!match) {
      for (const entry of allTeams) {
        const t = entry.team || {};
        if (_norm(t.location).includes(needle)) { match = t; break; }
      }
    }

    if (!match) throw new Error("No ESPN team found matching: " + teamName);
    return match; // {id, location, displayName, abbreviation, color, logo, ...}
  }

  // ── Schedule fetch ─────────────────────────────────────────────────────────

  async function _fetchSchedule(teamId) {
    const url = SCHEDULE_URL + encodeURIComponent(teamId) + "/schedule";
    const res = await fetch(url);
    if (!res.ok) throw new Error("ESPN schedule HTTP " + res.status);
    return res.json();
  }

  // ── Row parsing ────────────────────────────────────────────────────────────

  /**
   * Returns an array of row objects, one per game, sorted by week number.
   * Each row: { week, dateISO, dateDisp, vsAt, opp, oppId, oppRank, cuRank,
   *             state, result, resultClass, time, tv, isCurrent }
   */
  function _parseRows(data, teamId) {
    const events = data.events || [];
    const teamIdStr = String(teamId);

    // Determine which event is "current" (in-progress) or "next" (first pre after last post)
    let lastPostIdx = -1;
    let firstPreIdx = -1;
    let inProgressIdx = -1;

    const rows = events.map(function (e, ei) {
      const week = (e.week || {}).number;
      const dateISO = e.date || "";
      const timeValid = e.timeValid !== false;
      const comp = (e.competitions || [])[0] || {};
      const status = comp.status || {};
      const statusType = status.type || {};
      const state = statusType.state || "pre";
      const shortDetail = statusType.shortDetail || "";

      // Competitors
      let cu = null, opp = null;
      for (const c of (comp.competitors || [])) {
        const t = c.team || {};
        if (String(t.id) === teamIdStr) {
          cu = c;
        } else {
          opp = c;
        }
      }

      const oppTeam  = (opp && opp.team)  || {};
      const cuTeam   = (cu  && cu.team)   || {};
      const oppId    = oppTeam.id  || "";
      const oppAbbr  = oppTeam.abbreviation || oppTeam.location || "???";
      const oppRank  = (opp && opp.curatedRank && opp.curatedRank.current !== 99)
                         ? opp.curatedRank.current : null;
      const cuRank   = (cu  && cu.curatedRank  && cu.curatedRank.current  !== 99)
                         ? cu.curatedRank.current  : null;
      const cuHa     = (cu && cu.homeAway) || "away";
      const vsAt     = cuHa === "home" ? "vs" : "@";

      // TV network
      let tv = "";
      for (const b of (comp.broadcasts || [])) {
        const net = (b.media || {}).shortName || "";
        if (net) { tv = net; break; }
      }

      // Result / time string
      let result = "";
      let resultClass = ""; // "win" | "loss" | "live" | ""

      if (state === "post") {
        const cuScore  = (cu  && cu.score  && cu.score.displayValue)  || "0";
        const oppScore = (opp && opp.score && opp.score.displayValue) || "0";
        const winner   = cu  && cu.winner;
        result      = (winner ? "W" : "L") + " " + cuScore + "-" + oppScore;
        resultClass = winner ? "win" : "loss";
        lastPostIdx = ei;
      } else if (state === "in") {
        const cuScore  = (cu  && cu.score  && cu.score.displayValue)  || "0";
        const oppScore = (opp && opp.score && opp.score.displayValue) || "0";
        const period   = status.period || "";
        const clock    = status.displayClock || "";
        result      = cuScore + "-" + oppScore + " Q" + period + " " + clock;
        resultClass = "live";
        inProgressIdx = ei;
      } else {
        // pre
        result = timeValid && shortDetail ? shortDetail : "TBD";
        if (firstPreIdx < 0) firstPreIdx = ei;
      }

      // Date display: "SEP 4"
      let dateDisp = "";
      try {
        const d = new Date(dateISO);
        const mo = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getUTCMonth()];
        dateDisp = mo + " " + d.getUTCDate();
      } catch (_) {
        dateDisp = dateISO.slice(5, 10);
      }

      return {
        week, dateISO, dateDisp, vsAt, oppAbbr, oppId, oppRank, cuRank,
        state, result, resultClass, tv,
        ei, // original index for current-game detection
      };
    });

    // Mark "current" game: in-progress first, else first pre, else last post
    const currentEi = inProgressIdx >= 0 ? inProgressIdx
                    : firstPreIdx    >= 0 ? firstPreIdx
                    : lastPostIdx;

    rows.forEach(function (r) {
      r.isCurrent = (r.ei === currentEi);
    });

    return rows;
  }

  // ── DOM builder ────────────────────────────────────────────────────────────

  function _logoUrl(teamId, localLogosAvailable) {
    if (localLogosAvailable && teamId) {
      // Caller signals that ../logos/<id>.png exists; use it for offline/LAN use
      return "../logos/" + teamId + ".png";
    }
    return teamId ? LOGO_BASE + teamId + ".png" : "";
  }

  function _buildHeader(container, teamInfo, record) {
    const bar = _el("div",
      "display:flex;align-items:center;justify-content:space-between;" +
      "padding:1.4vh 2vw 1.2vh;" +
      "background:" + P.header + ";" +
      "border-bottom:2px solid " + P.border + ";" +
      "flex-shrink:0;" +
      "gap:1.2vw;"
    );

    // Left: team logo + name
    const left = _el("div", "display:flex;align-items:center;gap:1.2vw;min-width:0;");

    if (teamInfo.id) {
      const logoWrap = _el("div",
        "width:5.8vh;height:5.8vh;flex-shrink:0;" +
        "background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
        "overflow:hidden;"
      );
      const img = document.createElement("img");
      img.src = LOGO_BASE + teamInfo.id + ".png";
      img.alt = "";
      img.style.cssText = "width:4.6vh;height:4.6vh;object-fit:contain;display:block;";
      img.onerror = function () { logoWrap.style.display = "none"; };
      logoWrap.appendChild(img);
      left.appendChild(logoWrap);
    }

    const nameEl = _el("span",
      "font-family:'Oswald',sans-serif;font-size:3.2vh;font-weight:700;" +
      "letter-spacing:0.04em;color:" + P.text + ";text-transform:uppercase;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    );
    nameEl.textContent = teamInfo.displayName || teamInfo.location || "";
    left.appendChild(nameEl);

    bar.appendChild(left);

    // Right: record + season label
    const right = _el("div", "display:flex;align-items:center;gap:1.4vw;flex-shrink:0;");

    if (record) {
      const recEl = _el("span",
        "font-family:'Oswald',sans-serif;font-size:2.6vh;font-weight:600;" +
        "color:" + P.label + ";letter-spacing:0.06em;"
      );
      recEl.textContent = record;
      right.appendChild(recEl);
    }

    const seasonEl = _el("span",
      "font-family:'Barlow Condensed',sans-serif;font-size:2vh;font-weight:600;" +
      "color:" + P.dim + ";letter-spacing:0.08em;text-transform:uppercase;"
    );
    seasonEl.textContent = "2026 SEASON";
    right.appendChild(seasonEl);

    bar.appendChild(right);
    container.appendChild(bar);
  }

  function _buildRow(row, colCount) {
    // isCurrent row gets subtle highlight
    const bgColor = row.isCurrent ? P.current : "transparent";
    const borderLeft = row.isCurrent
      ? "border-left:3px solid " + P.label + ";"
      : "border-left:3px solid transparent;";

    const tr = _el("div",
      "display:grid;" +
      "grid-template-columns:4.5ch 5.5ch 3.2vh 1fr 1fr 6ch;" +
      "align-items:center;gap:0 0.8vw;" +
      "padding:0.8vh 1.2vw 0.8vh 0.9vw;" +
      "background:" + bgColor + ";" +
      borderLeft +
      "border-bottom:1px solid " + P.border + ";" +
      "min-width:0;"
    );

    // ── Week ──
    const weekEl = _el("div",
      "font-family:'Oswald',sans-serif;font-size:1.5vh;font-weight:700;" +
      "color:" + P.dim + ";letter-spacing:0.10em;text-transform:uppercase;" +
      "white-space:nowrap;"
    );
    weekEl.textContent = "W" + (row.week !== undefined ? row.week : "?");
    tr.appendChild(weekEl);

    // ── Date ──
    const dateEl = _el("div",
      "font-family:'Barlow Condensed',sans-serif;font-size:1.8vh;font-weight:600;" +
      "color:" + P.dim + ";white-space:nowrap;"
    );
    dateEl.textContent = row.dateDisp;
    tr.appendChild(dateEl);

    // ── Opponent logo ──
    const logoWrap = _el("div",
      "width:3.2vh;height:3.2vh;" +
      "background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
      "overflow:hidden;flex-shrink:0;"
    );
    if (row.oppId) {
      const img = document.createElement("img");
      img.src = LOGO_BASE + row.oppId + ".png";
      img.alt = "";
      img.style.cssText = "width:2.5vh;height:2.5vh;object-fit:contain;display:block;";
      img.onerror = function () {
        logoWrap.style.background = P.surface;
        logoWrap.style.border = "1px solid " + P.border;
      };
      logoWrap.appendChild(img);
    } else {
      logoWrap.style.background = P.surface;
    }
    tr.appendChild(logoWrap);

    // ── Opponent label: vs/@ + [rank] + ABBR ──
    const oppEl = _el("div",
      "font-family:'Barlow Condensed',sans-serif;font-size:2vh;font-weight:600;" +
      "color:" + P.text + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "min-width:0;"
    );
    // Build the text in safe pieces
    const vsSpan = _el("span",
      "color:" + P.dim + ";font-size:1.8vh;margin-right:0.35ch;"
    );
    vsSpan.textContent = row.vsAt;
    oppEl.appendChild(vsSpan);

    if (row.oppRank) {
      const rnk = _el("span",
        "color:" + P.rank + ";font-size:1.6vh;font-weight:700;margin-right:0.3ch;" +
        "font-family:'Oswald',sans-serif;letter-spacing:0.04em;"
      );
      rnk.textContent = "#" + row.oppRank;
      oppEl.appendChild(rnk);
    }

    const abbrSpan = document.createElement("span");
    abbrSpan.textContent = row.oppAbbr;
    oppEl.appendChild(abbrSpan);

    tr.appendChild(oppEl);

    // ── Result / time ──
    let resultColor = P.text;
    if (row.resultClass === "win")  resultColor = P.win;
    if (row.resultClass === "loss") resultColor = P.loss;
    if (row.resultClass === "live") resultColor = P.live;

    const resEl = _el("div",
      "font-family:'Barlow Condensed',sans-serif;font-size:1.9vh;font-weight:600;" +
      "color:" + resultColor + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "min-width:0;" +
      (row.resultClass === "live"
        ? "background:rgba(255,106,0,0.12);border-radius:3px;padding:0.15vh 0.4vw;"
        : "")
    );
    resEl.textContent = row.result;
    tr.appendChild(resEl);

    // ── TV ──
    const tvEl = _el("div",
      "font-family:'Barlow Condensed',sans-serif;font-size:1.6vh;font-weight:600;" +
      "color:" + P.dim + ";text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    );
    tvEl.textContent = row.tv || "";
    tr.appendChild(tvEl);

    return tr;
  }

  function _buildSchedule(container, teamInfo, record, rows) {
    container.replaceChildren();
    container.style.cssText =
      "display:flex;flex-direction:column;width:100%;height:100%;" +
      "background:" + P.bg + ";overflow:hidden;font-size:1vh;";

    _buildHeader(container, teamInfo, record);

    // Column header row (labels)
    const colHdr = _el("div",
      "display:grid;" +
      "grid-template-columns:4.5ch 5.5ch 3.2vh 1fr 1fr 6ch;" +
      "align-items:center;gap:0 0.8vw;" +
      "padding:0.45vh 1.2vw 0.45vh 0.9vw;" +
      "background:" + P.header + ";" +
      "border-bottom:1px solid " + P.border + ";" +
      "border-left:3px solid transparent;" +
      "flex-shrink:0;"
    );

    const hdrLabels = ["WEEK", "DATE", "", "OPPONENT", "RESULT / KICKOFF", "TV"];
    hdrLabels.forEach(function (lbl) {
      const h = _el("div",
        "font-family:'Oswald',sans-serif;font-size:1.3vh;font-weight:700;" +
        "letter-spacing:0.12em;color:" + P.dim + ";text-transform:uppercase;"
      );
      h.textContent = lbl;
      colHdr.appendChild(h);
    });
    container.appendChild(colHdr);

    // Scrollable rows area
    const body = _el("div",
      "flex:1;overflow-y:auto;min-height:0;" +
      // Hide scrollbar visually — projector display
      "scrollbar-width:none;"
    );
    body.style.msOverflowStyle = "none";

    const useTwoCol = rows.length > SINGLE_COL_MAX;

    if (useTwoCol) {
      // Two-column grid: split rows roughly evenly
      const mid = Math.ceil(rows.length / 2);
      const col1 = rows.slice(0, mid);
      const col2 = rows.slice(mid);

      const grid = _el("div",
        "display:grid;grid-template-columns:1fr 1fr;" +
        "gap:0;height:100%;"
      );

      const leftCol  = _el("div", "display:flex;flex-direction:column;border-right:2px solid " + P.border + ";");
      const rightCol = _el("div", "display:flex;flex-direction:column;");

      col1.forEach(function (r) { leftCol.appendChild(_buildRow(r, 2)); });
      col2.forEach(function (r) { rightCol.appendChild(_buildRow(r, 2)); });

      grid.appendChild(leftCol);
      grid.appendChild(rightCol);
      body.appendChild(grid);
    } else {
      rows.forEach(function (r) { body.appendChild(_buildRow(r, 1)); });
    }

    container.appendChild(body);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * mountSchedule(container, teamName, opts)
   *
   * @param {Element}  container  — DOM element to render into (replaces contents)
   * @param {string}   teamName   — Team name, location, or abbreviation (case-insensitive).
   *                               Examples: "Colorado", "COLO", "Georgia Tech", "GT"
   * @param {object}   [opts]
   *   @param {function} [opts.onEmpty]  — called if ESPN returns no games for this team/season
   *   @param {function} [opts.onError]  — called on fetch/parse failure: onError(err)
   *
   * Renders a full-season schedule list optimized for a dark projector screen.
   * Layout: header (team logo + name + record) then one row per game showing
   * WEEK · DATE · opponent logo · vs/@[rank]ABBR · result or kickoff time · TV network.
   * The current or next game is subtly highlighted. Bye weeks are absent (ESPN omits them).
   * Switches to a two-column layout automatically when the season has > 8 games.
   *
   * Security: all ESPN-sourced strings are assigned via textContent only. No innerHTML
   * is ever used with API data.
   */
  async function mountSchedule(container, teamName, opts) {
    opts = opts || {};
    stopSchedule();
    _container = container;
    _active = true;

    // Show a loading state while fetching
    container.replaceChildren();
    container.style.cssText =
      "display:flex;align-items:center;justify-content:center;" +
      "width:100%;height:100%;background:" + P.bg + ";";
    const loading = _el("div",
      "font-family:'Oswald',sans-serif;font-size:2.4vh;font-weight:700;" +
      "color:" + P.dim + ";letter-spacing:0.14em;text-transform:uppercase;"
    );
    loading.textContent = "LOADING SCHEDULE…";
    container.appendChild(loading);

    let teamInfo;
    if (opts.teamId) {
      // caller pre-resolved the ESPN id (the teams-list endpoint is CORS-blocked in-browser)
      teamInfo = { id: String(opts.teamId), name: teamName || "", abbrev: "", record: "" };
    } else {
      try {
        teamInfo = await _resolveTeam(teamName);
      } catch (err) {
        _active = false;
        if (opts.onError) opts.onError(err);
        return;
      }
    }
    if (!_active) return;

    let schedData;
    try {
      schedData = await _fetchSchedule(teamInfo.id);
    } catch (err) {
      _active = false;
      if (opts.onError) opts.onError(err);
      return;
    }
    if (!_active) return;

    // Merge richer team info from schedule response (has recordSummary)
    const schedTeam = schedData.team || {};
    const mergedInfo = Object.assign({}, teamInfo, {
      displayName: schedTeam.displayName || teamInfo.displayName,
      location:    schedTeam.location    || teamInfo.location,
      // id stays from the resolve step — it's already correct
    });
    const record = schedTeam.recordSummary || "";

    let rows;
    try {
      rows = _parseRows(schedData, teamInfo.id);
    } catch (err) {
      _active = false;
      if (opts.onError) opts.onError(new Error("Parse error: " + err.message));
      return;
    }
    if (!_active) return;

    if (!rows || !rows.length) {
      _active = false;
      if (opts.onEmpty) opts.onEmpty();
      return;
    }

    _buildSchedule(container, mergedInfo, record, rows);
  }

  /**
   * stopSchedule()
   * Clears container reference and marks module inactive.
   * Call before switching scenes or changing team.
   */
  function stopSchedule() {
    _active = false;
    _container = null;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  root.mountSchedule = mountSchedule;
  root.stopSchedule  = stopSchedule;

}(typeof window !== "undefined" ? window : this));
