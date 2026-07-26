/**
 * @fileoverview Normalizer for RIS OGD responses: unwraps the JSON-serialized-XML envelope,
 * coerces object-or-array lists, classifies in-band errors, and maps the six controller
 * metadata classes to the normalized shapes in `types.ts`.
 *
 * Error classification (observed live 2026-07-05): the handbook documents an `@type`
 * attribute on `OgdSearchResult.Error`, but production responses omit it and prefix the
 * message with `soap:Client.` / `soap:Server.` instead — both signals are checked. Client
 * errors become `InvalidParams` with RIS's message passed through (it names the invalid
 * element); everything else is treated as a transient upstream failure, never a
 * `SerializationError`. RIS carries the same envelope on a 500 for rejected parameters, so
 * `errorFromResponseBody` classifies an error-response body through the same path. Some
 * faults arrive wrapped in .NET exception scaffolding, which is stripped so RIS's own
 * explanation is what reaches the caller.
 * @module services/ris/normalizer
 */

import {
  type ErrorFactoryOptions,
  invalidParams,
  type McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';

import type {
  OneOrMany,
  RawBezirkeMeta,
  RawBundesrechtMeta,
  RawContentReference,
  RawContentUrl,
  RawDocumentReference,
  RawDokumentliste,
  RawGemeindenMeta,
  RawJudikaturAppKey,
  RawJudikaturAppNode,
  RawJudikaturMeta,
  RawLandesrechtMeta,
  RawOgdResponse,
  RawOgdSearchResult,
  RawRisError,
  RawSonstigeMeta,
  RawWrappedList,
  RisBezirkeMetadata,
  RisBundesrechtMetadata,
  RisChange,
  RisChangeSet,
  RisConsolidatedFields,
  RisContentReference,
  RisGemeindenMetadata,
  RisHit,
  RisHitMetadata,
  RisJudikaturMetadata,
  RisKeyedUrls,
  RisLandesrechtMetadata,
  RisSearchResult,
  RisSonstigeMetadata,
} from './types.js';

/* ------------------------------------------------------------------------------------ */
/* Generic coercion and text helpers                                                     */
/* ------------------------------------------------------------------------------------ */

/** Coerce RIS's object-or-array serialization to an array (empty for null/undefined/''). */
export function coerceOneOrMany<T>(value: OneOrMany<T> | '' | undefined): T[] {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Coerce a RIS wrapped list (`{ item: T | T[] }`), a bare scalar, or an empty element to
 * a string array — the upstream uses all three shapes for the same logical field.
 */
export function coerceWrappedList(
  value: RawWrappedList<string> | string | '' | undefined,
): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') return [value];
  return coerceOneOrMany(value.item).filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  );
}

const HTML_ENTITIES: readonly [RegExp, string][] = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#0?39;/g, "'"],
  [/&nbsp;/g, ' '],
];

/** Strip `<br/>` markers, CRLF line endings, and residual HTML remnants from RIS text. */
export function stripHtmlRemnants(text: string): string {
  let out = text
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  for (const [pattern, replacement] of HTML_ENTITIES) out = out.replace(pattern, replacement);
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Strip and trim a raw text field; empty/absent values become `undefined`. */
function cleanText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return;
  const cleaned = stripHtmlRemnants(value);
  return cleaned === '' ? undefined : cleaned;
}

/** Pass a raw scalar through unchanged, mapping empty strings to `undefined`. */
function rawText(value: string | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const CELEX_BRACKET = /\[CELEX-?Nr\.?:?\s*([^\]]+)\]/gi;

/** Parse `[CELEX-Nr.: …]` markers (possibly multi-valued) out of RIS text fields. */
export function parseCelexReferences(...texts: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(CELEX_BRACKET)) {
      for (const token of (match[1] ?? '').split(/[,;\s]+/)) {
        if (token !== '') out.add(token);
      }
    }
  }
  return [...out];
}

/** Detect an HTML error page masquerading as an API response. */
export function isHtmlErrorPage(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * Drop `undefined`-valued keys so optional fields stay genuinely absent
 * (`exactOptionalPropertyTypes`). Input is keyed against the target type, so field-name
 * typos still fail compilation.
 */
function prune<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/* ------------------------------------------------------------------------------------ */
/* Envelope handling                                                                     */
/* ------------------------------------------------------------------------------------ */

/** The SOAP fault code opening a RIS message, with the optional subcode RIS puts on some. */
const SOAP_PREFIX = /^soap:(Client|Server)(?:\.\w+:)?[.:]?\s*/;

/**
 * .NET scaffolding RIS leaks into some fault messages: a namespaced exception type, and the
 * stack-trace marker closing the message. Observed live 2026-07-15 on the fulltext-validation
 * faults every controller raises (`soap:Client.Validation:System.Web.…SoapException: …
 * \n  <STACKTRACE>`) and on Landesrecht, which wraps the whole fault a second time
 * (`Bka.Ris.…OgdException: soap:Client…`) — hiding the `soap:` prefix that classification
 * keys on, which is why a Landesrecht fault only classifies once this is stripped.
 *
 * Matching requires a dotted namespace before `…Exception:`, so it fires only on genuine
 * .NET type names: RIS's own prose (`Die Seitennummer ist höher…`, `Schema Validation
 * Error: …`) carries no such token and passes through byte-identical.
 */
const DOTNET_EXCEPTION = /(?:\w+\.)+\w*Exception:\s*/g;
const STACKTRACE_MARKER = /\s*<STACKTRACE>\s*$/;

/** Classify a fault from its `@type` attribute, falling back to the descaffolded message. */
function classifyError(error: RawRisError, fault: string): 'Client' | 'Server' | undefined {
  const type = error['@type'];
  if (type === 'Client' || type === 'Server') return type;
  const match = SOAP_PREFIX.exec(fault);
  return match ? (match[1] as 'Client' | 'Server') : undefined;
}

/**
 * Build the error for one RIS `Error` node. Client errors pass RIS's message through — it
 * names the invalid element and its expected datatype; Server and unclassifiable errors are
 * transient (`ServiceUnavailable`). The single classification point for both the 200-status
 * in-band path and the 500-status error-body path.
 */
function inBandError(error: RawRisError, options?: ErrorFactoryOptions): McpError {
  const fault = (error.Message ?? 'RIS returned an unspecified error.')
    .replace(DOTNET_EXCEPTION, '')
    .replace(STACKTRACE_MARKER, '');
  const message = fault.replace(SOAP_PREFIX, '').trim();
  const data = prune<{ risApplication?: string }>({ risApplication: rawText(error.Applikation) });
  return classifyError(error, fault) === 'Client'
    ? invalidParams(message, data, options)
    : serviceUnavailable(message, data, options);
}

/** Throw when a 200-status envelope carries an in-band error. */
export function assertNoInBandError(result: RawOgdSearchResult): void {
  if (result.Error) throw inBandError(result.Error);
}

/**
 * Build the error RIS described in a non-2xx response body. RIS reports a rejected
 * parameter as HTTP 500 carrying the same `OgdSearchResult.Error` envelope it uses in-band
 * on a 200 — an out-of-range page number, a malformed fulltext query — so the status alone
 * misclassifies a caller input error as a server fault.
 *
 * Returns `undefined` when the body is absent, is not JSON (the framework truncates a
 * captured error body past its byte cap, which can cut mid-JSON), or carries no error
 * envelope. The caller keeps its original error in that case, never a fabricated one.
 */
export function errorFromResponseBody(
  body: unknown,
  options?: ErrorFactoryOptions,
): McpError | undefined {
  if (typeof body !== 'string') return;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }
  const error = (payload as RawOgdResponse | undefined)?.OgdSearchResult?.Error;
  return error ? inBandError(error, options) : undefined;
}

function unrecognizedEnvelope(detail: string): never {
  throw serviceUnavailable(
    `RIS returned an unrecognized response envelope (${detail}) — retry shortly.`,
  );
}

interface ParsedEnvelope {
  readonly page: number;
  readonly pageSize: number;
  readonly references: RawDocumentReference[];
  readonly total: number;
}

function parseEnvelope(payload: unknown): ParsedEnvelope {
  const result = (payload as RawOgdResponse | undefined)?.OgdSearchResult;
  if (result === undefined || result === null) unrecognizedEnvelope('missing OgdSearchResult');
  assertNoInBandError(result);
  const documentResults = result.OgdDocumentResults;
  const total = Number.parseInt(documentResults?.Hits?.['#text'] ?? '', 10);
  if (documentResults === undefined || Number.isNaN(total)) unrecognizedEnvelope('missing Hits');
  const references = coerceOneOrMany(documentResults.OgdDocumentReference);
  const page = Number.parseInt(documentResults.Hits?.['@pageNumber'] ?? '', 10);
  const pageSize = Number.parseInt(documentResults.Hits?.['@pageSize'] ?? '', 10);
  return {
    page: Number.isNaN(page) ? 1 : page,
    pageSize: Number.isNaN(pageSize) ? references.length : pageSize,
    references,
    total,
  };
}

/** Parse a search-controller response into a normalized result page. */
export function parseSearchResponse(payload: unknown): RisSearchResult {
  const { page, pageSize, references, total } = parseEnvelope(payload);
  return { hits: references.map(normalizeHit), page, pageSize, total };
}

/** Parse a History-controller response, separating changed documents from deletions. */
export function parseHistoryResponse(payload: unknown): RisChangeSet {
  const { page, pageSize, references, total } = parseEnvelope(payload);
  const changes: RisChange[] = references.map((ref) => {
    const deleted = ref.Deleted;
    if (deleted) {
      const documentNumber = rawText(deleted.ID);
      if (!documentNumber) unrecognizedEnvelope('deletion record without ID');
      return {
        kind: 'deleted',
        record: prune({
          application: rawText(deleted.Applikation),
          deletedAt: rawText(deleted.ImportTimestamp),
          documentNumber,
          organ: rawText(deleted.Organ),
        }),
      };
    }
    return { kind: 'document', hit: normalizeHit(ref) };
  });
  return { changes, page, pageSize, total };
}

/* ------------------------------------------------------------------------------------ */
/* Content references                                                                    */
/* ------------------------------------------------------------------------------------ */

const CORE_DATA_TYPES: Record<
  string,
  keyof Pick<RisKeyedUrls, 'authentic' | 'html' | 'pdf' | 'rtf' | 'xml'>
> = {
  Authentisch: 'authentic',
  Html: 'html',
  Pdf: 'pdf',
  Rtf: 'rtf',
  Xml: 'xml',
};

function keyContentUrls(contentUrl: OneOrMany<RawContentUrl> | undefined): RisKeyedUrls {
  const keyed: { -readonly [K in keyof RisKeyedUrls]: RisKeyedUrls[K] } = {};
  const other: { dataType: string; url: string }[] = [];
  for (const entry of coerceOneOrMany(contentUrl)) {
    const url = rawText(entry.Url);
    const dataType = rawText(entry.DataType);
    if (!url || !dataType) continue;
    const core = CORE_DATA_TYPES[dataType];
    if (core) keyed[core] ??= url;
    else other.push({ dataType, url });
  }
  if (other.length > 0) keyed.other = other;
  return keyed;
}

function normalizeContentReferences(
  dokumentliste: RawDokumentliste | '' | undefined,
): RisContentReference[] {
  if (dokumentliste === undefined || dokumentliste === '') return [];
  return coerceOneOrMany(dokumentliste.ContentReference).map((ref: RawContentReference) =>
    prune<RisContentReference>({
      name: rawText(ref.Name),
      type: rawText(ref.ContentType),
      urls: keyContentUrls(ref.Urls?.ContentUrl),
    }),
  );
}

/* ------------------------------------------------------------------------------------ */
/* Controller-class metadata maps                                                        */
/* ------------------------------------------------------------------------------------ */

/** Map the shared consolidated-law node (BrKons / LrKons). */
function mapConsolidated(kons: RawBundesrechtMeta['BrKons']): {
  [K in keyof RisConsolidatedFields]: RisConsolidatedFields[K] | undefined;
} {
  return {
    amendment: cleanText(kons?.Aenderung),
    inForceFrom: rawText(kons?.Inkrafttretensdatum),
    inForceUntil: rawText(kons?.Ausserkrafttretensdatum),
    indexes: coerceWrappedList(kons?.Indizes),
    keywords: cleanText(kons?.Schlagworte),
    lawId: rawText(kons?.Gesetzesnummer),
    lawUrl: rawText(kons?.GesamteRechtsvorschriftUrl),
    normType: rawText(kons?.Typ),
    promulgation: cleanText(kons?.Kundmachungsorgan),
    sectionLabel: rawText(kons?.ArtikelParagraphAnlage),
  };
}

function mapBundesrecht(raw: RawBundesrechtMeta): RisBundesrechtMetadata {
  const { Begut, BgblAlt, BgblAuth, BgblPdf, BrKons, Erv, RegV } = raw;
  return prune<RisBundesrechtMetadata>({
    ...mapConsolidated(BrKons),
    abbreviation: rawText(Begut?.Abkuerzung) ?? rawText(RegV?.Abkuerzung),
    alexUrl: rawText(BgblAlt?.AlexUrl),
    // Both Erv fields are `<br/>`-separated prose upstream — an author reads
    // "Ministry X<br/>amendment: Chancellery", a source three labelled version lines.
    author: cleanText(Erv?.Author),
    celexReferences: [
      ...new Set([
        ...parseCelexReferences(raw.Titel, BrKons?.Aenderung),
        ...coerceWrappedList(BgblPdf?.CelexNummer),
      ]),
    ],
    controller: 'Bundesrecht',
    decided: rawText(RegV?.Beschlussdatum),
    eli: rawText(raw.Eli),
    gazetteNumber:
      rawText(BgblAuth?.Bgblnummer) ?? rawText(BgblPdf?.Bgblnummer) ?? rawText(BgblAlt?.Fundstelle),
    issue: rawText(BgblAlt?.Stueck),
    keywords:
      cleanText(BrKons?.Schlagworte) ??
      cleanText(Begut?.Schlagworte) ??
      cleanText(RegV?.Schlagworte),
    ministry: rawText(Begut?.EinbringendeStelle) ?? rawText(RegV?.EinbringendeStelle),
    normType:
      rawText(BrKons?.Typ) ??
      rawText(BgblAuth?.Typ) ??
      rawText(BgblPdf?.Typ) ??
      rawText(BgblAlt?.Typ),
    part: rawText(BgblAuth?.Teil) ?? rawText(BgblPdf?.Teil),
    promulgation: cleanText(BrKons?.Kundmachungsorgan) ?? cleanText(BgblAlt?.Kundmachungsorgan),
    publishedDate:
      rawText(BgblAuth?.Ausgabedatum) ??
      rawText(BgblPdf?.Kundmachungsdatum) ??
      rawText(BgblAlt?.Kundmachungsdatum),
    reviewDeadline: rawText(Begut?.EndeBegutachtungsfrist),
    reviewStart: rawText(Begut?.BeginnBegutachtungsfrist),
    shortTitle: cleanText(raw.Kurztitel),
    source: cleanText(Erv?.Source),
    startPage: rawText(BgblAlt?.Anfangsseite),
    title: cleanText(raw.Titel),
    year: rawText(BgblPdf?.Jahrgang),
  });
}

function mapLandesrecht(raw: RawLandesrechtMeta): RisLandesrechtMetadata {
  const { Lgbl, LgblAuth, LgblNO, LrKons, Vbl } = raw;
  return prune<RisLandesrechtMetadata>({
    ...mapConsolidated(LrKons),
    celexReferences: [
      ...new Set([
        ...parseCelexReferences(raw.Titel, LrKons?.Aenderung),
        ...coerceWrappedList(LgblAuth?.CelexNummer),
      ]),
    ],
    controller: 'Landesrecht',
    eli: rawText(LrKons?.Eli) ?? rawText(LgblAuth?.EuropeanLegislationIdentifier),
    gazetteNumber:
      rawText(LgblAuth?.Lgblnummer) ??
      rawText(Lgbl?.Fundstelle) ??
      rawText(Vbl?.Kundmachungsnummer),
    indexes: [...coerceWrappedList(LrKons?.Indizes), ...coerceWrappedList(LgblNO?.Indizes)],
    issue: rawText(LgblNO?.StueckNummer),
    normType:
      rawText(LrKons?.Typ) ??
      rawText(LgblAuth?.Typ) ??
      rawText(Lgbl?.Typ) ??
      rawText(LgblNO?.Typ) ??
      rawText(Vbl?.Typ),
    promulgation: cleanText(LrKons?.Kundmachungsorgan) ?? cleanText(Vbl?.Kundmachungsorgan),
    publishedDate: rawText(raw.Kundmachungsdatum) ?? rawText(LgblNO?.Ausgabedatum),
    shortTitle: cleanText(raw.Kurztitel),
    state: rawText(raw.Bundesland),
    systematicNumber: rawText(LgblNO?.Gliederungszahl),
    title: cleanText(raw.Titel),
  });
}

const JUDIKATUR_APP_KEYS: readonly RawJudikaturAppKey[] = [
  'Vfgh',
  'Vwgh',
  'Justiz',
  'Normenliste',
  'Bvwg',
  'Lvwg',
  'Dsk',
  'Dok',
  'Pvak',
  'Gbk',
  'Uvs',
  'AsylGH',
  'Ubas',
  'Umse',
  'Bks',
  'Verg',
];

function mapJudikatur(raw: RawJudikaturMeta): RisJudikaturMetadata {
  const node: RawJudikaturAppNode =
    JUDIKATUR_APP_KEYS.map((key) => raw[key]).find(
      (value) => value !== undefined && typeof value === 'object',
    ) ?? {};
  return prune<RisJudikaturMetadata>({
    // The VwGH short form is on every Normenliste record and is the form its citations use;
    // `Abkuerzung` is sparse and frequently repeats the full title instead.
    abbreviation: rawText(node.AbkuerzungDesVerwaltungsgerichtshofes) ?? rawText(node.Abkuerzung),
    caseNumbers: coerceWrappedList(raw.Geschaeftszahl),
    collectionNumber: rawText(node.Sammlungsnummer),
    controller: 'Judikatur',
    courtName: rawText(node.Gericht),
    decisionDate: rawText(raw.Entscheidungsdatum),
    decisionDocumentType: rawText(raw.Dokumenttyp),
    decisionKind: rawText(node.Entscheidungsart),
    decisionUrl: rawText(raw.GesamteEntscheidungUrl),
    ecli: rawText(raw.EuropeanCaseLawIdentifier),
    guidingPrinciple: cleanText(node.Leitsatz),
    headnotesUrl: rawText(raw.RechtssaetzeUrl),
    indexes: coerceWrappedList(node.Indizes),
    issuingBody: rawText(node.EntscheidendeBehoerde),
    keywords: cleanText(raw.Schlagworte),
    legalAreas: coerceWrappedList(node.Rechtsgebiete),
    legalForceNote: cleanText(node.Anfechtung),
    normType: rawText(node.Typ),
    normsCited: coerceWrappedList(raw.Normen),
    note: cleanText(node.Anmerkung),
    reference: cleanText(node.Fundstelle),
    state: rawText(node.Bundesland),
    summary: cleanText(node.Kurzinformation),
    textUrl: rawText(raw.EntscheidungstextUrl),
    title: cleanText(node.Titel),
  });
}

function mapBezirke(raw: RawBezirkeMeta): RisBezirkeMetadata {
  const bvb = raw.Bvb;
  return prune<RisBezirkeMetadata>({
    controller: 'Bezirke',
    districtAuthority: rawText(bvb?.Bezirksverwaltungsbehoerde),
    gazetteNumber: rawText(bvb?.Kundmachungsnummer),
    keywords: cleanText(bvb?.Schlagworte),
    normType: rawText(bvb?.Typ),
    promulgation: cleanText(bvb?.Kundmachungsorgan),
    publishedDate: rawText(bvb?.Kundmachungsdatum),
    shortTitle: cleanText(raw.Kurztitel),
    state: rawText(raw.Bundesland),
    title: cleanText(raw.Titel),
  });
}

function mapGemeinden(raw: RawGemeindenMeta): RisGemeindenMetadata {
  const { Gr, GrA } = raw;
  return prune<RisGemeindenMetadata>({
    abbreviation: rawText(GrA?.Abkuerzung),
    caseNumbers: coerceWrappedList(raw.Geschaeftszahl),
    controller: 'Gemeinden',
    district: rawText(GrA?.Bezirk),
    gazetteNumber: rawText(GrA?.KundmachungsorganNr),
    indexes: coerceWrappedList(Gr?.Indizes),
    inForceFrom: rawText(Gr?.Inkrafttretensdatum),
    keywords: cleanText(GrA?.Schlagworte),
    municipality: rawText(raw.Gemeinde),
    normType: rawText(raw.Typ),
    note: cleanText(raw.Anmerkung),
    publishedDate: rawText(GrA?.Kundmachungsdatum),
    shortTitle: cleanText(raw.Kurztitel),
    state: rawText(raw.Bundesland),
    title: cleanText(raw.Titel),
  });
}

function mapSonstige(raw: RawSonstigeMeta): RisSonstigeMetadata {
  const { Avn, Avsv, Erlaesse, KmGer, Mrp, PruefGewO, Spg, Upts } = raw;
  const issuers = [
    ...(rawText(Avsv?.Urheber) ? [Avsv?.Urheber as string] : []),
    ...(rawText(Erlaesse?.Bundesministerium) ? [Erlaesse?.Bundesministerium as string] : []),
    ...coerceWrappedList(Mrp?.Einbringer),
  ];
  const caseNumbers = [
    ...coerceWrappedList(Erlaesse?.Geschaeftszahl),
    ...coerceWrappedList(Avn?.Geschaeftszahl),
    ...coerceWrappedList(KmGer?.GZ),
    ...coerceWrappedList(PruefGewO?.GZ),
    ...coerceWrappedList(Upts?.GZ),
  ];
  return prune<RisSonstigeMetadata>({
    caseNumbers,
    controller: 'Sonstige',
    courtName: rawText(KmGer?.Gericht),
    decisionDate: rawText(Upts?.Entscheidungsdatum),
    department: rawText(Erlaesse?.Abteilung),
    inForceFrom:
      rawText(Avn?.Inkrafttretensdatum) ??
      rawText(Erlaesse?.Inkrafttretensdatum) ??
      rawText(KmGer?.Inkrafttretensdatum) ??
      rawText(PruefGewO?.Inkrafttretensdatum) ??
      rawText(Spg?.Inkrafttretensdatum),
    inForceUntil:
      rawText(Avn?.Ausserkrafttretensdatum) ??
      rawText(Erlaesse?.Ausserkrafttretensdatum) ??
      rawText(KmGer?.Ausserkrafttretensdatum),
    issuers,
    keywords: cleanText(raw.Schlagworte),
    legislature: rawText(Mrp?.Gesetzgebungsperiode),
    normType:
      rawText(Avn?.Typ) ??
      rawText(Erlaesse?.Typ) ??
      rawText(KmGer?.Typ) ??
      rawText(PruefGewO?.Typ) ??
      rawText(Spg?.Typ),
    // Upts renders multiple cited norms as one newline-separated scalar (observed live).
    normsCited: [
      ...coerceWrappedList(Avn?.Normen),
      ...(rawText(Upts?.Norm)
        ?.split(/\r?\n/)
        .map((norm) => norm.trim())
        .filter((norm) => norm !== '') ?? []),
    ],
    note: cleanText(Avn?.Anmerkung) ?? cleanText(PruefGewO?.Anmerkung),
    number: rawText(Avsv?.Avsvnummer) ?? rawText(Avn?.Avnnummer) ?? rawText(Spg?.Spgnummer),
    party: rawText(Upts?.Partei),
    planState: rawText(Spg?.Land),
    publishedDate: rawText(raw.Kundmachungsdatum),
    sessionDate: rawText(Mrp?.Sitzungsdatum),
    sessionNumber: rawText(Mrp?.Sitzungsnummer),
    shortTitle: cleanText(raw.Kurztitel),
    summary:
      cleanText(Avsv?.Kurzinformation) ??
      cleanText(Avn?.Kurzinformation) ??
      cleanText(Erlaesse?.Kurzinformation) ??
      cleanText(KmGer?.Kurzinformation) ??
      cleanText(PruefGewO?.Kurzinformation) ??
      cleanText(Spg?.Kurzinformation),
    title: cleanText(raw.Titel),
  });
}

/* ------------------------------------------------------------------------------------ */
/* Hit normalization                                                                     */
/* ------------------------------------------------------------------------------------ */

/** Normalize one search hit. Throws `ServiceUnavailable` on unrecognized hit shapes. */
export function normalizeHit(ref: RawDocumentReference): RisHit {
  const data = ref.Data;
  const metadaten = data?.Metadaten;
  const documentNumber = rawText(metadaten?.Technisch?.ID);
  if (!documentNumber) unrecognizedEnvelope('hit without Technisch.ID');

  let metadata: RisHitMetadata | undefined;
  if (metadaten?.Bundesrecht) metadata = mapBundesrecht(metadaten.Bundesrecht);
  else if (metadaten?.Landesrecht) metadata = mapLandesrecht(metadaten.Landesrecht);
  else if (metadaten?.Judikatur) metadata = mapJudikatur(metadaten.Judikatur);
  else if (metadaten?.Bezirke) metadata = mapBezirke(metadaten.Bezirke);
  else if (metadaten?.Gemeinden) metadata = mapGemeinden(metadaten.Gemeinden);
  else if (metadaten?.Sonstige) metadata = mapSonstige(metadaten.Sonstige);
  if (!metadata) unrecognizedEnvelope(`hit ${documentNumber} without a controller metadata class`);

  const contentReferences = normalizeContentReferences(data?.Dokumentliste);
  const mainReference =
    contentReferences.find((entry) => entry.type === 'MainDocument') ?? contentReferences[0];
  return prune<RisHit>({
    application: rawText(metadaten?.Technisch?.Applikation),
    changed: rawText(metadaten?.Allgemein?.Geaendert),
    contentReferences,
    contentUrls: mainReference?.urls ?? {},
    documentNumber,
    documentUrl: rawText(metadaten?.Allgemein?.DokumentUrl),
    metadata,
    organ: rawText(metadaten?.Technisch?.Organ),
    published: rawText(metadaten?.Allgemein?.Veroeffentlicht),
    submitter: rawText(metadaten?.Technisch?.Einbringer),
  });
}
