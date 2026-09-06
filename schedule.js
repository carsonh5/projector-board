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

  /**
   * Determine how many columns to use.
   * ≤ 9 games  → 3 columns (3×3)
   * 10-12 games → 3 columns (4/4/4 or similar)
   * > 12 games  → 4 columns
   */
  function _colCount(gameCount) {
    return gameCount > 12 ? 4 : 3;
  }

  /** Derive season year from the first game's ISO date string. Falls back to current year. */
  function _seasonYear(rows) {
    if (rows && rows.length && rows[0].dateISO) {
      const y = parseInt(rows[0].dateISO.slice(0, 4), 10);
      if (y > 2000 && y < 2100) return String(y);
    }
    return String(new Date().getFullYear());
  }

  function _buildCenteredHeader(container, teamInfo, record, rows) {
    const bar = _el("div",
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "padding:1.6vh 2vw 1.4vh;" +
      "background:" + P.header + ";" +
      "border-bottom:2px solid " + P.border + ";" +
      "flex-shrink:0;" +
      "gap:0.5vh;"
    );

    // Top row: logo + team name (large, centered)
    const nameRow = _el("div",
      "display:flex;align-items:center;justify-content:center;gap:1.4vw;"
    );

    if (teamInfo.id) {
      const logoWrap = _el("div",
        "width:7vh;height:7vh;flex-shrink:0;" +
        "background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
        "overflow:hidden;"
      );
      const img = document.createElement("img");
      img.src = LOGO_BASE + teamInfo.id + ".png";
      img.alt = "";
      img.style.cssText = "width:5.6vh;height:5.6vh;object-fit:contain;display:block;";
      img.onerror = function () { logoWrap.style.display = "none"; };
      logoWrap.appendChild(img);
      nameRow.appendChild(logoWrap);
    }

    const nameEl = _el("span",
      "font-family:'Oswald',sans-serif;font-size:5vh;font-weight:700;" +
      "letter-spacing:0.04em;color:" + P.text + ";text-transform:uppercase;" +
      "white-space:nowrap;"
    );
    nameEl.textContent = teamInfo.displayName || teamInfo.location || "";
    nameRow.appendChild(nameEl);

    bar.appendChild(nameRow);

    // Bottom row: season label + record
    const subRow = _el("div",
      "display:flex;align-items:center;justify-content:center;gap:2vw;"
    );

    const seasonEl = _el("span",
      "font-family:'Barlow Condensed',sans-serif;font-size:2.4vh;font-weight:600;" +
      "color:" + P.label + ";letter-spacing:0.14em;text-transform:uppercase;"
    );
    seasonEl.textContent = _seasonYear(rows) + " SCHEDULE";
    subRow.appendChild(seasonEl);

    if (record) {
      const sep = _el("span",
        "font-family:'Barlow Condensed',sans-serif;font-size:2.2vh;color:" + P.border + ";"
      );
      sep.textContent = "|";
      subRow.appendChild(sep);

      const recEl = _el("span",
        "font-family:'Oswald',sans-serif;font-size:2.4vh;font-weight:600;" +
        "color:" + P.dim + ";letter-spacing:0.08em;"
      );
      recEl.textContent = record;
      subRow.appendChild(recEl);
    }

    bar.appendChild(subRow);
    container.appendChild(bar);
  }

  /**
   * Build a single compact game card.
   * Layout (three lines stacked):
   *   Line 1: DATE  ·  vs/@ [#RANK] OPPABBR  (opp logo inline)
   *   Line 2: result string (W/L+score) OR kickoff time
   *   Line 3: TV network (only for upcoming games)
   *
   * Deliberately taller and larger text than the old row design.
   */
  function _buildCard(row) {
    const bgColor = row.isCurrent ? P.current : "transparent";
    const borderLeft = row.isCurrent
      ? "border-left:3px solid " + P.label + ";"
      : "border-left:3px solid transparent;";

    const card = _el("div",
      "display:flex;flex-direction:column;justify-content:center;" +
      "padding:1.1vh 1.1vw 1.0vh 0.9vw;" +
      "background:" + bgColor + ";" +
      borderLeft +
      "border-bottom:1px solid " + P.border + ";" +
      "min-width:0;box-sizing:border-box;"
    );

    // ── Line 1: date + opponent ──────────────────────────────────────────────
    const line1 = _el("div",
      "display:flex;align-items:center;gap:0.55vw;min-width:0;flex-wrap:nowrap;"
    );

    // Date chip
    const dateEl = _el("span",
      "font-family:'Oswald',sans-serif;font-size:2.3vh;font-weight:600;" +
      "color:" + P.dim + ";white-space:nowrap;flex-shrink:0;" +
      "letter-spacing:0.04em;"
    );
    dateEl.textContent = row.dateDisp;
    line1.appendChild(dateEl);

    // Thin separator dot
    const dot = _el("span",
      "color:" + P.border + ";font-size:2.3vh;flex-shrink:0;margin:0 0.1vw;"
    );
    dot.textContent = "·";
    line1.appendChild(dot);

    // Opponent logo (small)
    const logoWrap = _el("div",
      "width:3vh;height:3vh;flex-shrink:0;" +
      "background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
      "overflow:hidden;"
    );
    if (row.oppId) {
      const img = document.createElement("img");
      img.src = LOGO_BASE + row.oppId + ".png";
      img.alt = "";
      img.style.cssText = "width:2.3vh;height:2.3vh;object-fit:contain;display:block;";
      img.onerror = function () {
        logoWrap.style.background = P.surface;
        logoWrap.style.border = "1px solid " + P.border;
      };
      logoWrap.appendChild(img);
    } else {
      logoWrap.style.background = P.surface;
    }
    line1.appendChild(logoWrap);

    // vs/@ marker
    const vsSpan = _el("span",
      "font-family:'Barlow Condensed',sans-serif;font-size:2.2vh;font-weight:500;" +
      "color:" + P.dim + ";flex-shrink:0;"
    );
    vsSpan.textContent = row.vsAt;
    line1.appendChild(vsSpan);

    // Rank (if any)
    if (row.oppRank) {
      const rnk = _el("span",
        "font-family:'Oswald',sans-serif;font-size:2vh;font-weight:700;" +
        "color:" + P.rank + ";flex-shrink:0;letter-spacing:0.02em;"
      );
      rnk.textContent = "#" + row.oppRank;
      line1.appendChild(rnk);
    }

    // Opponent abbreviation
    const abbrEl = _el("span",
      "font-family:'Barlow Condensed',sans-serif;font-size:2.6vh;font-weight:700;" +
      "color:" + P.text + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "min-width:0;letter-spacing:0.03em;"
    );
    abbrEl.textContent = row.oppAbbr;
    line1.appendChild(abbrEl);

    card.appendChild(line1);

    // ── Line 2: result or kickoff time ───────────────────────────────────────
    let resultColor = P.dim;
    if (row.resultClass === "win")  resultColor = P.win;
    if (row.resultClass === "loss") resultColor = P.loss;
    if (row.resultClass === "live") resultColor = P.live;

    // For win/loss: show W/L bold + score dimmer
    const line2 = _el("div",
      "display:flex;align-items:baseline;gap:0.4vw;margin-top:0.35vh;min-width:0;"
    );

    if (row.resultClass === "win" || row.resultClass === "loss") {
      // Split "W 35-14" → badge + score
      const parts = row.result.split(" ");
      const badge = parts[0] || "";   // "W" or "L"
      const score = parts.slice(1).join(" ");

      const badgeEl = _el("span",
        "font-family:'Oswald',sans-serif;font-size:2.6vh;font-weight:700;" +
        "color:" + resultColor + ";letter-spacing:0.06em;flex-shrink:0;"
      );
      badgeEl.textContent = badge;
      line2.appendChild(badgeEl);

      if (score) {
        const scoreEl = _el("span",
          "font-family:'Barlow Condensed',sans-serif;font-size:2.3vh;font-weight:600;" +
          "color:" + P.dim + ";white-space:nowrap;"
        );
        scoreEl.textContent = score;
        line2.appendChild(scoreEl);
      }
    } else if (row.resultClass === "live") {
      const liveEl = _el("span",
        "font-family:'Barlow Condensed',sans-serif;font-size:2.3vh;font-weight:700;" +
        "color:" + P.live + ";white-space:nowrap;" +
        "background:rgba(255,106,0,0.12);border-radius:3px;padding:0.1vh 0.4vw;"
      );
      liveEl.textContent = row.result;
      line2.appendChild(liveEl);
    } else {
      // Upcoming: kickoff time
      const timeEl = _el("span",
        "font-family:'Barlow Condensed',sans-serif;font-size:2.3vh;font-weight:600;" +
        "color:" + P.dim + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
      );
      timeEl.textContent = row.result;  // e.g. "9/12 - 3:30 PM EDT" or "TBD"
      line2.appendChild(timeEl);

      // TV network inline on the same line for upcoming games (saves vertical space)
      if (row.tv) {
        const tvSep = _el("span",
          "color:" + P.border + ";font-size:2.2vh;flex-shrink:0;margin:0 0.2vw;"
        );
        tvSep.textContent = "·";
        line2.appendChild(tvSep);

        const tvEl = _el("span",
          "font-family:'Barlow Condensed',sans-serif;font-size:2.2vh;font-weight:600;" +
          "color:" + P.dim + ";white-space:nowrap;flex-shrink:0;"
        );
        tvEl.textContent = row.tv;
        line2.appendChild(tvEl);
      }
    }

    card.appendChild(line2);

    return card;
  }

  function _buildSchedule(container, teamInfo, record, rows) {
    container.replaceChildren();
    container.style.cssText =
      "display:flex;flex-direction:column;width:100%;height:100%;" +
      "background:" + P.bg + ";overflow:hidden;box-sizing:border-box;";

    _buildCenteredHeader(container, teamInfo, record, rows);

    // ── Multi-column grid body ──────────────────────────────────────────────
    const numCols = _colCount(rows.length);
    const colSize = Math.ceil(rows.length / numCols);

    // Build column arrays: top-to-bottom reading order within each column
    const columns = [];
    for (let c = 0; c < numCols; c++) {
      columns.push(rows.slice(c * colSize, c * colSize + colSize));
    }

    // Outer body: takes all remaining height, no scroll (projector — fit it)
    const body = _el("div",
      "flex:1;display:grid;min-height:0;" +
      "grid-template-columns:repeat(" + numCols + ",1fr);" +
      "gap:0;"
    );

    columns.forEach(function (colRows, ci) {
      const borderStyle = ci < numCols - 1
        ? "border-right:1px solid " + P.border + ";"
        : "";

      const colEl = _el("div",
        "display:flex;flex-direction:column;" + borderStyle
      );

      // Column header label bar
      const colHdrEl = _el("div",
        "display:flex;align-items:center;gap:0.6vw;" +
        "padding:0.5vh 1.1vw 0.45vh 0.9vw;" +
        "background:" + P.header + ";" +
        "border-bottom:1px solid " + P.border + ";" +
        "flex-shrink:0;"
      );
      const colHdrText = _el("span",
        "font-family:'Oswald',sans-serif;font-size:1.5vh;font-weight:700;" +
        "letter-spacing:0.14em;color:" + P.dim + ";text-transform:uppercase;"
      );
      colHdrText.textContent = "DATE  ·  OPPONENT";
      colHdrEl.appendChild(colHdrText);
      colEl.appendChild(colHdrEl);

      // Cards
      colRows.forEach(function (r) {
        colEl.appendChild(_buildCard(r));
      });

      body.appendChild(colEl);
    });

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
   * Renders a full-season schedule optimized for a dark projector screen.
   * Layout: centered header (team logo + name + season label + record), then
   * a 3-column grid (4 columns if > 12 games). Each game card shows date,
   * opponent logo + vs/@[rank]ABBR, and either the final result (W/L + score)
   * or kickoff time + TV for upcoming games. Current/next game is highlighted.
   * Bye weeks are absent (ESPN omits them from events[]).
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
