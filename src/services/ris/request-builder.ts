/**
 * @fileoverview Request builders for the RIS OGD API — one thin builder per document
 * class over a shared param bag, plus ministry-abbreviation expansion and the History
 * application aliasing.
 *
 * STRICT PARAM ALLOWLIST: RIS silently ignores unknown query params (a typo returns
 * plausible but unfiltered results, never an error), so builders emit only spellings
 * confirmed against the live API (design ledger 2026-07-04/05 + build probes 2026-07-05).
 * A caller-supplied field with no confirmed mapping for the target application throws a
 * local ValidationError — it is never dropped and never forwarded.
 *
 * Flag complexes (`Teil.SucheIn…`, `Typ.SucheIn…`, `Dokumenttyp.SucheIn…`,
 * `Bundesland.SucheIn…`) are only ever emitted as `=true` — probes show a present-but-
 * false flag changes results in undocumented ways, while omission means "no filter".
 * @module services/ris/request-builder
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

import {
  type MinistryParamFamily,
  RIS_APPLICATIONS,
  RIS_CHANGED_SINCE_INTERVALS,
  RIS_COLLECTIONS,
  RIS_COURTS,
  RIS_DECISION_KINDS,
  RIS_MINISTRIES,
  RIS_STAGES,
  RIS_STATES,
  type RisController,
} from './reference/index.js';

/* ------------------------------------------------------------------------------------ */
/* Shared vocabulary                                                                     */
/* ------------------------------------------------------------------------------------ */

/** Page sizes RIS accepts (`DokumenteProSeite`). */
export type RisPageSize = 10 | 20 | 50 | 100;

const PAGE_SIZE_TOKENS: Record<RisPageSize, string> = {
  10: 'Ten',
  20: 'Twenty',
  50: 'Fifty',
  100: 'OneHundred',
};

/** Common paging params. */
export interface RisPagingParams {
  /** 1-based page number (`Seitennummer`). */
  readonly page?: number;
  /** Documents per page (`DokumenteProSeite`). */
  readonly pageSize?: RisPageSize;
}

/** Recency interval codes (`ImRisSeit`). */
export type ChangedSinceCode = (typeof RIS_CHANGED_SINCE_INTERVALS)[number]['code'];

/** Bundesland codes accepted by state-conditional params. */
export type RisStateCode = (typeof RIS_STATES)[number]['code'];

/** Court codes served by the case-law surface. */
export type RisCourtCode = (typeof RIS_COURTS)[number]['code'];

/** Announcement collection codes. */
export type RisCollectionCode = (typeof RIS_COLLECTIONS)[number]['code'];

/** Lawmaking-pipeline stage codes. */
export type RisStageCode = (typeof RIS_STAGES)[number]['code'];

/** Sort direction (`Sortierung.SortDirection`, XSD `WebSortDirection`). */
export type RisSortDirection = 'ascending' | 'descending';

/** A fully built upstream request: controller path segment + allowlisted params. */
export interface RisRequest {
  readonly controller: RisController | 'History';
  readonly params: Readonly<Record<string, string>>;
}

const CHANGED_SINCE_TOKENS = new Map<string, string>(
  RIS_CHANGED_SINCE_INTERVALS.map((interval) => [interval.code, interval.risValue]),
);

const STATE_BY_CODE = new Map(RIS_STATES.map((state) => [state.code, state]));
const COURT_BY_CODE = new Map(RIS_COURTS.map((court) => [court.code, court]));
const COLLECTION_BY_CODE = new Map(
  RIS_COLLECTIONS.map((collection) => [collection.code, collection]),
);
const STAGE_BY_CODE = new Map(RIS_STAGES.map((stage) => [stage.code, stage]));
const APPLICATION_BY_CODE = new Map<string, (typeof RIS_APPLICATIONS)[number]>(
  RIS_APPLICATIONS.map((app) => [app.code, app]),
);
const DECISION_KINDS_BY_COURT = new Map<string, (typeof RIS_DECISION_KINDS)[number]>(
  RIS_DECISION_KINDS.map((entry) => [entry.court, entry]),
);

/** States the Vbl backend actually resolves — other values pass schema validation but 500. */
const VBL_COVERED_STATES: readonly RisStateCode[] = ['tirol'];

/**
 * Reject a caller field the target application has no confirmed mapping for.
 *
 * The message is diagnostic text for logs: it speaks the builder's vocabulary (the service
 * param name and the RIS application code), neither of which the caller sent. Every tool
 * whose input can reach this rewrites it into its own vocabulary at its `.catch()`, off the
 * structured `data` — so `param`, the rejected `value`, and the `alternatives` that *are*
 * mapped are carried as separate fields rather than fused into one identifier.
 */
function unsupported(
  param: string,
  application: string,
  rejected?: { readonly value: string; readonly alternatives: readonly string[] },
): never {
  const label = rejected === undefined ? param : `${param}: ${rejected.value}`;
  throw validationError(
    `Parameter "${label}" has no confirmed RIS mapping for application ${application} — it would be silently ignored upstream, so it is rejected instead.`,
    {
      application,
      param,
      ...(rejected !== undefined && {
        alternatives: [...rejected.alternatives],
        value: rejected.value,
      }),
    },
  );
}

function invalidValue(param: string, value: string, valid: readonly string[]): never {
  throw validationError(`Invalid ${param} value "${value}". Valid values: ${valid.join(', ')}.`, {
    param,
    valid: [...valid],
    value,
  });
}

class ParamBag {
  private readonly entries: Record<string, string> = {};

  constructor(application?: string) {
    if (application !== undefined) this.entries['Applikation'] = application;
  }

  set(name: string, value: string): this {
    this.entries[name] = value;
    return this;
  }

  /** Set when the caller provided a non-empty value. */
  setIf(name: string, value: string | undefined): this {
    if (value !== undefined && value !== '') this.set(name, value);
    return this;
  }

  paging(params: RisPagingParams): this {
    if (params.pageSize !== undefined)
      this.set('DokumenteProSeite', PAGE_SIZE_TOKENS[params.pageSize]);
    if (params.page !== undefined)
      this.set('Seitennummer', String(Math.max(1, Math.trunc(params.page))));
    return this;
  }

  changedSince(code: ChangedSinceCode | undefined): this {
    if (code === undefined) return this;
    const token = CHANGED_SINCE_TOKENS.get(code);
    if (!token) invalidValue('changedSince', code, [...CHANGED_SINCE_TOKENS.keys()]);
    return this.set('ImRisSeit', token);
  }

  sort(column: string, direction: RisSortDirection | undefined): this {
    this.set('Sortierung.SortedByColumn', column);
    if (direction !== undefined) {
      this.set('Sortierung.SortDirection', direction === 'ascending' ? 'Ascending' : 'Descending');
    }
    return this;
  }

  toRequest(controller: RisController | 'History'): RisRequest {
    return { controller, params: this.entries };
  }
}

function stateByCode(code: RisStateCode): (typeof RIS_STATES)[number] {
  const state = STATE_BY_CODE.get(code);
  if (!state) invalidValue('state', code, [...STATE_BY_CODE.keys()]);
  return state;
}

/* ------------------------------------------------------------------------------------ */
/* Ministry expansion                                                                    */
/* ------------------------------------------------------------------------------------ */

/**
 * Resolve a ministry input (abbreviation or full designation) to the value the target
 * issuer-param family needs. Phrase-matched `EinbringendeStelle` gets the bare
 * abbreviation (matches every designation era of that abbreviation — live-confirmed equal
 * to the composite, 536 = 536); the exact-match families get the full designation
 * (Erlaesse `Bundesministerium`) or the `ABBR (Name)` composite (Mrp `Einbringer`).
 * Unknown or ambiguous inputs throw a ValidationError naming the near-misses.
 */
export function expandMinistry(input: string, family: MinistryParamFamily): string {
  const needle = input.trim();
  const lower = needle.toLowerCase();
  const matches = RIS_MINISTRIES.filter(
    (ministry) =>
      ministry.acceptedBy.some((accepted) => accepted === family) &&
      (ministry.abbreviation?.toLowerCase() === lower ||
        ministry.designation.toLowerCase() === lower ||
        ministry.mrpComposite?.toLowerCase() === lower),
  );
  if (matches.length === 0) {
    const nearMisses = RIS_MINISTRIES.filter(
      (ministry) =>
        ministry.abbreviation?.toLowerCase().startsWith(lower) ||
        ministry.designation.toLowerCase().includes(lower),
    )
      .slice(0, 3)
      .map((ministry) => ministry.abbreviation ?? ministry.designation);
    throw validationError(
      `Unknown ministry "${needle}"${nearMisses.length > 0 ? ` — closest matches: ${nearMisses.join(', ')}` : ''}. Pass an abbreviation or full designation from the RIS ministries table.`,
      { input: needle, nearMisses },
    );
  }
  if (family === 'einbringende_stelle') {
    const first = matches[0] as (typeof RIS_MINISTRIES)[number];
    return first.abbreviation ?? first.designation;
  }
  const values: string[] = [
    ...new Set(
      matches.flatMap((ministry) => {
        const value = family === 'mrp_einbringer' ? ministry.mrpComposite : ministry.designation;
        return value === null ? [] : [value];
      }),
    ),
  ];
  if (values.length === 0) {
    throw validationError(`Ministry "${needle}" is not accepted by this issuer parameter.`, {
      family,
      input: needle,
    });
  }
  if (values.length > 1) {
    throw validationError(
      `Ministry "${needle}" is ambiguous here — pass the full designation instead: ${values.join(' | ')}.`,
      { candidates: values, input: needle },
    );
  }
  return values[0] as string;
}

/* ------------------------------------------------------------------------------------ */
/* Legislation (BrKons / LrKons / Gr / Erv)                                              */
/* ------------------------------------------------------------------------------------ */

/** Applications reachable through the legislation surface. */
export type LegislationApplication = 'BrKons' | 'Erv' | 'Gr' | 'LrKons';

/** Search params for consolidated law and English translations. */
export interface LegislationSearchParams extends RisPagingParams {
  readonly application: LegislationApplication;
  readonly changedSince?: ChangedSinceCode;
  readonly enteredForceFrom?: string;
  readonly enteredForceTo?: string;
  readonly index?: string;
  readonly inForceAsOf?: string;
  readonly lawId?: string;
  readonly leftForceFrom?: string;
  readonly leftForceTo?: string;
  readonly municipality?: string;
  readonly query?: string;
  readonly sectionFrom?: string;
  readonly sectionTo?: string;
  readonly sectionType?: 'Alle' | 'Anlage' | 'Artikel' | 'Paragraph';
  readonly sortBy?: 'in_force_date' | 'section';
  readonly sortDirection?: RisSortDirection;
  readonly state?: RisStateCode;
  readonly title?: string;
}

/** Build a legislation search request. */
export function buildLegislationRequest(params: LegislationSearchParams): RisRequest {
  const app = params.application;
  const consolidated = app === 'BrKons' || app === 'LrKons';
  const bag = new ParamBag(app);

  bag.setIf(app === 'Erv' ? 'SearchTerms' : 'Suchworte', params.query);
  bag.setIf(app === 'Erv' ? 'Title' : 'Titel', params.title);

  if (params.state !== undefined) {
    const state = stateByCode(params.state);
    if (app === 'LrKons') bag.set(`Bundesland.${state.flagParam}`, 'true');
    else if (app === 'Gr') bag.set('Bundesland', state.flatAscii);
    else unsupported('state', app);
  }
  if (params.municipality !== undefined) {
    if (app !== 'Gr') unsupported('municipality', app);
    bag.set('Gemeinde', params.municipality);
  }
  if (params.inForceAsOf !== undefined) {
    if (app === 'Erv') unsupported('inForceAsOf', app);
    bag.set('FassungVom', params.inForceAsOf);
  }
  for (const [field, name] of [
    ['enteredForceFrom', 'Fassung.VonInkrafttretensdatum'],
    ['enteredForceTo', 'Fassung.BisInkrafttretensdatum'],
    ['leftForceFrom', 'Fassung.VonAusserkrafttretensdatum'],
    ['leftForceTo', 'Fassung.BisAusserkrafttretensdatum'],
  ] as const) {
    if (params[field] !== undefined) {
      if (!consolidated) unsupported(field, app);
      bag.set(name, params[field]);
    }
  }
  if (
    params.sectionFrom !== undefined ||
    params.sectionTo !== undefined ||
    params.sectionType !== undefined
  ) {
    if (!consolidated) unsupported('sectionFrom/sectionTo/sectionType', app);
    bag.setIf('Abschnitt.Von', params.sectionFrom);
    bag.setIf('Abschnitt.Bis', params.sectionTo);
    bag.set('Abschnitt.Typ', params.sectionType ?? 'Paragraph');
  }
  if (params.lawId !== undefined) {
    if (!consolidated) unsupported('lawId', app);
    bag.set('Gesetzesnummer', params.lawId);
  }
  if (params.index !== undefined) {
    if (!consolidated) unsupported('index', app);
    bag.set('Index', params.index);
  }
  bag.changedSince(params.changedSince);
  if (params.sortBy !== undefined) {
    if (!consolidated) unsupported('sortBy', app);
    bag.sort(
      params.sortBy === 'section' ? 'ArtikelParagraphAnlage' : 'Inkrafttretensdatum',
      params.sortDirection,
    );
  }
  bag.paging(params);
  return bag.toRequest(
    app === 'Gr' ? 'Gemeinden' : app === 'LrKons' ? 'Landesrecht' : 'Bundesrecht',
  );
}

/* ------------------------------------------------------------------------------------ */
/* Case law (17 courts; Upts rides the Sonstige controller)                              */
/* ------------------------------------------------------------------------------------ */

/** Search params for the case-law surface. */
export interface CaseLawSearchParams extends RisPagingParams {
  readonly caseNumber?: string;
  readonly changedSince?: ChangedSinceCode;
  readonly collectionNumber?: string;
  /** Gbk: federal vs general commission (upstream `BundesGleichbehandlungskommission` / `Gleichbehandlungskommission`). */
  readonly commission?: 'federal' | 'general';
  readonly court: RisCourtCode;
  readonly courtName?: string;
  readonly decidedFrom?: string;
  readonly decidedTo?: string;
  readonly decisionKind?: string;
  readonly decisionType?: 'all' | 'full_text' | 'headnote';
  readonly discriminationGround?:
    | 'Alter'
    | 'EthnischeZugehoerigkeit'
    | 'Geschlecht'
    | 'Mehrfachdiskriminierung'
    | 'Religion'
    | 'SexuelleOrientierung'
    | 'Weltanschauung';
  readonly issuingBody?: string;
  readonly legalArea?: 'civil' | 'criminal';
  readonly norm?: string;
  readonly party?: string;
  readonly query?: string;
  readonly senate?: 'I' | 'II' | 'III';
  readonly sortBy?: 'case_number' | 'decision_date';
  readonly sortDirection?: RisSortDirection;
  readonly state?: RisStateCode;
  readonly subjectArea?: string;
  readonly subjectLaw?: string;
}

const COLLECTION_NUMBER_COURTS = new Set<RisCourtCode>(['uvs', 'vfgh', 'vwgh']);
const ISSUING_BODY_COURTS = new Set<RisCourtCode>(['dok', 'dsk', 'pvak', 'verg']);
const STATE_COURTS = new Set<RisCourtCode>(['lvwg', 'uvs']);
const NO_DECISION_TYPE_COURTS = new Set<RisCourtCode>(['gbk', 'normenliste', 'upts']);

/** Build a case-law search request. */
export function buildCaseLawRequest(params: CaseLawSearchParams): RisRequest {
  const court = COURT_BY_CODE.get(params.court);
  if (!court) invalidValue('court', params.court, [...COURT_BY_CODE.keys()]);
  const code = court.code;
  const upts = code === 'upts';
  const bag = new ParamBag(court.application);

  bag.setIf('Suchworte', params.query);
  bag.setIf('Norm', params.norm);
  if (params.caseNumber !== undefined) {
    if (code === 'normenliste') unsupported('caseNumber', court.application);
    bag.set(upts ? 'GZ' : 'Geschaeftszahl', params.caseNumber);
  }
  if (params.decisionType !== undefined && params.decisionType !== 'all') {
    if (NO_DECISION_TYPE_COURTS.has(code)) unsupported('decisionType', court.application);
    bag.set(
      params.decisionType === 'headnote'
        ? 'Dokumenttyp.SucheInRechtssaetzen'
        : 'Dokumenttyp.SucheInEntscheidungstexten',
      'true',
    );
  }
  if (params.decidedFrom !== undefined || params.decidedTo !== undefined) {
    if (code === 'normenliste') unsupported('decidedFrom/decidedTo', court.application);
    bag.setIf(upts ? 'Entscheidungsdatum.Von' : 'EntscheidungsdatumVon', params.decidedFrom);
    bag.setIf(upts ? 'Entscheidungsdatum.Bis' : 'EntscheidungsdatumBis', params.decidedTo);
  }
  if (params.decisionKind !== undefined) {
    const kinds = DECISION_KINDS_BY_COURT.get(code);
    if (!kinds) unsupported('decisionKind', court.application);
    if (!kinds.values.some((value) => value === params.decisionKind)) {
      invalidValue('decisionKind', params.decisionKind, kinds.values);
    }
    bag.set('Entscheidungsart', params.decisionKind);
  }
  if (params.collectionNumber !== undefined) {
    if (!COLLECTION_NUMBER_COURTS.has(code)) unsupported('collectionNumber', court.application);
    bag.set('Sammlungsnummer', params.collectionNumber);
  }
  if (params.issuingBody !== undefined) {
    if (!ISSUING_BODY_COURTS.has(code)) unsupported('issuingBody', court.application);
    bag.set('EntscheidendeBehoerde', params.issuingBody);
  }
  if (params.courtName !== undefined) {
    if (code !== 'justiz') unsupported('courtName', court.application);
    bag.set('Gericht', params.courtName);
  }
  if (params.legalArea !== undefined) {
    if (code !== 'justiz') unsupported('legalArea', court.application);
    bag.set('Rechtsgebiet', params.legalArea === 'civil' ? 'Zivilrecht' : 'Strafrecht');
  }
  if (params.subjectArea !== undefined) {
    if (code !== 'justiz') unsupported('subjectArea', court.application);
    bag.set('Fachgebiet', params.subjectArea);
  }
  if (params.state !== undefined) {
    if (!STATE_COURTS.has(code)) unsupported('state', court.application);
    bag.set('Bundesland', stateByCode(params.state).flatAscii);
  }
  if (params.party !== undefined) {
    if (!upts) unsupported('party', court.application);
    bag.set('Partei', params.party);
  }
  if (params.commission !== undefined) {
    if (code !== 'gbk') unsupported('commission', court.application);
    bag.set(
      'Kommission',
      params.commission === 'federal'
        ? 'BundesGleichbehandlungskommission'
        : 'Gleichbehandlungskommission',
    );
  }
  if (params.senate !== undefined) {
    if (code !== 'gbk') unsupported('senate', court.application);
    bag.set('Senat', params.senate);
  }
  if (params.discriminationGround !== undefined) {
    if (code !== 'gbk') unsupported('discriminationGround', court.application);
    bag.set('Diskriminierungsgrund', params.discriminationGround);
  }
  if (params.subjectLaw !== undefined) {
    if (code !== 'bks') unsupported('subjectLaw', court.application);
    bag.set('Bereich', params.subjectLaw);
  }
  bag.changedSince(params.changedSince);
  if (params.sortBy !== undefined) {
    if (code === 'normenliste') unsupported('sortBy', court.application);
    const column =
      params.sortBy === 'decision_date'
        ? upts
          ? 'Entscheidungsdatum'
          : 'Datum'
        : upts
          ? 'GZ'
          : 'Geschaeftszahl';
    bag.sort(column, params.sortDirection);
  }
  bag.paging(params);
  return bag.toRequest(upts ? 'Sonstige' : 'Judikatur');
}

/* ------------------------------------------------------------------------------------ */
/* Gazettes (federal era tiers, state series, district, municipal)                        */
/* ------------------------------------------------------------------------------------ */

/** Applications reachable through the gazette surface. */
export type GazetteApplication =
  | 'BgblAlt'
  | 'BgblAuth'
  | 'BgblPdf'
  | 'Bvb'
  | 'GrA'
  | 'Lgbl'
  | 'LgblAuth'
  | 'LgblNO'
  | 'Vbl';

/** Search params for the gazette surface (the tool resolves era tiers before calling). */
export interface GazetteSearchParams extends RisPagingParams {
  readonly application: GazetteApplication;
  readonly districtAuthority?: string;
  readonly issuer?: string;
  readonly municipality?: string;
  /**
   * Gazette number. BgblAuth `Bgblnummer`, BgblPdf `Bundesgesetzblatt`, LgblAuth/Lgbl
   * `Lgblnummer`, Vbl/Bvb/GrA `Kundmachungsnummer`. BgblAlt expects the full `N/YYYY`
   * form in `Gesetzblattnummer` (e.g. "189/1902" — a bare number plus `year` matches
   * nothing; live-confirmed 2026-07-05).
   */
  readonly number?: string;
  readonly part?: 'part1' | 'part2' | 'part3' | 'pre_1997';
  readonly publishedFrom?: string;
  readonly publishedTo?: string;
  readonly query?: string;
  readonly sortBy?: 'number' | 'published';
  readonly sortDirection?: RisSortDirection;
  readonly state?: RisStateCode;
  readonly title?: string;
  readonly type?: 'announcements' | 'laws' | 'other' | 'regulations';
  /** Volume year filter — BgblAlt only (`Jahrgang`). */
  readonly year?: string;
}

const GAZETTE_NUMBER_PARAMS: Partial<Record<GazetteApplication, string>> = {
  BgblAlt: 'Gesetzblattnummer',
  BgblAuth: 'Bgblnummer',
  BgblPdf: 'Bundesgesetzblatt',
  Bvb: 'Kundmachungsnummer',
  GrA: 'Kundmachungsnummer',
  Lgbl: 'Lgblnummer',
  LgblAuth: 'Lgblnummer',
  Vbl: 'Kundmachungsnummer',
};

const GAZETTE_DATE_PARAMS: Record<GazetteApplication, readonly [string, string]> = {
  BgblAlt: ['Kundgemacht.Von', 'Kundgemacht.Bis'],
  BgblAuth: ['KundmachungsdatumVon', 'KundmachungsdatumBis'],
  BgblPdf: ['Kundgemacht.Von', 'Kundgemacht.Bis'],
  Bvb: ['Kundmachungsdatum.Von', 'Kundmachungsdatum.Bis'],
  GrA: ['Kundmachungsdatum.Von', 'Kundmachungsdatum.Bis'],
  Lgbl: ['Kundmachung.Von', 'Kundmachung.Bis'],
  LgblAuth: ['Kundmachung.Von', 'Kundmachung.Bis'],
  LgblNO: ['Ausgabedatum.Von', 'Ausgabedatum.Bis'],
  Vbl: ['Kundmachungsdatum.Von', 'Kundmachungsdatum.Bis'],
};

const GAZETTE_TYPE_FLAGS: Record<NonNullable<GazetteSearchParams['type']>, string> = {
  announcements: 'Typ.SucheInKundmachungen',
  laws: 'Typ.SucheInGesetzen',
  other: 'Typ.SucheInSonstiges',
  regulations: 'Typ.SucheInVerordnungen',
};

const GAZETTE_TYPE_APPS = new Set<GazetteApplication>([
  'BgblAuth',
  'BgblPdf',
  'Lgbl',
  'LgblAuth',
  'LgblNO',
]);

const GAZETTE_CONTROLLERS: Record<GazetteApplication, RisController> = {
  BgblAlt: 'Bundesrecht',
  BgblAuth: 'Bundesrecht',
  BgblPdf: 'Bundesrecht',
  Bvb: 'Bezirke',
  GrA: 'Gemeinden',
  Lgbl: 'Landesrecht',
  LgblAuth: 'Landesrecht',
  LgblNO: 'Landesrecht',
  Vbl: 'Landesrecht',
};

/** Sort columns confirmed valid per gazette application (probed 2026-07-05). */
const GAZETTE_SORT_COLUMNS: Partial<
  Record<GazetteApplication, Partial<Record<'number' | 'published', string>>>
> = {
  BgblAlt: { number: 'Fundstelle', published: 'Kundmachungsdatum' },
  BgblAuth: { published: 'Kundmachungsdatum' },
  BgblPdf: { published: 'Kundmachungsdatum' },
  Bvb: { published: 'Kundmachungsdatum' },
  GrA: { published: 'Kundmachungsdatum' },
  Lgbl: { number: 'Fundstelle', published: 'Kundmachungsdatum' },
  LgblAuth: { published: 'Kundmachungsdatum' },
  LgblNO: { published: 'Ausgabedatum' },
  Vbl: { published: 'Kundmachungsdatum' },
};

/** Build a gazette search request. */
export function buildGazetteRequest(params: GazetteSearchParams): RisRequest {
  const app = params.application;
  const bag = new ParamBag(app);

  bag.setIf('Suchworte', params.query);
  bag.setIf('Titel', params.title);
  if (params.number !== undefined) {
    const name = GAZETTE_NUMBER_PARAMS[app];
    if (!name) unsupported('number', app);
    bag.set(name, params.number);
  }
  if (params.year !== undefined) {
    if (app !== 'BgblAlt') unsupported('year', app);
    bag.set('Jahrgang', params.year);
  }
  if (params.part !== undefined) {
    if (app !== 'BgblAuth' && app !== 'BgblPdf') unsupported('part', app);
    if (params.part === 'pre_1997') {
      if (app !== 'BgblPdf') unsupported('part: pre_1997', app);
      bag.set('Teil.SucheInAlt', 'true');
    } else {
      bag.set(`Teil.SucheInTeil${params.part.slice(-1)}`, 'true');
    }
  }
  if (params.type !== undefined) {
    if (!GAZETTE_TYPE_APPS.has(app)) unsupported('type', app);
    bag.set(GAZETTE_TYPE_FLAGS[params.type], 'true');
  }
  if (params.publishedFrom !== undefined || params.publishedTo !== undefined) {
    const [from, to] = GAZETTE_DATE_PARAMS[app];
    bag.setIf(from, params.publishedFrom);
    bag.setIf(to, params.publishedTo);
  }
  if (params.issuer !== undefined) {
    if (app === 'BgblAuth')
      bag.set('EinbringendeStelle', expandMinistry(params.issuer, 'einbringende_stelle'));
    else if (app === 'Vbl') bag.set('Einbringer', params.issuer);
    else unsupported('issuer', app);
  }
  if (params.state !== undefined) {
    const state = stateByCode(params.state);
    if (app === 'LgblAuth') bag.set(`Bundesland.${state.flagParam}`, 'true');
    else if (app === 'Lgbl') {
      if (!state.inLgbl) {
        throw validationError(
          `The historical Lgbl gazette has no ${state.name} — Niederösterreich uses the LgblNO systematic collection and Wien is not carried.`,
          { application: app, state: params.state },
        );
      }
      bag.set(`Bundesland.${state.flagParam}`, 'true');
    } else if (app === 'Vbl') {
      if (!VBL_COVERED_STATES.includes(params.state)) {
        throw validationError(
          `Verordnungsblätter in RIS currently cover Tirol only — "${params.state}" fails on the RIS backend.`,
          { application: app, coveredStates: [...VBL_COVERED_STATES], state: params.state },
        );
      }
      bag.set('Bundesland', state.flatAscii);
    } else if (app === 'Bvb') bag.set('Bundesland', state.flatUmlaut);
    else if (app === 'GrA') bag.set('Bundesland', state.flatAscii);
    else unsupported('state', app);
  }
  if (params.districtAuthority !== undefined) {
    if (app !== 'Bvb') unsupported('districtAuthority', app);
    bag.set('Bezirksverwaltungsbehoerde', params.districtAuthority);
  }
  if (params.municipality !== undefined) {
    if (app !== 'GrA') unsupported('municipality', app);
    bag.set('Gemeinde', params.municipality);
  }
  if (params.sortBy !== undefined) {
    const columns = GAZETTE_SORT_COLUMNS[app] ?? {};
    const column = columns[params.sortBy];
    if (!column) {
      unsupported('sortBy', app, { alternatives: Object.keys(columns), value: params.sortBy });
    }
    bag.sort(column, params.sortDirection);
  }
  bag.paging(params);
  return bag.toRequest(GAZETTE_CONTROLLERS[app]);
}

/* ------------------------------------------------------------------------------------ */
/* Lawmaking pipeline (Begut / RegV)                                                     */
/* ------------------------------------------------------------------------------------ */

/** Search params for the drafts surface. */
export interface DraftsSearchParams extends RisPagingParams {
  readonly changedSince?: ChangedSinceCode;
  readonly decidedFrom?: string;
  readonly decidedTo?: string;
  readonly inReviewOn?: string;
  readonly ministry?: string;
  readonly query?: string;
  readonly sortBy?: 'date' | 'ministry' | 'title';
  readonly sortDirection?: RisSortDirection;
  readonly stage: RisStageCode;
  readonly title?: string;
}

/** Build a drafts search request. */
export function buildDraftsRequest(params: DraftsSearchParams): RisRequest {
  const stage = STAGE_BY_CODE.get(params.stage);
  if (!stage) invalidValue('stage', params.stage, [...STAGE_BY_CODE.keys()]);
  const review = stage.code === 'review_drafts';
  const bag = new ParamBag(stage.application);

  bag.setIf('Suchworte', params.query);
  bag.setIf('Titel', params.title);
  if (params.ministry !== undefined)
    bag.set('EinbringendeStelle', expandMinistry(params.ministry, 'einbringende_stelle'));
  if (params.inReviewOn !== undefined) {
    if (!review) unsupported('inReviewOn', stage.application);
    bag.set('InBegutachtungAm', params.inReviewOn);
  }
  if (params.decidedFrom !== undefined || params.decidedTo !== undefined) {
    if (review) unsupported('decidedFrom/decidedTo', stage.application);
    bag.setIf('BeschlussdatumVon', params.decidedFrom);
    bag.setIf('BeschlussdatumBis', params.decidedTo);
  }
  bag.changedSince(params.changedSince);
  if (params.sortBy !== undefined) {
    const column =
      params.sortBy === 'title'
        ? 'Kurztitel'
        : params.sortBy === 'ministry'
          ? 'EinbringendeStelle'
          : review
            ? 'EndeBegutachtungsfrist'
            : 'Beschlussdatum';
    bag.sort(column, params.sortDirection);
  }
  bag.paging(params);
  return bag.toRequest('Bundesrecht');
}

/* ------------------------------------------------------------------------------------ */
/* Sectoral announcements (7 collections)                                                */
/* ------------------------------------------------------------------------------------ */

/** Search params for the announcements surface. */
export interface AnnouncementsSearchParams extends RisPagingParams {
  readonly caseNumber?: string;
  readonly changedSince?: ChangedSinceCode;
  readonly collection: RisCollectionCode;
  readonly department?: string;
  readonly enteredForceFrom?: string;
  readonly enteredForceTo?: string;
  readonly inForceAsOf?: string;
  readonly issuer?: string;
  readonly legislature?: string;
  readonly norm?: string;
  readonly number?: string;
  /** Spg plan kind (upstream `SpgStrukturplanType`); defaults to `all` when a scope is set. */
  readonly planKind?: 'all' | 'expert_opinion' | 'regulation';
  /** Spg: federal ÖSG vs regional RSG search restriction. */
  readonly planScope?: 'federal' | 'regional';
  readonly planState?: RisStateCode;
  readonly publishedFrom?: string;
  readonly publishedTo?: string;
  readonly query?: string;
  readonly sessionNumber?: string;
  readonly sortBy?: 'number' | 'published';
  readonly sortDirection?: RisSortDirection;
  readonly title?: string;
  /**
   * Document type. KmGer: `Geschaeftsordnung` | `Geschaeftsverteilung`; PruefGewO:
   * `Befaehigungspruefungsordnung` | `Meisterpruefungsordnung`; Avn: one of the
   * `Kundmachungen` / `VeroeffentlichungenAufGrundVEVO` / `SonstigeVeroeffentlichungen`
   * search flags.
   */
  readonly type?: string;
}

type AnnouncementApp = 'Avn' | 'Avsv' | 'Erlaesse' | 'KmGer' | 'Mrp' | 'PruefGewO' | 'Spg';

const ANNOUNCEMENT_NUMBER_PARAMS: Partial<Record<AnnouncementApp, string>> = {
  Avn: 'Avnnummer',
  Avsv: 'Avsvnummer',
  Spg: 'Spgnummer',
};

const ANNOUNCEMENT_DATE_PARAMS: Partial<Record<AnnouncementApp, readonly [string, string]>> = {
  Avn: ['Kundmachung.Von', 'Kundmachung.Bis'],
  Avsv: ['Kundmachung.Von', 'Kundmachung.Bis'],
  KmGer: ['Kundmachungsdatum.Von', 'Kundmachungsdatum.Bis'],
  Mrp: ['Sitzungsdatum.Von', 'Sitzungsdatum.Bis'],
  PruefGewO: ['Kundmachungsdatum.Von', 'Kundmachungsdatum.Bis'],
  Spg: ['Kundmachungsdatum.Von', 'Kundmachungsdatum.Bis'],
};

/** Flat vs nested in-force spelling per collection (probed 2026-07-05). */
const ANNOUNCEMENT_FASSUNG_PARAMS: Partial<Record<AnnouncementApp, string>> = {
  Avn: 'FassungVom',
  Erlaesse: 'FassungVom',
  KmGer: 'Fassung.FassungVom',
  PruefGewO: 'Fassung.FassungVom',
  Spg: 'Fassung.FassungVom',
};

const AVN_TYPE_FLAGS = [
  'Kundmachungen',
  'SonstigeVeroeffentlichungen',
  'VeroeffentlichungenAufGrundVEVO',
] as const;

const NORM_APPS = new Set<AnnouncementApp>(['Avn', 'Erlaesse']);

/** Sort columns confirmed valid per collection (probed 2026-07-05). */
const ANNOUNCEMENT_SORT_COLUMNS: Partial<
  Record<AnnouncementApp, Partial<Record<'number' | 'published', string>>>
> = {
  Avn: { number: 'Avnnummer', published: 'Kundmachungsdatum' },
  Avsv: { number: 'Avsvnummer', published: 'Kundmachungsdatum' },
  Mrp: { published: 'Sitzungsdatum' },
  PruefGewO: { published: 'Kundmachungsdatum' },
  Spg: { number: 'Spgnummer' },
};

const PLAN_KIND_TOKENS: Record<NonNullable<AnnouncementsSearchParams['planKind']>, string> = {
  all: 'Alle',
  expert_opinion: 'Gutachten',
  regulation: 'Verordnungen',
};

/** Build an announcements search request. */
export function buildAnnouncementsRequest(params: AnnouncementsSearchParams): RisRequest {
  const collection = COLLECTION_BY_CODE.get(params.collection);
  if (!collection) invalidValue('collection', params.collection, [...COLLECTION_BY_CODE.keys()]);
  const app = collection.application as AnnouncementApp;
  const bag = new ParamBag(app);

  bag.setIf('Suchworte', params.query);
  if (params.title !== undefined) {
    if (app === 'Mrp') unsupported('title', app);
    bag.set('Titel', params.title);
  }
  if (params.number !== undefined) {
    const name = ANNOUNCEMENT_NUMBER_PARAMS[app];
    if (!name) unsupported('number', app);
    bag.set(name, params.number);
  }
  if (params.publishedFrom !== undefined || params.publishedTo !== undefined) {
    const pair = ANNOUNCEMENT_DATE_PARAMS[app];
    if (!pair) unsupported('publishedFrom/publishedTo', app);
    bag.setIf(pair[0], params.publishedFrom);
    bag.setIf(pair[1], params.publishedTo);
  }
  if (params.inForceAsOf !== undefined) {
    const name = ANNOUNCEMENT_FASSUNG_PARAMS[app];
    if (!name) unsupported('inForceAsOf', app);
    bag.set(name, params.inForceAsOf);
  }
  if (params.enteredForceFrom !== undefined || params.enteredForceTo !== undefined) {
    if (app !== 'Erlaesse') unsupported('enteredForceFrom/enteredForceTo', app);
    bag.setIf('VonInkrafttretensdatum', params.enteredForceFrom);
    bag.setIf('BisInkrafttretensdatum', params.enteredForceTo);
  }
  if (params.issuer !== undefined) {
    if (app === 'Avsv') bag.set('Urheber', params.issuer);
    else if (app === 'Erlaesse')
      bag.set('Bundesministerium', expandMinistry(params.issuer, 'erlaesse_bundesministerium'));
    else if (app === 'Mrp') bag.set('Einbringer', expandMinistry(params.issuer, 'mrp_einbringer'));
    else unsupported('issuer', app);
  }
  if (params.norm !== undefined) {
    if (!NORM_APPS.has(app)) unsupported('norm', app);
    bag.set('Norm', params.norm);
  }
  if (params.caseNumber !== undefined) {
    if (!NORM_APPS.has(app)) unsupported('caseNumber', app);
    bag.set('Geschaeftszahl', params.caseNumber);
  }
  if (params.type !== undefined) {
    if (app === 'Avn') {
      if (!(AVN_TYPE_FLAGS as readonly string[]).includes(params.type)) {
        invalidValue('type', params.type, AVN_TYPE_FLAGS);
      }
      bag.set(`Typ.SucheIn${params.type}`, 'true');
    } else if (app === 'KmGer' || app === 'PruefGewO') {
      bag.set('Typ', params.type);
    } else unsupported('type', app);
  }
  if (params.department !== undefined) {
    if (app !== 'Erlaesse') unsupported('department', app);
    bag.set('Abteilung', params.department);
  }
  if (
    params.planScope !== undefined ||
    params.planKind !== undefined ||
    params.planState !== undefined
  ) {
    if (app !== 'Spg') unsupported('planScope/planKind/planState', app);
    const scope = params.planScope ?? (params.planState !== undefined ? 'regional' : 'federal');
    const kind = PLAN_KIND_TOKENS[params.planKind ?? 'all'];
    if (scope === 'federal') {
      if (params.planState !== undefined) {
        throw validationError('planState applies only to regional (RSG) health-structure plans.', {
          planScope: scope,
          planState: params.planState,
        });
      }
      bag.set('OsgSuchEinschraenkung.SpgStrukturplanType', kind);
    } else {
      bag.set('RsgSuchEinschraenkung.SpgStrukturplanType', kind);
      if (params.planState !== undefined) {
        bag.set('RsgSuchEinschraenkung.Land', stateByCode(params.planState).flatAscii);
      }
    }
  }
  if (params.sessionNumber !== undefined) {
    if (app !== 'Mrp') unsupported('sessionNumber', app);
    bag.set('Sitzungsnummer', params.sessionNumber);
  }
  if (params.legislature !== undefined) {
    if (app !== 'Mrp') unsupported('legislature', app);
    bag.set('Gesetzgebungsperiode', params.legislature);
  }
  bag.changedSince(params.changedSince);
  if (params.sortBy !== undefined) {
    const columns = ANNOUNCEMENT_SORT_COLUMNS[app] ?? {};
    const column = columns[params.sortBy];
    if (!column) {
      unsupported('sortBy', app, { alternatives: Object.keys(columns), value: params.sortBy });
    }
    bag.sort(column, params.sortDirection);
  }
  bag.paging(params);
  return bag.toRequest('Sonstige');
}

/* ------------------------------------------------------------------------------------ */
/* History change feed                                                                   */
/* ------------------------------------------------------------------------------------ */

/** Params for the History change feed. */
export interface TrackChangesParams extends RisPagingParams {
  /** Standard application code (e.g. `BrKons`) — aliased to the History name internally. */
  readonly application: string;
  readonly changedFrom?: string;
  readonly changedTo?: string;
  readonly includeDeleted?: boolean;
}

/** Build a History change-feed request (maps the four aliased application names). */
export function buildTrackChangesRequest(params: TrackChangesParams): RisRequest {
  const application = APPLICATION_BY_CODE.get(params.application);
  if (!application)
    invalidValue('application', params.application, [...APPLICATION_BY_CODE.keys()]);
  const bag = new ParamBag();
  bag.set('Anwendung', application.historyName);
  bag.setIf('AenderungenVon', params.changedFrom);
  bag.setIf('AenderungenBis', params.changedTo);
  if (params.includeDeleted === true) bag.set('IncludeDeletedDocuments', 'True');
  bag.paging(params);
  return bag.toRequest('History');
}
