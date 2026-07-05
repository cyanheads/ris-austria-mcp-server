/**
 * @fileoverview Section types for the consolidated-law section range filter — upstream
 * `Abschnitt.Typ` (request XSD `NormabschnittTyp`).
 * @module services/ris/reference/section-types
 */

/** One section type. */
export interface SectionType {
  /** English meaning. */
  readonly english: string;
  /** Usage note. */
  readonly note: string | null;
  /** Exact `Abschnitt.Typ` value (also the tool's `section_type` value). */
  readonly value: string;
}

/** All four section types. */
export const RIS_SECTION_TYPES = [
  {
    value: 'Alle',
    english: 'All section kinds',
    note: null,
  },
  {
    value: 'Artikel',
    english: 'Article (Artikel)',
    note: 'Used by constitutional laws and treaties (e.g. "Art 10 B-VG").',
  },
  {
    value: 'Paragraph',
    english: 'Paragraph (§)',
    note: 'The default when a section range is given without a type — most laws are §-numbered.',
  },
  {
    value: 'Anlage',
    english: 'Annex (Anlage)',
    note: null,
  },
] as const satisfies readonly SectionType[];
