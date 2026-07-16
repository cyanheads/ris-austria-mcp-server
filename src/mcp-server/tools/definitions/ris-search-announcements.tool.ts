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
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

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

import { isoDateString } from './_shared.js';

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

/** Map an empty string from a form-based client to `undefined`. */
function meaningful(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
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
    issuers: z
      .array(z.string().describe('One issuing body.'))
      .describe(
        'Issuing bodies (Urheber / Bundesministerium / Einbringer) — a council minute can carry several. Empty when none.',
      ),
    norms_cited: z
      .array(z.string().describe('One cited norm in RIS format, e.g. "DSG §1".'))
      .describe(
        'Norms the document cites (veterinary notices and decrees) — copy an entry verbatim into a norm filter to find siblings. Empty when none.',
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
  };
  const md = hit.metadata;
  if (md.controller === 'Sonstige') {
    return {
      ...base,
      issuers: [...md.issuers],
      norms_cited: [...md.normsCited],
      ...(md.number !== undefined && { number: md.number }),
      ...(md.publishedDate !== undefined && { published: md.publishedDate }),
      ...(md.sessionDate !== undefined && { session_date: md.sessionDate }),
      ...(md.summary !== undefined && { summary: md.summary }),
      ...(md.title !== undefined && { title: md.title }),
    };
  }
  return base;
}

export const risSearchAnnouncements = tool('ris_search_announcements', {
  title: 'Search Official Announcements',
  description:
    'Search Austria’s sectoral official gazettes and executive documents — seven collections behind one collection enum: social_insurance (Amtliche Verlautbarungen der Sozialversicherung, authentic), veterinary (Amtliche Veterinärnachrichten, authentic), court_rules (Kundmachungen der Gerichte — rules of procedure and case-allocation plans, authentic; currently LVwG Tirol and Vorarlberg only), trade_exam_rules (Prüfungsordnungen gemäß Gewerbeordnung, authentic), health_structure_plans (Strukturpläne Gesundheit — federal ÖSG and per-state RSG, authentic), ministerial_decrees (Erlässe der Bundesministerien — decrees interpreting law; bind the administration, not citizens), and council_minutes (Ministerratsprotokolle — council-of-ministers session records). Each collection accepts a different filter set: query and title are broadly available; number, published_from/to, in_force_as_of, issuer (ministry abbreviations expanded), norm ("decrees citing the DSG"), case_number, type, department, plan_type/plan_state (health plans), and session_number/legislature (council minutes) apply where the collection supports them — a filter outside its set is rejected locally. Every result carries a binding label and the authentic PDF where it exists. Per-collection parameter matrix and issuers: ris_list_reference topic collections or issuing_bodies.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    collection: z
      .enum(COLLECTION_CODES)
      .describe(
        'Which collection to search — one per call. social_insurance | veterinary | court_rules | trade_exam_rules | health_structure_plans | ministerial_decrees | council_minutes. Per-collection filter matrix: ris_list_reference topic collections.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search (Suchworte). Boolean operators UND/ODER/NICHT or AND/OR/NOT, parentheses, quoted phrases; wildcard * is trailing-only. Valid for all collections.',
      ),
    title: z
      .string()
      .optional()
      .describe(
        'Title search (Titel) — phrase field. Valid for all collections except council_minutes.',
      ),
    number: z
      .string()
      .optional()
      .describe(
        'Serial number (Avsvnummer / Avnnummer / Spgnummer) — social_insurance, veterinary, health_structure_plans.',
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
        'Version in force on this date (YYYY-MM-DD) — veterinary, court_rules, trade_exam_rules, health_structure_plans, ministerial_decrees (the consolidated-ish collections).',
      ),
    entered_force_from: isoDateString
      .optional()
      .describe(
        'Provisions that entered force on/after this date (YYYY-MM-DD) — ministerial_decrees only.',
      ),
    entered_force_to: isoDateString
      .optional()
      .describe(
        'Provisions that entered force on/before this date (YYYY-MM-DD) — ministerial_decrees only.',
      ),
    issuer: z
      .string()
      .optional()
      .describe(
        'Issuing body — social_insurance (Urheber, e.g. ÖGK/SVS/BVAEB/AUVA/PVA), ministerial_decrees (Bundesministerium — abbreviation expanded), council_minutes (Einbringer ministry). Values: ris_list_reference topic issuing_bodies or ministries.',
      ),
    norm: z
      .string()
      .optional()
      .describe(
        'Cited-provision filter (Norm) — "DSG §1", "DSGVO Art32" style. veterinary and ministerial_decrees only ("decrees citing the DSG").',
      ),
    case_number: z
      .string()
      .optional()
      .describe(
        'Business reference number (Geschäftszahl) — veterinary and ministerial_decrees only.',
      ),
    type: z
      .string()
      .optional()
      .describe(
        'Document type (Typ) — trade_exam_rules (Befaehigungspruefungsordnung | Meisterpruefungsordnung), court_rules (Geschaeftsordnung | Geschaeftsverteilung), veterinary (Kundmachungen | VeroeffentlichungenAufGrundVEVO | SonstigeVeroeffentlichungen).',
      ),
    department: z
      .string()
      .optional()
      .describe('Ministry department (Abteilung) — ministerial_decrees only.'),
    plan_type: z
      .enum(['all', 'expert_opinion', 'regulation'])
      .optional()
      .describe(
        'health_structure_plans only. Plan kind — all (default), expert_opinion (Gutachten), or regulation (Verordnungen). Searches the federal ÖSG unless plan_state is set.',
      ),
    plan_state: z
      .enum(STATE_CODES)
      .optional()
      .describe(
        'health_structure_plans only. Restrict to one Bundesland’s regional health-structure plan (RSG) — setting it switches the search from the federal ÖSG to that state’s RSG.',
      ),
    session_number: z
      .string()
      .optional()
      .describe('Council session number (Sitzungsnummer) — council_minutes only.'),
    legislature: z
      .string()
      .optional()
      .describe('Legislative period (Gesetzgebungsperiode, e.g. "XXVII") — council_minutes only.'),
    changed_since: z
      .enum(CHANGED_SINCE_CODES)
      .optional()
      .describe(
        'Coarse recency filter — documents changed in RIS within the interval. For exact windows use ris_track_changes.',
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
    page_size: z
      .union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)])
      .optional()
      .describe('Documents per page — RIS accepts 10, 20, 50, or 100. Default 20.'),
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
      .describe('Zero-hit guidance — names the likely cause and the concrete next call.'),
  },
  errors: [
    {
      reason: 'collection_filter_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parameter was combined with a collection that does not accept it — rejected locally before any upstream call; the message names the offending parameter and lists the collection’s valid parameters.',
      recovery:
        'Drop the named parameter or switch collection — each collection accepts a different parameter set. Valid parameters per collection: ris_list_reference topic collections.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'RIS rejected a parameter value — the in-band Client error message is passed through verbatim; it names the invalid element and its valid values.',
      recovery:
        'Correct the parameter RIS names in the message. Collections and their issuers: ris_list_reference topic collections or issuing_bodies.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'RIS is unreachable, returned a server error, or served an HTML error page.',
      retryable: true,
      recovery:
        'RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size or narrow the query.',
    },
  ],

  async handler(input, ctx) {
    const { collection } = input;
    const query = meaningful(input.query);
    const title = meaningful(input.title);
    const number = meaningful(input.number);
    const publishedFrom = meaningful(input.published_from);
    const publishedTo = meaningful(input.published_to);
    const inForceAsOf = meaningful(input.in_force_as_of);
    const enteredForceFrom = meaningful(input.entered_force_from);
    const enteredForceTo = meaningful(input.entered_force_to);
    const issuer = meaningful(input.issuer);
    const norm = meaningful(input.norm);
    const caseNumber = meaningful(input.case_number);
    const type = meaningful(input.type);
    const department = meaningful(input.department);
    const sessionNumber = meaningful(input.session_number);
    const legislature = meaningful(input.legislature);

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
    ];
    const offending = conditional.find(([name, value]) => value !== undefined && !valid.has(name));
    if (offending) {
      throw ctx.fail(
        'collection_filter_mismatch',
        `${offending[0]} is not a valid filter for collection '${collection}' — it accepts: ${validParams.join(', ')}.`,
        { ...ctx.recoveryFor('collection_filter_mismatch') },
      );
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
      ...(input.page_size !== undefined && { pageSize: input.page_size }),
    };

    // Map in-band RIS errors onto this tool's declared contract so reason +
    // recovery reach the wire (service-level throws carry neither).
    const result = await getRisService()
      .searchAnnouncements(params, ctx)
      .catch((err: unknown) => {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
          throw ctx.fail('invalid_query', err.message, { ...ctx.recoveryFor('invalid_query') });
        }
        if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, { ...ctx.recoveryFor('upstream_error') });
        }
        throw err;
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

    if (result.total === 0) {
      const fragments = [`0 documents in ${collection}.`];
      if (norm !== undefined) {
        fragments.push(
          "norm must match RIS's cited-norm format — copy from a result's norms_cited.",
        );
      }
      if (issuer !== undefined) {
        fragments.push(
          'issuer must match the RIS designation — abbreviations are expanded for ministries; social-insurance issuers: ris_list_reference topic issuing_bodies.',
        );
      }
      if (collection === 'court_rules') {
        fragments.push('KmGer currently carries LVwG Tirol and Vorarlberg rules only.');
      }
      ctx.enrich.notice(fragments.join(' '));
    }

    return { results: result.hits.map((hit) => toRecord(hit, collection)) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals and paging ride the enrichment trailer.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No documents on this page._' }];
    }
    const blocks = result.results.map((r) => {
      const lines = [`## ${r.title ?? r.summary ?? r.document_number}`];
      lines.push(`**Document:** ${r.document_number} (${r.collection})`);
      const facts: string[] = [];
      if (r.number !== undefined) facts.push(`**Number:** ${r.number}`);
      if (r.published !== undefined) facts.push(`**Published:** ${r.published}`);
      if (r.session_date !== undefined) facts.push(`**Session:** ${r.session_date}`);
      if (facts.length > 0) lines.push(facts.join(' | '));
      lines.push(`**Binding:** ${r.binding}`);
      if (r.issuers.length > 0) lines.push(`**Issuer:** ${r.issuers.join(', ')}`);
      if (r.summary !== undefined) lines.push(r.summary);
      if (r.norms_cited.length > 0) lines.push(`**Norms:** ${r.norms_cited.join('; ')}`);
      if (r.authentic_pdf_url !== undefined)
        lines.push(`**Authentic PDF:** ${r.authentic_pdf_url}`);
      const urls = (['html', 'pdf', 'rtf', 'xml'] as const)
        .filter((key) => r.content_urls[key] !== undefined)
        .map((key) => `[${key.toUpperCase()}](${r.content_urls[key]})`);
      if (urls.length > 0) lines.push(`**Text:** ${urls.join(' · ')}`);
      return lines.join('\n');
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
