/**
 * @fileoverview Principal norm-type codes carried in consolidated-law records (`Typ` field)
 * and accepted by the BrKons/LrKons `Typ` filter. `Typ` is a full-text field, not a closed
 * enum — these are the principal codes confirmed against the live corpus (2026-07-05), not
 * an exhaustive list. Treaties additionally appear as "Vertrag – <party>" variants.
 * @module services/ris/reference/law-types
 */

/** One norm-type code. */
export interface LawType {
  /** Code as carried in document records and accepted by the `Typ` filter. */
  readonly code: string;
  /** English meaning. */
  readonly english: string;
  /** German name. */
  readonly germanName: string;
  /** Usage note. */
  readonly note: string | null;
}

/** Principal norm-type codes, live-confirmed. */
export const RIS_LAW_TYPES = [
  {
    code: 'BG',
    germanName: 'Bundesgesetz',
    english: 'Federal act',
    note: null,
  },
  {
    code: 'BVG',
    germanName: 'Bundesverfassungsgesetz',
    english: 'Federal constitutional act',
    note: null,
  },
  {
    code: 'V',
    germanName: 'Verordnung',
    english: 'Regulation (secondary legislation)',
    note: null,
  },
  {
    code: 'K',
    germanName: 'Kundmachung',
    english: 'Promulgation notice',
    note: null,
  },
  {
    code: 'Vertrag',
    germanName: 'Staatsvertrag',
    english: 'Treaty',
    note: 'Appears in records with a party suffix, e.g. "Vertrag – Multilateral" or "Vertrag – Deutschland".',
  },
] as const satisfies readonly LawType[];
