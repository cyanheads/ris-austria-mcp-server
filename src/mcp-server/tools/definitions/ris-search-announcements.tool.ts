/**
 * @fileoverview ris_search_announcements — search the sectoral official gazettes and executive
 * documents on the Sonstige controller (minus Upts, which is case law): social-insurance and
 * veterinary notices, court rules of procedure, trade-exam regulations, health-structure plans,
 * ministerial decrees, and council-of-ministers minutes. Seven collections behind one enum;
 * each collection accepts a different parameter set, guarded locally against the reference matrix
 * before any upstream call. Five of the seven are legally binding authentic publications.
 * @module mcp-server/tools/definitions/ris-search-announcements
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';

import {
  RIS_CHANGED_SINCE_INTERVALS,
  RIS_COLLECTIONS,
  RIS_STATES,
} from '@/services/ris/reference/index.js';
import type {
  AnnouncementsSearchParams,
  ChangedSinceCode,
  RisCollectionCode,
  RisStateCode,
} from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisHit } from '@/services/ris/types.js';

import {
  failMinistrySearchError,
  filterText,
  foldStateNames,
  isoDateString,
  joinNotices,
  pageSizeParam,
  renditionLinks,
  reversedWindowNotice,
  rewriteUnsupportedParam,
  servePageSize,
  type UnsupportedParam,
} from './_shared.js';

const COLLECTION_CODES = RIS_COLLECTIONS.map((c) => c.code) as [
  RisCollectionCode,
  ...RisCollectionCode[],
];
const STATE_CODES = RIS_STATES.map((s) => s.code) as [RisStateCode, ...RisStateCode[]];
const CHANGED_SINCE_CODES = RIS_CHANGED_SINCE_INTERVALS.map((i) => i.code) as [
  ChangedSinceCode,
  ...ChangedSinceCode[],
];

/** Binding label per collection (canonical seven-label list, Design Decisions). */
const ANNOUNCEMENT_BINDING: Record<
  RisCollectionCode,
  'administrative_directive' | 'authentic' | 'preparatory'
> = {
  council_minutes: 'preparatory',
  court_rules: 'authentic',
  health_structure_plans: 'authentic',
  ministerial_decrees: 'administrative_directive',
  social_insurance: 'authentic',
  trade_exam_rules: 'authentic',
  veterinary: 'authentic',
};

/**
 * A request-builder rejection restated with the `collection` value the caller sent and the
 * input field it belongs to. Every other filter is already refused against the collection's
 * parameter set below, so sort_by is the one that gets this far; anything else returns
 * `undefined` and keeps the builder's own message rather than inventing a cause.
 */
function callerFacingRejection(
  rejected: UnsupportedParam,
  collection: RisCollectionCode,
): string | undefined {
  if (rejected.param !== 'sortBy' || rejected.value === undefined) return;
  return `sort_by: '${rejected.value}' is not available for collection '${collection}'.${
    rejected.alternatives.length > 0
      ? ` Use sort_by: ${rejected.alternatives.map((value) => `'${value}'`).join(' or ')}, or drop sort_by.`
      : ' Drop sort_by — this collection carries no sortable column.'
  }`;
}

const ContentUrlsSchema = z
  .object({
    xml: z.string().optional().describe('XML rendition URL (RIS Nutzdaten schema).'),
    html: z.string().optional().describe('HTML rendition URL.'),
    pdf: z
      .string()
      .optional()
      .describe('PDF rendition URL (the only rendition for council minutes).'),
    rtf: z.string().optional().describe('RTF rendition URL.'),
  })
  .describe(
    'Rendition URLs of the main document. Court rules publish the authentic PDF only; council minutes are plain PDF only (see authentic_pdf_url).',
  );

const AnnouncementRecordSchema = z
  .object({
    document_number: z
      .string()
      .describe(
        'Technical RIS document number (e.g. AVSV_2026_0040, AVN_…, KMGER_…, PRUEF_…, SPG_…, ERL_BMJ_…, MRP_20260701_59) — pass together with the collection’s application to ris_get_document.',
      ),
    collection: z
      .string()
      .describe('The collection the record belongs to (the requested collection value).'),
    title: z.string().optional().describe('Full document title, HTML markup stripped.'),
    summary: z.string().optional().describe('Short summary (Kurzinformation), where present.'),
    number: z
      .string()
      .optional()
      .describe(
        'Serial number within the collection (Avsvnummer / Avnnummer / Spgnummer), where assigned.',
      ),
    published: z
      .string()
      .optional()
      .describe('Promulgation / publication date (Kundmachungsdatum).'),
    session_date: z
      .string()
      .optional()
      .describe('Council session date (Sitzungsdatum) — council_minutes only.'),
    session_number: z
      .string()
      .optional()
      .describe(
        'Council session number (Sitzungsnummer, e.g. "65", "58b") — council_minutes only; the session_number filter takes this value.',
      ),
    legislature: z
      .string()
      .optional()
      .describe(
        'Legislative period (Gesetzgebungsperiode, e.g. "XXVIII") — council_minutes only; the legislature filter takes this value.',
      ),
    approved: z
      .string()
      .optional()
      .describe(
        'Approval date (Genehmigungsdatum) — ministerial_decrees only, which carry no publication date.',
      ),
    case_numbers: z
      .array(z.string().describe('One business reference number, trimmed.'))
      .optional()
      .describe(
        'Business reference numbers (Geschäftszahl / GZ) — present on ministerial_decrees, veterinary, court_rules, and trade_exam_rules (empty when the entry carries none), absent on other collections. The case_number filter takes one on veterinary and ministerial_decrees.',
      ),
    type: z
      .string()
      .optional()
      .describe(
        'Document type (Typ — e.g. Erlass, Rundschreiben, Kundmachung, Geschaeftsverteilung, Meisterpruefungsordnung, RsgVerordnung).',
      ),
    department: z
      .string()
      .optional()
      .describe(
        'Ministry department (Abteilung) — ministerial_decrees only; the department filter takes this value.',
      ),
    court_name: z
      .string()
      .optional()
      .describe('Court whose rules these are (Gericht, e.g. "LVwG Tirol") — court_rules only.'),
    plan_state: z
      .string()
      .optional()
      .describe(
        'Plan region as RIS writes it (Land — Oesterreich for the federal ÖSG, else the Bundesland, e.g. Salzburg) — health_structure_plans only.',
      ),
    in_force_from: z
      .string()
      .optional()
      .describe('Entry-into-force date (Inkrafttretensdatum), where recorded.'),
    in_force_until: z
      .string()
      .optional()
      .describe('Repeal date (Ausserkrafttretensdatum), where recorded.'),
    promulgation: z
      .string()
      .optional()
      .describe(
        'Gazette citation of a decree (Fundstelle, e.g. "eJABl Nr. 13/2026") — ministerial_decrees only.',
      ),
    keywords: z
      .string()
      .optional()
      .describe('Subject keywords (Schlagworte), comma-separated as RIS writes them.'),
    note: z
      .string()
      .optional()
      .describe('Annotation (Anmerkung) — e.g. the earlier notice this one replaces.'),
    issuers: z
      .array(z.string().describe('One issuing body.'))
      .describe(
        'Issuing bodies (Urheber / Bundesministerium / Einbringer) — a council minute can carry several. Empty when none.',
      ),
    norms_cited: z
      .array(z.string().describe('One cited norm in RIS format, e.g. "DSG §1".'))
      .describe(
        'Norms the document cites (veterinary notices and decrees), one entry per RIS item and never split — a decree entry often names several norms ("TP1 GGG, TP2 GGG"). Copy an entry verbatim into the norm filter to find the document and its siblings. Empty when none.',
      ),
    binding: z
      .enum(['authentic', 'administrative_directive', 'preparatory'])
      .describe(
        'Legal binding status: authentic (amtssigniert, legally binding — social insurance, veterinary, court rules, trade-exam rules, health-structure plans), administrative_directive (binds the administration, not citizens — ministerial decrees), or preparatory (council minutes).',
      ),
    authentic_pdf_url: z
      .string()
      .optional()
      .describe(
        'The amtssigniert authentic PDF (.pdfsig, Authentisch DataType) — the legally binding artifact — where the collection publishes one.',
      ),
    document_url: z
      .string()
      .optional()
      .describe(
        'RIS web view of the document (DokumentUrl) — for humans. The only browsable surface for council minutes (PDF-only) and ministerial decrees.',
      ),
    content_urls: ContentUrlsSchema,
  })
  .describe('One sectoral announcement or executive document.');

type AnnouncementRecord = z.infer<typeof AnnouncementRecordSchema>;

/** Pick the four core rendition URLs off a normalized hit. */
function pickContentUrls(hit: RisHit): AnnouncementRecord['content_urls'] {
  const { html, pdf, rtf, xml } = hit.contentUrls;
  return {
    ...(xml !== undefined && { xml }),
    ...(html !== undefined && { html }),
    ...(pdf !== undefined && { pdf }),
    ...(rtf !== undefined && { rtf }),
  };
}

/** Collections whose RIS application carries a case number (Geschaeftszahl / GZ). */
const CASE_NUMBER_COLLECTIONS: ReadonlySet<RisCollectionCode> = new Set([
  'court_rules',
  'ministerial_decrees',
  'trade_exam_rules',
  'veterinary',
]);

/** Map a normalized RIS hit (all seven collections ride the Sonstige controller) to the record shape. */
function toRecord(hit: RisHit, collection: RisCollectionCode): AnnouncementRecord {
  const base: AnnouncementRecord = {
    binding: ANNOUNCEMENT_BINDING[collection],
    collection,
    content_urls: pickContentUrls(hit),
    document_number: hit.documentNumber,
    issuers: [],
    norms_cited: [],
    ...(hit.contentUrls.authentic !== undefined && {
      authentic_pdf_url: hit.contentUrls.authentic,
    }),
    ...(hit.documentUrl !== undefined && { document_url: hit.documentUrl }),
  };
  const md = hit.metadata;
  if (md.controller === 'Sonstige') {
    return {
      ...base,
      ...(md.approvalDate !== undefined && { approved: md.approvalDate }),
      ...(CASE_NUMBER_COLLECTIONS.has(collection) && { case_numbers: [...md.caseNumbers] }),
      ...(md.courtName !== undefined && { court_name: md.courtName }),
      ...(md.department !== undefined && { department: md.department }),
      ...(md.inForceFrom !== undefined && { in_force_from: md.inForceFrom }),
      ...(md.inForceUntil !== undefined && { in_force_until: md.inForceUntil }),
      issuers: [...md.issuers],
      ...(md.keywords !== undefined && { keywords: md.keywords }),
      ...(md.legislature !== undefined && { legislature: md.legislature }),
      norms_cited: [...md.normsCited],
      ...(md.note !== undefined && { note: md.note }),
      ...(md.number !== undefined && { number: md.number }),
      ...(md.planState !== undefined && { plan_state: md.planState }),
      ...(md.promulgation !== undefined && { promulgation: md.promulgation }),
      ...(md.publishedDate !== undefined && { published: md.publishedDate }),
      ...(md.sessionDate !== undefined && { session_date: md.sessionDate }),
      ...(md.sessionNumber !== undefined && { session_number: md.sessionNumber }),
      ...(md.summary !== undefined && { summary: md.summary }),
      ...(md.title !== undefined && { title: md.title }),
      ...(md.normType !== undefined && { type: md.normType }),
    };
  }
  return base;
}

export const risSearchAnnouncements = tool('ris_search_announcements', {
  title: 'Search Official Announcements',
  description:
    'Search Austria’s sectoral official gazettes and executive documents — seven collections behind one collection enum: social_insurance (Amtliche Verlautbarungen der Sozialversicherung, authentic), veterinary (Amtliche Veterinärnachrichten, authentic), court_rules (Kundmachungen der Gerichte — rules of procedure and case-allocation plans, authentic; currently LVwG Tirol and Vorarlberg only), trade_exam_rules (Prüfungsordnungen gemäß Gewerbeordnung, authentic), health_structure_plans (Strukturpläne Gesundheit — federal ÖSG and per-state RSG, authentic), ministerial_decrees (Erlässe der Bundesministerien — decrees interpreting law; bind the administration, not citizens), and council_minutes (Ministerratsprotokolle — council-of-ministers session records). Each collection accepts a different filter set: query and title are broadly available; number, published_from/to, in_force_as_of, issuer (ministry and social-insurance carrier abbreviations expanded), norm ("decrees citing the DSG"), case_number, type, department, plan_type/plan_state (health plans), session_number/legislature (council minutes), and changed_since (all but social_insurance and veterinary) apply where the collection supports them — a filter outside its set is rejected locally. Every result carries a binding label, the authentic PDF where it exists, and the RIS web view (document_url) — the only browsable surface for the PDF-only council minutes and for ministerial decrees. Per-collection parameter matrix and issuers: ris_list_reference topic collections or issuing_bodies.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    collection: z
      .enum(COLLECTION_CODES)
      .describe(
        'Which collection to search — one per call. social_insurance | veterinary | court_rules | trade_exam_rules | health_structure_plans | ministerial_decrees | council_minutes. Per-collection filter matrix: ris_list_reference topic collections.',
      ),
    query: filterText
      .optional()
      .describe(
        'Full-text search (Suchworte). Boolean operators UND/ODER/NICHT or AND/OR/NOT, parentheses, quoted phrases; wildcard * is trailing-only. Valid for all collections. Omit to leave unfiltered; a blank value is rejected.',
      ),
    title: filterText
      .optional()
      .describe(
        'Title search (Titel) — phrase field. Valid for all collections except council_minutes. Omit to leave unfiltered; a blank value is rejected.',
      ),
    number: filterText
      .optional()
      .describe(
        'Serial number (Avsvnummer / Avnnummer / Spgnummer) — social_insurance, veterinary, health_structure_plans. Omit to leave unfiltered; a blank value is rejected.',
      ),
    published_from: isoDateString
      .optional()
      .describe(
        'Earliest publication/session date (YYYY-MM-DD). All collections except ministerial_decrees (decrees date by force — use in_force_as_of / entered_force_from/to).',
      ),
    published_to: isoDateString
      .optional()
      .describe('Latest publication/session date (YYYY-MM-DD).'),
    in_force_as_of: isoDateString
      .optional()
      .describe(
        'Version in force on this date (YYYY-MM-DD) — veterinary, court_rules, trade_exam_rules, health_structure_plans, ministerial_decrees (the consolidated-ish collections). RIS also returns documents with no recorded entry-into-force date, for any date; they carry no in_force_from.',
      ),
    entered_force_from: isoDateString
      .optional()
      .describe(
        'Provisions that entered force on/after this date (YYYY-MM-DD) — ministerial_decrees only. RIS also returns decrees with no recorded entry-into-force date, for any date; they carry no in_force_from.',
      ),
    entered_force_to: isoDateString
      .optional()
      .describe(
        'Provisions that entered force on/before this date (YYYY-MM-DD) — ministerial_decrees only. RIS also returns decrees with no recorded entry-into-force date, for any date; they carry no in_force_from.',
      ),
    issuer: filterText
      .optional()
      .describe(
        'Issuing body — social_insurance (Urheber: a carrier abbreviation such as ÖGK, DVSV, SVS, BVAEB, AUVA, or PVA is expanded to its full designation; a full designation or a "<ABBR> Gesamtvertrag" series is sent as written), ministerial_decrees (Bundesministerium) or council_minutes (Einbringer) — a ministry abbreviation such as "BMF" is expanded, a full designation is sent as written. Values: ris_list_reference topic issuing_bodies or ministries. Omit to leave unfiltered; a blank value is rejected.',
      ),
    norm: filterText
      .optional()
      .describe(
        'Cited-provision filter (Norm) — "DSG §1", "DSGVO Art32" style. veterinary and ministerial_decrees only ("decrees citing the DSG"). Omit to leave unfiltered; a blank value is rejected.',
      ),
    case_number: filterText
      .optional()
      .describe(
        'Business reference number (Geschäftszahl) — veterinary and ministerial_decrees only. Omit to leave unfiltered; a blank value is rejected.',
      ),
    type: filterText
      .optional()
      .describe(
        'Document type (Typ) — trade_exam_rules (Befaehigungspruefungsordnung | Meisterpruefungsordnung | HoehereBerufsqualifikation | Fachdiplom | HoeheresFachdiplom), court_rules (Geschaeftsordnung | Geschaeftsverteilung), veterinary (Kundmachungen | VeroeffentlichungenAufGrundVEVO | SonstigeVeroeffentlichungen). Only these values, in any letter case. Omit to leave unfiltered; a blank value is rejected.',
      ),
    department: filterText
      .optional()
      .describe(
        'Ministry department (Abteilung) — ministerial_decrees only. Omit to leave unfiltered; a blank value is rejected.',
      ),
    plan_type: z
      .enum(['all', 'expert_opinion', 'regulation'])
      .optional()
      .describe(
        'health_structure_plans only. Plan kind — all (default), expert_opinion (Gutachten), or regulation (Verordnungen). Searches the federal ÖSG unless plan_state is set.',
      ),
    plan_state: foldStateNames(z.enum(STATE_CODES).optional()).describe(
      'health_structure_plans only. Restrict to one Bundesland’s regional health-structure plan (RSG) — setting it switches the search from the federal ÖSG to that state’s RSG.',
    ),
    session_number: filterText
      .optional()
      .describe(
        'Council session number (Sitzungsnummer) — council_minutes only. Omit to leave unfiltered; a blank value is rejected.',
      ),
    legislature: filterText
      .optional()
      .describe(
        'Legislative period (Gesetzgebungsperiode, e.g. "XXVII") — council_minutes only. Omit to leave unfiltered; a blank value is rejected.',
      ),
    changed_since: z
      .enum(CHANGED_SINCE_CODES)
      .optional()
      .describe(
        'Coarse recency filter — documents changed in RIS within the interval. Every collection except social_insurance and veterinary, where RIS ignores it: use published_from there, or ris_track_changes for changes. For exact windows use ris_track_changes.',
      ),
    sort_by: z
      .enum(['published', 'number'])
      .optional()
      .describe(
        'Sort column: published or number, where the collection has the column. Default: upstream order.',
      ),
    sort_direction: z
      .enum(['ascending', 'descending'])
      .optional()
      .describe('Sort direction; applies with sort_by.'),
    page: z.number().int().min(1).optional().describe('1-based result page. Default 1.'),
    page_size: pageSizeParam,
  }),
  output: z.object({
    results: z
      .array(AnnouncementRecordSchema)
      .describe('Matching documents for the requested page. Totals and paging in enrichment.'),
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
      .describe(
        'The served page size when it differs from page_size; then, under an in-force filter, how many rows on this page have no in_force_from (RIS returns undated documents for any date); then zero-hit guidance — the likely cause and the concrete next call. A reversed window (published_from later than published_to, or entered_force_from later than entered_force_to) is answered without a RIS request: 0 documents, and the swapped bounds to retry with in place of the guidance.',
      ),
  },
  errors: [
    {
      reason: 'collection_filter_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parameter was combined with a collection that does not accept it — rejected locally before any upstream call; the message names the offending parameter and lists the collection’s valid parameters. Includes changed_since on social_insurance or veterinary, where RIS ignores the recency filter and would return the whole collection; that rejection’s recovery names the replacement calls.',
      recovery:
        'Drop the named parameter or switch collection — each collection accepts a different parameter set. Valid parameters per collection: ris_list_reference topic collections.',
    },
    {
      reason: 'unresolved_ministry',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A ministerial_decrees or council_minutes issuer did not resolve — an abbreviation-shaped value matching no row of the RIS ministries table (the message names the closest matches), a ministry the table lists only for another issuer parameter (the message names the parameters that accept it), or an abbreviation carrying several designations this collection cannot tell apart (the message lists them). Rejected locally before any upstream call; a value the table does not know that contains a space is sent to RIS as written instead.',
      recovery:
        'Pass a ministry abbreviation or full designation from ris_list_reference topic ministries whose "Accepted by" includes this collection’s parameter (erlaesse_bundesministerium for ministerial_decrees, mrp_einbringer for council_minutes), or one of the candidate designations the message lists, verbatim.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A page past the last page of results; or a parameter value rejected locally — a type outside the collection’s values, a plan_state outside regional health-structure plans, or a sort_by value this collection has no column for, in which case the message names the values it does sort by; or RIS rejecting a value in-band (the Client error message is passed through verbatim, in German, and it does not name the page).',
      recovery:
        'For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message, or drop it if this collection does not carry it. Collections and their issuers: ris_list_reference topic collections or issuing_bodies.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'RIS is unreachable, returned a server error, or served an HTML error page.',
      retryable: true,
      recovery:
        'RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size to 10 or narrow the query.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'RIS did not answer the search within the request deadline.',
      retryable: true,
      recovery:
        'RIS did not answer in time — retry the same search shortly, or make it cheaper upstream: drop leading wildcards, reduce page_size to 10, or narrow the date range.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const {
      case_number: caseNumber,
      collection,
      department,
      entered_force_from: enteredForceFrom,
      entered_force_to: enteredForceTo,
      in_force_as_of: inForceAsOf,
      issuer,
      legislature,
      norm,
      number,
      published_from: publishedFrom,
      published_to: publishedTo,
      query,
      session_number: sessionNumber,
      title,
      type,
    } = input;

    const collectionEntry = RIS_COLLECTIONS.find((entry) => entry.code === collection);
    const validParams = collectionEntry?.params ?? [];
    const valid = new Set<string>(validParams);
    const conditional: readonly [name: string, value: unknown][] = [
      ['title', title],
      ['number', number],
      ['published_from', publishedFrom],
      ['published_to', publishedTo],
      ['in_force_as_of', inForceAsOf],
      ['entered_force_from', enteredForceFrom],
      ['entered_force_to', enteredForceTo],
      ['issuer', issuer],
      ['norm', norm],
      ['case_number', caseNumber],
      ['type', type],
      ['department', department],
      ['plan_type', input.plan_type],
      ['plan_state', input.plan_state],
      ['session_number', sessionNumber],
      ['legislature', legislature],
      ['changed_since', input.changed_since],
    ];
    const offending = conditional.find(([name, value]) => value !== undefined && !valid.has(name));
    if (offending) {
      const [name] = offending;
      const recency = name === 'changed_since';
      throw ctx.fail(
        'collection_filter_mismatch',
        `${name} is not a valid filter for collection '${collection}'${recency ? ' (RIS ignores it there and would return the whole collection)' : ''} — it accepts: ${validParams.join(', ')}.`,
        recency
          ? {
              recovery: {
                hint: `Drop changed_since. For recently published documents, set published_from (YYYY-MM-DD) on collection '${collection}'; for recently changed ones, call ris_track_changes with application: "${collectionEntry?.application}" and changed_from (YYYY-MM-DD).`,
              },
            }
          : undefined,
      );
    }
    const served = servePageSize(input.page_size);

    // A reversed window holds no dates — answer it here, since RIS's empty page for it reads as
    // a real zero-hit (and Erlaesse answers a reversed entered-force window with every undated
    // decree).
    const reversed = reversedWindowNotice([
      ['published_from', publishedFrom, 'published_to', publishedTo],
      ['entered_force_from', enteredForceFrom, 'entered_force_to', enteredForceTo],
    ]);
    if (reversed !== undefined) {
      ctx.enrich.total(0);
      ctx.enrich({ page: input.page ?? 1, pageSize: served.pageSize ?? 20 });
      ctx.enrich.notice(joinNotices(served.notice, reversed));
      return { results: [] };
    }

    const params: AnnouncementsSearchParams = {
      collection,
      ...(query !== undefined && { query }),
      ...(title !== undefined && { title }),
      ...(number !== undefined && { number }),
      ...(publishedFrom !== undefined && { publishedFrom }),
      ...(publishedTo !== undefined && { publishedTo }),
      ...(inForceAsOf !== undefined && { inForceAsOf }),
      ...(enteredForceFrom !== undefined && { enteredForceFrom }),
      ...(enteredForceTo !== undefined && { enteredForceTo }),
      ...(issuer !== undefined && { issuer }),
      ...(norm !== undefined && { norm }),
      ...(caseNumber !== undefined && { caseNumber }),
      ...(type !== undefined && { type }),
      ...(department !== undefined && { department }),
      ...(input.plan_type !== undefined && { planKind: input.plan_type }),
      ...(input.plan_state !== undefined && { planState: input.plan_state }),
      ...(sessionNumber !== undefined && { sessionNumber }),
      ...(legislature !== undefined && { legislature }),
      ...(input.changed_since !== undefined && { changedSince: input.changed_since }),
      ...(input.sort_by !== undefined && { sortBy: input.sort_by }),
      ...(input.sort_direction !== undefined && { sortDirection: input.sort_direction }),
      ...(input.page !== undefined && { page: input.page }),
      ...(served.pageSize !== undefined && { pageSize: served.pageSize }),
    };

    // Restate a builder rejection in this tool's vocabulary, then map it and every service
    // failure onto the declared contract so reason + recovery reach the wire (neither
    // carries them on its own).
    const result = await getRisService()
      .searchAnnouncements(params, ctx)
      .catch((err: unknown) => {
        throw failMinistrySearchError(
          rewriteUnsupportedParam(err, (rejected) => callerFacingRejection(rejected, collection)),
          ctx,
        );
      });
    ctx.log.info('Announcements search completed', {
      collection,
      hits: result.hits.length,
      total: result.total,
    });

    ctx.enrich.total(result.total);
    ctx.enrich({ page: result.page, pageSize: result.pageSize });
    if (result.total > (result.page - 1) * result.pageSize + result.hits.length) {
      ctx.enrich({ truncated: true });
    }

    let zeroHit: string | undefined;
    if (result.total === 0) {
      const fragments = [`0 documents in ${collection}.`];
      if (norm !== undefined) {
        fragments.push(
          "norm must match RIS's cited-norm format — copy from a result's norms_cited.",
        );
      }
      if (issuer !== undefined) {
        fragments.push(
          'issuer must match the RIS designation — ministry and social-insurance carrier abbreviations are expanded, any other value is matched exactly as written; issuers: ris_list_reference topic issuing_bodies or ministries.',
        );
      }
      if (collection === 'court_rules') {
        fragments.push('KmGer currently carries LVwG Tirol and Vorarlberg rules only.');
      }
      zeroHit = fragments.join(' ');
    }
    const results = result.hits.map((hit) => toRecord(hit, collection));
    // RIS keeps every document with no recorded Inkrafttretensdatum under FassungVom and under
    // either Inkrafttretensdatum bound, whatever the date (#96). Dropping those rows here would
    // break page and totalCount, so the page is served as RIS sent it and the share disclosed.
    const undatedRows = results.filter((r) => r.in_force_from === undefined).length;
    const undated =
      undatedRows > 0 &&
      [inForceAsOf, enteredForceFrom, enteredForceTo].some((date) => date !== undefined)
        ? `${undatedRows} of ${results.length} on this page ${undatedRows === 1 ? 'has' : 'have'} no in_force_from — RIS returns all documents with no recorded entry-into-force date under in_force_as_of, entered_force_from, or entered_force_to, whatever the date, so totalCount counts them too.`
        : undefined;
    const notice = joinNotices(served.notice, undated, zeroHit);
    if (notice !== undefined) ctx.enrich.notice(notice);

    return { results };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals and paging ride the enrichment trailer. RIS strings go through
  // escapeMarkdownInline and URLs through markdownLink, so a CommonMark parse reads back the
  // structuredContent value; the heading holds the line-free document number, since a title
  // can span lines and a heading ends at its first.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No documents on this page._' }];
    }
    const esc = escapeMarkdownInline;
    const blocks = result.results.map((r) => {
      const lines = [`## ${esc(r.document_number)}`];
      if (r.title !== undefined) lines.push(`**Title:** ${esc(r.title)}`);
      lines.push(`**Document:** ${esc(r.document_number)} (${r.collection})`);
      const facts: string[] = [];
      if (r.number !== undefined) facts.push(`**Number:** ${esc(r.number)}`);
      if (r.published !== undefined) facts.push(`**Published:** ${esc(r.published)}`);
      if (r.approved !== undefined) facts.push(`**Approved:** ${esc(r.approved)}`);
      if (r.session_date !== undefined) facts.push(`**Session:** ${esc(r.session_date)}`);
      if (r.session_number !== undefined) {
        facts.push(`**Session number:** ${esc(r.session_number)}`);
      }
      if (r.legislature !== undefined) facts.push(`**Legislature:** ${esc(r.legislature)}`);
      if (facts.length > 0) lines.push(facts.join(' | '));
      if (r.case_numbers !== undefined && r.case_numbers.length > 0) {
        lines.push(`**Case numbers:** ${r.case_numbers.map(esc).join(', ')}`);
      }
      const kind: string[] = [];
      if (r.type !== undefined) kind.push(`**Type:** ${esc(r.type)}`);
      if (r.department !== undefined) kind.push(`**Department:** ${esc(r.department)}`);
      if (r.court_name !== undefined) kind.push(`**Court:** ${esc(r.court_name)}`);
      if (r.plan_state !== undefined) kind.push(`**Plan state:** ${esc(r.plan_state)}`);
      if (kind.length > 0) lines.push(kind.join(' | '));
      const force: string[] = [];
      if (r.in_force_from !== undefined) force.push(`**In force from:** ${esc(r.in_force_from)}`);
      if (r.in_force_until !== undefined) {
        force.push(`**In force until:** ${esc(r.in_force_until)}`);
      }
      if (force.length > 0) lines.push(force.join(' | '));
      if (r.promulgation !== undefined) lines.push(`**Promulgation:** ${esc(r.promulgation)}`);
      lines.push(`**Binding:** ${r.binding}`);
      if (r.issuers.length > 0) lines.push(`**Issuer:** ${r.issuers.map(esc).join(', ')}`);
      if (r.summary !== undefined) lines.push(esc(r.summary));
      if (r.norms_cited.length > 0) lines.push(`**Norms:** ${r.norms_cited.map(esc).join('; ')}`);
      if (r.keywords !== undefined) lines.push(`**Keywords:** ${esc(r.keywords)}`);
      // The escaper keeps a note's own line breaks (RIS <br/>) as hard breaks in this paragraph.
      if (r.note !== undefined) lines.push(`**Note:** ${esc(r.note)}`);
      if (r.authentic_pdf_url !== undefined) {
        lines.push(`**Authentic PDF:** ${markdownLink(r.authentic_pdf_url, r.authentic_pdf_url)}`);
      }
      if (r.document_url !== undefined) {
        lines.push(`**RIS view:** ${markdownLink(r.document_url, r.document_url)}`);
      }
      const urls = renditionLinks(r.content_urls);
      if (urls.length > 0) lines.push(`**Text:** ${urls.join(' · ')}`);
      return lines.join('\n');
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
