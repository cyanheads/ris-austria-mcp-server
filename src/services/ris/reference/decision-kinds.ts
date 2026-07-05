/**
 * @fileoverview Per-court `Entscheidungsart` (decision kind) values. Most courts validate
 * against a schema enum (request XSDs); Justiz takes an exact-match string with four
 * documented values. Courts not listed here have no Entscheidungsart parameter at all.
 * The XSD enums carry an "Undefined" sentinel meaning "no filter" — omitted here.
 * @module services/ris/reference/decision-kinds
 */

/** Decision-kind values for one court. */
export interface CourtDecisionKinds {
  /** Court code (matches `RIS_COURTS`). */
  readonly court: string;
  /** Usage note, when needed. */
  readonly note: string | null;
  /** Whether upstream validates the value against a schema enum or matches a string. */
  readonly paramKind: 'schema_enum' | 'exact_match_string';
  /** Valid values, verbatim. */
  readonly values: readonly string[];
}

/** Courts whose search request has no Entscheidungsart parameter. */
export const COURTS_WITHOUT_DECISION_KIND = [
  'normenliste',
  'dok',
  'pvak',
  'umse',
  'bks',
  'upts',
] as const;

/** Decision-kind values per court that has the parameter. */
export const RIS_DECISION_KINDS = [
  {
    court: 'vfgh',
    paramKind: 'schema_enum',
    values: ['Beschluss', 'Erkenntnis', 'Vergleich', 'KeineAngabe'],
    note: null,
  },
  {
    court: 'vwgh',
    paramKind: 'schema_enum',
    values: ['Beschluss', 'Erkenntnis', 'BeschlussVS', 'ErkenntnisVS'],
    note: 'VS marks decisions of a verstärkter Senat (enlarged panel).',
  },
  {
    court: 'justiz',
    paramKind: 'exact_match_string',
    values: [
      'Ordentliche Erledigung (Sachentscheidung)',
      'Zurückweisung mangels erheblicher Rechtsfrage',
      'Zurückweisung aus anderen Gründen',
      'Verstärkter Senat',
    ],
    note: 'New in API v2.6; like Fachgebiet, tagging is not yet populated in the corpus — probed values returned 0 hits on 2026-07-05.',
  },
  {
    court: 'bvwg',
    paramKind: 'schema_enum',
    values: ['Beschluss', 'Erkenntnis'],
    note: null,
  },
  {
    court: 'lvwg',
    paramKind: 'schema_enum',
    values: ['Beschluss', 'Erkenntnis', 'Bescheid'],
    note: null,
  },
  {
    court: 'dsk',
    paramKind: 'schema_enum',
    values: [
      'BescheidBeschwerde',
      'BescheidAmtswegigesPruefverfahren',
      'VerwaltungsstraferkenntnisVerwarnungErmahnung',
      'BescheidWissenschaftStatistikArchiv',
      'BescheidInternatDatenverkehr',
      'BescheidAkkreditierungZertifizierung',
      'BescheidVerhaltensregeln',
      'BescheidWarnung',
      'BescheidRegistrierung',
      'BescheidSonstiger',
      'Empfehlung',
      'Verfahrensschriftsaetze',
    ],
    note: 'BescheidBeschwerde (complaint decisions) is the volume category — 1,296 live hits on 2026-07-05.',
  },
  {
    court: 'gbk',
    paramKind: 'schema_enum',
    values: ['Einzelfallpruefungsergebnis', 'Gutachten'],
    note: null,
  },
  {
    court: 'uvs',
    paramKind: 'schema_enum',
    values: ['Beschluss', 'Erkenntnis', 'Bescheid'],
    note: null,
  },
  {
    court: 'asylgh',
    paramKind: 'schema_enum',
    values: [
      'Beschluss',
      'Erkenntnis',
      'ErkenntnisGrundsatzentscheidung',
      'ErkenntnisVerstaerkterSenat',
      'Bescheid',
    ],
    note: null,
  },
  {
    court: 'ubas',
    paramKind: 'schema_enum',
    values: ['Bescheid', 'Ersatzbescheid'],
    note: null,
  },
  {
    court: 'verg',
    paramKind: 'schema_enum',
    values: [
      'Bescheid',
      'Beschluss',
      'Empfehlung',
      'Gutachten',
      'Vorabentscheidungsantrag',
      'Vorabentscheidung',
    ],
    note: null,
  },
] as const satisfies readonly CourtDecisionKinds[];
