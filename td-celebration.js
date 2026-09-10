/**
 * td-celebration.js — Full-screen TOUCHDOWN celebration takeover
 * Projector Scoreboard | Vanilla JS, no frameworks
 *
 * Public API:
 *   mountTDCelebration(container, opts) -> Promise  (resolves when shown)
 *   stopTDCelebration()                             (cancel / cleanup immediately)
 *
 * opts = {
 *   eventId,   // ESPN event id string, e.g. "401858437"
 *   teamId,    // ESPN team id string of the scoring team
 *   teamName,  // fallback display name, e.g. "Washington Huskies"
 *   primary,   // team primary color hex (may be null -> fallback)
 *   secondary, // team secondary hex   (may be null)
 *   onDone     // callback after auto-dismiss or stopTDCelebration
 * }
 *
 * Data path: ESPN summary endpoint — CORS-open, no key required.
 *   https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=EVENTID
 *
 * JSON paths used:
 *   scoringPlays[]                             — list of all scoring plays
 *   scoringPlays[i].scoringType.abbreviation  — "TD" to filter for touchdowns
 *   scoringPlays[i].team.id                   — scoring team id
 *   scoringPlays[i].type.text                 — "Rushing Touchdown" / "Passing Touchdown"
 *   scoringPlays[i].text                      — play description, e.g. "Demond Williams Jr. 5 Yd Run ..."
 *   boxscore.players[j].statistics[k].athletes[m].athlete.displayName
 *   boxscore.players[j].statistics[k].athletes[m].athlete.id
 *   boxscore.players[j].statistics[k].athletes[m].athlete.jersey
 *   boxscore.players[j].statistics[k].athletes[m].athlete.headshot.href
 *   leaders[j].leaders[k].leaders[m].athlete.position.abbreviation  — "QB"/"RB"/"WR" etc.
 *   leaders[j].leaders[k].leaders[m].athlete.displayName
 *
 * Player headshot URL pattern:
 *   https://a.espncdn.com/i/headshots/college-football/players/full/{ATHLETE_ID}.png
 *
 * Example host call:
 *   await mountTDCelebration(document.getElementById('zone1'), {
 *     eventId: '401858437', teamId: '264', teamName: 'Washington Huskies',
 *     primary: '#4B2E83', secondary: '#B7A57A', onDone: () => restoreNormal()
 *   });
 *
 * Tested event: 401858437 (Washington vs Washington State, 2026-09-06 Final 24-10)
 *   Scoring plays confirmed: scoringPlays[] contains 4 TD entries with type.text,
 *   text (player name + yards), team.id. boxscore.players has athletes with
 *   headshot.href. leaders has position.abbreviation.
 */

(function (root) {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────
  // League-aware: window.BOARD_LEAGUE is the ESPN path segment ("college-football" | "nfl").
  function _lg(){ return (typeof window !== "undefined" && window.BOARD_LEAGUE) || "college-football"; }
  function _summaryUrl(){ return "https://site.api.espn.com/apis/site/v2/sports/football/" + _lg() + "/summary?event="; }

  const STYLE_ID = "td-celebration-keyframes";
  const AUTO_DISMISS_MS = 7000;

  // Fallback colors when opts.primary/secondary are absent
  const FALLBACK_PRIMARY   = "#1a1a2e";
  const FALLBACK_SECONDARY = "#ffffff";

  // ── Module state ───────────────────────────────────────────────────────────
  let _container    = null;
  let _wrapEl       = null;
  let _dismissTimer = null;
  let _active       = false;
  let _onDone       = null;

  // ── Keyframe injection ─────────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes td-bg-pop {
        0%   { opacity: 0; transform: scale(1.04); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes td-word-drop {
        0%   { opacity: 0; transform: translateY(-18%) scaleY(0.7); letter-spacing: 0.32em; }
        60%  { opacity: 1; transform: translateY(4%)  scaleY(1.05); letter-spacing: 0.16em; }
        100% { opacity: 1; transform: translateY(0)   scaleY(1);    letter-spacing: 0.12em; }
      }
      @keyframes td-letter-pop {
        0%   { opacity: 0; transform: translateY(-40%) scale(0.6); }
        70%  { opacity: 1; transform: translateY(6%)   scale(1.08); }
        100% { opacity: 1; transform: translateY(0)    scale(1); }
      }
      @keyframes td-slide-up {
        0%   { opacity: 0; transform: translateY(3vh); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes td-headshot-pop {
        0%   { opacity: 0; transform: scale(0.5); }
        70%  { opacity: 1; transform: scale(1.08); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes td-flash {
        0%, 100% { opacity: 0; }
        10%, 30% { opacity: 0.18; }
        20%      { opacity: 0.32; }
      }
      @keyframes td-shake {
        0%, 100% { transform: translate3d(0,0,0) rotate(0deg); }
        12% { transform: translate3d(-1.6%,0,0) rotate(-1.4deg); }
        24% { transform: translate3d(1.6%,0,0)  rotate(1.4deg); }
        36% { transform: translate3d(-1.3%,0,0) rotate(-1deg); }
        48% { transform: translate3d(1.3%,0,0)  rotate(1deg); }
        62% { transform: translate3d(-0.8%,0,0) rotate(-0.5deg); }
        76% { transform: translate3d(0.8%,0,0)  rotate(0.5deg); }
        88% { transform: translate3d(-0.3%,0,0) rotate(0deg); }
      }
      @keyframes td-logo-in {
        0%   { opacity: 0; transform: translateX(-8%) scale(0.86); }
        70%  { opacity: 1; transform: translateX(1%)  scale(1.04); }
        100% { opacity: 1; transform: translateX(0)   scale(1); }
      }
    `;
    document.head.appendChild(style);
  }

  function _removeStyles() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.parentNode.removeChild(el);
  }

  // ── Data helpers ───────────────────────────────────────────────────────────

  /**
   * Returns the most recent TD play for the given teamId from scoringPlays[].
   * scoringPlays are ordered chronologically; we pick the last one for the team.
   */
  function _findTDPlay(scoringPlays, teamId) {
    let td = null;
    for (const play of scoringPlays) {
      const isScore = (play.scoringType && play.scoringType.abbreviation === "TD") ||
                      (play.type && play.type.abbreviation === "TD");
      const isTeam  = play.team && String(play.team.id) === String(teamId);
      if (isScore && isTeam) td = play;
    }
    return td;
  }

  /**
   * Parses a scoring play text string and returns { playerName, yards, tdType }.
   *
   * Patterns observed in ESPN data:
   *   "Demond Williams Jr. 5 Yd Run (Tyler Robles Kick)"          -> RUSH
   *   "Rashid Williams 1 Yd pass from Demond Williams Jr. (...)"  -> REC  (receiver scores)
   *   "Caden Pinnick 11 Yd Run (Jack Stevens Kick)"               -> RUSH
   *   "Jayden Limar 11 Yd Run (...)"                              -> RUSH
   *
   * For "N Yd pass from X" the scoring player is the first name (receiver).
   * type.text ("Rushing Touchdown" / "Passing Touchdown") disambiguates.
   */
  function _parsePlayText(text, typeText) {
    if (!text) return { playerName: "", yards: 0, tdType: "TD" };

    // Strip trailing paren (kicker note, review note, etc.)
    const clean = text.replace(/\s*\(.*?\)\s*$/g, "").trim();

    let yards     = 0;
    let playerName = "";
    let tdType    = "RUSH TD";

    // Match: "<Name> <N> Yd <verb> ..."
    const m = clean.match(/^(.+?)\s+(\d+)\s+Yd\s+(.*)/i);
    if (m) {
      playerName = m[1].trim();
      yards      = parseInt(m[2], 10);
      const verb = m[3].toLowerCase();

      if (/pass\s+from/i.test(verb)) {
        // Receiver catch TD
        tdType = "REC TD";
      } else if (/run|rush/i.test(verb)) {
        tdType = "RUSH TD";
      } else if (/pass|throw/i.test(verb)) {
        // Rare: QB scramble framed as pass
        tdType = "PASS TD";
      } else {
        // Use play type text as fallback
        if (typeText) {
          if (/rush/i.test(typeText))   tdType = "RUSH TD";
          else if (/pass/i.test(typeText)) tdType = "PASS TD";
        }
      }
    } else {
      // Fallback: take everything before the first digit sequence as player name
      const fb = clean.match(/^([A-Za-z\s'.,-]+?)(?:\s+\d|$)/);
      if (fb) playerName = fb[1].trim();
      if (typeText) {
        if (/rush/i.test(typeText))   tdType = "RUSH TD";
        else if (/pass/i.test(typeText)) tdType = "PASS TD";
      }
    }

    return { playerName, yards, tdType };
  }

  /**
   * Builds a name -> athlete record lookup from boxscore.players and leaders.
   * leaders entries carry position.abbreviation; boxscore entries carry headshot.
   * We merge by displayName so both sources fill in gaps.
   */
  function _buildAthleteLookup(data) {
    const byName = {};

    // Pass 1: boxscore.players — headshot + jersey, no position
    const boxPlayers = (data.boxscore && data.boxscore.players) || [];
    for (const teamEntry of boxPlayers) {
      for (const statCat of (teamEntry.statistics || [])) {
        for (const ae of (statCat.athletes || [])) {
          const ath = ae.athlete;
          if (!ath) continue;
          const name = ath.displayName || "";
          if (!byName[name]) byName[name] = {};
          const rec = byName[name];
          if (!rec.id)       rec.id       = ath.id || "";
          if (!rec.jersey)   rec.jersey   = ath.jersey || "";
          if (!rec.headshot) rec.headshot = (ath.headshot && ath.headshot.href) || "";
          if (!rec.name)     rec.name     = name;
        }
      }
    }

    // Pass 2: leaders — adds position.abbreviation
    const leaderTeams = data.leaders || [];
    for (const teamEntry of leaderTeams) {
      for (const category of (teamEntry.leaders || [])) {
        for (const leader of (category.leaders || [])) {
          const ath = leader.athlete;
          if (!ath) continue;
          const name = ath.displayName || ath.fullName || "";
          if (!byName[name]) byName[name] = {};
          const rec = byName[name];
          if (!rec.id)       rec.id       = ath.id || "";
          if (!rec.jersey)   rec.jersey   = ath.jersey || "";
          if (!rec.headshot) rec.headshot = (ath.headshot && ath.headshot.href) || "";
          if (!rec.name)     rec.name     = name;
          if (!rec.position && ath.position) {
            rec.position = ath.position.abbreviation || "";
          }
        }
      }
    }

    return byName;
  }

  /**
   * Resolve athlete data by matching playerName against the lookup.
   * Tries exact match first, then case-insensitive, then last-name partial.
   * Gracefully returns empty strings if unresolvable.
   */
  function _resolveAthlete(playerName, lookup) {
    if (!playerName) return { id: "", jersey: "", position: "", headshot: "", name: playerName };

    // Exact
    if (lookup[playerName]) return lookup[playerName];

    // Case-insensitive
    const lower = playerName.toLowerCase();
    for (const [k, v] of Object.entries(lookup)) {
      if (k.toLowerCase() === lower) return v;
    }

    // Last-name partial: "Williams Jr." matches "Demond Williams Jr."
    for (const [k, v] of Object.entries(lookup)) {
      if (k.toLowerCase().endsWith(lower)) return v;
    }

    // Partial substring (first + last name token overlap)
    const tokens = lower.split(/\s+/);
    for (const [k, v] of Object.entries(lookup)) {
      const kl = k.toLowerCase();
      if (tokens.every(t => kl.includes(t))) return v;
    }

    return { id: "", jersey: "", position: "", headshot: "", name: playerName };
  }

  /**
   * Derive headshot URL from athlete id as fallback.
   * Pattern: https://a.espncdn.com/i/headshots/college-football/players/full/{ID}.png
   */
  function _headshotUrl(athleteId) {
    if (!athleteId) return "";
    return "https://a.espncdn.com/i/headshots/" + _lg() + "/players/full/" + athleteId + ".png";
  }

  // ── Color helpers ──────────────────────────────────────────────────────────

  /**
   * Parse hex to { r, g, b } (handles #RGB and #RRGGBB).
   */
  function _hexToRgb(hex) {
    if (!hex) return null;
    hex = hex.replace(/^#/, "");
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length !== 6) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  /**
   * Perceived luminance (0–1). Used to decide whether overlay text should
   * be white or dark.
   */
  function _luminance(hex) {
    const c = _hexToRgb(hex);
    if (!c) return 0.5;
    const toLinear = x => {
      x /= 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
  }

  /**
   * Returns "#ffffff" or "#000000" based on contrast against bgHex.
   */
  function _contrastText(bgHex) {
    return _luminance(bgHex) > 0.35 ? "#000000" : "#ffffff";
  }

  /**
   * Accent colour for headline text, unless it barely contrasts with the background — then fall back
   * to readable black/white (e.g. Falcons black-on-red becomes white-on-red).
   */
  function _readableAccent(accent, bgHex) {
    return Math.abs(_luminance(accent) - _luminance(bgHex)) < 0.22 ? _contrastText(bgHex) : accent;
  }

  // ── DOM builders ───────────────────────────────────────────────────────────

  function _el(tag, styles, attrs) {
    const e = document.createElement(tag);
    if (styles) Object.assign(e.style, styles);
    if (attrs)  Object.assign(e, attrs);
    return e;
  }

  function _txt(tag, text, styles) {
    const e = _el(tag, styles);
    e.textContent = text;
    return e;
  }

  /**
   * Build and mount the celebration overlay into container.
   *
   * @param {object} p - resolved parameters:
   *   primary, secondary, teamName, playerName, jersey, position,
   *   headshot, yards, tdType
   */
  function _buildOverlay(container, p) {
    const bg        = p.primary   || FALLBACK_PRIMARY;
    const accent    = p.secondary || FALLBACK_SECONDARY;
    const textOnBg  = _contrastText(bg);              // white or black over primary
    const headAcc   = _readableAccent(accent, bg);    // headline colour, forced readable

    // Outer wrapper: big team logo on the left, celebration content on the right
    const wrap = _el("div", {
      position: "absolute", inset: "0", overflow: "hidden",
      fontFamily: "'Oswald', 'Barlow Condensed', sans-serif", background: bg,
      display: "flex", flexDirection: "row", alignItems: "center",
      zIndex: "9999", animation: "td-bg-pop 0.32s cubic-bezier(0.22,0.61,0.36,1) both",
    });

    // Flash overlay (brief white burst on entry)
    wrap.appendChild(_el("div", {
      position: "absolute", inset: "0", background: "#ffffff",
      pointerEvents: "none", animation: "td-flash 0.7s ease-out both", zIndex: "1",
    }));

    // ── Big team logo, left side ──────────────────────────────────────────────
    if (p.logo) {
      const logoWrap = _el("div", {
        position: "relative", zIndex: "2", flex: "0 0 25vw", height: "100%",
        display: "flex", alignItems: "center", justifyContent: "center",
        animation: "td-logo-in 0.55s 0.12s cubic-bezier(0.22,0.61,0.36,1) both",
      });
      const limg = document.createElement("img");
      limg.src = p.logo; limg.alt = "";
      // fixed HEIGHT so every team logo is the same size; a very small white stroke keeps same-colour
      // logos visible (e.g. Rams blue on blue)
      limg.style.cssText = "height:60%;width:auto;max-width:94%;object-fit:contain;display:block;filter:drop-shadow(1.3px 0 0 #fff) drop-shadow(-1.3px 0 0 #fff) drop-shadow(0 1.3px 0 #fff) drop-shadow(0 -1.3px 0 #fff) drop-shadow(0 0.7vh 1.2vh rgba(0,0,0,0.55));";
      limg.onerror = function () { logoWrap.style.display = "none"; };
      logoWrap.appendChild(limg);
      wrap.appendChild(logoWrap);
    }

    // ── Content column (shifted a little left via asymmetric padding) ──────────
    const col = _el("div", {
      position: "relative", zIndex: "2", flex: "1 1 0", minWidth: "0",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: "2.4vh", padding: "3vh 10vw 3vh 2vw", textAlign: "center", boxSizing: "border-box",
    });
    wrap.appendChild(col);

    // "TOUCHDOWN" headline — staggered letter pop, then a shake
    const word = "TOUCHDOWN";
    const tdRow = _el("div", {
      display: "flex", justifyContent: "center", gap: "0.03em", lineHeight: "1",
      animation: "td-shake 0.42s 0.92s ease-in-out 3 both",
    });
    for (let i = 0; i < word.length; i++) {
      tdRow.appendChild(_txt("span", word[i], {
        fontFamily: "'Oswald', 'Barlow Condensed', sans-serif", fontWeight: "900",
        fontSize: "clamp(3rem, 10.5vh, 8.5rem)", color: headAcc, display: "inline-block",
        lineHeight: "0.9", textShadow: "0 0 40px rgba(0,0,0,0.55), 0 4px 8px rgba(0,0,0,0.45)",
        animation: "td-letter-pop 0.52s cubic-bezier(0.22,0.61,0.36,1) both",
        animationDelay: (0.04 + i * 0.04) + "s",
      }));
    }
    col.appendChild(tdRow);

    // Player row: circular headshot (no stroke) + position over name
    if (p.playerName) {
      const playerRow = _el("div", {
        display: "flex", alignItems: "center", gap: "1.8vw",
        animation: "td-slide-up 0.4s 0.55s cubic-bezier(0.22,0.61,0.36,1) both",
      });
      if (p.headshot) {
        const imgWrap = _el("div", {
          width: "clamp(80px, 15vh, 150px)", height: "clamp(80px, 15vh, 150px)",
          borderRadius: "50%", overflow: "hidden", flexShrink: "0", background: "rgba(0,0,0,0.22)",
          animation: "td-headshot-pop 0.5s 0.5s cubic-bezier(0.22,0.61,0.36,1) both",
        });
        const img = document.createElement("img");
        img.src = p.headshot; img.alt = p.playerName;
        img.style.cssText = "width:100%;height:100%;object-fit:cover;object-position:top center;display:block;";
        img.onerror = function () { this.style.display = "none"; };
        imgWrap.appendChild(img);
        playerRow.appendChild(imgWrap);
      }
      const infoCol = _el("div", { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.4vh", textAlign: "left" });
      if (p.position) {
        infoCol.appendChild(_txt("div", p.position, {
          fontFamily: "'Barlow Condensed', 'Oswald', sans-serif", fontWeight: "600",
          fontSize: "clamp(1rem, 2.6vh, 1.8rem)", letterSpacing: "0.1em",
          color: headAcc, textTransform: "uppercase", opacity: "0.95",
        }));
      }
      infoCol.appendChild(_txt("div", p.playerName, {
        fontFamily: "'Oswald', sans-serif", fontWeight: "700",
        fontSize: "clamp(1.7rem, 5vh, 4rem)", color: textOnBg,
        lineHeight: "1.02", letterSpacing: "0.03em", textTransform: "uppercase",
      }));
      playerRow.appendChild(infoCol);
      col.appendChild(playerRow);
    }

    // Play line: big "18 YD RUSH TD"
    if (p.yards || p.tdType) {
      const parts = [];
      if (p.yards) parts.push(p.yards + " YD");
      if (p.tdType) parts.push(p.tdType);
      const playEl = _el("div", { animation: "td-slide-up 0.4s 0.68s cubic-bezier(0.22,0.61,0.36,1) both" });
      const pill = _el("div", { display: "inline-block", background: "rgba(0,0,0,0.42)", borderRadius: "0.7vh", padding: "1.1vh 3vw" });
      pill.appendChild(_txt("span", parts.join(" "), {
        fontFamily: "'Barlow Condensed', 'Oswald', sans-serif", fontWeight: "700",
        fontSize: "clamp(1.9rem, 5.6vh, 4.2rem)", letterSpacing: "0.14em",
        color: textOnBg, textTransform: "uppercase",
      }));
      playEl.appendChild(pill);
      col.appendChild(playEl);
    }

    return wrap;
  }

  // ── Core fetch + render ────────────────────────────────────────────────────

  async function _fetchAndRender(container, opts) {
    if (!_active) return;

    const primary   = opts.primary   || FALLBACK_PRIMARY;
    const secondary = opts.secondary || (_luminance(primary) > 0.35 ? "#000000" : "#ffffff");
    const teamName  = opts.teamName  || "";

    let playerName = "";
    let jersey     = "";
    let position   = "";
    let headshot   = "";
    let yards      = 0;
    let tdType     = "TD";

    // Direct-data mode (fantasy preview / known player): skip the ESPN fetch, render opts as-is.
    if (opts.skipFetch) {
      playerName = opts.playerName || ""; jersey = opts.jersey || "";
      position = opts.position || ""; headshot = opts.headshot || "";
      yards = opts.yards || 0; tdType = opts.tdType || "TD";
    } else
    try {
      const url  = _summaryUrl() + encodeURIComponent(opts.eventId);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("ESPN fetch " + resp.status);
      const data = await resp.json();

      // Find the most recent TD for this team
      const sp   = data.scoringPlays || [];
      const play = _findTDPlay(sp, opts.teamId);

      if (play) {
        const parsed = _parsePlayText(
          play.text,
          play.type && play.type.text
        );
        playerName = parsed.playerName;
        yards      = parsed.yards;
        tdType     = parsed.tdType;

        // Build athlete lookup and resolve headshot + jersey + position
        const lookup  = _buildAthleteLookup(data);
        const athlete = _resolveAthlete(playerName, lookup);

        if (athlete.id)       headshot = athlete.headshot || _headshotUrl(athlete.id);
        if (athlete.jersey)   jersey   = athlete.jersey;
        if (athlete.position) position = athlete.position;
        if (athlete.name)     playerName = athlete.name; // canonical casing from ESPN
      }
    } catch (_err) {
      // Fetch failure — degrade gracefully: show team-only card, still auto-dismiss
    }

    if (!_active) return; // stopTDCelebration() called while fetching

    const wrap = _buildOverlay(container, {
      primary:    primary,
      secondary:  secondary,
      teamName:   teamName,
      playerName: playerName,
      jersey:     jersey,
      position:   position,
      headshot:   headshot,
      yards:      yards,
      tdType:     tdType,
      logo:       opts.logo || "",
    });

    _wrapEl = wrap;

    // Container must be positioned for absolute children
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(wrap);

    // Auto-dismiss
    _dismissTimer = setTimeout(_dismiss, AUTO_DISMISS_MS);
  }

  function _dismiss() {
    if (!_active) return;
    _active = false;
    clearTimeout(_dismissTimer);
    _dismissTimer = null;

    if (_wrapEl && _wrapEl.parentNode) {
      _wrapEl.parentNode.removeChild(_wrapEl);
    }
    _wrapEl = null;

    _removeStyles();

    const cb = _onDone;
    _onDone    = null;
    _container = null;
    if (cb) cb();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * mountTDCelebration(container, opts) -> Promise
   *
   * Mounts the celebration overlay into `container`. Resolves immediately
   * after the DOM is injected (before auto-dismiss). Never throws — any
   * fetch error degrades gracefully to a team-only card.
   */
  async function mountTDCelebration(container, opts) {
    // Clean up any prior instance
    stopTDCelebration();

    if (!container || !opts) return;

    _container = container;
    _onDone    = (typeof opts.onDone === "function") ? opts.onDone : null;
    _active    = true;

    _injectStyles();

    // Fire-and-forget; errors caught internally
    await _fetchAndRender(container, opts);
  }

  /**
   * stopTDCelebration()
   *
   * Immediately cancels any running celebration: clears timers, removes
   * injected DOM, fires onDone so the host can restore the normal view.
   */
  function stopTDCelebration() {
    if (!_active && !_wrapEl) return;
    _active = false;
    clearTimeout(_dismissTimer);
    _dismissTimer = null;

    if (_wrapEl && _wrapEl.parentNode) {
      _wrapEl.parentNode.removeChild(_wrapEl);
    }
    _wrapEl = null;

    _removeStyles();

    const cb = _onDone;
    _onDone    = null;
    _container = null;
    if (cb) cb();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  root.mountTDCelebration = mountTDCelebration;
  root.stopTDCelebration  = stopTDCelebration;

}(typeof globalThis !== "undefined" ? globalThis : window));
