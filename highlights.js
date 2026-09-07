/**
 * highlights.js — ESPN CFB highlight player module
 * Projector Scoreboard | Vanilla JS, no frameworks
 *
 * Usage:
 *   mountHighlights(container, eventId, { onEmpty, onClip })
 *   stopHighlights()
 *
 * Data path: ESPN summary endpoint — direct client-side fetch, no proxy.
 *   Access-Control-Allow-Origin: * confirmed on both the summary API and
 *   the espnmedia-cdn.akamaized.net video CDN (verified 2026-09-06).
 *
 * Tested event: 401856776 (CU @ Georgia Tech, Final 14-13, 2026-09-04)
 *   6 clips, all mp4s returning HTTP 200 video/mp4.
 */

(function (root) {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────
  const SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=";

  // Full browser UA — Akamai 403s bare curl but passes real browsers.
  // The summary endpoint does NOT require this for CORS, but keep it anyway
  // for consistency with the scoreboard fetch pattern.
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

  // Projector palette
  const PALETTE = {
    bg: "#08090b",
    label: "#FFE84D",   // gold labels
    text: "#ffffff",
    live: "#FF6A00",    // halftime/live accent
    dim: "rgba(0,0,0,0.72)",
  };

  // Auto-advance to next clip after this many seconds (or when clip ends, whichever is sooner)
  const CLIP_MAX_DURATION_S = 90;

  // ── Module state ───────────────────────────────────────────────────────────
  let _container = null;
  let _clips = [];
  let _idx = 0;
  let _advanceTimer = null;
  let _videoEl = null;
  let _capEl = null;
  let _canvasEl = null;   // canvas mode: blit hidden-video frames here (composites in-page)
  let _rafId = null;
  let _active = false;
  let _onClip = null;  // caller callback, set per mountHighlights() call
  // Fire TV / Amazon devices (model prefix "AFT") cannot composite the WebView inline-video overlay
  // to the screen (the <video> hole-punch shows black). Fallback modes render in-page instead.
  var _hlModeParam = "";
  try { _hlModeParam = new URLSearchParams(location.search).get("hlmode") || ""; } catch(e) {}
  var _ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  // Amazon Silk (and desktop Chrome) COMPOSITE inline video correctly. The Android System WebView
  // used by Fully Kiosk does NOT (video plays but shows black) — those get the image slideshow.
  var _isSilk = /\bSilk\//i.test(_ua);
  var _isFireTVWebView = /\bAFT[A-Z0-9]/i.test(_ua) && !_isSilk;
  var _forceImg = (typeof window !== "undefined" && window._FORCE_IMG_HL);
  // mode: "video" (inline), "canvas" (blit), "img" (thumbnail slideshow)
  const _MODE = _hlModeParam === "video" ? "video"
    : _hlModeParam === "canvas" ? "canvas"
    : _hlModeParam === "img" ? "img"
    : ((_isFireTVWebView || _forceImg) ? "img" : "video");
  const _IMG_MODE = _MODE === "img";
  const _CANVAS_MODE = _MODE === "canvas";
  const IMG_DWELL_S = 6;

  // ── Internal helpers ───────────────────────────────────────────────────────

  function _srcOf(v) {
    const s = (v && v.links && v.links.source) || {};
    return (
      (s.HD && s.HD.href) ||
      s.href ||
      (s.mezzanine && typeof s.mezzanine === "object" ? s.mezzanine.href : s.mezzanine) ||
      (v && v.links && v.links.mobile && v.links.mobile.source && v.links.mobile.source.href) ||
      ""
    );
  }

  function _fmtDuration(s) {
    if (!s || isNaN(s)) return "";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `0:${String(sec).padStart(2, "0")}`;
  }

  function _updateCaption(clip, idx, total) {
    if (!_capEl) return;
    const dur = clip.duration ? _fmtDuration(clip.duration) : "";

    // Build DOM nodes — never innerHTML with untrusted API strings.
    const kicker = document.createElement("span");
    kicker.className = "hl-kicker";
    kicker.style.cssText =
      "color:" + PALETTE.label + ";font-size:1.6vh;letter-spacing:0.12em;" +
      "display:block;margin-bottom:0.5vh;font-family:'Oswald',sans-serif;font-weight:700;";
    // Label text is fully trusted (our own arithmetic + safe duration string)
    kicker.textContent = "HIGHLIGHT " + (idx + 1) + "/" + total + (dur ? " · " + dur : "");

    const headline = document.createElement("span");
    headline.className = "hl-headline";
    headline.style.cssText =
      "font-family:'Oswald',sans-serif;font-size:2.8vh;font-weight:600;line-height:1.2;";
    // clip.headline comes from ESPN — always assign via textContent, never innerHTML.
    headline.textContent = clip.headline || "";

    // Replace caption contents atomically
    _capEl.replaceChildren(kicker, headline);

    // Fire caller callback if registered
    if (_onClip) _onClip(clip, idx, total);
  }

  var _canvasProbe = { frames: 0, nonBlack: 0, decided: false };
  function _startCanvasLoop() {
    if (_rafId) return;
    var ctx = _canvasEl && _canvasEl.getContext ? _canvasEl.getContext("2d") : null;
    if (!ctx) return;
    var loop = function () {
      if (!_active || !_canvasEl || !_videoEl) return;
      try {
        ctx.drawImage(_videoEl, 0, 0, _canvasEl.width, _canvasEl.height);
        // Auto-detect: sample the center; if frames stay black while the video is playing,
        // the WebView won't expose decoded frames → give up on canvas (host can fall back).
        if (!_canvasProbe.decided && _videoEl.currentTime > 0.3) {
          _canvasProbe.frames++;
          try {
            var d = ctx.getImageData(_canvasEl.width >> 1, _canvasEl.height >> 1, 1, 1).data;
            if (d[0] + d[1] + d[2] > 24) _canvasProbe.nonBlack++;
          } catch (e) { _canvasProbe.tainted = true; }
          if (_canvasProbe.frames >= 20) {
            _canvasProbe.decided = true;
            _canvasProbe.works = _canvasProbe.nonBlack >= 2;
            if (_canvasEl) _canvasEl.setAttribute("data-probe", _canvasProbe.works ? "ok" : "black");
          }
        }
      } catch (e) {}
      _rafId = root.requestAnimationFrame ? root.requestAnimationFrame(loop) : setTimeout(loop, 40);
    };
    _rafId = root.requestAnimationFrame ? root.requestAnimationFrame(loop) : setTimeout(loop, 40);
  }
  function _stopCanvasLoop() {
    if (_rafId) { if (root.cancelAnimationFrame) root.cancelAnimationFrame(_rafId); else clearTimeout(_rafId); _rafId = null; }
  }

  function _playClip(idx) {
    if (!_active || !_videoEl || !_clips.length) return;
    idx = ((idx % _clips.length) + _clips.length) % _clips.length;
    _idx = idx;
    const clip = _clips[idx];

    clearTimeout(_advanceTimer);

    if (_IMG_MODE) {
      // Image slideshow: show the clip thumbnail, dwell, then advance.
      if (clip.thumbnail) _videoEl.src = clip.thumbnail;
      _updateCaption(clip, idx, _clips.length);
      _advanceTimer = setTimeout(function () { _playClip(_idx + 1); }, IMG_DWELL_S * 1000);
      return;
    }

    const src = clip.mp4 || _srcOf(clip);   // clips are already mapped to {mp4}; _srcOf needs raw ESPN shape

    if (_CANVAS_MODE) {
      _videoEl.muted = true; _videoEl.setAttribute("muted","");
      _videoEl.src = src; _videoEl.load();
      var _tp = function(){ if(!_active||!_videoEl) return; var p=_videoEl.play(); if(p&&p.catch) p.catch(function(){}); };
      _tp(); _videoEl.addEventListener("loadeddata", _tp, {once:true}); _videoEl.addEventListener("canplay", _tp, {once:true});
      _startCanvasLoop();
      _updateCaption(clip, idx, _clips.length);
      var _cm = (clip.duration ? Math.min(clip.duration, CLIP_MAX_DURATION_S) : CLIP_MAX_DURATION_S) * 1000;
      _advanceTimer = setTimeout(function(){ _playClip(_idx + 1); }, _cm);
      return;
    }
    // Load clip — webview needs muted set as an ATTRIBUTE before src, plus a retry once decodable.
    _videoEl.muted = true; _videoEl.defaultMuted = true;
    _videoEl.setAttribute("muted", "");
    _videoEl.setAttribute("playsinline", "");
    _videoEl.setAttribute("webkit-playsinline", "");
    _videoEl.setAttribute("autoplay", "");
    _videoEl.src = src;
    _videoEl.load();
    var _tryPlay = function () { if (!_active || !_videoEl) return; var p = _videoEl.play(); if (p && p.catch) p.catch(function () {}); };
    _tryPlay();
    _videoEl.addEventListener("loadeddata", _tryPlay, { once: true });
    _videoEl.addEventListener("canplay", _tryPlay, { once: true });

    _updateCaption(clip, idx, _clips.length);

    // Safety net: advance after CLIP_MAX_DURATION_S regardless of 'ended' event
    const maxMs = (clip.duration ? Math.min(clip.duration, CLIP_MAX_DURATION_S) : CLIP_MAX_DURATION_S) * 1000;
    _advanceTimer = setTimeout(function () {
      _playClip(_idx + 1);
    }, maxMs);
  }

  // ── Fetch clips ────────────────────────────────────────────────────────────

  async function _fetchClips(eventId) {
    const url = SUMMARY_URL + encodeURIComponent(eventId);
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) throw new Error("ESPN summary HTTP " + res.status);
    const data = await res.json();
    const raw = data.videos || [];
    return raw
      .map(function (v) {
        return {
          id: String(v.id || ""),
          headline: String(v.headline || ""),
          duration: v.duration || null,
          thumbnail: v.thumbnail || null,
          mp4: _srcOf(v),
          webUrl: (v.links && v.links.web && v.links.web.href) || null,
        };
      })
      .filter(function (v) { return v.mp4; });
  }

  // ── DOM builder ────────────────────────────────────────────────────────────

  function _buildDOM(container, noCaption) {
    // replaceChildren() with no args clears all children without innerHTML.
    container.replaceChildren();
    container.style.cssText =
      "position:relative;width:100%;height:100%;background:" + PALETTE.bg + ";overflow:hidden;";

    if (_IMG_MODE) {
      // Fire TV: image slideshow of clip thumbnails (no <video>, so no hole-punch → always visible)
      const img = document.createElement("img");
      img.id = "hl-image";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;background:#000;";
      container.appendChild(img);
      _videoEl = img;   // reuse the same handle; _playClip branches on _IMG_MODE
    } else if (_CANVAS_MODE) {
      // Blit hidden-video frames to a canvas (composites in-page like an image → visible on Fire TV
      // IF the WebView exposes decoded frames to drawImage; auto-detected at runtime).
      const video = document.createElement("video");
      video.id = "hl-video";
      video.muted = true; video.defaultMuted = true; video.playsInline = true; video.autoplay = true;
      video.setAttribute("muted",""); video.setAttribute("playsinline",""); video.setAttribute("webkit-playsinline",""); video.setAttribute("autoplay",""); video.setAttribute("preload","auto");
      video.crossOrigin = "anonymous";   // needed so the canvas isn't tainted (ESPN CDN allows *)
      // Force TextureView (frames in an in-page texture, readable by drawImage) instead of a
      // hardware SurfaceView overlay: a transform/filter on the element itself defeats the overlay path.
      video.style.cssText = "position:absolute;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;transform:translateZ(0) scale(1.0001);filter:opacity(0.999);border-radius:1px;";
      const canvas = document.createElement("canvas");
      canvas.id = "hl-canvas";
      canvas.width = 640; canvas.height = 360;
      canvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;background:#000;";
      container.appendChild(video); container.appendChild(canvas);
      _videoEl = video; _canvasEl = canvas;
    } else {
      const video = document.createElement("video");
      video.id = "hl-video";
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.autoplay = true;
      // Attributes (not just properties) — required for webview autoplay policy
      video.setAttribute("muted", "");
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.setAttribute("autoplay", "");
      video.setAttribute("preload", "auto");
      // Force TextureView compositing (in-page, stays in the mapped column) instead of a hardware
      // SurfaceView overlay that Fire OS won't composite to screen. A transform/filter on the <video>
      // element itself is the documented trigger. Harmless on desktop.
      video.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;display:block;transform:translateZ(0) scale(1.0001);filter:opacity(0.999);border-radius:2px;will-change:transform;";
      container.appendChild(video);
      _videoEl = video;
    }

    // Caption overlay — skipped when the host renders the caption in a side panel (noCaption)
    let cap = null;
    if (!noCaption) {
      cap = document.createElement("div");
      cap.id = "hl-caption";
      cap.style.cssText =
        "position:absolute;left:0;right:0;bottom:0;padding:2.5vh 2.5vw;" +
        "background:linear-gradient(transparent," + PALETTE.dim + " 45%);" +
        "color:" + PALETTE.text + ";pointer-events:none;";
      container.appendChild(cap);
    }

    if (!_IMG_MODE && _videoEl) {
      // 'Ended' listener — advance immediately on natural end
      _videoEl.addEventListener("ended", function () {
        clearTimeout(_advanceTimer);
        _playClip(_idx + 1);
      });
      // Error listener — skip broken clip
      _videoEl.addEventListener("error", function () {
        clearTimeout(_advanceTimer);
        _advanceTimer = setTimeout(function () {
          _playClip(_idx + 1);
        }, 500);
      });
    }

    _capEl = cap;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * mountHighlights(container, eventId, opts)
   *
   * @param {Element}  container  — DOM element to render into (replaces contents)
   * @param {string}   eventId    — ESPN event id (e.g. "401856776")
   * @param {object}   [opts]
   *   @param {function} [opts.onEmpty]  — called if ESPN has no clips for this event
   *   @param {function} [opts.onClip]   — called on each clip change: onClip(clip, idx, total)
   *   @param {function} [opts.onError]  — called if fetch fails: onError(err)
   *
   * Politely rate-limited: call at most every 60s for the same eventId.
   * The ESPN CDN cache-control is max-age=5–7s on the summary JSON, so clips
   * appear within one poll cycle of ESPN publishing them.
   */
  async function mountHighlights(container, eventId, opts) {
    opts = opts || {};
    stopHighlights(); // clean up any prior instance
    _container = container;
    _active = true;

    _buildDOM(container, opts.noCaption);

    let clips;
    try {
      clips = await _fetchClips(eventId);
    } catch (err) {
      _active = false;
      if (opts.onError) opts.onError(err);
      return;
    }

    if (!clips || !clips.length) {
      _active = false;
      if (opts.onEmpty) opts.onEmpty();
      return;
    }

    _clips = clips;
    _idx = 0;
    _onClip = opts.onClip || null;

    _playClip(0);
  }

  /**
   * stopHighlights()
   * Cleans up: pauses video, clears timers, empties the container reference.
   * Call before switching scenes or unmounting.
   */
  function stopHighlights() {
    _active = false;
    clearTimeout(_advanceTimer);
    _advanceTimer = null;
    _stopCanvasLoop();
    if (_videoEl) {
      if (typeof _videoEl.pause === "function") _videoEl.pause();
      _videoEl.src = "";
      _videoEl = null;
    }
    _canvasEl = null;
    _canvasProbe = { frames: 0, nonBlack: 0, decided: false };
    _capEl = null;
    _clips = [];
    _idx = 0;
    _onClip = null;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  root.mountHighlights = mountHighlights;
  root.stopHighlights = stopHighlights;

}(typeof window !== "undefined" ? window : this));
