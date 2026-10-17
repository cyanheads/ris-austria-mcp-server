/**
 * @fileoverview The nine Bundesländer and their RIS request spellings. RIS uses three
 * different shapes depending on the application: `Bundesland.SucheIn<Land>` boolean flags
 * (LrKons/LgblAuth; Lgbl has only seven — no Niederösterreich, no Wien), a flat ASCII enum
 * ("Kaernten" — Gr, GrA, Vbl, Lvwg, Uvs, and Spg's RSG `Land`), and a flat umlauted enum
 * ("Kärnten" — Bvb only). Grounded in the request XSDs and live probes (2026-07-05):
 * sending the wrong spelling fails schema validation. Also the fold that maps a caller's
 * spelling of a state (German, capitalized, umlauted, English) onto the tool-parameter code.
 * @module services/ris/reference/states
 */

/** One Bundesland with every RIS request spelling. */
export interface RisState {
  /** State code used by tool `scope`/`state` parameters (lowercase). */
  readonly code: string;
  /** Boolean flag element under `Bundesland.` for LrKons / LgblAuth / Lgbl. */
  readonly flagParam: string;
  /** Flat enum value for Gr, GrA, Vbl, Lvwg, Uvs, and Spg `Land` (ASCII, no umlauts). */
  readonly flatAscii: string;
  /** Flat enum value for Bvb (umlauted). */
  readonly flatUmlaut: string;
  /** Whether the historical non-authentic Lgbl gazette carries this state. */
  readonly inLgbl: boolean;
  /** German proper name. */
  readonly name: string;
}

/** All nine Bundesländer. */
export const RIS_STATES = [
  {
    code: 'burgenland',
    name: 'Burgenland',
    flagParam: 'SucheInBurgenland',
    flatAscii: 'Burgenland',
    flatUmlaut: 'Burgenland',
    inLgbl: true,
  },
  {
    code: 'kaernten',
    name: 'Kärnten',
    flagParam: 'SucheInKaernten',
    flatAscii: 'Kaernten',
    flatUmlaut: 'Kärnten',
    inLgbl: true,
  },
  {
    code: 'niederoesterreich',
    name: 'Niederösterreich',
    flagParam: 'SucheInNiederoesterreich',
    flatAscii: 'Niederoesterreich',
    flatUmlaut: 'Niederösterreich',
    inLgbl: false,
  },
  {
    code: 'oberoesterreich',
    name: 'Oberösterreich',
    flagParam: 'SucheInOberoesterreich',
    flatAscii: 'Oberoesterreich',
    flatUmlaut: 'Oberösterreich',
    inLgbl: true,
  },
  {
    code: 'salzburg',
    name: 'Salzburg',
    flagParam: 'SucheInSalzburg',
    flatAscii: 'Salzburg',
    flatUmlaut: 'Salzburg',
    inLgbl: true,
  },
  {
    code: 'steiermark',
    name: 'Steiermark',
    flagParam: 'SucheInSteiermark',
    flatAscii: 'Steiermark',
    flatUmlaut: 'Steiermark',
    inLgbl: true,
  },
  {
    code: 'tirol',
    name: 'Tirol',
    flagParam: 'SucheInTirol',
    flatAscii: 'Tirol',
    flatUmlaut: 'Tirol',
    inLgbl: true,
  },
  {
    code: 'vorarlberg',
    name: 'Vorarlberg',
    flagParam: 'SucheInVorarlberg',
    flatAscii: 'Vorarlberg',
    flatUmlaut: 'Vorarlberg',
    inLgbl: true,
  },
  {
    code: 'wien',
    name: 'Wien',
    flagParam: 'SucheInWien',
    flatAscii: 'Wien',
    flatUmlaut: 'Wien',
    inLgbl: false,
  },
] as const satisfies readonly RisState[];

/** A state code — the value every state-valued tool parameter takes. */
type RisStateCode = (typeof RIS_STATES)[number]['code'];

/**
 * The standard English names that differ from the German one, keyed in folded form. Each names
 * exactly one state; Burgenland, Salzburg, and Vorarlberg read the same in both languages.
 */
const ENGLISH_STATE_NAMES = new Map<string, RisStateCode>([
  ['vienna', 'wien'],
  ['tyrol', 'tirol'],
  ['carinthia', 'kaernten'],
  ['styria', 'steiermark'],
  ['lower austria', 'niederoesterreich'],
  ['upper austria', 'oberoesterreich'],
]);

/**
 * Fold a caller's spelling of a state onto the code a state-valued parameter takes: the German
 * name ("Niederösterreich", composed or decomposed), any capitalization, surrounding or doubled
 * whitespace, the ASCII transliteration, and the English names above. The value is
 * NFC-normalized, trimmed, whitespace-collapsed, and lowercased, ä/ö/ü become ae/oe/ue, and the
 * result is returned when `accepted` holds it — so the same fold reaches `federal`, `district`,
 * and `municipal` on fields that offer them. Every other value, and every non-string, comes
 * back exactly as sent, so the enum rejects it with the same error as before the fold.
 */
export function foldStateName(value: unknown, accepted: ReadonlySet<string>): unknown {
  if (typeof value !== 'string') return value;
  const folded = value
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue');
  if (accepted.has(folded)) return folded;
  const code = ENGLISH_STATE_NAMES.get(folded);
  return code !== undefined && accepted.has(code) ? code : value;
}
