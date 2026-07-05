/**
 * @fileoverview All 39 RIS OGD applications: controller routing, document class, binding
 * status, coverage window, content-format availability, the History-feed name, and the
 * content-host path segment (`/Dokumente/{segment}/{DOKNR}/…`).
 * Sources: OGD Handbook V2.6 (application descriptions and windows), the request XSDs
 * (`HistoryRequestApplicationType`), and live probes of content renditions and content
 * URLs harvested per application (2026-07-04/05).
 * @module services/ris/reference/applications
 */

/** Controller (URL path segment) that serves an application. */
export type RisController =
  | 'Bundesrecht'
  | 'Landesrecht'
  | 'Bezirke'
  | 'Gemeinden'
  | 'Judikatur'
  | 'Sonstige';

/** Document class an application belongs to. */
export type RisDocumentClass =
  | 'consolidated_law'
  | 'translation'
  | 'authentic_promulgation'
  | 'historical_gazette'
  | 'case_law'
  | 'pipeline'
  | 'executive_record'
  | 'sectoral_announcement';

/**
 * Legal-binding label carried on every document-bearing output. Only `authentic`
 * (amtssignierte) publications are legally binding.
 */
export type RisBindingStatus =
  | 'authentic'
  | 'consolidated_informational'
  | 'historical_record'
  | 'decision'
  | 'preparatory'
  | 'administrative_directive'
  | 'translation';

/** Which content renditions an application's documents carry. */
export type RisFormatAvailability =
  /** Xml / Html / Rtf (plus Pdf and the signed Authentisch PDF where published). */
  | 'full'
  /** Signed authentic PDF (.pdfsig) only — no text renditions. */
  | 'authentic_pdf_only'
  /** Plain PDF only. */
  | 'pdf_only'
  /** No content URLs at all — metadata only (scans hosted by the Austrian National Library). */
  | 'none';

/** One RIS OGD application. */
export interface RisApplication {
  /** Binding status of the application's documents. */
  readonly binding: RisBindingStatus;
  /** Exact `Applikation` request value. */
  readonly code: string;
  /**
   * Path segment of the application's content URLs on the content host
   * (`https://www.ris.bka.gv.at/Dokumente/{segment}/{DOKNR}/{DOKNR}.{ext}`), harvested from
   * live search hits 2026-07-05. Null for BgblAlt, whose documents carry no content URLs
   * (metadata only — scans are hosted by the Austrian National Library).
   */
  readonly contentPathSegment: string | null;
  /** Controller that serves the application. */
  readonly controller: RisController;
  /** Coverage window / scope, when documented; null when RIS documents no restriction. */
  readonly coverage: string | null;
  /** Document class. */
  readonly documentClass: RisDocumentClass;
  /** Content-format availability. */
  readonly formats: RisFormatAvailability;
  /** Official German designation (OGD Handbook V2.6). */
  readonly germanName: string;
  /** `Anwendung` value for the History change feed (differs from `code` for four applications). */
  readonly historyName: string;
  /** English name. */
  readonly name: string;
  /** Extra usage note, when needed. */
  readonly note: string | null;
}

/** All RIS OGD applications reachable through the v2.6 API. */
export const RIS_APPLICATIONS = [
  {
    code: 'BrKons',
    controller: 'Bundesrecht',
    name: 'Consolidated federal law',
    germanName: 'Bundesrecht in konsolidierter Fassung',
    documentClass: 'consolidated_law',
    binding: 'consolidated_informational',
    coverage: 'Current and all historical versions (FassungVom / force-window filters)',
    formats: 'full',
    historyName: 'Bundesnormen',
    contentPathSegment: 'Bundesnormen',
    note: 'One document per Paragraph, Artikel, or Anlage of a law.',
  },
  {
    code: 'BgblAuth',
    controller: 'Bundesrecht',
    name: 'Authentic Federal Law Gazette',
    germanName: 'Bundesgesetzblatt authentisch ab 2004',
    documentClass: 'authentic_promulgation',
    binding: 'authentic',
    coverage: '2004 and later',
    formats: 'full',
    historyName: 'BgblAuth',
    contentPathSegment: 'BgblAuth',
    note: 'The electronically promulgated version is the legally binding one since 2004-01-01.',
  },
  {
    code: 'BgblPdf',
    controller: 'Bundesrecht',
    name: 'Post-war federal gazettes',
    germanName: 'Staats- und Bundesgesetzblatt 1945–2003',
    documentClass: 'historical_gazette',
    binding: 'historical_record',
    coverage: '1945–2003 (Staatsgesetzblatt 1945 and Bundesgesetzblatt volumes)',
    formats: 'full',
    historyName: 'BgblPdf',
    contentPathSegment: 'BgblPdf',
    note: 'Number parameter is `Bundesgesetzblatt` (e.g. "194/1961").',
  },
  {
    code: 'BgblAlt',
    controller: 'Bundesrecht',
    name: 'Imperial and interwar gazettes',
    germanName: 'Reichs-, Staats- und Bundesgesetzblatt 1848–1940',
    documentClass: 'historical_gazette',
    binding: 'historical_record',
    coverage: 'RGBl 1849–1918, StGBl 1918–1920, BGBl 1920–1938, GBlÖ 1938–1940',
    formats: 'none',
    historyName: 'BgblAlt',
    contentPathSegment: null,
    note: 'Metadata only — document scans are linked at the Austrian National Library (ÖNB).',
  },
  {
    code: 'Begut',
    controller: 'Bundesrecht',
    name: 'Ministerial review drafts',
    germanName: 'Begutachtungsentwürfe',
    documentClass: 'pipeline',
    binding: 'preparatory',
    coverage: 'As made available by the ministries',
    formats: 'full',
    historyName: 'Begut',
    contentPathSegment: 'Begut',
    note: null,
  },
  {
    code: 'RegV',
    controller: 'Bundesrecht',
    name: 'Government bills',
    germanName: 'Regierungsvorlagen',
    documentClass: 'pipeline',
    binding: 'preparatory',
    coverage: '2004 and later',
    formats: 'full',
    historyName: 'RegV',
    contentPathSegment: 'RegV',
    note: null,
  },
  {
    code: 'Erv',
    controller: 'Bundesrecht',
    name: 'English translations of selected federal laws',
    germanName: 'Rechtsvorschriften in englischer Sprache (Austrian Laws)',
    documentClass: 'translation',
    binding: 'translation',
    coverage: 'Roughly 138 selected laws',
    formats: 'full',
    historyName: 'Erv',
    contentPathSegment: 'Erv',
    note: 'Request parameters are English here: SearchTerms and Title.',
  },
  {
    code: 'LrKons',
    controller: 'Landesrecht',
    name: 'Consolidated state law',
    germanName: 'Landesrecht konsolidiert (Landesnormen)',
    documentClass: 'consolidated_law',
    binding: 'consolidated_informational',
    coverage: 'All nine Bundesländer; current and historical versions',
    formats: 'full',
    historyName: 'Landesnormen',
    contentPathSegment: 'Landesnormen',
    note: null,
  },
  {
    code: 'LgblAuth',
    controller: 'Landesrecht',
    name: 'Authentic state law gazettes',
    germanName: 'Landesgesetzblätter authentisch',
    documentClass: 'authentic_promulgation',
    binding: 'authentic',
    coverage: null,
    formats: 'full',
    historyName: 'LgblAuth',
    contentPathSegment: 'LgblAuth',
    note: 'Salzburg district-authority regulations are promulgated here since 2022-07-01.',
  },
  {
    code: 'Lgbl',
    controller: 'Landesrecht',
    name: 'Historical non-authentic state gazettes',
    germanName: 'Landesgesetzblätter nicht authentisch',
    documentClass: 'historical_gazette',
    binding: 'historical_record',
    coverage: 'Seven Bundesländer — no Niederösterreich, no Wien',
    formats: 'full',
    historyName: 'Lgbl',
    contentPathSegment: 'Lgbl',
    note: null,
  },
  {
    code: 'LgblNO',
    controller: 'Landesrecht',
    name: 'Niederösterreich systematic state-law collection',
    germanName: 'Landesgesetzblätter Niederösterreich',
    documentClass: 'consolidated_law',
    binding: 'consolidated_informational',
    coverage: 'Niederösterreich only',
    formats: 'full',
    historyName: 'LgblNO',
    contentPathSegment: 'LgblNO',
    note: 'Carries FassungVom and Gliederungszahl (systematic classification number).',
  },
  {
    code: 'Vbl',
    controller: 'Landesrecht',
    name: 'State ordinance gazettes',
    germanName: 'Verordnungsblätter der Länder',
    documentClass: 'authentic_promulgation',
    binding: 'authentic',
    coverage: 'Tirol only, since 2022-01-01',
    formats: 'full',
    historyName: 'Vbl',
    contentPathSegment: 'Vbl',
    note: 'State regulations promulgated outside the Landesgesetzblatt (not district-authority regulations). Other Bundesland values pass schema validation but fail server-side.',
  },
  {
    code: 'Bvb',
    controller: 'Bezirke',
    name: 'District-authority promulgations',
    germanName: 'Kundmachungen der Bezirksverwaltungsbehörden',
    documentClass: 'authentic_promulgation',
    binding: 'authentic',
    coverage:
      'Niederösterreich since 2021-09-01, Oberösterreich and Tirol since 2022-01-01, Vorarlberg since 2022-07-01, Burgenland since 2023-01-01, Steiermark since 2013-01-01; Salzburg districts publish in the Salzburg LGBl',
    formats: 'authentic_pdf_only',
    historyName: 'Bvb',
    contentPathSegment: 'Bvb',
    note: 'Bundesland filter uses umlauted spellings here (e.g. "Kärnten").',
  },
  {
    code: 'Gr',
    controller: 'Gemeinden',
    name: 'Municipal law (selected norms)',
    germanName: 'Rechtsnormen von Gemeinden',
    documentClass: 'consolidated_law',
    binding: 'consolidated_informational',
    coverage:
      'Kärnten (all municipalities), Niederösterreich, Oberösterreich, Salzburg, Steiermark, Wien — none from Burgenland, Tirol, or Vorarlberg',
    formats: 'full',
    historyName: 'Gemeinderecht',
    contentPathSegment: 'Gemeinderecht',
    note: null,
  },
  {
    code: 'GrA',
    controller: 'Gemeinden',
    name: 'Authentic municipal promulgations',
    germanName: 'Rechtsverbindliche Kundmachungen und Verordnungen von Gemeinden',
    documentClass: 'authentic_promulgation',
    binding: 'authentic',
    coverage: null,
    formats: 'authentic_pdf_only',
    historyName: 'GemeinderechtAuth',
    contentPathSegment: 'GemeinderechtAuth',
    note: null,
  },
  {
    code: 'Vfgh',
    controller: 'Judikatur',
    name: 'Constitutional Court decisions',
    germanName: 'Verfassungsgerichtshof (VfGH)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '1980 and later',
    formats: 'full',
    historyName: 'Vfgh',
    contentPathSegment: 'Vfgh',
    note: null,
  },
  {
    code: 'Vwgh',
    controller: 'Judikatur',
    name: 'Supreme Administrative Court decisions',
    germanName: 'Verwaltungsgerichtshof (VwGH)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '1990 and later; older decisions selected',
    formats: 'full',
    historyName: 'Vwgh',
    contentPathSegment: 'Vwgh',
    note: null,
  },
  {
    code: 'Normenliste',
    controller: 'Judikatur',
    name: 'VwGH norm index',
    germanName: 'Normenliste des Verwaltungsgerichtshofes',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: null,
    formats: 'full',
    historyName: 'Normenliste',
    contentPathSegment: 'Normenliste',
    note: 'A register of norms, not decisions — no case-number, date, or decision-type filters.',
  },
  {
    code: 'Justiz',
    controller: 'Judikatur',
    name: 'Ordinary courts (OGH and selected lower courts)',
    germanName: 'Justiz',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: 'Selected decisions of the ordinary courts, not the full record',
    formats: 'full',
    historyName: 'Justiz',
    contentPathSegment: 'Justiz',
    note: null,
  },
  {
    code: 'Bvwg',
    controller: 'Judikatur',
    name: 'Federal Administrative Court decisions',
    germanName: 'Bundesverwaltungsgericht (BVwG)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '2014 and later',
    formats: 'full',
    historyName: 'Bvwg',
    contentPathSegment: 'Bvwg',
    note: null,
  },
  {
    code: 'Lvwg',
    controller: 'Judikatur',
    name: 'State administrative court decisions',
    germanName: 'Landesverwaltungsgerichte (LVwG)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '2014 and later',
    formats: 'full',
    historyName: 'Lvwg',
    contentPathSegment: 'Lvwg',
    note: null,
  },
  {
    code: 'Dsk',
    controller: 'Judikatur',
    name: 'Data protection authority decisions',
    germanName: 'Datenschutzbehörde, Datenschutzkommission',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '1990 and later, selected',
    formats: 'full',
    historyName: 'Dsk',
    contentPathSegment: 'Dsk',
    note: 'Covers the Datenschutzbehörde (2014+) and its predecessor Datenschutzkommission (up to 2013) — split via the EntscheidendeBehoerde filter.',
  },
  {
    code: 'Dok',
    controller: 'Judikatur',
    name: 'Civil-service disciplinary decisions',
    germanName: 'Bundesdisziplinarbehörde, Disziplinarkommissionen',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: null,
    formats: 'full',
    historyName: 'Dok',
    contentPathSegment: 'Dok',
    note: null,
  },
  {
    code: 'Pvak',
    controller: 'Judikatur',
    name: 'Staff-representation oversight decisions',
    germanName: 'Personalvertretungsaufsichtsbehörde, Personalvertretungsaufsichtskommission',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: null,
    formats: 'full',
    historyName: 'Pvak',
    contentPathSegment: 'Pvak',
    note: null,
  },
  {
    code: 'Gbk',
    controller: 'Judikatur',
    name: 'Equal-treatment commission decisions',
    germanName: 'Bundes-Gleichbehandlungskommission, Gleichbehandlungskommission',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: null,
    formats: 'full',
    historyName: 'Gbk',
    contentPathSegment: 'Gbk',
    note: null,
  },
  {
    code: 'Uvs',
    controller: 'Judikatur',
    name: 'Independent administrative senate decisions',
    germanName: 'Unabhängige Verwaltungssenate (UVS)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '1991–2013; succeeded by the Landesverwaltungsgerichte',
    formats: 'full',
    historyName: 'Uvs',
    contentPathSegment: 'Uvs',
    note: null,
  },
  {
    code: 'AsylGH',
    controller: 'Judikatur',
    name: 'Asylum Court decisions',
    germanName: 'Asylgerichtshof (AsylGH)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '2008–2013; succeeded by the Bundesverwaltungsgericht',
    formats: 'full',
    historyName: 'AsylGH',
    contentPathSegment: 'AsylGH',
    note: null,
  },
  {
    code: 'Ubas',
    controller: 'Judikatur',
    name: 'Independent Federal Asylum Senate decisions',
    germanName: 'Unabhängiger Bundesasylsenat (UBAS)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: '1998–2008; succeeded by the Asylgerichtshof',
    formats: 'full',
    historyName: 'Ubas',
    contentPathSegment: 'Ubas',
    note: null,
  },
  {
    code: 'Umse',
    controller: 'Judikatur',
    name: 'Environmental Senate decisions',
    germanName: 'Umweltsenat (UMSE)',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: 'Until 2013',
    formats: 'full',
    historyName: 'Umse',
    contentPathSegment: 'Umse',
    note: null,
  },
  {
    code: 'Bks',
    controller: 'Judikatur',
    name: 'Federal Communications Senate decisions',
    germanName: 'Bundeskommunikationssenat',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: 'Until 2013',
    formats: 'full',
    historyName: 'Bks',
    contentPathSegment: 'Bks',
    note: null,
  },
  {
    code: 'Verg',
    controller: 'Judikatur',
    name: 'Procurement review decisions',
    germanName: 'Vergabekontrollbehörden',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: null,
    formats: 'full',
    historyName: 'Verg',
    contentPathSegment: 'Verg',
    note: null,
  },
  {
    code: 'PruefGewO',
    controller: 'Sonstige',
    name: 'Trade-exam regulations',
    germanName: 'Prüfungsordnungen gemäß Gewerbeordnung',
    documentClass: 'sectoral_announcement',
    binding: 'authentic',
    coverage: null,
    formats: 'full',
    historyName: 'PruefGewO',
    contentPathSegment: 'PruefGewO',
    note: null,
  },
  {
    code: 'Avsv',
    controller: 'Sonstige',
    name: 'Official social-insurance notices',
    germanName: 'Amtliche Verlautbarungen der Sozialversicherung',
    documentClass: 'sectoral_announcement',
    binding: 'authentic',
    coverage: '2002 and later',
    formats: 'full',
    historyName: 'Avsv',
    contentPathSegment: 'Avsv',
    note: null,
  },
  {
    code: 'Spg',
    controller: 'Sonstige',
    name: 'Health structure plans',
    germanName: 'Strukturpläne Gesundheit (ÖSG, RSG)',
    documentClass: 'sectoral_announcement',
    binding: 'authentic',
    coverage: null,
    formats: 'full',
    historyName: 'Spg',
    contentPathSegment: 'Spg',
    note: 'ÖSG is the federal plan; RSG plans are per Bundesland.',
  },
  {
    code: 'Avn',
    controller: 'Sonstige',
    name: 'Official veterinary notices',
    germanName: 'Amtliche Veterinärnachrichten (AVN)',
    documentClass: 'sectoral_announcement',
    binding: 'authentic',
    coverage: '2004-09-15 and later',
    formats: 'full',
    historyName: 'Avn',
    contentPathSegment: 'Avn',
    note: null,
  },
  {
    code: 'KmGer',
    controller: 'Sonstige',
    name: 'Court rules of procedure and case-allocation plans',
    germanName: 'Kundmachungen der Gerichte',
    documentClass: 'sectoral_announcement',
    binding: 'authentic',
    coverage: 'Currently LVwG Tirol and LVwG Vorarlberg only',
    formats: 'authentic_pdf_only',
    historyName: 'KmGer',
    contentPathSegment: 'KmGer',
    note: null,
  },
  {
    code: 'Upts',
    controller: 'Sonstige',
    name: 'Party-Transparency Senate decisions',
    germanName: 'Entscheidungen des unabhängigen Parteien-Transparenz-Senats',
    documentClass: 'case_law',
    binding: 'decision',
    coverage: null,
    formats: 'pdf_only',
    historyName: 'Upts',
    contentPathSegment: 'Upts',
    note: 'Lives in the Sonstige controller upstream, but its documents are decisions.',
  },
  {
    code: 'Mrp',
    controller: 'Sonstige',
    name: 'Council-of-ministers minutes',
    germanName: 'Ministerratsprotokolle',
    documentClass: 'executive_record',
    binding: 'preparatory',
    coverage: '2004 and later',
    formats: 'pdf_only',
    historyName: 'Mrp',
    contentPathSegment: 'Mrp',
    note: 'Has no Titel parameter.',
  },
  {
    code: 'Erlaesse',
    controller: 'Sonstige',
    name: 'Federal-ministry decrees',
    germanName: 'Erlässe der Bundesministerien',
    documentClass: 'executive_record',
    binding: 'administrative_directive',
    coverage: null,
    formats: 'full',
    historyName: 'Erlaesse',
    contentPathSegment: 'Erlaesse',
    note: 'Decrees bind the administration internally, not citizens.',
  },
] as const satisfies readonly RisApplication[];
