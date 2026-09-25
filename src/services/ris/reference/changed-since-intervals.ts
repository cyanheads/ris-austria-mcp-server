/**
 * @fileoverview `changed_since` interval values and their upstream `ImRisSeit` spellings
 * (request XSD `ChangeSetInterval`). `ImRisSeit` filters on when a document last changed in
 * RIS. Avsv and Avn accept the element but ignore it, so the announcements builder refuses
 * `changed_since` for them; their `Kundmachung.Periode` shares this value set but filters on
 * promulgation date, a different question that `published_from` already answers exactly.
 * @module services/ris/reference/changed-since-intervals
 */

/** One recency interval. */
export interface ChangedSinceInterval {
  /** Value used by the tool's `changed_since` parameter. */
  readonly code: string;
  /** English meaning. */
  readonly english: string;
  /** Upstream `ImRisSeit` value. */
  readonly risValue: string;
}

/** All six intervals. */
export const RIS_CHANGED_SINCE_INTERVALS = [
  { code: 'one_week', risValue: 'EinerWoche', english: 'Within the last week' },
  { code: 'two_weeks', risValue: 'ZweiWochen', english: 'Within the last two weeks' },
  { code: 'one_month', risValue: 'EinemMonat', english: 'Within the last month' },
  { code: 'three_months', risValue: 'DreiMonaten', english: 'Within the last three months' },
  { code: 'six_months', risValue: 'SechsMonaten', english: 'Within the last six months' },
  { code: 'one_year', risValue: 'EinemJahr', english: 'Within the last year' },
] as const satisfies readonly ChangedSinceInterval[];
