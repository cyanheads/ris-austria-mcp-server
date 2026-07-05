/**
 * @fileoverview The nine Bundesländer and their RIS request spellings. RIS uses three
 * different shapes depending on the application: `Bundesland.SucheIn<Land>` boolean flags
 * (LrKons/LgblAuth; Lgbl has only seven — no Niederösterreich, no Wien), a flat ASCII enum
 * ("Kaernten" — Gr, GrA, Vbl, Lvwg, Uvs, and Spg's RSG `Land`), and a flat umlauted enum
 * ("Kärnten" — Bvb only). Grounded in the request XSDs and live probes (2026-07-05):
 * sending the wrong spelling fails schema validation.
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
