/**
 * standings.js — ESPN CFB conference standings module
 * Projector Scoreboard | Vanilla JS, no frameworks
 *
 * Usage:
 *   mountStandings(container, conferenceName, { onEmpty, onError })
 *   stopStandings()
 *
 * Data path: ESPN standings v2 endpoint — direct client-side fetch, CORS-open.
 *   https://site.api.espn.com/apis/v2/sports/football/college-football/standings?season=<YEAR>
 *
 * Data source: Option A (ESPN client-side). No proxy needed.
 *
 * API structure verified 2026-09-05 against live SEC / Big 12 data:
 *   response.children[] — one entry per conference
 *     .name              — "Southeastern Conference"
 *     .abbreviation      — "sec"
 *     .standings.entries[] — one per team
 *       .team.abbreviation   — "ALA"
 *       .team.displayName    — "Alabama Crimson Tide"
 *       .team.logos[0].href  — logo CDN URL
 *       .stats[] — flat array, multiple stat blocks merged in; scan by name:
 *         name="overall"      shortDisplayName="OVER"  displayValue="1-0"
 *         name="vs. Conf."    shortDisplayName="CONF"  displayValue="0-0"
 *         name="wins"         shortDisplayName="W"     value=1.0
 *         name="playoffSeed"  shortDisplayName="POS"   value=1.0  (ESPN rank, use for tiebreak)
 *
 * Sort: conf wins desc → conf losses asc → overall wins desc → ESPN playoffSeed asc
 *
 * Security: all ESPN-sourced strings assigned via textContent only, never innerHTML.
 */

(function (root) {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────

  // League-aware: window.BOARD_LEAGUE is the ESPN path segment ("college-football" | "nfl").
  // NOTE: NFL standings are shaped differently (AFC/NFC -> divisions); NFL standings rendering is a
  // follow-up — the board guards the standings scene for NFL so this isn't hit with the CFB parser yet.
  function _lg(){ return (typeof window !== "undefined" && window.BOARD_LEAGUE) || "college-football"; }
  function _standingsBase(){ return "https://site.api.espn.com/apis/v2/sports/football/" + _lg() + "/standings?season="; }

  // Dynamically detect current CFB season: season flips to new year after July 1
  function _currentSeason() {
    var d = new Date();
    return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  }

  // Map of caller-facing conference names → ESPN abbreviation
  // ESPN uses lowercase abbreviations in the response
  const CONF_ALIAS = {
    // SEC
    "sec":                              "sec",
    "southeastern":                     "sec",
    "southeastern conference":          "sec",
    // Big Ten
    "big ten":                          "big10",
    "big 10":                           "big10",
    "big10":                            "big10",
    "big ten conference":               "big10",
    // Big 12
    "big 12":                           "big12",
    "big12":                            "big12",
    "big 12 conference":                "big12",
    // ACC
    "acc":                              "acc",
    "atlantic coast":                   "acc",
    "atlantic coast conference":        "acc",
    // Mountain West
    "mountain west":                    "mwest",
    "mw":                               "mwest",
    "mwest":                            "mwest",
    "mountain west conference":         "mwest",
    // American
    "aac":                              "american",
    "american":                         "american",
    "american conference":              "american",
    "american athletic":                "american",
    "american athletic conference":     "american",
    // Pac-12
    "pac-12":                           "pac12",
    "pac 12":                           "pac12",
    "pac12":                            "pac12",
    "pac-12 conference":                "pac12",
    // Sun Belt
    "sun belt":                         "belt",
    "belt":                             "belt",
    "sun belt conference":              "belt",
    // MAC
    "mac":                              "midam",
    "mid-american":                     "midam",
    "mid american":                     "midam",
    "midam":                            "midam",
    "mid-american conference":          "midam",
    // Conference USA
    "cusa":                             "usa",
    "conference usa":                   "usa",
    "c-usa":                            "usa",
    "usa":                              "usa",
  };

  // Projector palette — matches playerstats.js / highlights.js
  const P = {
    bg:      "#08090b",
    surface: "#0f1318",
    border:  "#1e242c",
    label:   "#FFE84D",   // gold
    text:    "#ffffff",
    dim:     "#7a8290",
    live:    "#FF6A00",
    header:  "#13181f",
    alt:     "rgba(255,255,255,0.025)",
  };

  // ── Module state ───────────────────────────────────────────────────────────
  let _container = null;
  let _active    = false;

  // ── Conference resolution ──────────────────────────────────────────────────

  function _resolveConf(name) {
    // Returns the ESPN abbreviation for a caller-supplied conference name.
    // Returns null if not recognized.
    var key = (name || "").trim().toLowerCase();
    return CONF_ALIAS[key] || null;
  }

  // ── Fetch + parse ──────────────────────────────────────────────────────────

  async function _fetchStandings(season) {
    var url = _standingsBase() + encodeURIComponent(season);
    var res = await fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
        "Origin": "https://www.espn.com",
      },
    });
    if (!res.ok) throw new Error("ESPN standings HTTP " + res.status);
    return res.json();
  }

  // Extract the first value for a stat field from an entry's stats array.
  // Matches by `shortDisplayName` (OVER, CONF, POS, W) or by `name`.
  function _statFirst(stats, matchFn) {
    for (var i = 0; i < stats.length; i++) {
      if (matchFn(stats[i])) return stats[i];
    }
    return null;
  }

  function _parseEntry(e) {
    var t      = e.team || {};
    var stats  = e.stats || [];

    // Overall record string e.g. "3-1"
    var overallStat = _statFirst(stats, function (s) {
      return s.shortDisplayName === "OVER" || s.name === "overall";
    });
    var overallDisp = overallStat ? (overallStat.displayValue || "0-0") : "0-0";

    // Conference record string e.g. "2-0"
    var confStat = _statFirst(stats, function (s) {
      return s.shortDisplayName === "CONF" || s.name === "vs. Conf.";
    });
    var confDisp = confStat ? (confStat.displayValue || "0-0") : "0-0";

    // Overall wins (numeric, for sort)
    var winsStat = _statFirst(stats, function (s) {
      return s.name === "wins" && s.shortDisplayName === "W";
    });
    var overallWins  = winsStat  ? (parseFloat(winsStat.value)  || 0) : 0;

    // ESPN playoff seed / position (numeric, tiebreak sort)
    var posStat = _statFirst(stats, function (s) {
      return s.name === "playoffSeed" && s.shortDisplayName === "POS";
    });
    var espnRank = posStat ? (parseFloat(posStat.value) || 999) : 999;

    // Conference wins/losses from displayValue "W-L"
    var confParts = confDisp.split("-");
    var confWins   = parseInt(confParts[0], 10) || 0;
    var confLosses = parseInt(confParts[1], 10) || 0;

    // Logo URL
    var logos = t.logos || [];
    var logoUrl = logos.length ? logos[0].href : "";

    return {
      abbr:        t.abbreviation || "",
      displayName: t.displayName  || t.abbreviation || "",
      logoUrl:     logoUrl,
      overall:     overallDisp,
      conf:        confDisp,
      overallWins: overallWins,
      confWins:    confWins,
      confLosses:  confLosses,
      espnRank:    espnRank,
    };
  }

  function _parseData(data, espnAbbr) {
    var children = data.children || [];

    // Find the conference block
    var confBlock = null;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if ((c.abbreviation || "").toLowerCase() === espnAbbr.toLowerCase()) {
        confBlock = c;
        break;
      }
    }

    if (!confBlock) return { confName: null, teams: [], empty: true };

    var entries = (confBlock.standings && confBlock.standings.entries) || [];
    if (!entries.length) return { confName: confBlock.name, teams: [], empty: true };

    var teams = entries.map(_parseEntry);

    // Sort: conf wins desc → conf losses asc → overall wins desc → espnRank asc
    teams.sort(function (a, b) {
      if (b.confWins  !== a.confWins)  return b.confWins  - a.confWins;
      if (a.confLosses !== b.confLosses) return a.confLosses - b.confLosses;
      if (b.overallWins !== a.overallWins) return b.overallWins - a.overallWins;
      return a.espnRank - b.espnRank;
    });

    return {
      confName: confBlock.name,
      teams:    teams,
      empty:    false,
    };
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

  // Safe text node — never innerHTML with API data
  function _t(str) {
    return document.createTextNode(
      str === null || str === undefined ? "" : String(str)
    );
  }

  function _el(tag, cssText, cls) {
    var e = document.createElement(tag);
    if (cssText) e.style.cssText = cssText;
    if (cls) e.className = cls;
    return e;
  }

  // ── DOM builder ────────────────────────────────────────────────────────────

  function _buildDOM(container, parsed, conferenceName) {
    container.replaceChildren();
    container.style.cssText =
      "display:flex;flex-direction:column;width:100%;height:100%;" +
      "background:" + P.bg + ";overflow:hidden;font-family:sans-serif;";

    // ── Header bar ────────────────────────────────────────────────────────
    var header = _el("div",
      "display:flex;align-items:center;padding:1.1vh 1.8vw 0.9vh;" +
      "background:" + P.header + ";border-bottom:1px solid " + P.border + ";" +
      "flex-shrink:0;"
    );

    var confLabel = _el("span",
      "font-family:'Oswald',sans-serif;font-size:3vh;font-weight:700;" +
      "letter-spacing:0.06em;color:" + P.label + ";text-transform:uppercase;"
    );
    confLabel.textContent = parsed.confName || conferenceName;
    header.appendChild(confLabel);

    var subLabel = _el("span",
      "font-family:'Barlow Condensed',sans-serif;font-size:1.8vh;" +
      "color:" + P.dim + ";margin-left:1.6vw;letter-spacing:0.05em;"
    );
    subLabel.textContent = "STANDINGS";
    header.appendChild(subLabel);

    container.appendChild(header);

    // ── Column headers ────────────────────────────────────────────────────
    var colHdr = _el("div",
      "display:grid;" +
      "grid-template-columns:3.5ch 1fr 8ch 8ch;" +
      "padding:0.5vh 1.4vw;" +
      "border-bottom:1px solid " + P.border + ";" +
      "flex-shrink:0;gap:0 0.8vw;"
    );

    var colLabels = ["#", "TEAM", "CONF", "OVERALL"];
    var colAligns = ["center", "left", "center", "center"];
    colLabels.forEach(function (lbl, i) {
      var ch = _el("div",
        "font-family:'Oswald',sans-serif;font-size:1.4vh;font-weight:700;" +
        "letter-spacing:0.12em;color:" + P.dim + ";text-transform:uppercase;" +
        "text-align:" + colAligns[i] + ";"
      );
      ch.textContent = lbl;
      colHdr.appendChild(ch);
    });
    container.appendChild(colHdr);

    // ── Team rows ─────────────────────────────────────────────────────────
    var rows = _el("div",
      "flex:1;overflow:hidden;display:flex;flex-direction:column;"
    );

    parsed.teams.forEach(function (team, i) {
      var row = _el("div",
        "display:grid;" +
        "grid-template-columns:3.5ch 1fr 8ch 8ch;" +
        "padding:0.7vh 1.4vw;gap:0 0.8vw;align-items:center;" +
        "flex-shrink:0;" +
        (i % 2 === 1 ? "background:" + P.alt + ";" : "")
      );

      // Rank number
      var rankCell = _el("div",
        "font-family:'Oswald',sans-serif;font-size:1.8vh;font-weight:600;" +
        "color:" + P.dim + ";text-align:center;"
      );
      rankCell.textContent = String(i + 1);
      row.appendChild(rankCell);

      // Team: logo + abbreviation
      var teamCell = _el("div",
        "display:flex;align-items:center;gap:0.7vw;min-width:0;"
      );

      if (team.logoUrl) {
        var logo = document.createElement("img");
        // Logo URL is from ESPN CDN — safe to use as img src (not in textContent/innerHTML)
        logo.src = team.logoUrl;
        logo.alt = "";   // decorative
        logo.style.cssText =
          "width:2.4vh;height:2.4vh;object-fit:contain;flex-shrink:0;" +
          "filter:drop-shadow(0 0 1px rgba(0,0,0,0.6));";
        logo.onerror = function () { this.style.display = "none"; };
        teamCell.appendChild(logo);
      }

      var abbrEl = _el("span",
        "font-family:'Barlow Condensed',sans-serif;font-size:2.1vh;font-weight:600;" +
        "color:" + P.text + ";letter-spacing:0.04em;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;"
      );
      abbrEl.textContent = team.abbr;
      teamCell.appendChild(abbrEl);

      row.appendChild(teamCell);

      // Conference record
      var confCell = _el("div",
        "font-family:'Barlow Condensed',sans-serif;font-size:2.1vh;font-weight:600;" +
        "color:" + P.label + ";text-align:center;letter-spacing:0.02em;"
      );
      confCell.textContent = team.conf;
      row.appendChild(confCell);

      // Overall record
      var overallCell = _el("div",
        "font-family:'Barlow Condensed',sans-serif;font-size:2.1vh;font-weight:500;" +
        "color:" + P.text + ";text-align:center;letter-spacing:0.02em;"
      );
      overallCell.textContent = team.overall;
      row.appendChild(overallCell);

      rows.appendChild(row);
    });

    container.appendChild(rows);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * mountStandings(container, conferenceName, opts)
   *
   * @param {Element}  container        — DOM element to render into (replaces contents)
   * @param {string}   conferenceName   — Conference to display, e.g. "SEC", "Big Ten",
   *                                      "Big 12", "ACC", "Mountain West"
   *                                      (case-insensitive; see CONF_ALIAS for full list)
   * @param {object}   [opts]
   *   @param {function} [opts.onEmpty]  — called if ESPN returns no entries for the conference
   *   @param {function} [opts.onError]  — called on fetch/parse failure: onError(err)
   *
   * Renders rank | team logo+abbr | conf record | overall record, sorted
   * by conf record then overall. Projector palette (dark bg, gold conf column,
   * white values), Oswald headers / Barlow Condensed rows, vh/vw sizing.
   *
   * Security: all ESPN-sourced strings assigned via textContent only. Logo URLs are
   * set as img.src (attribute assignment), never injected into HTML strings.
   * No innerHTML is ever used with API data.
   */
  async function mountStandings(container, conferenceName, opts) {
    opts = opts || {};
    stopStandings();
    _container = container;
    _active    = true;

    // Resolve conference name → ESPN abbreviation
    var espnAbbr = _resolveConf(conferenceName);
    if (!espnAbbr) {
      _active = false;
      if (opts.onError) {
        opts.onError(new Error("Unknown conference: \"" + conferenceName + "\""));
      }
      return;
    }

    var season = _currentSeason();
    var data;
    try {
      data = await _fetchStandings(season);
    } catch (err) {
      _active = false;
      if (opts.onError) opts.onError(err);
      return;
    }

    if (!_active) return; // stopStandings() called during fetch

    var parsed;
    try {
      parsed = _parseData(data, espnAbbr);
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

    _buildDOM(container, parsed, conferenceName);
  }

  /**
   * stopStandings()
   * Clears container reference and marks module inactive.
   * Call before switching conferences or unmounting.
   */
  function stopStandings() {
    _active    = false;
    _container = null;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  root.mountStandings = mountStandings;
  root.stopStandings  = stopStandings;

}(typeof window !== "undefined" ? window : this));
