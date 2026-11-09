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
  /** Citation kind — the resolver's `kind` value, except `eli`, which resolves as norm or gazette. */
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
      'A gazette citation: BGBl. with optional part I/II/III and Nr. year, pre-2004 BGBl. forms, RGBl./StGBl./GBlÖ forms, LGBl. with a state hint, or a state gazette organ carrying its Bundesland as federal records cite it (LGBlBgld., LGBlKtn., LGBlNÖ, LGBlOÖ., LGBlSbg., LGBlStmk., LGBlTir., LGBlVbg., LGBlW.), which names the state itself. Number and year read in either order — year-first "BGBl I 2018/24" is number 24 of 2018, while "BGBl. Nr. 1005/1994" keeps its number above 999, since a four-digit year from 1848 on in second place stays the year; a year in first place is never past the current one, so Niederösterreich’s systematic "LGBl. 8240/2-0" reads as no number and year. "BGBI", a capital I for the l, reads as BGBl. A string of several cites, as a consolidated record’s promulgation joins them ("BGBl. Nr. 267/1967 zuletzt geändert durch BGBl. I Nr. 17/2026"), is read by its first cite alone — the text through its first number/year pair — so a later cite’s part or series never filters it.',
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
      'Year 2004+ → BgblAuth (Bgblnummer); 1945–2003 → BgblPdf (Bundesgesetzblatt), including the 1945 StGBl.; 1848–1940 and RGBl./GBlÖ prefixes → BgblAlt (Gesetzblattnummer, the full n/yyyy form), StGBl. 1918–1920 included. A gazette files several series under one number space — the StGBl. and BGBl. in 1945, the older gazettes in their changeover years — so the entry whose own gazette (Fundstelle or Kundmachungsorgan) is the cited one wins; a number only another series carries returns found: false naming that entry. LGBl. + state hint → LgblAuth (Lgblnummer), falling back on zero hits to that Bundesland’s pre-e-Recht Lgbl series. Niederösterreich keys its legacy collection by Gliederungszahl and Wien has no legacy series, so neither is reachable by an LGBl. number before that state’s switch. A BGBl. number from 1997 on cited without its part, matching more than one of parts I/II/III, returns found: false naming each part. Each later cite of a several-cite string is named, with the words linking it in parentheses as RIS writes them ("BGBl. I Nr. 17/2026 (zuletzt geändert durch)"), never searched; a first cite in a gazette the lookup does not read ("ABl.Nr. 52/2006", "dRGBl. I S 653/1936") returns found: false without a request.',
  },
  {
    kind: 'case_number',
    description:
      'A Geschäftszahl — the format identifies the court (per-court examples: reference topic courts) — optionally after the court name (VfGH, VwGH, OGH, BVwG, or DSB); a decision’s ECLI; or a Justiz Rechtssatz number: R, then one or two capitals naming the court (RS for the OGH, RW for OLG Wien, RLI for LG Linz), then seven digits — "RS0022961" — optionally after "RIS-Justiz" and before a bracket of T numbers ("RS0022961 [T3, T7]").',
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
      'RS0022961',
      'RIS-Justiz RS0022961 [T3]',
      'RW0001127',
    ],
    resolvesVia:
      'Pattern-matched to the owning court application (a leading court name sets it), then an exact Geschaeftszahl search across headnotes and decision texts, where the decision text wins, then a Rechtssatz that decision leads; a court hint short-circuits, ambiguous formats probe up to two candidate applications. An ECLI maps its court segment (VFGH, VWGH, OGH/OLG/LG/BG + court number, BVWG, LVWG + state, DSB, PDK, PVAB) to the application and full-text searches the quoted ECLI there; the decision text carrying it wins over a Rechtssatz carrying it. A Rechtssatz number is one Justiz search on Rechtssatznummer, uppercased, whatever the court hint (Vwgh and Vfgh ignore the filter); its bracketed T numbers count Beisätze, additions later decisions made inside the same Rechtssatz document, so they are not searched.',
  },
  {
    kind: 'collection_number',
    description:
      'An official collection citation of the VfGH or VwGH, with the year after the slash. A VwSlg cite carries a part letter — A for the administrative series, F for the finance series — and the two reuse numbers, so a cite given without it names a decision in each. VfSlg numbering restarted in 1921, so a number from the 1919–1920 volumes given without its year names a 1921 decision too.',
    examples: ['VfSlg 19.632/2012', 'VwSlg 18.000 A/2010', 'VwSlg 8000 F/2005'],
    resolvesVia:
      'Vfgh/Vwgh via the Sammlungsnummer filter, whose accepted value differs by court: Vfgh (and Uvs) store the bare number and match it dotted or undotted, while Vwgh stores the full labelled undotted cite ("VwSlg 18000 A/2010") and matches nothing on a bare or dotted number. The cited year is checked on the hits, not sent: a hit agrees when the cited year is its decision year or, on Vwgh, the year its Sammlungsnummer carries (RIS labels some old decisions with their Geschäftszahl year, "VwSlg 6843 A/1964" decided 1966), a two-digit year comparing on its last two digits. A Vfgh Rechtssatz listing several numbers ("17330 - 17898") is dated by its first number’s decision and confirms only that one; with no hit dated to the cited decision the year goes unchecked. A VwSlg cite with a year whose first search finds no decision of that year sends one more: Sammlungsnummer "*1485*" (the undotted number, wildcarded on both sides) within that year’s decision dates, a two-digit year spanning the latest year ending in it. It reaches the shapes VwGH stores some older cites in, which the labelled prefix misses ("VwSlg 0017 F/1947", "VwSlg. 1485 A/1950", "VwSlg 544 /F1952", "VwSlg 10414/A", "VwSlg 9766/79"), and a row counts only when its stored value names the cited number, a part letter not contradicting the cited one (a row without a letter contradicts none), and the year; rows naming more than one decision return found: false naming each, and rows naming the cited number and year only under another part letter return found: false naming them and the cite carrying that letter. A number that matched only other years returns found: false naming each cite it does match, and a cite naming more than one decision — a VwSlg cite without its part letter, or a VfSlg number from the 1919–1920 volumes without its year (VfSlg numbering restarted in 1921) — returns found: false naming each.',
  },
  {
    kind: 'eli',
    description:
      'An ELI (European Legislation Identifier) link on ris.bka.gv.at, www.ris.bka.gv.at, or ogd.ris.bka.gv.at, over https or http — the eli or document_url a consolidated-law or authentic-gazette record carries — read under kind auto before any cite shape. A consolidated provision’s ELI ends in its document number, whatever gazette and era the path before it names (NOR… federal; LBG…, LKT…, LNO…, LOO…, LSB…, LST…, LTI…, LVB…, or LWI… state); an authentic gazette’s is /eli/bgbl/{I|II|III}/{year}/{number}/{yyyymmdd} or /eli/lgbl/{state}/{year}/{number}/{yyyymmdd}. Another layout whose path spells a gazette cite (/eli/bgbl/{I|II|III}/{year}/{number}, /eli/lgbl/{state}/{year}/{number}, or /eli/{bgbl|rgbl|stgbl|gbloe}/{year}/{number} with no part, as before 1997) followed by nothing but date, language, or format segments (/eli/bgbl/II/2026/317, /eli/bgbl/1974/60) is classified as that cite; any other /eli/ layout on those hosts, such as a provision’s path cut before its document number (/eli/bgbl/i/1999/165/A2P4, /eli/bgbl/1974/60/P75), returns found: false with kind unknown, nothing searched. A forced kind parses the link as a citation.',
    examples: [
      'https://www.ris.bka.gv.at/eli/bgbl/1974/60/P75/NOR12029618',
      'https://ris.bka.gv.at/eli/lgbl/NI/0824/A13/LNO40086080',
      'https://www.ris.bka.gv.at/eli/bgbl/II/2026/317/20261103',
      'https://ogd.ris.bka.gv.at/eli/lgbl/SA/2026/103/20261104',
    ],
    resolvesVia:
      'A consolidated ELI resolves as kind norm: BrKons (NOR…) or LrKons (L…) searched with the document number as query and no in-force date, so a version no longer in force resolves too; the hit carrying that number wins, and in_force_as_of and state are not applied. A gazette ELI resolves as kind gazette: BgblAuth by number and part, or LgblAuth by number and the ELI’s state; the entry carrying the document number the ELI names wins (BGBLA_{year}_{part}_{number}, LGBLA_{state}_{yyyymmdd}_{number}). A miss on either returns found: false in that kind.',
  },
] as const satisfies readonly CitationFormat[];
