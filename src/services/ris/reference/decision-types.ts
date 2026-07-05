/**
 * @fileoverview Decision document types for case-law searches — headnote (Rechtssatz) vs.
 * full decision text (Entscheidungstext) — and how they map to the upstream `Dokumenttyp`
 * flags. One decision can appear as several headnote documents plus one text document
 * sharing the same Geschäftszahl.
 * @module services/ris/reference/decision-types
 */

/** One decision document type. */
export interface DecisionType {
  /** Value used by the tool's `decision_type` parameter. */
  readonly code: 'headnote' | 'full_text' | 'all';
  /** What the value selects. */
  readonly description: string;
  /** German name of the document kind. */
  readonly germanName: string;
  /** Upstream mapping. */
  readonly upstream: string;
}

/** All decision document types. */
export const RIS_DECISION_TYPES = [
  {
    code: 'headnote',
    germanName: 'Rechtssatz',
    upstream: 'Dokumenttyp.SucheInRechtssaetzen=true',
    description:
      'Search only headnotes — the distilled legal propositions extracted from a decision.',
  },
  {
    code: 'full_text',
    germanName: 'Entscheidungstext',
    upstream: 'Dokumenttyp.SucheInEntscheidungstexten=true',
    description: 'Search only full decision texts.',
  },
  {
    code: 'all',
    germanName: 'Rechtssatz und Entscheidungstext',
    upstream: 'both flags omitted (upstream searches everything)',
    description:
      'Search headnotes and full texts alike — the default. Not available on gbk, upts, or normenliste.',
  },
] as const satisfies readonly DecisionType[];
