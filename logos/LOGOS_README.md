# logos/ — Dark-Background CFB Team Logos

## Source

**`C:\Users\carso\Projects\cfb-dynasty-bot\assets\logos_emoji\`**

These are the emoji-ready logos built by `cfb-dynasty-bot/outline_logos.py`. That
script auto-detects dark logos (luminance < 78 over their opaque pixels) and adds a
soft 16px white halo/stroke so teams like Ohio State, LSU, and Texas A&M read clearly
on Discord's dark background. Light logos are copied through unchanged. All originals
sourced from ESPN's CDN (`a.espncdn.com/i/teamlogos/ncaa/500/<espn_id>.png`).

**Why this set and not `assets/logos/` or `power4_logos/`:**
- `logos_emoji/` is the processed, dark-bg-ready output — white-outlined where needed,
  confirmed readable on black. This is exactly what the projector scoreboard's dark
  background needs.
- `assets/logos/` (conference subfolders) = original light-background copies, no stroke.
- `power4_logos/` = 138 PNG set, also no outline processing, Power-4 focused only.

## Coverage

- **136 FBS teams** — all Power 4 (SEC, Big Ten, Big 12, ACC), Independents (Notre Dame,
  UConn, Oregon State, Washington State), and all Group of 5 conferences (AAC, CUSA,
  MAC, Mountain West, Sun Belt).
- **Format:** PNG, RGBA, 500x500 px, ~30–110 KB each.
- **Total folder size:** ~6.4 MB (136 logos + logo-map.json). Well within GitHub Pages limits.
- **Conference logo PNGs** (aac, acc, big-12, big-ten, etc.) exist in the source set but
  were intentionally excluded from this folder — the board only needs team logos.

## logo-map.json

**Path:** `C:\Users\carso\Projects\projector-board-public\logos\logo-map.json`

A flat JSON object with **272 keys** (2 per team), mapping to the PNG filename:

- **Key 1:** ESPN `abbreviation` field as returned by the scoreboard API (e.g. `"COLO"`,
  `"ALA"`, `"MISS"`, `"TAMU"`, `"PITT"`, `"OSU"`).
- **Key 2:** ESPN `location` field, lowercased (e.g. `"colorado"`, `"alabama"`,
  `"ole miss"`, `"texas a&m"`, `"pittsburgh"`, `"ohio state"`).

The board's game objects expose `aAbbr`/`hAbbr` and `aLoc`/`hLoc`. Either key resolves
the logo. Example entries:

```json
{
  "ALA":        "alabama.png",
  "alabama":    "alabama.png",
  "COLO":       "colorado.png",
  "colorado":   "colorado.png",
  "MISS":       "ole-miss.png",
  "ole miss":   "ole-miss.png",
  "TAMU":       "texas-am.png",
  "texas a&m":  "texas-am.png",
  "PITT":       "pitt.png",
  "pittsburgh": "pitt.png"
}
```

## How the board should resolve a logo

Replace the current `logoOf` call in `cfb.html` with a local-first lookup. Add a
`LOGO_MAP` constant (loaded once) and a `localLogo` function:

```js
// Load once at startup (or inline the JSON directly into the page)
let LOGO_MAP = {};
fetch("logos/logo-map.json")
  .then(r => r.json())
  .then(m => { LOGO_MAP = m; });

function localLogo(t) {
  // t is the ESPN team object: has .abbreviation, .location, .id
  const abbr = (t.abbreviation || "").toUpperCase();
  const loc  = (t.location || "").toLowerCase();
  const file = LOGO_MAP[abbr] || LOGO_MAP[loc];
  if (file) return `logos/${file}`;
  // Fall back to ESPN CDN if not in our set (FCS opponents, etc.)
  return t.logo || t.logos?.[0]?.href || `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.id}.png`;
}
```

Then replace the single `logoOf` call at line 214 of `cfb.html` with `localLogo`.
The plate/splate `onerror` handlers already hide missing images so ESPN fallback still
works seamlessly for any FCS opponent not in the set.

## Teams that will fall back to ESPN

Any FCS opponent (e.g. a week-1 cupcake not in the FBS set) will fall back to the ESPN
CDN URL. The fallback chain in `localLogo` above handles this transparently. No FBS
teams are missing from this set.

## Build script

`C:\Users\carso\Projects\projector-board-public\_build\build_logos.py`

Re-run this any time the source logo set in `cfb-dynasty-bot` is updated. It reads the
manifest, copies all team logos from `logos_emoji/`, and regenerates `logo-map.json`.
