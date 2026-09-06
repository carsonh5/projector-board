"""
build_logos.py
Copy dark-bg-ready logos from cfb-dynasty-bot into projector-board-public/logos/
and generate logos/logo-map.json keyed by ESPN abbreviation and location.
"""
import json, shutil
from pathlib import Path

SRC   = Path("C:/Users/carso/Projects/cfb-dynasty-bot/assets/logos_emoji")
MFST  = Path("C:/Users/carso/Projects/cfb-dynasty-bot/assets/logos/manifest.json")
DST   = Path("C:/Users/carso/Projects/projector-board-public/logos")
DST.mkdir(exist_ok=True)

manifest = json.loads(MFST.read_text(encoding="utf-8"))

# ESPN abbreviation map: slug -> ESPN abbr
ESPN_ABBR = {
    "air-force":           "AF",
    "akron":               "AKR",
    "alabama":             "ALA",
    "app-state":           "APP",
    "arizona":             "ARIZ",
    "arizona-state":       "ASU",
    "arkansas":            "ARK",
    "arkansas-state":      "ARST",
    "army":                "ARMY",
    "auburn":              "AUB",
    "ball-state":          "BALL",
    "baylor":              "BAY",
    "boise-state":         "BSU",
    "boston-college":      "BC",
    "bowling-green":       "BGSU",
    "buffalo":             "BUFF",
    "byu":                 "BYU",
    "california":          "CAL",
    "central-michigan":    "CMU",
    "charlotte":           "CLT",
    "cincinnati":          "CIN",
    "clemson":             "CLEM",
    "coastal-carolina":    "CCU",
    "colorado":            "COLO",
    "colorado-state":      "CSU",
    "delaware":            "DEL",
    "duke":                "DUKE",
    "east-carolina":       "ECU",
    "eastern-michigan":    "EMU",
    "florida":             "FLA",
    "florida-atlantic":    "FAU",
    "florida-international": "FIU",
    "florida-state":       "FSU",
    "fresno-state":        "FRES",
    "georgia":             "UGA",
    "georgia-southern":    "GASO",
    "georgia-state":       "GAST",
    "georgia-tech":        "GT",
    "hawaii":              "HAW",
    "houston":             "HOU",
    "illinois":            "ILL",
    "indiana":             "IND",
    "iowa":                "IOWA",
    "iowa-state":          "ISU",
    "jacksonville-state":  "JVST",
    "james-madison":       "JMU",
    "kansas":              "KAN",
    "kansas-state":        "KSU",
    "kennesaw-state":      "KENN",
    "kent-state":          "KENT",
    "kentucky":            "UK",
    "liberty":             "LIB",
    "louisiana":           "ULL",
    "louisiana-tech":      "LT",
    "louisville":          "LOU",
    "lsu":                 "LSU",
    "marshall":            "MRSH",
    "maryland":            "MD",
    "memphis":             "MEM",
    "miami":               "MIA",
    "miami-oh":            "MIOH",
    "michigan":            "MICH",
    "michigan-state":      "MSU",
    "middle-tennessee":    "MTSU",
    "minnesota":           "MINN",
    "mississippi-state":   "MSST",
    "missouri":            "MIZ",
    "missouri-state":      "MOST",
    "navy":                "NAVY",
    "nc-state":            "NCST",
    "nebraska":            "NEB",
    "nevada":              "NEV",
    "new-mexico":          "UNM",
    "new-mexico-state":    "NMST",
    "north-carolina":      "UNC",
    "north-texas":         "UNT",
    "northern-illinois":   "NIU",
    "northwestern":        "NW",
    "notre-dame":          "ND",
    "ohio":                "OHIO",
    "ohio-state":          "OSU",
    "oklahoma":            "OU",
    "oklahoma-state":      "OKST",
    "ole-miss":            "MISS",
    "old-dominion":        "ODU",
    "oregon":              "ORE",
    "oregon-state":        "ORST",
    "penn-state":          "PSU",
    "pitt":                "PITT",
    "purdue":              "PUR",
    "rice":                "RICE",
    "rutgers":             "RUTG",
    "sam-houston":         "SHSU",
    "san-diego-state":     "SDSU",
    "san-jos-state":       "SJSU",
    "smu":                 "SMU",
    "south-alabama":       "USA",
    "south-carolina":      "SC",
    "south-florida":       "USF",
    "southern-miss":       "USM",
    "stanford":            "STAN",
    "syracuse":            "SYR",
    "tcu":                 "TCU",
    "temple":              "TEM",
    "tennessee":           "TENN",
    "texas":               "TEX",
    "texas-am":            "TAMU",
    "texas-state":         "TXST",
    "texas-tech":          "TTU",
    "toledo":              "TOL",
    "troy":                "TROY",
    "tulane":              "TUL",
    "tulsa":               "TLSA",
    "uab":                 "UAB",
    "ucf":                 "UCF",
    "ucla":                "UCLA",
    "uconn":               "CONN",
    "ul-monroe":           "ULM",
    "umass":               "MASS",
    "unlv":                "UNLV",
    "usc":                 "USC",
    "utah":                "UTAH",
    "utah-state":          "USU",
    "utep":                "UTEP",
    "utsa":                "UTSA",
    "vanderbilt":          "VAN",
    "virginia":            "UVA",
    "virginia-tech":       "VT",
    "wake-forest":         "WAKE",
    "washington":          "WASH",
    "washington-state":    "WSU",
    "west-virginia":       "WVU",
    "western-kentucky":    "WKU",
    "western-michigan":    "WMU",
    "wisconsin":           "WIS",
    "wyoming":             "WYO",
}

# ESPN location field overrides (what team.location returns from the API)
ESPN_LOC = {
    "air-force":           "Air Force",
    "app-state":           "Appalachian State",
    "arizona-state":       "Arizona State",
    "arkansas-state":      "Arkansas State",
    "ball-state":          "Ball State",
    "boise-state":         "Boise State",
    "boston-college":      "Boston College",
    "bowling-green":       "Bowling Green",
    "byu":                 "BYU",
    "california":          "California",
    "central-michigan":    "Central Michigan",
    "coastal-carolina":    "Coastal Carolina",
    "colorado-state":      "Colorado State",
    "east-carolina":       "East Carolina",
    "eastern-michigan":    "Eastern Michigan",
    "florida-atlantic":    "Florida Atlantic",
    "florida-international": "Florida International",
    "florida-state":       "Florida State",
    "fresno-state":        "Fresno State",
    "georgia-southern":    "Georgia Southern",
    "georgia-state":       "Georgia State",
    "georgia-tech":        "Georgia Tech",
    "iowa-state":          "Iowa State",
    "jacksonville-state":  "Jacksonville State",
    "james-madison":       "James Madison",
    "kansas-state":        "Kansas State",
    "kennesaw-state":      "Kennesaw State",
    "kent-state":          "Kent State",
    "louisiana":           "Louisiana",
    "louisiana-tech":      "Louisiana Tech",
    "lsu":                 "LSU",
    "miami-oh":            "Miami (OH)",
    "michigan-state":      "Michigan State",
    "middle-tennessee":    "Middle Tennessee",
    "mississippi-state":   "Mississippi State",
    "missouri-state":      "Missouri State",
    "nc-state":            "NC State",
    "new-mexico":          "New Mexico",
    "new-mexico-state":    "New Mexico State",
    "north-carolina":      "North Carolina",
    "north-texas":         "North Texas",
    "northern-illinois":   "Northern Illinois",
    "notre-dame":          "Notre Dame",
    "ohio-state":          "Ohio State",
    "oklahoma-state":      "Oklahoma State",
    "ole-miss":            "Ole Miss",
    "old-dominion":        "Old Dominion",
    "oregon-state":        "Oregon State",
    "penn-state":          "Penn State",
    "pitt":                "Pittsburgh",
    "sam-houston":         "Sam Houston State",
    "san-diego-state":     "San Diego State",
    "san-jos-state":       "San Jose State",
    "smu":                 "SMU",
    "south-alabama":       "South Alabama",
    "south-carolina":      "South Carolina",
    "south-florida":       "South Florida",
    "southern-miss":       "Southern Mississippi",
    "tcu":                 "TCU",
    "texas-am":            "Texas A&M",
    "texas-state":         "Texas State",
    "texas-tech":          "Texas Tech",
    "uab":                 "UAB",
    "ucf":                 "UCF",
    "ucla":                "UCLA",
    "uconn":               "UConn",
    "ul-monroe":           "Louisiana Monroe",
    "umass":               "Massachusetts",
    "unlv":                "UNLV",
    "usc":                 "USC",
    "utah-state":          "Utah State",
    "utep":                "UTEP",
    "utsa":                "UTSA",
    "vanderbilt":          "Vanderbilt",
    "virginia-tech":       "Virginia Tech",
    "wake-forest":         "Wake Forest",
    "washington-state":    "Washington State",
    "west-virginia":       "West Virginia",
    "western-kentucky":    "Western Kentucky",
    "western-michigan":    "Western Michigan",
}

logo_map = {}
copied   = []
skipped  = []

for row in manifest:
    slug = row.get("slug")
    if not slug or row.get("conference") == "conferences":
        continue

    src_file = SRC / f"{slug}.png"
    if not src_file.exists():
        skipped.append(slug)
        continue

    dst_file = DST / f"{slug}.png"
    shutil.copy2(str(src_file), str(dst_file))
    copied.append(slug)

    filename = f"{slug}.png"

    # Key 1: ESPN abbreviation
    abbr = ESPN_ABBR.get(slug)
    if abbr:
        logo_map[abbr] = filename

    # Key 2: ESPN location, lowercased
    loc = ESPN_LOC.get(slug)
    if not loc:
        # Derive from display_name: strip mascot via slug words
        dn = row.get("display_name", "")
        slug_words = slug.split("-")
        disp_words = dn.split()
        i = 0
        while (i < len(disp_words) and i < len(slug_words)
               and disp_words[i].lower().rstrip(".,") == slug_words[i].lower()):
            i += 1
        loc = " ".join(disp_words[:i]) if i > 0 else dn
    if loc:
        logo_map[loc.lower()] = filename
        # Also add accent-stripped variant for San Jose State
        normalized = loc.lower().replace("é", "e").replace("à", "a")
        if normalized != loc.lower():
            logo_map[normalized] = filename

(DST / "logo-map.json").write_text(
    json.dumps(logo_map, sort_keys=True, indent=2), encoding="utf-8"
)

print(f"Copied {len(copied)} logos to {DST}")
print(f"logo-map.json has {len(logo_map)} keys")
if skipped:
    print(f"Skipped (not in emoji set): {skipped}")
