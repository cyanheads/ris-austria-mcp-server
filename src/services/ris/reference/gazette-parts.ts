/**
 * @fileoverview Federal gazette parts (BGBl. I/II/III plus the pre-1997 partless era) and
 * the three federal era tiers the gazette surface auto-routes across. Parts exist only
 * from 1997 onward.
 * @module services/ris/reference/gazette-parts
 */

/** One gazette part. */
export interface GazettePart {
  /** Value used by the tool's `part` parameter. */
  readonly code: string;
  /** What the part contains. */
  readonly contents: string;
  /** German content designation. */
  readonly germanName: string;
  /** Upstream flag. */
  readonly upstream: string;
}

/** One federal gazette era tier. */
export interface FederalGazetteTier {
  /** RIS application serving the tier. */
  readonly application: string;
  /** Whether the tier's documents are the legally binding (amtssignierte) promulgation. */
  readonly authentic: boolean;
  /** Content note. */
  readonly note: string | null;
  /** Number parameter(s) for point lookups in this tier. */
  readonly numberParams: string;
  /** Coverage window. */
  readonly window: string;
}

/** All gazette part values. */
export const RIS_GAZETTE_PARTS = [
  {
    code: 'part1',
    germanName: 'Teil I — Gesetze',
    contents: 'Federal acts (Bundesgesetze)',
    upstream: 'Teil.SucheInTeil1=true',
  },
  {
    code: 'part2',
    germanName: 'Teil II — Verordnungen',
    contents: 'Regulations (Verordnungen)',
    upstream: 'Teil.SucheInTeil2=true',
  },
  {
    code: 'part3',
    germanName: 'Teil III — Staatsverträge',
    contents: 'International treaties (Staatsverträge)',
    upstream: 'Teil.SucheInTeil3=true',
  },
  {
    code: 'pre_1997',
    germanName: 'BGBl. vor der Teilung 1997',
    contents: 'Gazette issues before the 1997 split into parts I/II/III',
    upstream: 'Teil.SucheInAlt=true (BgblPdf only)',
  },
] as const satisfies readonly GazettePart[];

/** The three federal era tiers, newest first. */
export const RIS_FEDERAL_GAZETTE_TIERS = [
  {
    application: 'BgblAuth',
    window: '2004 and later',
    authentic: true,
    numberParams: 'Bgblnummer (e.g. "171/2026" or "BGBl. II Nr. 171/2026")',
    note: 'The electronically promulgated version is the legally binding one.',
  },
  {
    application: 'BgblPdf',
    window: '1945–2003',
    authentic: false,
    numberParams: 'Bundesgesetzblatt (e.g. "194/1961")',
    note: 'Staats- und Bundesgesetzblatt volumes; full Html/Pdf renditions.',
  },
  {
    application: 'BgblAlt',
    window: '1848–1940',
    authentic: false,
    numberParams: 'Gesetzblattnummer plus Jahrgang',
    note: 'RGBl 1849–1918, StGBl 1918–1920, BGBl 1920–1938, GBlÖ 1938–1940. Metadata only — scans hosted by the Austrian National Library.',
  },
] as const satisfies readonly FederalGazetteTier[];
