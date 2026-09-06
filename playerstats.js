/**
 * playerstats.js — ESPN CFB player box-score stats module
 * Projector Scoreboard | Vanilla JS, no frameworks
 *
 * Usage:
 *   mountPlayerStats(container, eventId, teamKey, { onEmpty, onError })
 *   stopPlayerStats()
 *
 * Data path: ESPN summary endpoint — direct client-side fetch, CORS-open.
 *   https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=<ID>
 *
 * Verified label→index mapping (event 401856776, CU @ Georgia Tech, Final 14-13):
 *   passing:   labels ['C/ATT','YDS','AVG','TD','INT','QBR']  → C/ATT=0 YDS=1 TD=3 INT=4
 *   rushing:   labels ['CAR','YDS','AVG','TD','LONG']         → CAR=0  YDS=1 TD=3
 *   receiving: labels ['REC','YDS','AVG','TD','LONG']         → REC=0  YDS=1 TD=3
 *   defensive: labels ['TOT','SOLO','SACKS','TFL','PD','QB HUR','TD'] → TOT=0 SOLO=1 SACKS=2
 *   interceptions (separate category): labels ['INT','YDS','TD']     → INT=0
 *
 * Layout: 4-column wide projector layout — PASSING | RUSHING | RECEIVING | DEFENSE
 * Security: all ESPN-sourced strings assigned via textContent only, never innerHTML.
 */

(function (root) {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────
  const SUMMARY_URL =
    "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=";

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

  // Projector palette — matches highlights.js
  const P = {
    bg:      "#08090b",
    surface: "#0f1318",
    border:  "#1e242c",
    label:   "#FFE84D",   // gold
    text:    "#ffffff",
    dim:     "#7a8290",
    live:    "#FF6A00",
    header:  "#13181f",
  };

  // Max rows per column so nothing bleeds off a projector screen
  const MAX_ROWS = 6;

  // ── Module state ───────────────────────────────────────────────────────────
  let _container = null;
  let _active    = false;

  // ── Label→index maps (verified against real ESPN data) ────────────────────
  // We resolve these dynamically at runtime from `stat.labels` so mismatches
  // are caught at parse time rather than silently producing wrong numbers.
  // The constants below are the expected label strings, not hardcoded indices.

  const PASSING_COLS = [
    { label: "C/ATT", key: "CATT" },
    { label: "YDS",   key: "YDS"  },
    { label: "TD",    key: "TD"   },
    { label: "INT",   key: "INT"  },
  ];
  const RUSHING_COLS = [
    { label: "CAR", key: "CAR" },
    { label: "YDS", key: "YDS" },
    { label: "TD",  key: "TD"  },
  ];
  const RECEIVING_COLS = [
    { label: "REC", key: "REC" },
    { label: "YDS", key: "YDS" },
    { label: "TD",  key: "TD"  },
  ];
  const DEFENSIVE_COLS = [
    { label: "TOT",   key: "TOT"   },
    { label: "SOLO",  key: "SOLO"  },
    { label: "SACKS", key: "SACK"  },
    { label: "INT",   key: "INT"   }, // merged from interceptions category
  ];

  // ── Fetch + parse ──────────────────────────────────────────────────────────

  async function _fetchSummary(eventId) {
    const url = SUMMARY_URL + encodeURIComponent(eventId);
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
        "Origin": "https://www.espn.com",
      },
    });
    if (!res.ok) throw new Error("ESPN summary HTTP " + res.status);
    return res.json();
  }

  function _buildIdxMap(labels) {
    // Returns { LABEL: index } for a category's labels array
    const m = {};
    labels.forEach(function (lbl, i) { m[lbl] = i; });
    return m;
  }

  function _parseAthletes(stat, colDefs, sortKey) {
    // colDefs: [{label, key}] — label is the ESPN label string, key is our internal name
    const idx = _buildIdxMap(stat.labels || []);
    const rows = (stat.athletes || [])
      .filter(function (a) {
        // Skip " Team" pseudo-athletes (their displayName starts with space or is "Team")
        const name = (a.athlete && a.athlete.displayName) || "";
        return name && name.trim() !== "Team";
      })
      .map(function (a) {
        const vals = a.stats || [];
        const row = { name: (a.athlete.displayName || "").trim() };
        colDefs.forEach(function (col) {
          if (col.label === "INT" && col.key === "INT" && !(col.label in idx)) {
            // INT on defensive category — will be merged externally
            row[col.key] = null;
          } else {
            const i = idx[col.label];
            row[col.key] = (i !== undefined && vals[i] !== undefined) ? vals[i] : null;
          }
        });
        return row;
      });

    // Sort descending by sortKey's numeric value; nulls and "-" to the end
    const sortIdx = colDefs.findIndex(function (c) { return c.key === sortKey; });
    if (sortIdx >= 0) {
      rows.sort(function (a, b) {
        const av = parseFloat(a[colDefs[sortIdx].key]) || 0;
        const bv = parseFloat(b[colDefs[sortIdx].key]) || 0;
        return bv - av;
      });
    }

    return rows.slice(0, MAX_ROWS);
  }

  function _parseData(data, teamKey) {
    // ── Status line ───────────────────────────────────────────────────────
    const comp  = data.header && data.header.competitions && data.header.competitions[0];
    const teams = (comp && comp.competitors) || [];

    // Find target team and opponent
    const tk = teamKey.toLowerCase();
    let targetTeam = null, opponentTeam = null;
    teams.forEach(function (c) {
      const t = c.team || {};
      const abbr = (t.abbreviation || "").toLowerCase();
      const loc  = (t.location || "").toLowerCase();
      const name = (t.displayName || "").toLowerCase();
      if (abbr === tk || loc === tk || name.includes(tk)) {
        targetTeam = c;
      } else {
        opponentTeam = c;
      }
    });

    // Status text
    const status = comp && comp.status;
    let statusText = "";
    if (status) {
      const desc = status.type && status.type.description;
      const clock = status.displayClock;
      const period = status.period;
      if (desc === "Final" || desc === "Final/OT") {
        statusText = desc.toUpperCase();
      } else if (clock && period) {
        statusText = "Q" + period + "  " + clock;
      } else if (desc) {
        statusText = desc.toUpperCase();
      }
    }

    // Score / header string
    let headerParts = { targetName: teamKey, oppName: "", score: "", status: statusText };
    if (targetTeam && opponentTeam) {
      const tt = targetTeam.team || {};
      const ot = opponentTeam.team || {};
      headerParts.targetName = tt.displayName || teamKey;
      headerParts.targetAbbr = tt.abbreviation || "";
      headerParts.oppName    = ot.displayName || "";
      headerParts.oppAbbr    = ot.abbreviation || "";
      headerParts.score      = targetTeam.score + " – " + opponentTeam.score;
    }

    // ── Boxscore players ──────────────────────────────────────────────────
    const bpEntries = (data.boxscore && data.boxscore.players) || [];
    let teamEntry = null;
    bpEntries.forEach(function (entry) {
      const t = entry.team || {};
      const abbr = (t.abbreviation || "").toLowerCase();
      const loc  = (t.location || "").toLowerCase();
      const name = (t.displayName || "").toLowerCase();
      if (abbr === tk || loc === tk || name.includes(tk)) {
        teamEntry = entry;
      }
    });

    if (!teamEntry) return { headerParts, passing: [], rushing: [], receiving: [], defensive: [], empty: true };

    const stats = teamEntry.statistics || [];
    const byName = {};
    stats.forEach(function (s) { byName[s.name] = s; });

    // ── Passing ───────────────────────────────────────────────────────────
    const passing = byName.passing
      ? _parseAthletes(byName.passing, PASSING_COLS, "YDS")
      : [];

    // ── Rushing ───────────────────────────────────────────────────────────
    const rushing = byName.rushing
      ? _parseAthletes(byName.rushing, RUSHING_COLS, "YDS")
      : [];

    // ── Receiving ─────────────────────────────────────────────────────────
    const receiving = byName.receiving
      ? _parseAthletes(byName.receiving, RECEIVING_COLS, "YDS")
      : [];

    // ── Defensive — merge INT from interceptions category ─────────────────
    let defRows = [];
    if (byName.defensive) {
      defRows = _parseAthletes(byName.defensive, DEFENSIVE_COLS, "TOT");
    }

    // Build INT lookup from interceptions category (may have zero athletes)
    const intLookup = {};
    if (byName.interceptions) {
      const intStat = byName.interceptions;
      const intIdx  = _buildIdxMap(intStat.labels || []);
      const ii      = intIdx["INT"];
      (intStat.athletes || []).forEach(function (a) {
        const name = (a.athlete && a.athlete.displayName || "").trim();
        if (name && name !== "Team" && ii !== undefined) {
          intLookup[name] = a.stats[ii] || "0";
        }
      });
    }

    // Merge INT into defensive rows; default "0"
    defRows.forEach(function (row) {
      if (row.INT === null) {
        row.INT = intLookup[row.name] || "0";
      }
    });

    const hasStats = passing.length || rushing.length || receiving.length || defRows.length;

    return {
      headerParts,
      passing,
      rushing,
      receiving,
      defensive: defRows,
      empty: !hasStats,
    };
  }

  // ── DOM builders ───────────────────────────────────────────────────────────

  // Safe text node helper — never innerHTML with API data
  function _t(str) {
    return document.createTextNode(str === null || str === undefined ? "" : String(str));
  }

  function _el(tag, cssText, cls) {
    const e = document.createElement(tag);
    if (cssText) e.style.cssText = cssText;
    if (cls) e.className = cls;
    return e;
  }

  function _buildHeader(container, hp) {
    const bar = _el("div",
      "display:flex;align-items:baseline;justify-content:space-between;" +
      "padding:1.1vh 1.8vw 0.9vh;" +
      "background:" + P.header + ";" +
      "border-bottom:1px solid " + P.border + ";" +
      "flex-shrink:0;"
    );

    // Team name (large)
    const nameEl = _el("span",
      "font-family:'Oswald',sans-serif;font-size:3.2vh;font-weight:700;" +
      "letter-spacing:0.04em;color:" + P.text + ";text-transform:uppercase;"
    );
    nameEl.textContent = hp.targetName;
    bar.appendChild(nameEl);

    // Score + status (right side)
    const right = _el("div", "display:flex;align-items:baseline;gap:1.4vw;");

    if (hp.oppName) {
      const vsEl = _el("span",
        "font-family:'Barlow Condensed',sans-serif;font-size:2vh;color:" + P.dim + ";"
      );
      vsEl.textContent = "vs " + hp.oppName;
      right.appendChild(vsEl);
    }

    if (hp.score) {
      const scoreEl = _el("span",
        "font-family:'Oswald',sans-serif;font-size:3vh;font-weight:600;color:" + P.text + ";"
      );
      scoreEl.textContent = hp.score;
      right.appendChild(scoreEl);
    }

    if (hp.status) {
      const isLive = hp.status.match(/^Q[1-4]/i);
      const statusEl = _el("span",
        "font-family:'Oswald',sans-serif;font-size:1.8vh;font-weight:700;" +
        "letter-spacing:0.12em;color:" + (isLive ? P.live : P.label) + ";" +
        "text-transform:uppercase;padding:0.25vh 0.7vw;border-radius:3px;" +
        (isLive ? "background:rgba(255,106,0,0.15);" : "")
      );
      statusEl.textContent = hp.status;
      right.appendChild(statusEl);
    }

    bar.appendChild(right);
    container.appendChild(bar);
  }

  function _buildStatTable(title, colDefs, rows) {
    // Returns a column card element
    const card = _el("div",
      "flex:1;min-width:0;display:flex;flex-direction:column;" +
      "background:" + P.surface + ";border-radius:6px;overflow:hidden;" +
      "border:1px solid " + P.border + ";"
    );

    // Column title
    const titleEl = _el("div",
      "font-family:'Oswald',sans-serif;font-size:1.7vh;font-weight:700;" +
      "letter-spacing:0.14em;color:" + P.label + ";text-transform:uppercase;" +
      "padding:0.7vh 0.9vw;background:" + P.header + ";border-bottom:1px solid " + P.border + ";"
    );
    titleEl.textContent = title;
    card.appendChild(titleEl);

    if (!rows.length) {
      const empty = _el("div",
        "padding:1.5vh 0.9vw;color:" + P.dim + ";font-size:1.6vh;" +
        "font-family:'Barlow Condensed',sans-serif;"
      );
      empty.textContent = "No data";
      card.appendChild(empty);
      return card;
    }

    // Header row (stat labels)
    const hdr = _el("div",
      "display:grid;" +
      _gridTemplate(colDefs.length) + ";" +
      "padding:0.45vh 0.9vw;border-bottom:1px solid " + P.border + ";" +
      "gap:0 0.5vw;"
    );

    // Player label
    const plHdr = _el("div",
      "font-family:'Oswald',sans-serif;font-size:1.3vh;font-weight:700;" +
      "letter-spacing:0.10em;color:" + P.dim + ";text-transform:uppercase;overflow:hidden;"
    );
    plHdr.textContent = "PLAYER";
    hdr.appendChild(plHdr);

    colDefs.forEach(function (col) {
      const ch = _el("div",
        "font-family:'Oswald',sans-serif;font-size:1.3vh;font-weight:700;" +
        "letter-spacing:0.10em;color:" + P.dim + ";text-transform:uppercase;" +
        "text-align:right;"
      );
      ch.textContent = col.label;
      hdr.appendChild(ch);
    });
    card.appendChild(hdr);

    // Data rows
    rows.forEach(function (row, ri) {
      const tr = _el("div",
        "display:grid;" +
        _gridTemplate(colDefs.length) + ";" +
        "padding:0.55vh 0.9vw;gap:0 0.5vw;" +
        (ri % 2 === 1 ? "background:rgba(255,255,255,0.025);" : "")
      );

      // Player name — truncate if too long
      const nameCell = _el("div",
        "font-family:'Barlow Condensed',sans-serif;font-size:1.9vh;font-weight:500;" +
        "color:" + P.text + ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
      );
      nameCell.textContent = row.name;
      tr.appendChild(nameCell);

      colDefs.forEach(function (col) {
        const cell = _el("div",
          "font-family:'Barlow Condensed',sans-serif;font-size:1.9vh;font-weight:600;" +
          "color:" + P.text + ";text-align:right;"
        );
        const val = row[col.key];
        cell.textContent = (val === null || val === undefined || val === "") ? "—" : val;
        tr.appendChild(cell);
      });

      card.appendChild(tr);
    });

    return card;
  }

  function _gridTemplate(numStatCols) {
    // Player name gets remaining space; stat cols are fixed narrow
    return "grid-template-columns:1fr " + Array(numStatCols).fill("5.5ch").join(" ");
  }

  function _buildGrid(container, parsed) {
    const grid = _el("div",
      "display:flex;gap:0.8vw;padding:0.8vw;flex:1;min-height:0;align-items:stretch;"
    );

    // PASSING: show C/ATT, YDS, TD, INT
    const passingColDefs = [
      { label: "C/ATT", key: "CATT" },
      { label: "YDS",   key: "YDS"  },
      { label: "TD",    key: "TD"   },
      { label: "INT",   key: "INT"  },
    ];
    grid.appendChild(_buildStatTable("PASSING",   passingColDefs,  parsed.passing));

    // RUSHING: CAR, YDS, TD
    const rushColDefs = [
      { label: "CAR", key: "CAR" },
      { label: "YDS", key: "YDS" },
      { label: "TD",  key: "TD"  },
    ];
    grid.appendChild(_buildStatTable("RUSHING",   rushColDefs,     parsed.rushing));

    // RECEIVING: REC, YDS, TD
    const recColDefs = [
      { label: "REC", key: "REC" },
      { label: "YDS", key: "YDS" },
      { label: "TD",  key: "TD"  },
    ];
    grid.appendChild(_buildStatTable("RECEIVING", recColDefs,      parsed.receiving));

    // DEFENSE: TOT, SOLO, SACKS, INT
    const defColDefs = [
      { label: "TOT",  key: "TOT"  },
      { label: "SOLO", key: "SOLO" },
      { label: "SACK", key: "SACK" },
      { label: "INT",  key: "INT"  },
    ];
    grid.appendChild(_buildStatTable("DEFENSE",   defColDefs,      parsed.defensive));

    container.appendChild(grid);
  }

  function _buildDOM(container, parsed) {
    container.replaceChildren();
    container.style.cssText =
      "display:flex;flex-direction:column;width:100%;height:100%;" +
      "background:" + P.bg + ";overflow:hidden;";

    _buildHeader(container, parsed.headerParts);
    _buildGrid(container, parsed);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * mountPlayerStats(container, eventId, teamKey, opts)
   *
   * @param {Element}  container — DOM element to render into (replaces contents)
   * @param {string}   eventId   — ESPN event id (e.g. "401856776")
   * @param {string}   teamKey   — team to display: abbreviation, location, or partial name
   *                               (case-insensitive, e.g. "COLO", "Colorado", "colorado")
   * @param {object}   [opts]
   *   @param {function} [opts.onEmpty]  — called if ESPN has no player stats yet (upcoming/early game)
   *   @param {function} [opts.onError]  — called on fetch failure: onError(err)
   *
   * Shows one team's box score: PASSING | RUSHING | RECEIVING | DEFENSE across a
   * wide 4-column projector layout. Header shows team, opponent, score, and game status.
   *
   * Security: all ESPN-sourced strings are assigned via textContent only. No innerHTML
   * is ever used with API data. A security hook enforces this rule.
   */
  async function mountPlayerStats(container, eventId, teamKey, opts) {
    opts = opts || {};
    stopPlayerStats();
    _container = container;
    _active = true;

    let data;
    try {
      data = await _fetchSummary(eventId);
    } catch (err) {
      _active = false;
      if (opts.onError) opts.onError(err);
      return;
    }

    if (!_active) return; // stopPlayerStats() called during fetch

    let parsed;
    try {
      parsed = _parseData(data, teamKey);
    } catch (err) {
      _active = false;
      if (opts.onError) opts.onError(new Error("Parse error: " + err.message));
      return;
    }

    if (parsed.empty) {
      _active = false;
      if (opts.onEmpty) opts.onEmpty();
      return;
    }

    _buildDOM(container, parsed);
  }

  /**
   * stopPlayerStats()
   * Clears container reference and marks module inactive.
   * Call before switching scenes or changing event/team.
   */
  function stopPlayerStats() {
    _active = false;
    _container = null;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  root.mountPlayerStats = mountPlayerStats;
  root.stopPlayerStats  = stopPlayerStats;

}(typeof window !== "undefined" ? window : this));
