// 2026-27 season layer for the club catalogue.
// The FCLOGO data only knows each club's federation, so top-flight membership,
// promotions and relegations are applied here, keyed on normalised club names.

export const SEASON = "2026-27";
export const LOWER_LABEL = "Lower divisions";

const FED_LEAGUES = new Set(["Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1"]);

/** Strip accents/punctuation so "Köln", "1. FC Köln" and "fckoln" compare alike. */
export const norm = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Tokens match when contained in the normalised name/fullName of a club from that federation.
const TOP_FLIGHT = {
  "Premier League": {
    clubs: ["chelsea", "mancity", "manchestercity", "arsenal", "liverpool", "astonvilla", "bournemouth", "brentford", "brighton",
      "crystalpalace", "everton", "fulham", "ipswich", "manchesterunited", "manunited", "newcastle", "nottingham", "tottenham",
      "leeds", "sunderland", "coventry", "hullcity"],
    promoted: ["ipswich", "coventry", "hullcity"],
    relegated: { wolves: "Championship", burnley: "Championship", westham: "Championship" },
  },
  "La Liga": {
    clubs: ["realmadrid", "barcelona", "atletico", "athletic", "sevilla", "valencia", "villarreal", "alaves", "celta", "coruna",
      "elche", "espanyol", "getafe", "levante", "malaga", "osasuna", "racingsantander", "rayo", "betis", "realsociedad"],
    promoted: ["racingsantander", "coruna", "malaga"],
    relegated: { mallorca: "Segunda División", girona: "Segunda División", oviedo: "Segunda División" },
  },
  "Serie A": {
    clubs: ["juventus", "inter", "acmilan", "atalanta", "bologna", "cagliari", "como", "fiorentina", "frosinone", "genoa", "lazio",
      "lecce", "monza", "napoli", "parma", "roma", "sassuolo", "torino", "udinese", "venezia"],
    promoted: ["venezia", "frosinone", "monza"],
    relegated: { cremonese: "Serie B", verona: "Serie B", pisa: "Serie B" },
  },
  Bundesliga: {
    clubs: ["bayern", "dortmund", "augsburg", "leverkusen", "stuttgart", "leipzig", "frankfurt", "hoffenheim", "bremen", "freiburg",
      "mainz", "monchengladbach", "unionberlin", "hamburg", "koln", "paderborn", "schalke", "elversberg"],
    promoted: ["schalke", "elversberg", "paderborn"],
    relegated: { wolfsburg: "2. Bundesliga", heidenheim: "2. Bundesliga", stpauli: "2. Bundesliga" },
  },
  "Ligue 1": {
    clubs: ["parissg", "psg", "angers", "auxerre", "brest", "lehavre", "lemans", "lens", "lille", "lorient", "lyon", "marseille",
      "monaco", "nice", "parisfc", "rennais", "rennes", "strasbourg", "toulouse", "troyes"],
    promoted: ["lemans", "troyes"],
    relegated: { metz: "Ligue 2", nantes: "Ligue 2" },
  },
};

const hits = (keys, tokens) => tokens.some((t) => keys.some((k) => k.includes(t)));

/** Returns the club with its 2026-27 league, and `seasonStatus` set to "promoted" or "relegated" where it applies. */
export function applySeason(club) {
  const rules = TOP_FLIGHT[club.league];
  if (!rules) return club;
  const keys = [norm(club.name), norm(club.fullName)].filter(Boolean);
  if (hits(keys, rules.clubs)) {
    return hits(keys, rules.promoted) ? { ...club, seasonStatus: "promoted" } : club;
  }
  const rel = Object.entries(rules.relegated).find(([t]) => hits(keys, [t]));
  if (rel) return { ...club, league: rel[1], seasonStatus: "relegated" };
  return FED_LEAGUES.has(club.league) ? { ...club, league: LOWER_LABEL } : club;
}

const FCLOGO = "https://cdn.jsdelivr.net/gh/FCLOGO/fclogo.top@main/src/data/logos";
const svg = (fed, dir, file) => `${FCLOGO}/${fed}/clubs/${encodeURIComponent(dir)}/svg/${file}`;

/** 2026-27 top-flight clubs that the bundled catalogue lacks. Those without a logo file are found online on click. */
export const SEASON_EXTRAS = [
  {
    id: "RFEF_005_Alaves", name: "Deportivo Alavés", fullName: "Deportivo Alavés", city: "Vitoria-Gasteiz", nation: "ESP", league: "La Liga", federation: "RFEF",
    colorUrl: svg("RFEF", "005_Alavés", "Deportivo-Alaves-v2020.svg"), monoUrl: svg("RFEF", "005_Alavés", "Deportivo-Alaves-v2020-mono.svg"),
    aliases: ["alaves", "alavés", "vitoria"],
  },
  {
    id: "DFB_019_Koln", name: "1. FC Köln", fullName: "1. FC Köln", city: "Köln", nation: "GER", league: "Bundesliga", federation: "DFB",
    colorUrl: svg("DFB", "019_Köln", "FC-Koln-v1993.svg"), monoUrl: svg("DFB", "019_Köln", "FC-Koln-v1993-mono.svg"),
    aliases: ["koln", "köln", "cologne", "fc koln"],
  },
  { id: "NEW_Coventry", name: "Coventry City", city: "Coventry", nation: "ENG", league: "Premier League", seasonStatus: "promoted", needsOnline: true, aliases: ["coventry", "sky blues"] },
  { id: "NEW_Hull", name: "Hull City", city: "Hull", nation: "ENG", league: "Premier League", seasonStatus: "promoted", needsOnline: true, aliases: ["hull", "tigers"] },
  { id: "NEW_Frosinone", name: "Frosinone", city: "Frosinone", nation: "ITA", league: "Serie A", seasonStatus: "promoted", needsOnline: true, aliases: ["frosinone calcio"] },
  { id: "NEW_LeMans", name: "Le Mans FC", city: "Le Mans", nation: "FRA", league: "Ligue 1", seasonStatus: "promoted", needsOnline: true, aliases: ["le mans", "mans"] },
  { id: "NEW_Troyes", name: "ES Troyes AC", city: "Troyes", nation: "FRA", league: "Ligue 1", seasonStatus: "promoted", needsOnline: true, aliases: ["troyes", "estac"] },
];
