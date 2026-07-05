/**
 * @fileoverview Ministry designations accepted by RIS issuer parameters, including historical
 * ministries. Compiled from the OGD Handbook V2.6 value lists: `EinbringendeStelle`
 * (BgblAuth/Begut/RegV — phrase match, the bare abbreviation matches), Mrp `Einbringer`
 * (exact match against the full "ABBR (Name)" composite), and Erlaesse `Bundesministerium`
 * (exact match against the full designation only).
 * @module services/ris/reference/ministries
 */

/** Which RIS issuer parameter families accept a ministry value. */
export type MinistryParamFamily =
  /** `EinbringendeStelle` on BgblAuth / Begut / RegV — phrase match; bare abbreviation works. */
  | 'einbringende_stelle'
  /** Mrp `Einbringer` — exact match; pass `mrpComposite` verbatim. */
  | 'mrp_einbringer'
  /** Erlaesse `Bundesministerium` — exact match; pass `designation` verbatim. */
  | 'erlaesse_bundesministerium';

/** One ministry designation (current or historical). */
export interface Ministry {
  /** Official abbreviation ("BMF"); null for older Erlaesse-only designations. */
  readonly abbreviation: string | null;
  /** Parameter families whose documented value lists carry this ministry. */
  readonly acceptedBy: readonly MinistryParamFamily[];
  /** Full German designation without the abbreviation prefix. */
  readonly designation: string;
  /** Exact composite string for the Mrp `Einbringer` parameter, when documented there. */
  readonly mrpComposite: string | null;
}

/** All ministry designations documented in the OGD Handbook V2.6 value lists. */
export const RIS_MINISTRIES = [
  {
    abbreviation: 'BKA',
    designation: 'Bundeskanzleramt',
    mrpComposite: 'BKA (Bundeskanzleramt)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMA',
    designation: 'Bundesministerium für Arbeit',
    mrpComposite: 'BMA (Bundesministerium für Arbeit)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMAA',
    designation: 'Bundesministerium für auswärtige Angelegenheiten',
    mrpComposite: 'BMAA (Bundesministerium für auswärtige Angelegenheiten)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMAFJ',
    designation: 'Bundesministerium für Arbeit, Familie und Jugend',
    mrpComposite: 'BMAFJ (Bundesministerium für Arbeit, Familie und Jugend)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMASGK',
    designation: 'Bundesministerium für Arbeit, Soziales, Gesundheit und Konsumentenschutz',
    mrpComposite:
      'BMASGK (Bundesministerium für Arbeit, Soziales, Gesundheit und Konsumentenschutz)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMASK',
    designation: 'Bundesministerium für Arbeit, Soziales und Konsumentenschutz',
    mrpComposite: 'BMASK (Bundesministerium für Arbeit, Soziales und Konsumentenschutz)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMAW',
    designation: 'Bundesministerium für Arbeit und Wirtschaft',
    mrpComposite: 'BMAW (Bundesministerium für Arbeit und Wirtschaft)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMB',
    designation: 'Bundesministerium für Bildung',
    mrpComposite: 'BMB (Bundesministerium für Bildung)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMBF',
    designation: 'Bundesministerium für Bildung und Frauen',
    mrpComposite: 'BMBF (Bundesministerium für Bildung und Frauen)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMBWF',
    designation: 'Bundesministerium für Bildung, Wissenschaft und Forschung',
    mrpComposite: 'BMBWF (Bundesministerium für Bildung, Wissenschaft und Forschung)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMBWK',
    designation: 'Bundesministerium für Bildung, Wissenschaft und Kultur',
    mrpComposite: 'BMBWK (Bundesministerium für Bildung, Wissenschaft und Kultur)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMDW',
    designation: 'Bundesministerium für Digitalisierung und Wirtschaftsstandort',
    mrpComposite: 'BMDW (Bundesministerium für Digitalisierung und Wirtschaftsstandort)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMEIA',
    designation: 'Bundesministerium für Europa, Integration und Äußeres',
    mrpComposite: 'BMEIA (Bundesministerium für Europa, Integration und Äußeres)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMEIA',
    designation: 'Bundesministerium für europäische und internationale Angelegenheiten',
    mrpComposite: 'BMEIA (Bundesministerium für europäische und internationale Angelegenheiten)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMEUV',
    designation: 'Bundesministerin für EU und Verfassung im Bundeskanzleramt',
    mrpComposite: 'BMEUV (Bundesministerin für EU und Verfassung im Bundeskanzleramt)',
    acceptedBy: ['einbringende_stelle', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMF',
    designation: 'Bundesministerium für Finanzen',
    mrpComposite: 'BMF (Bundesministerium für Finanzen)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMFFIM',
    designation: 'Bundesministerin für Frauen, Familie, Integration und Medien im Bundeskanzleramt',
    mrpComposite:
      'BMFFIM (Bundesministerin für Frauen, Familie, Integration und Medien im Bundeskanzleramt)',
    acceptedBy: ['einbringende_stelle', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMFJ',
    designation: 'Bundesministerium für Familien und Jugend',
    mrpComposite: 'BMFJ (Bundesministerium für Familien und Jugend)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMG',
    designation: 'Bundesministerium für Gesundheit',
    mrpComposite: 'BMG (Bundesministerium für Gesundheit)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMGF',
    designation: 'Bundesministerium für Gesundheit und Frauen',
    mrpComposite: 'BMGF (Bundesministerium für Gesundheit und Frauen)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMGFJ',
    designation: 'Bundesministerium für Gesundheit, Familie und Jugend',
    mrpComposite: 'BMGFJ (Bundesministerium für Gesundheit, Familie und Jugend)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMI',
    designation: 'Bundesministerium für Inneres',
    mrpComposite: 'BMI (Bundesministerium für Inneres)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMJ',
    designation: 'Bundesministerium für Justiz',
    mrpComposite: 'BMJ (Bundesministerium für Justiz)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMK',
    designation:
      'Bundesministerium für Klimaschutz, Umwelt, Energie, Mobilität, Innovation und Technologie',
    mrpComposite:
      'BMK (Bundesministerium für Klimaschutz, Umwelt, Energie, Mobilität, Innovation und Technologie)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMKOES',
    designation: 'Bundesministerium für Kunst, Kultur, öffentlichen Dienst und Sport',
    mrpComposite: 'BMKOES (Bundesministerium für Kunst, Kultur, öffentlichen Dienst und Sport)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BML',
    designation: 'Bundesministerium für Land- und Forstwirtschaft, Regionen und Wasserwirtschaft',
    mrpComposite:
      'BML (Bundesministerium für Land- und Forstwirtschaft, Regionen und Wasserwirtschaft)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMLFUW',
    designation: 'Bundesministerium für Land- und Forstwirtschaft, Umwelt und Wasserwirtschaft',
    mrpComposite:
      'BMLFUW (Bundesministerium für Land- und Forstwirtschaft, Umwelt und Wasserwirtschaft)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMLRT',
    designation: 'Bundesministerium für Landwirtschaft, Regionen und Tourismus',
    mrpComposite: 'BMLRT (Bundesministerium für Landwirtschaft, Regionen und Tourismus)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMLV',
    designation: 'Bundesministerium für Landesverteidigung',
    mrpComposite: 'BMLV (Bundesministerium für Landesverteidigung)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMLVS',
    designation: 'Bundesministerium für Landesverteidigung und Sport',
    mrpComposite: 'BMLVS (Bundesministerium für Landesverteidigung und Sport)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMNT',
    designation: 'Bundesministerium für Nachhaltigkeit und Tourismus',
    mrpComposite: 'BMNT (Bundesministerium für Nachhaltigkeit und Tourismus)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMOEDS',
    designation: 'Bundesministerium für öffentlichen Dienst und Sport',
    mrpComposite: 'BMOEDS (Bundesministerium für öffentlichen Dienst und Sport)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMSG',
    designation: 'Bundesministerium für soziale Sicherheit, Generationen und Konsumentenschutz',
    mrpComposite:
      'BMSG (Bundesministerium für soziale Sicherheit, Generationen und Konsumentenschutz)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMSGPK',
    designation: 'Bundesministerium für Soziales, Gesundheit, Pflege und Konsumentenschutz',
    mrpComposite:
      'BMSGPK (Bundesministerium für Soziales, Gesundheit, Pflege und Konsumentenschutz)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMSK',
    designation: 'Bundesministerium für Soziales und Konsumentenschutz',
    mrpComposite: 'BMSK (Bundesministerium für Soziales und Konsumentenschutz)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMUKK',
    designation: 'Bundesministerium für Unterricht, Kunst und Kultur',
    mrpComposite: 'BMUKK (Bundesministerium für Unterricht, Kunst und Kultur)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMVIT',
    designation: 'Bundesministerium für Verkehr, Innovation und Technologie',
    mrpComposite: 'BMVIT (Bundesministerium für Verkehr, Innovation und Technologie)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMVRDJ',
    designation: 'Bundesministerium für Verfassung, Reformen, Deregulierung und Justiz',
    mrpComposite: 'BMVRDJ (Bundesministerium für Verfassung, Reformen, Deregulierung und Justiz)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMWA',
    designation: 'Bundesministerium für Wirtschaft und Arbeit',
    mrpComposite: 'BMWA (Bundesministerium für Wirtschaft und Arbeit)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMWF',
    designation: 'Bundesministerium für Wissenschaft und Forschung',
    mrpComposite: 'BMWF (Bundesministerium für Wissenschaft und Forschung)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMWFJ',
    designation: 'Bundesministerium für Wirtschaft, Familie und Jugend',
    mrpComposite: 'BMWFJ (Bundesministerium für Wirtschaft, Familie und Jugend)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'BMWFW',
    designation: 'Bundesministerium für Wissenschaft, Forschung und Wirtschaft',
    mrpComposite: 'BMWFW (Bundesministerium für Wissenschaft, Forschung und Wirtschaft)',
    acceptedBy: ['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer'],
  },
  {
    abbreviation: 'PARLAMENT',
    designation: 'Parlament',
    mrpComposite: null,
    acceptedBy: ['einbringende_stelle'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Arbeit und Soziales',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Arbeit, Gesundheit und Soziales',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Auswärtige Angelegenheiten',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Bauten und Technik',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Familie, Jugend und Konsumentenschutz',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Gesundheit und Konsumentenschutz',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Gesundheit und Umweltschutz',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Gesundheit, Sport und Konsumentenschutz',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Handel, Gewerbe und Industrie',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Jugend und Familie',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Land- und Forstwirtschaft',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für öffentliche Leistung und Sport',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für öffentliche Wirtschaft und Verkehr',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für soziale Sicherheit und Generationen',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für soziale Verwaltung',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Umwelt, Jugend und Familie',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Unterricht und kulturelle Angelegenheiten',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Unterricht und Kunst',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Unterricht, Kunst und Sport',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für wirtschaftliche Angelegenheiten',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Wissenschaft und Verkehr',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Wissenschaft, Forschung und Kunst',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
  {
    abbreviation: null,
    designation: 'Bundesministerium für Wissenschaft, Verkehr und Kunst',
    mrpComposite: null,
    acceptedBy: ['erlaesse_bundesministerium'],
  },
] as const satisfies readonly Ministry[];
