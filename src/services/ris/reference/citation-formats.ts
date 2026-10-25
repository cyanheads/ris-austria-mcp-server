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
      'A provision of a law: section sign or Artikel plus the official abbreviation, in either order — section-first ("§ 6 DSG") or abbreviation-first ("DSG §1", the shape ris_search_case_law returns in norms_cited) — or a bare abbreviation for the whole law, including a short title whose hyphen is suspended before "und" ("Steuer- und Zollkoordination 2004"); an ordinal-led abbreviation ("1. COVID-19-JuBG §1") reads like any other, though a day and month name ("12. Mai") is a date, never a law. Sub-provisions (Abs, Z, lit, a parenthesized "(1)") and a terminal ";", which older VwGH entries end in, are dropped, so "Art. 6 (1) B-VG" searches B-VG Art 6. So is the version a law is cited in, an "idF" clause naming the amending act or "aF" / "nF" ("ABGB idF 2. ErwSchG §254" and "ABGB aF §140" search the ABGB): the version searched stays the one in force on the requested date (resolution_note says the cited version was not applied), and a gazette number inside the clause does not make the cite a gazette citation, while a law named by its own gazette number before the clause still is one, as is a cite whose only provision is a Roman-numbered Artikel of the amending act ("AngG idF BGBl 1975/418 ArtII"). A long title cited with its short form after a dash ("StaatsanwaltschaftsG - StAG §35") reads as the short form. A comma-joined entry citing several provisions of one law ("DSG §1, §24", as VfGH headnotes write it), or one joining full norms with ". " ("ZPO §179. ZPO §275 Abs2", as OGH headnotes write it), resolves its first provision and names the rest as their own cites.',
    examples: ['§ 6 DSG', 'Art 10 B-VG', 'DSG §1', 'EMRK Art8', 'DSG §1, §24', 'ABGB'],
    resolvesVia:
      'Consolidated federal law (BrKons) via title + section-range filters, as in force on the requested date; a state hint routes to consolidated state law (LrKons). The hit whose abbreviation is the cited one wins, then the cited one plus a year ("EStG" → EStG 1988), then the cited one without a year RIS’s abbreviation omits, when the law’s short title carries it ("AlVG 1977" → AlVG), the exact §/Artikel label ahead of a prefixed one. A cite whose year matches nothing ("VwGVG 2014") is searched once more without it, taking only the law filed under the cited abbreviation without that year and first promulgated no later than it, for a year no later than the in-force date’s. An EU act RIS does not consolidate (DSGVO, the Charter as GRC or EU-Grundrechte-Charta, EuGVVO, EuInsVO 2015, EuUVO, the EC Treaty as EG, EGV, or EG-Vertrag), an EU act cited by its number ("RL 2006/123/EG", "VO (EG) 178/2002"), or a cite led by a CELEX other than a post-Lisbon TFEU or TEU one, returns found: false pointing to EUR-Lex, decided before any RIS request; a leading TFEU/TEU CELEX from 2008 on ("12010E267 AEUV Art267") is dropped and the rest resolves, while an earlier one ("11997E175 EG Art175") names the EC Treaty or a pre-Lisbon TEU and is an EU miss. An act number is an EU act only when it is the whole abbreviation, with at most one designator such as RL, VO, or Richtlinie before it, so an Austrian law whose name holds one ("UmsetzungsG-RL 2014/54/EU") still resolves.',
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
