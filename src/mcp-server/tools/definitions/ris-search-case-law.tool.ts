/**
 * @fileoverview ris_search_case_law — search Austrian case law (Judikatur) in one
 * court/tribunal application per call across the 17 court codes, including the
 * Parteien-Transparenz-Senat (upts), which the service routes to the Sonstige controller.
 * The full court-conditional filter matrix is guarded locally before any upstream call,
 * and decision_kind / subject_area values are validated against the static reference
 * tables — RIS silently ignores unknown params, so local strictness is the only safety.
 * @module mcp-server/tools/definitions/ris-search-case-law
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import {
  COURTS_WITHOUT_DECISION_KIND,
  RIS_CHANGED_SINCE_INTERVALS,
  RIS_COURTS,
  RIS_DECISION_KINDS,
  RIS_ISSUING_BODIES,
  RIS_JUSTIZ_SUBJECT_AREAS,
  RIS_STATES,
} from '@/services/ris/reference/index.js';
import type {
  CaseLawSearchParams,
  ChangedSinceCode,
  RisCourtCode,
  RisStateCode,
} from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisHit, RisJudikaturMetadata } from '@/services/ris/types.js';

import {
  failSearchError,
  isoDateString,
  rewriteUnsupportedParam,
  type UnsupportedParam,
} from './_shared.js';

const COURT_CODES = RIS_COURTS.map((c) => c.code) as [RisCourtCode, ...RisCourtCode[]];
const STATE_CODES = RIS_STATES.map((s) => s.code) as [RisStateCode, ...RisStateCode[]];
const CHANGED_SINCE_CODES = RIS_CHANGED_SINCE_INTERVALS.map((i) => i.code) as [
  ChangedSinceCode,
  ...ChangedSinceCode[],
];

/** Courts whose RIS search schema carries no Entscheidungsart (decision_kind) parameter. */
const NO_DECISION_KIND = new Set<string>(COURTS_WITHOUT_DECISION_KIND);

/** First 4-digit year in a court's documented coverage window, when one is stated. */
function coverageStartYear(window: string | null): number | undefined {
  const match = window === null ? null : /\d{4}/.exec(window);
  return match ? Number.parseInt(match[0], 10) : undefined;
}

/** Map an empty string from a form-based client to `undefined`. */
function meaningful(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * A request-builder rejection restated with the `court` value the caller sent and the input
 * field it belongs to. Every court-conditional filter is already refused by the local guards
 * below, so `sort_by` under normenliste is the one combination that gets this far; anything
 * else returns `undefined` and keeps the builder's own message rather than inventing a cause.
 */
function callerFacingRejection(
  rejected: UnsupportedParam,
  court: RisCourtCode,
): string | undefined {
  if (rejected.param !== 'sortBy' || court !== 'normenliste') return;
  return "sort_by is not available for court 'normenliste' — the VwGH norm index lists laws rather than decisions, so it carries no decision date or case number to sort on. Drop sort_by, or search court: 'vwgh' for the decisions themselves.";
}

const ContentUrlsSchema = z
  .object({
    xml: z.string().optional().describe('XML rendition URL.'),
    html: z.string().optional().describe('HTML rendition URL.'),
    pdf: z.string().optional().describe('PDF rendition URL (the only rendition for upts).'),
    rtf: z.string().optional().describe('RTF rendition URL.'),
  })
  .describe('Rendition URLs of the main document.');

/**
 * The identity of a law, for the one court code that indexes laws rather than deciding
 * cases. Grouped rather than flattened onto the record: these four fields exist only under
 * `court: normenliste`, they would need a `norm_` prefix each to avoid reading as decision
 * attributes (`type` beside `decision_type`, a `title` no decision has), and the object's
 * presence is a single check that tells a caller which kind of record it holds.
 */
const NormIndexSchema = z
  .object({
    title: z
      .string()
      .optional()
      .describe(
        'Full title of the law as the index records it (Titel) — often several lines, carrying the parliamentary references and originating gazette.',
      ),
    abbreviation: z
      .string()
      .optional()
      .describe(
        'Citable short form the VwGH uses for the law, e.g. "DSG 2000", "HlG 1989", "KFGNov 21te".',
      ),
    type: z
      .string()
      .optional()
      .describe('Norm type code (BG, V, K, …) — glossary: ris_list_reference topic law_types.'),
    reference: z
      .string()
      .optional()
      .describe(
        'Promulgation reference of the law (Fundstelle), e.g. "BGBl I 165/1999" — resolve it with ris_search_gazette or ris_lookup_citation.',
      ),
  })
  .describe(
    'The law this record indexes. Present only for court normenliste (the VwGH norm index); absent for the sixteen deciding courts, whose records describe a decision instead.',
  );

export const CaseLawRecordSchema = z
  .object({
    document_number: z
      .string()
      .describe(
        'Technical RIS document number (e.g. JFT_…, DSBT_20251114_…, UPTS_…) — pass together with the court value (as application) to ris_get_document.',
      ),
    court: z
      .string()
      .describe(
        'RIS application code of the deciding body (e.g. Vfgh, Justiz, Upts) — use as the application argument of ris_get_document.',
      ),
    organ: z
      .string()
      .optional()
      .describe('Issuing body name (Organ), e.g. "Verfassungsgerichtshof".'),
    case_numbers: z
      .array(z.string().describe('One Geschäftszahl.'))
      .describe('Case numbers (Geschäftszahl) — a decision can carry several.'),
    decision_date: z.string().optional().describe('Decision date (Entscheidungsdatum).'),
    decision_type: z
      .string()
      .optional()
      .describe(
        "Document kind: 'Rechtssatz' (headnote) or 'Text' (full decision text). One decision may appear as several headnote documents plus one text document sharing a Geschäftszahl.",
      ),
    decision_kind: z
      .string()
      .optional()
      .describe('Decision kind (Entscheidungsart — Erkenntnis, Beschluss, …), where tagged.'),
    party: z
      .string()
      .optional()
      .describe('Political party the decision concerns (upts decisions only).'),
    summary: z.string().optional().describe('Short summary (Kurzinformation), where present.'),
    guiding_principle: z
      .string()
      .optional()
      .describe(
        'Guiding legal principle / headnote (Leitsatz) — the abstracted rule the decision establishes. Present chiefly on Rechtssatz (headnote) documents, mostly VfGH.',
      ),
    norms_cited: z
      .array(z.string().describe('One cited norm in RIS format, e.g. "DSG §1".'))
      .describe(
        'Norms the decision cites — copy an entry verbatim into the norm filter to find sibling case law.',
      ),
    keywords: z.string().optional().describe('Keywords (Schlagworte), where present.'),
    indexes: z
      .array(z.string().describe('One Systematik index entry, e.g. "10/10 Datenschutz".'))
      .describe(
        'Systematik classification entries (Indizes) — the same taxonomy ris_search_legislation filters on, so an entry copied here finds the consolidated law around the decision. Carried by vfgh, vwgh, lvwg, uvs, umse, and normenliste; empty for the rest.',
      ),
    state: z
      .string()
      .optional()
      .describe(
        'Bundesland whose administrative court decided (lvwg and uvs records) — the German name, e.g. "Tirol".',
      ),
    note: z
      .string()
      .optional()
      .describe(
        'Annotation (Anmerkung) — a renaming or lifecycle note on a normenliste law, an editorial note on a justiz or dsk decision.',
      ),
    norm_index: NormIndexSchema.optional(),
    collection_number: z
      .string()
      .optional()
      .describe('Official collection number (VfSlg/VwSlg/UVS Sammlungsnummer), where assigned.'),
    ecli: z.string().optional().describe('European Case Law Identifier, where assigned.'),
    decision_url: z
      .string()
      .optional()
      .describe('RIS web view of the complete decision (GesamteEntscheidungUrl).'),
    headnotes_url: z
      .string()
      .optional()
      .describe('RIS web view of the decision’s headnotes (RechtssaetzeUrl).'),
    legal_force_note: z
      .string()
      .optional()
      .describe('Challenge / legal-force note (Anfechtung), where present.'),
    content_urls: ContentUrlsSchema,
  })
  .describe(
    'One document from the selected court — a decision (headnote or full text), or, under court normenliste, one law of the VwGH norm index (see norm_index).',
  );

export type CaseLawRecord = z.infer<typeof CaseLawRecordSchema>;

/** Pick the four core rendition URLs off a normalized hit. */
function pickContentUrls(hit: RisHit): CaseLawRecord['content_urls'] {
  const { html, pdf, rtf, xml } = hit.contentUrls;
  return {
    ...(xml !== undefined && { xml }),
    ...(html !== undefined && { html }),
    ...(pdf !== undefined && { pdf }),
    ...(rtf !== undefined && { rtf }),
  };
}

/**
 * The law a Judikatur hit indexes, or `undefined` when the hit is a decision. Only the
 * Normenliste node carries these four; every other court leaves all of them absent.
 */
function pickNormIndex(md: RisJudikaturMetadata): CaseLawRecord['norm_index'] {
  const normIndex = {
    ...(md.title !== undefined && { title: md.title }),
    ...(md.abbreviation !== undefined && { abbreviation: md.abbreviation }),
    ...(md.normType !== undefined && { type: md.normType }),
    ...(md.reference !== undefined && { reference: md.reference }),
  };
  return Object.keys(normIndex).length > 0 ? normIndex : undefined;
}

/** Map a normalized RIS hit (Judikatur, or Sonstige for upts) to the tool's record shape. */
export function toRecord(hit: RisHit, fallbackApplication: string): CaseLawRecord {
  const base: CaseLawRecord = {
    case_numbers: [],
    content_urls: pickContentUrls(hit),
    court: hit.application ?? fallbackApplication,
    document_number: hit.documentNumber,
    indexes: [],
    norms_cited: [],
    ...(hit.organ !== undefined && { organ: hit.organ }),
  };
  const md = hit.metadata;
  if (md.controller === 'Judikatur') {
    const normIndex = pickNormIndex(md);
    return {
      ...base,
      case_numbers: [...md.caseNumbers],
      ...(md.collectionNumber !== undefined && { collection_number: md.collectionNumber }),
      ...(md.decisionDate !== undefined && { decision_date: md.decisionDate }),
      ...(md.decisionKind !== undefined && { decision_kind: md.decisionKind }),
      ...(md.decisionDocumentType !== undefined && { decision_type: md.decisionDocumentType }),
      ...(md.decisionUrl !== undefined && { decision_url: md.decisionUrl }),
      ...(md.ecli !== undefined && { ecli: md.ecli }),
      ...(md.headnotesUrl !== undefined && { headnotes_url: md.headnotesUrl }),
      indexes: [...md.indexes],
      ...(md.keywords !== undefined && { keywords: md.keywords }),
      ...(md.legalForceNote !== undefined && { legal_force_note: md.legalForceNote }),
      ...(md.note !== undefined && { note: md.note }),
      ...(normIndex !== undefined && { norm_index: normIndex }),
      norms_cited: [...md.normsCited],
      ...(md.state !== undefined && { state: md.state }),
      ...(md.summary !== undefined && { summary: md.summary }),
      ...(md.guidingPrinciple !== undefined && { guiding_principle: md.guidingPrinciple }),
    };
  }
  if (md.controller === 'Sonstige') {
    return {
      ...base,
      case_numbers: [...md.caseNumbers],
      ...(md.decisionDate !== undefined && { decision_date: md.decisionDate }),
      ...(md.keywords !== undefined && { keywords: md.keywords }),
      norms_cited: [...md.normsCited],
      ...(md.party !== undefined && { party: md.party }),
      ...(md.summary !== undefined && { summary: md.summary }),
    };
  }
  return base;
}

export const risSearchCaseLaw = tool('ris_search_case_law', {
  title: 'Search Austrian Case Law',
  description:
    'Search Austrian case law (Judikatur) in ONE court or tribunal per call — court is required: vfgh (Constitutional Court), vwgh (Supreme Administrative Court), justiz (ordinary courts incl. OGH, selected decisions), bvwg (federal administrative), lvwg (state administrative), dsk (data protection authority), normenliste (VwGH norm index), dok, pvak, gbk, verg, upts (party transparency), and the historical uvs, asylgh, ubas, umse, bks. Cross-court research is one call per court (calls are cheap); historical bodies are closed windows with successors — codes, windows, and Geschäftszahl examples: ris_list_reference topic courts. Filter by full-text query, cited norm ("DSG §1", "DSGVO Art32" — the highest-value filter), exact case_number (Geschäftszahl), decision date range, decision_type (headnote vs full text), decision_kind, or the court-conditional filters: issuing_body (dsk/dok/pvak/verg), court_name/legal_area/subject_area (justiz), state (lvwg/uvs), party (upts), commission/senate/discrimination_ground (gbk), subject_law (bks), collection_number (vfgh/vwgh/uvs). For a known Geschäftszahl or VfSlg/VwSlg cite, ris_lookup_citation resolves it directly.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    court: z
      .enum(COURT_CODES)
      .describe(
        'Which court/tribunal application to search — one per call. Codes, coverage windows, and successor mapping: ris_list_reference topic courts.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search over decisions (Suchworte). Boolean UND/ODER/NICHT or AND/OR/NOT, quoted phrases, trailing-only * wildcard.',
      ),
    norm: z
      .string()
      .optional()
      .describe(
        'Cited-provision filter (Norm) — "DSG §1", "DSGVO Art32", "GewO 1994 §129", matching the format returned in norms_cited. The highest-value case-law filter.',
      ),
    case_number: z
      .string()
      .optional()
      .describe(
        'Exact Geschäftszahl — returns that decision’s documents. Formats differ per court (examples: ris_list_reference topic courts). Not available for normenliste.',
      ),
    decision_type: z
      .enum(['headnote', 'full_text', 'all'])
      .default('all')
      .describe(
        'Search headnotes (Rechtssätze), full decision texts (Entscheidungstexte), or both (all, the default). Not available for gbk, upts, or normenliste.',
      ),
    decided_from: isoDateString
      .optional()
      .describe('Earliest decision date (YYYY-MM-DD). Not available for normenliste.'),
    decided_to: isoDateString.optional().describe('Latest decision date (YYYY-MM-DD).'),
    decision_kind: z
      .string()
      .optional()
      .describe(
        'Decision kind (Entscheidungsart) — per-court value sets, validated locally: ris_list_reference topic decision_kinds. No such parameter exists for normenliste, dok, pvak, umse, bks, or upts. For justiz the four documented values are not yet populated in the corpus (every value returns 0 hits, verified 2026-07-05) — filter justiz with query or norm instead.',
      ),
    collection_number: z
      .string()
      .optional()
      .describe(
        'Official collection number (Sammlungsnummer). vfgh, vwgh, and uvs only, and the accepted form differs: vfgh and uvs store the bare number and match it dotted or undotted ("19632", "19.632"), while vwgh stores the full labelled undotted cite — pass "VwSlg 18000 A/2010", or the space-anchored prefix "VwSlg 18000 *" when the part letter or year is unknown. A bare or dotted number matches nothing under vwgh.',
      ),
    issuing_body: z
      .string()
      .optional()
      .describe(
        'Deciding body (EntscheidendeBehoerde) — dsk, dok, pvak, and verg only. dsk: Datenschutzbehoerde (2014+) or Datenschutzkommission (up to 2013). Full value lists: ris_list_reference topic issuing_bodies.',
      ),
    court_name: z
      .string()
      .optional()
      .describe('Filter within the ordinary courts (justiz only) — "OGH", "OLG Wien", "LG Linz".'),
    legal_area: z
      .enum(['civil', 'criminal'])
      .optional()
      .describe(
        'Legal area (Rechtsgebiet, justiz only): civil (Zivilrecht) or criminal (Strafrecht).',
      ),
    subject_area: z
      .string()
      .optional()
      .describe(
        'Subject-area taxonomy filter (Fachgebiet, justiz only) — 39 exact German values like "Datenschutzrecht", validated locally: ris_list_reference topic justiz_subject_areas. The corpus carries no tagged documents yet (every value returns 0 hits, verified 2026-07-05) — filter with query or norm instead until RIS populates the tags.',
      ),
    state: z
      .enum(STATE_CODES)
      .optional()
      .describe(
        'Which of the nine state administrative courts/senates to search (lvwg and uvs only).',
      ),
    party: z
      .string()
      .optional()
      .describe(
        'Political party the decision concerns (upts only). Documented values: ÖVP, SPÖ, FPÖ, KPÖ, BZÖ, Team Stronach — the filter is full-text, and further party names appear in live data (e.g. "Wandel").',
      ),
    commission: z
      .enum(['federal', 'general'])
      .optional()
      .describe(
        'Equal-treatment commission (gbk only): federal (Bundes-Gleichbehandlungskommission) or general (Gleichbehandlungskommission).',
      ),
    senate: z.enum(['I', 'II', 'III']).optional().describe('Commission senate (gbk only).'),
    discrimination_ground: z
      .enum([
        'Alter',
        'EthnischeZugehoerigkeit',
        'Geschlecht',
        'Mehrfachdiskriminierung',
        'Religion',
        'SexuelleOrientierung',
        'Weltanschauung',
      ])
      .optional()
      .describe(
        'Discrimination ground (gbk only): Alter (age), EthnischeZugehoerigkeit (ethnic origin), Geschlecht (gender/sex), Mehrfachdiskriminierung (multiple grounds), Religion (religion), SexuelleOrientierung (sexual orientation), Weltanschauung (worldview/belief). Upstream German enum values, sent verbatim.',
      ),
    subject_law: z
      .string()
      .optional()
      .describe(
        'Media statute the case concerns (Bereich, bks only) — e.g. "ORF-Gesetz", "Privatradiogesetz".',
      ),
    changed_since: z
      .enum(CHANGED_SINCE_CODES)
      .optional()
      .describe(
        'Coarse recency filter — decisions changed in RIS within the interval. For exact windows use ris_track_changes.',
      ),
    sort_by: z
      .enum(['decision_date', 'case_number'])
      .optional()
      .describe(
        'Sort column. Default: upstream order. Not available for court: normenliste, which indexes laws rather than decisions.',
      ),
    sort_direction: z
      .enum(['ascending', 'descending'])
      .optional()
      .describe('Sort direction; applies with sort_by.'),
    page: z.number().int().min(1).optional().describe('1-based result page. Default 1.'),
    page_size: z
      .union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)])
      .optional()
      .describe('Documents per page — RIS accepts 10, 20, 50, or 100. Default 20.'),
  }),
  output: z.object({
    results: z
      .array(CaseLawRecordSchema)
      .describe(
        'Matching documents for the requested page — decisions, or indexed laws under court normenliste. Totals and paging in enrichment.',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Total matching documents across all pages.'),
    page: z.number().describe('1-based page number RIS served.'),
    pageSize: z.number().describe('Page size RIS applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true when more pages exist beyond this one — raise page to continue.'),
    notice: z
      .string()
      .optional()
      .describe('Zero-hit guidance — names the likely cause and the concrete next call.'),
  },
  errors: [
    {
      reason: 'court_filter_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A court-conditional filter was sent with the wrong court, or case_number/dates/decision_type were sent with normenliste (a norm index, not decisions) — rejected locally before any upstream call; the message names the offending pair.',
      recovery:
        'Drop the filter or switch court: issuing_body → dsk/dok/pvak/verg, court_name/legal_area/subject_area → justiz, state → lvwg/uvs, party → upts, commission/senate/discrimination_ground → gbk, subject_law → bks, collection_number → vfgh/vwgh/uvs. Court codes: ris_list_reference topic courts.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A page past the last page of results, or a parameter value that failed validation — decision_kind/subject_area checked locally against the reference tables, sort_by rejected locally because court normenliste indexes laws rather than decisions, or RIS rejected the value in-band (message passed through verbatim, in German, and it does not name the page).',
      recovery:
        'For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message, or drop it if the court does not support it. Valid court codes, decision types/kinds, and syntax: ris_list_reference (topic: courts, decision_types, decision_kinds, or search_syntax).',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'RIS is unreachable, returned a server error, or served an HTML error page.',
      retryable: true,
      recovery:
        'RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size or narrow the query.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'RIS did not answer the search within the request deadline.',
      retryable: true,
      recovery:
        'RIS did not answer in time — retry the same search shortly, or make it cheaper upstream: drop leading wildcards, reduce page_size, or narrow the date range.',
    },
  ],

  async handler(input, ctx) {
    const { court } = input;
    const query = meaningful(input.query);
    const norm = meaningful(input.norm);
    const caseNumber = meaningful(input.case_number);
    const decidedFrom = meaningful(input.decided_from);
    const decidedTo = meaningful(input.decided_to);
    const decisionKind = meaningful(input.decision_kind);
    const collectionNumber = meaningful(input.collection_number);
    const courtName = meaningful(input.court_name);
    const subjectArea = meaningful(input.subject_area);
    const party = meaningful(input.party);
    const subjectLaw = meaningful(input.subject_law);
    let issuingBody = meaningful(input.issuing_body);

    const mismatch = (message: string) =>
      ctx.fail('court_filter_mismatch', message, { ...ctx.recoveryFor('court_filter_mismatch') });

    if (court === 'normenliste') {
      const rejected: readonly [name: string, value: unknown][] = [
        ['case_number', caseNumber],
        ['decided_from', decidedFrom],
        ['decided_to', decidedTo],
      ];
      const offending = rejected.find(([, value]) => value !== undefined);
      if (offending) {
        throw mismatch(
          `${offending[0]} cannot be used with court 'normenliste' — a norm index, not decisions.`,
        );
      }
    }
    if (
      input.decision_type !== 'all' &&
      (court === 'gbk' || court === 'upts' || court === 'normenliste')
    ) {
      throw mismatch(
        `decision_type '${input.decision_type}' cannot be used with court '${court}' — gbk, upts, and normenliste have no Rechtssatz/Entscheidungstext split.`,
      );
    }
    if (decisionKind !== undefined) {
      if (NO_DECISION_KIND.has(court)) {
        throw mismatch(
          `decision_kind does not apply to court '${court}' — its RIS search schema has no Entscheidungsart parameter (none exists for ${COURTS_WITHOUT_DECISION_KIND.join(', ')}).`,
        );
      }
      const kinds = RIS_DECISION_KINDS.find((entry) => entry.court === court);
      if (kinds && !kinds.values.some((value) => value === decisionKind)) {
        throw ctx.fail(
          'invalid_query',
          `decision_kind '${decisionKind}' is not a valid Entscheidungsart for court '${court}'. Valid values: ${kinds.values.join(' | ')}.`,
          { ...ctx.recoveryFor('invalid_query') },
        );
      }
    }

    const conditionals: readonly [
      name: string,
      value: unknown,
      allowed: readonly RisCourtCode[],
    ][] = [
      ['collection_number', collectionNumber, ['vfgh', 'vwgh', 'uvs']],
      ['issuing_body', issuingBody, ['dsk', 'dok', 'pvak', 'verg']],
      ['court_name', courtName, ['justiz']],
      ['legal_area', input.legal_area, ['justiz']],
      ['subject_area', subjectArea, ['justiz']],
      ['state', input.state, ['lvwg', 'uvs']],
      ['party', party, ['upts']],
      ['commission', input.commission, ['gbk']],
      ['senate', input.senate, ['gbk']],
      ['discrimination_ground', input.discrimination_ground, ['gbk']],
      ['subject_law', subjectLaw, ['bks']],
    ];
    for (const [name, value, allowed] of conditionals) {
      if (value !== undefined && !allowed.some((code) => code === court)) {
        throw mismatch(
          `${name} applies only to ${allowed.length > 1 ? 'courts' : 'court'} ${allowed.join('/')}, got '${court}'.`,
        );
      }
    }

    if (
      subjectArea !== undefined &&
      !RIS_JUSTIZ_SUBJECT_AREAS.some((area) => area.value === subjectArea)
    ) {
      throw ctx.fail(
        'invalid_query',
        `subject_area '${subjectArea}' is not in the Justiz Fachgebiet taxonomy — the 39 exact German values are listed by ris_list_reference topic justiz_subject_areas.`,
        { ...ctx.recoveryFor('invalid_query') },
      );
    }
    if (issuingBody !== undefined && (court === 'dsk' || court === 'pvak')) {
      const needle = issuingBody.toLowerCase();
      const match = RIS_ISSUING_BODIES.find(
        (body) =>
          body.application === (court === 'dsk' ? 'Dsk' : 'Pvak') &&
          body.value.toLowerCase() === needle,
      );
      if (match) issuingBody = match.value;
    }

    const params: CaseLawSearchParams = {
      court,
      ...(query !== undefined && { query }),
      ...(norm !== undefined && { norm }),
      ...(caseNumber !== undefined && { caseNumber }),
      decisionType: input.decision_type,
      ...(decidedFrom !== undefined && { decidedFrom }),
      ...(decidedTo !== undefined && { decidedTo }),
      ...(decisionKind !== undefined && { decisionKind }),
      ...(collectionNumber !== undefined && { collectionNumber }),
      ...(issuingBody !== undefined && { issuingBody }),
      ...(courtName !== undefined && { courtName }),
      ...(input.legal_area !== undefined && { legalArea: input.legal_area }),
      ...(subjectArea !== undefined && { subjectArea }),
      ...(input.state !== undefined && { state: input.state }),
      ...(party !== undefined && { party }),
      ...(input.commission !== undefined && { commission: input.commission }),
      ...(input.senate !== undefined && { senate: input.senate }),
      ...(input.discrimination_ground !== undefined && {
        discriminationGround: input.discrimination_ground,
      }),
      ...(subjectLaw !== undefined && { subjectLaw }),
      ...(input.changed_since !== undefined && { changedSince: input.changed_since }),
      ...(input.sort_by !== undefined && { sortBy: input.sort_by }),
      ...(input.sort_direction !== undefined && { sortDirection: input.sort_direction }),
      ...(input.page !== undefined && { page: input.page }),
      ...(input.page_size !== undefined && { pageSize: input.page_size }),
    };

    const courtEntry = RIS_COURTS.find((entry) => entry.code === court);
    // Restate a builder rejection in this tool's vocabulary, then map it and every service
    // failure onto the declared contract so reason + recovery reach the wire (neither
    // carries them on its own).
    const result = await getRisService()
      .searchCaseLaw(params, ctx)
      .catch((err: unknown) => {
        throw failSearchError(
          rewriteUnsupportedParam(err, (rejected) => callerFacingRejection(rejected, court)),
          ctx,
        );
      });
    ctx.log.info('Case-law search completed', {
      court,
      hits: result.hits.length,
      total: result.total,
    });

    ctx.enrich.total(result.total);
    ctx.enrich({ page: result.page, pageSize: result.pageSize });
    if (result.total > (result.page - 1) * result.pageSize + result.hits.length) {
      ctx.enrich({ truncated: true });
    }

    if (result.total === 0) {
      const fragments = [
        `0 decisions in ${court}. Other courts are separate calls — repeat per court.`,
      ];
      if (caseNumber !== undefined) {
        fragments.push(
          "Geschäftszahl formats differ per court ('Ro 2026/03/0016' = VwGH, 'G 287/2022' = VfGH, '14Os49/26a' = OGH/justiz) — ris_lookup_citation auto-detects the court from the format; examples per court: ris_list_reference topic courts.",
        );
      }
      if (norm !== undefined) {
        fragments.push(
          "norm must match RIS's cited-norm format ('DSG §1', 'DSGVO Art32' style as returned in norms_cited) — run a broader search first and copy the exact string from a result's norms_cited.",
        );
      }
      const startYear = coverageStartYear(courtEntry?.window ?? null);
      const decidedToYear =
        decidedTo !== undefined ? Number.parseInt(decidedTo.slice(0, 4), 10) : Number.NaN;
      if (startYear !== undefined && !Number.isNaN(decidedToYear) && decidedToYear < startYear) {
        fragments.push(
          `${court} coverage starts ${startYear} — earlier decisions are not in RIS. Windows: ris_list_reference topic courts.`,
        );
      }
      if (courtEntry !== undefined && courtEntry.status === 'historical') {
        fragments.push(
          courtEntry.successor === null
            ? `${court} is historical (${courtEntry.window ?? 'closed window'}) — it ceased deciding and has no direct successor in RIS.`
            : `${court} is historical (${courtEntry.window ?? 'closed window'}) — its successor is ${courtEntry.successor}. Search the successor for current decisions.`,
        );
      }
      if (court === 'dsk' && issuingBody === 'Datenschutzkommission') {
        fragments.push(
          "The Datenschutzkommission arm of dsk is historical (decisions up to 2013) — its successor is the Datenschutzbehoerde. Search issuing_body 'Datenschutzbehoerde' for current decisions.",
        );
      }
      if (subjectArea !== undefined || (court === 'justiz' && decisionKind !== undefined)) {
        fragments.push(
          'Justiz subject_area and decision_kind tags are not yet populated in the RIS corpus (every value returns 0 hits) — drop the filter and use query or norm instead.',
        );
      }
      ctx.enrich.notice(fragments.join(' '));
    }

    return { results: result.hits.map((hit) => toRecord(hit, courtEntry?.application ?? court)) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals, paging, and notices ride the enrichment trailer.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No decisions on this page._' }];
    }
    const blocks = result.results.map((r) => {
      const lines = [
        `## ${r.case_numbers.length > 0 ? r.case_numbers.join(', ') : r.document_number}`,
      ];
      lines.push(`**Document:** ${r.document_number} (${r.court})`);
      const facts: string[] = [];
      if (r.organ !== undefined) facts.push(`**Organ:** ${r.organ}`);
      if (r.state !== undefined) facts.push(`**State:** ${r.state}`);
      if (r.decision_date !== undefined) facts.push(`**Decided:** ${r.decision_date}`);
      if (r.decision_type !== undefined) facts.push(`**Type:** ${r.decision_type}`);
      if (r.decision_kind !== undefined) facts.push(`**Kind:** ${r.decision_kind}`);
      if (facts.length > 0) lines.push(facts.join(' | '));
      if (r.norm_index !== undefined) {
        const norm: string[] = [];
        if (r.norm_index.abbreviation !== undefined) {
          norm.push(`**Norm:** ${r.norm_index.abbreviation}`);
        }
        if (r.norm_index.type !== undefined) norm.push(`**Norm type:** ${r.norm_index.type}`);
        if (r.norm_index.reference !== undefined) {
          norm.push(`**Promulgated:** ${r.norm_index.reference}`);
        }
        if (norm.length > 0) lines.push(norm.join(' | '));
        if (r.norm_index.title !== undefined) lines.push(`**Law:** ${r.norm_index.title}`);
      }
      const identifiers: string[] = [];
      if (r.collection_number !== undefined) {
        identifiers.push(`**Collection:** ${r.collection_number}`);
      }
      if (r.ecli !== undefined) identifiers.push(`**ECLI:** ${r.ecli}`);
      if (r.party !== undefined) identifiers.push(`**Party:** ${r.party}`);
      if (identifiers.length > 0) lines.push(identifiers.join(' | '));
      if (r.summary !== undefined) lines.push(r.summary);
      if (r.guiding_principle !== undefined) {
        lines.push(`**Guiding principle:** ${r.guiding_principle}`);
      }
      if (r.norms_cited.length > 0) lines.push(`**Norms:** ${r.norms_cited.join('; ')}`);
      if (r.indexes.length > 0) lines.push(`**Index:** ${r.indexes.join('; ')}`);
      if (r.keywords !== undefined) lines.push(`**Keywords:** ${r.keywords}`);
      if (r.note !== undefined) lines.push(`**Note:** ${r.note}`);
      if (r.legal_force_note !== undefined) {
        lines.push(`**Legal force:** ${r.legal_force_note}`);
      }
      const links: string[] = [];
      if (r.decision_url !== undefined) links.push(`[Full decision](${r.decision_url})`);
      if (r.headnotes_url !== undefined) links.push(`[Headnotes](${r.headnotes_url})`);
      for (const key of ['html', 'pdf', 'rtf', 'xml'] as const) {
        const url = r.content_urls[key];
        if (url !== undefined) links.push(`[${key.toUpperCase()}](${url})`);
      }
      if (links.length > 0) lines.push(`**Links:** ${links.join(' · ')}`);
      return lines.join('\n');
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
