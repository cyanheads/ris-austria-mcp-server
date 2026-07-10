/**
 * @fileoverview The citation shapes `ris_lookup_citation` parses, with examples and the
 * deterministic route each resolves through.
 * @module services/ris/reference/citation-formats
 */

/** One citation kind. */
export interface CitationFormat {
  /** What the shape looks like. */
  readonly description: string;
  /** Example citations, verbatim. */
  readonly examples: readonly string[];
  /** Citation kind (also the resolver's `kind` value). */
  readonly kind: string;
  /** How the resolver routes it. */
  readonly resolvesVia: string;
}

/** All citation kinds the resolver understands. */
export const RIS_CITATION_FORMATS = [
  {
    kind: 'norm',
    description:
      'A provision of a law: section sign or Artikel plus the official abbreviation, in either order — section-first ("§ 6 DSG") or abbreviation-first ("DSG §1", the shape ris_search_case_law returns in norms_cited) — or a bare abbreviation for the whole law.',
    examples: ['§ 6 DSG', 'Art 10 B-VG', 'DSG §1', 'DSGVO Art32', 'ABGB'],
    resolvesVia:
      'Consolidated federal law (BrKons) via title + section-range filters, as in force on the requested date; a state hint routes to consolidated state law (LrKons).',
  },
  {
    kind: 'gazette',
    description:
      'A gazette citation: BGBl. with optional part I/II/III and Nr. year, pre-2004 BGBl. forms, imperial-era RGBl./StGBl. forms, or LGBl. with a state hint.',
    examples: [
      'BGBl. I Nr. 165/1999',
      'BGBl. II Nr. 171/2026',
      'BGBl. Nr. 194/1961',
      'RGBl. Nr. 189/1902',
      'LGBl. Nr. 61/2026',
    ],
    resolvesVia:
      'Year 2004+ → BgblAuth (Bgblnummer); 1945–2003 → BgblPdf (Bundesgesetzblatt); 1848–1940 and RGBl./StGBl./GBlÖ prefixes → BgblAlt (Gesetzblattnummer + Jahrgang); LGBl. + state hint → LgblAuth (Lgblnummer).',
  },
  {
    kind: 'case_number',
    description:
      'A Geschäftszahl — the format identifies the court (per-court examples: reference topic courts).',
    examples: ['2025-0.934.677', 'Ra 2019/22/0184', 'G 287/2022', '6Ob56/25k', 'W122 2312999-1'],
    resolvesVia:
      'Pattern-matched to the owning court application, then an exact Geschaeftszahl search; a court hint short-circuits, ambiguous formats probe up to two candidate applications.',
  },
  {
    kind: 'collection_number',
    description: 'An official collection citation of the VfGH or VwGH.',
    examples: ['VfSlg 19.632/2012', 'VwSlg 18.000 A/2010'],
    resolvesVia: 'Vfgh/Vwgh via the Sammlungsnummer filter.',
  },
] as const satisfies readonly CitationFormat[];
