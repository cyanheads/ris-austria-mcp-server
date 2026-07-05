/**
 * @fileoverview The 17 case-law court/tribunal codes served by `ris_search_case_law`:
 * English descriptions, active-vs-historical status with successor mapping, and a real
 * Geschäftszahl format example per court. Examples come from the design's live-confirmed
 * set and from live search results harvested 2026-07-05.
 * @module services/ris/reference/courts
 */

/** One court/tribunal reachable through the case-law surface. */
export interface RisCourt {
  /** Exact RIS `Applikation` value the code routes to. */
  readonly application: string;
  /** Court code used by the `court` tool parameter (lowercase). */
  readonly code: string;
  /** German designation. */
  readonly germanName: string;
  /** A real Geschäftszahl from this court, showing the case-number format. */
  readonly gzExample: string | null;
  /** English name. */
  readonly name: string;
  /** Extra usage note, when needed. */
  readonly note: string | null;
  /** Whether the body still decides cases or is a closed historical window. */
  readonly status: 'active' | 'historical';
  /** Court code of the successor body, for historical bodies with one. */
  readonly successor: string | null;
  /** Coverage window, when documented. */
  readonly window: string | null;
}

/** All 17 case-law codes. */
export const RIS_COURTS = [
  {
    code: 'vfgh',
    application: 'Vfgh',
    name: 'Constitutional Court',
    germanName: 'Verfassungsgerichtshof',
    status: 'active',
    window: 'Decisions 1980 and later',
    successor: null,
    gzExample: 'G 287/2022',
    note: 'Official collection numbers use the VfSlg form (e.g. "VfSlg 19.632/2012").',
  },
  {
    code: 'vwgh',
    application: 'Vwgh',
    name: 'Supreme Administrative Court',
    germanName: 'Verwaltungsgerichtshof',
    status: 'active',
    window: 'Decisions 1990 and later; older decisions selected',
    successor: null,
    gzExample: 'Ra 2019/22/0184',
    note: 'Official collection numbers use the VwSlg form (e.g. "VwSlg 18.000 A/2010").',
  },
  {
    code: 'justiz',
    application: 'Justiz',
    name: 'Ordinary courts (Supreme Court of Justice and selected lower courts)',
    germanName: 'Ordentliche Gerichtsbarkeit (OGH, OLG, LG, BG)',
    status: 'active',
    window: 'Selected decisions only, not the full record',
    successor: null,
    gzExample: '6Ob56/25k',
    note: 'The court_name, legal_area, and subject_area filters apply only here.',
  },
  {
    code: 'bvwg',
    application: 'Bvwg',
    name: 'Federal Administrative Court',
    germanName: 'Bundesverwaltungsgericht',
    status: 'active',
    window: 'Decisions 2014 and later',
    successor: null,
    gzExample: 'W122 2312999-1',
    note: null,
  },
  {
    code: 'lvwg',
    application: 'Lvwg',
    name: 'State administrative courts',
    germanName: 'Landesverwaltungsgerichte',
    status: 'active',
    window: 'Decisions 2014 and later',
    successor: null,
    gzExample: 'LVwG-AV-757/001-2026',
    note: 'The state filter selects one of the nine courts (ASCII spelling, e.g. "Kaernten").',
  },
  {
    code: 'dsk',
    application: 'Dsk',
    name: 'Data protection authority',
    germanName: 'Datenschutzbehörde / Datenschutzkommission',
    status: 'active',
    window: 'Decisions 1990 and later, selected',
    successor: null,
    gzExample: '2026-0.092.118',
    note: 'The issuing_body filter splits the Datenschutzbehörde (2014+) from the historical Datenschutzkommission (up to 2013).',
  },
  {
    code: 'normenliste',
    application: 'Normenliste',
    name: 'VwGH norm index',
    germanName: 'Normenliste des Verwaltungsgerichtshofes',
    status: 'active',
    window: null,
    successor: null,
    gzExample: null,
    note: 'A register of norms, not decisions — no case-number, date, or decision-type filters.',
  },
  {
    code: 'dok',
    application: 'Dok',
    name: 'Civil-service disciplinary authorities',
    germanName: 'Bundesdisziplinarbehörde / Disziplinarkommissionen',
    status: 'active',
    window: null,
    successor: null,
    gzExample: '2024-0.222.873',
    note: 'The issuing_body filter takes one of 59 documented authorities (topic issuing_bodies).',
  },
  {
    code: 'pvak',
    application: 'Pvak',
    name: 'Staff-representation oversight authority',
    germanName: 'Personalvertretungsaufsichtsbehörde / Personalvertretungsaufsichtskommission',
    status: 'active',
    window: null,
    successor: null,
    gzExample: 'B10-PVAB/25',
    note: null,
  },
  {
    code: 'gbk',
    application: 'Gbk',
    name: 'Equal-treatment commissions',
    germanName: 'Bundes-Gleichbehandlungskommission / Gleichbehandlungskommission',
    status: 'active',
    window: null,
    successor: null,
    gzExample: 'B-GBK II/307/26',
    note: 'The commission, senate, and discrimination_ground filters apply only here.',
  },
  {
    code: 'uvs',
    application: 'Uvs',
    name: 'Independent administrative senates',
    germanName: 'Unabhängige Verwaltungssenate',
    status: 'historical',
    window: '1991–2013',
    successor: 'lvwg',
    gzExample: '411-034/13',
    note: null,
  },
  {
    code: 'asylgh',
    application: 'AsylGH',
    name: 'Asylum Court',
    germanName: 'Asylgerichtshof',
    status: 'historical',
    window: '2008–2013',
    successor: 'bvwg',
    gzExample: 'B5 420141-2/2012',
    note: null,
  },
  {
    code: 'ubas',
    application: 'Ubas',
    name: 'Independent Federal Asylum Senate',
    germanName: 'Unabhängiger Bundesasylsenat',
    status: 'historical',
    window: '1998–2008',
    successor: 'asylgh',
    gzExample: '227.475/0/21E-VIII/23/02',
    note: null,
  },
  {
    code: 'umse',
    application: 'Umse',
    name: 'Environmental Senate',
    germanName: 'Umweltsenat',
    status: 'historical',
    window: 'Until 2013',
    successor: null,
    gzExample: 'US 8B/2013/14-4',
    note: null,
  },
  {
    code: 'bks',
    application: 'Bks',
    name: 'Federal Communications Senate',
    germanName: 'Bundeskommunikationssenat',
    status: 'historical',
    window: 'Until 2013',
    successor: null,
    gzExample: '611.001/0009-BKS/2013',
    note: 'The subject_law filter (media statute) applies only here.',
  },
  {
    code: 'verg',
    application: 'Verg',
    name: 'Procurement review bodies',
    germanName: 'Vergabekontrollbehörden',
    status: 'active',
    window: null,
    successor: null,
    gzExample: 'VKS-961040/13',
    note: 'Bodies: Bundesvergabeamt, Bundes-Vergabekontrollkommission, Vergabekontrollsenat Salzburg, Vergabekontrollsenat Wien (topic issuing_bodies).',
  },
  {
    code: 'upts',
    application: 'Upts',
    name: 'Independent Party-Transparency Senate',
    germanName: 'Unabhängiger Parteien-Transparenz-Senat',
    status: 'active',
    window: null,
    successor: null,
    gzExample: '2026-0.074.605/UPTS/Grüne',
    note: 'Served by the Sonstige controller upstream; documents are plain-PDF only. The party filter is full-text — parties beyond the documented list appear in live data (e.g. "Wandel", "TeamKärnten").',
  },
] as const satisfies readonly RisCourt[];
