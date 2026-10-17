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
      'Consolidated federal law (BrKons) via title + section-range filters, as in force on the requested date; a state hint routes to consolidated state law (LrKons). The hit whose abbreviation is the cited one wins, then the cited one plus a year ("EStG" → EStG 1988), the exact §/Artikel label ahead of a prefixed one.',
  },
  {
    kind: 'gazette',
    description:
      'A gazette citation: BGBl. with optional part I/II/III and Nr. year, pre-2004 BGBl. forms, RGBl./StGBl./GBlÖ forms, or LGBl. with a state hint. Number and year read in either order — year-first "BGBl I 2018/24" is number 24 of 2018, while "BGBl. Nr. 1005/1994" keeps its number above 999, since a four-digit year from 1848 on in second place stays the year.',
    examples: [
      'BGBl. I Nr. 165/1999',
      'BGBl. II Nr. 171/2026',
      'BGBl I 2018/24',
      'BGBl. Nr. 194/1961',
      'RGBl. Nr. 189/1902',
      'StGBl. Nr. 1/1945',
      'LGBl. Nr. 61/2026',
    ],
    resolvesVia:
      'Year 2004+ → BgblAuth (Bgblnummer); 1945–2003 → BgblPdf (Bundesgesetzblatt), including the 1945 StGBl.; 1848–1940 and RGBl./GBlÖ prefixes → BgblAlt (Gesetzblattnummer, the full n/yyyy form), StGBl. 1918–1920 included. A gazette files several series under one number space — the StGBl. and BGBl. in 1945, the older gazettes in their changeover years — so the entry whose own gazette (Fundstelle or Kundmachungsorgan) is the cited one wins; a number only another series carries returns found: false naming that entry. LGBl. + state hint → LgblAuth (Lgblnummer), falling back on zero hits to that Bundesland’s pre-e-Recht Lgbl series. Niederösterreich keys its legacy collection by Gliederungszahl and Wien has no legacy series, so neither is reachable by an LGBl. number before that state’s switch. A BGBl. number from 1997 on cited without its part, matching more than one of parts I/II/III, returns found: false naming each part.',
  },
  {
    kind: 'case_number',
    description:
      'A Geschäftszahl — the format identifies the court (per-court examples: reference topic courts) — optionally after the court name (VfGH, VwGH, OGH, BVwG, or DSB); or a decision’s ECLI.',
    examples: [
      '2025-0.934.677',
      'Ro 2026/03/0016',
      'G 287/2022',
      'G13/2025',
      '14Os49/26a',
      'W122 2312999-1',
      'VfGH G 13/2025',
      'OGH 6 Ob 236/23h',
      'ECLI:AT:VFGH:2026:G13.2025',
    ],
    resolvesVia:
      'Pattern-matched to the owning court application (a leading court name sets it), then an exact Geschaeftszahl search across headnotes and decision texts, where the decision text wins, then a Rechtssatz that decision leads; a court hint short-circuits, ambiguous formats probe up to two candidate applications. An ECLI maps its court segment (VFGH, VWGH, OGH/OLG/LG/BG + court number, BVWG, LVWG + state, DSB, PDK, PVAB) to the application and full-text searches the quoted ECLI there; the decision text carrying it wins over a Rechtssatz carrying it.',
  },
  {
    kind: 'collection_number',
    description:
      'An official collection citation of the VfGH or VwGH. A VwSlg cite carries a part letter — A for the administrative series, F for the finance series — and the two reuse numbers, so a cite given without it names a decision in each.',
    examples: ['VfSlg 19.632/2012', 'VwSlg 18.000 A/2010', 'VwSlg 8000 F/2005'],
    resolvesVia:
      'Vfgh/Vwgh via the Sammlungsnummer filter, whose accepted value differs by court: Vfgh (and Uvs) store the bare number and match it dotted or undotted, while Vwgh stores the full labelled undotted cite ("VwSlg 18000 A/2010") and matches nothing on a bare or dotted number.',
  },
] as const satisfies readonly CitationFormat[];
