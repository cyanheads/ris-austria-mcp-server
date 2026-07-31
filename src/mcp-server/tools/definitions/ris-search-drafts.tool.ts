/**
 * @fileoverview ris_search_drafts — search the federal lawmaking pipeline before promulgation:
 * ministerial review drafts (Begut) and government bills adopted by the council of ministers
 * (RegV, 2004+). `stage` routes to the owning application; the two stage-specific date filters
 * (in_review_on, decided_from/to) are guarded locally before any upstream call. Ministry inputs
 * accept an abbreviation ("BMF") — the service expands it to RIS's exact-match designation.
 * Records carry the companion documents filed with the draft (`materials` — Erläuterungen,
 * Textgegenüberstellung, WFA, covering letter, annexes), each as one opaque, per-record URL —
 * the only route to them: `ris_get_document` fetches it as `document_url`, its `format` input
 * selecting the rendition.
 * @module mcp-server/tools/definitions/ris-search-drafts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { RIS_CHANGED_SINCE_INTERVALS, RIS_STAGES } from '@/services/ris/reference/index.js';
import type {
  ChangedSinceCode,
  DraftsSearchParams,
  RisStageCode,
} from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisHit, RisKeyedUrls } from '@/services/ris/types.js';

import { failSearchError, isoDateString } from './_shared.js';

const STAGE_CODES = RIS_STAGES.map((s) => s.code) as [RisStageCode, ...RisStageCode[]];
const CHANGED_SINCE_CODES = RIS_CHANGED_SINCE_INTERVALS.map((i) => i.code) as [
  ChangedSinceCode,
  ...ChangedSinceCode[],
];

/** Map an empty string from a form-based client to `undefined`. */
function meaningful(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

const ContentUrlsSchema = z
  .object({
    xml: z.string().optional().describe('XML rendition URL (RIS Nutzdaten schema).'),
    html: z.string().optional().describe('HTML rendition URL.'),
    pdf: z.string().optional().describe('PDF rendition URL.'),
    rtf: z.string().optional().describe('RTF rendition URL.'),
  })
  .describe('Rendition URLs of the main document (companion documents ride in materials).');

/**
 * Content types of the companion documents a draft ships beside its bill text. Everything
 * else RIS lists is either the bill itself (`MainDocument`) or one of the dozens of inline
 * formula images per record (`EmbeddedAttachment`, ~55 per record — noise for a caller).
 */
const COMPANION_CONTENT_TYPES = new Set(['Material', 'Letter', 'Attachment']);

const MaterialSchema = z
  .object({
    type: z
      .string()
      .describe(
        'Content type — Material (Erläuterungen, Textgegenüberstellung, Vorblatt/WFA), Letter (the Begleitschreiben covering the review draft), or Attachment (annex texts, e.g. treaty translations). The reliable discriminator: name is free text and varies per record.',
      ),
    name: z
      .string()
      .optional()
      .describe(
        'RIS-supplied label, as filed. Unstable across records — the same content appears as "Vorblatt und WFA", "Vorblatt+WFA", or "WFA"; "Textgegenüberstellung" or "TGÜ". Read type, not this, to classify.',
      ),
    url: z
      .string()
      .describe(
        'One rendition URL for this companion — its HTML rendition, or its PDF where RIS files no HTML one (roughly one companion in eight, nearly all of them review-draft covering letters). Pass it to ris_get_document as document_url: the extension is discarded there and format selects what comes back (markdown, html, or the RIS Nutzdaten xml of this companion, plus the companion’s own rendition URLs under urls_only), so this one URL reaches every text rendition the companion has. A PDF-only companion has none, and the URL is a direct download. The filename is opaque and per-record, so no document number reaches it.',
      ),
  })
  .describe('One companion document filed alongside the draft.');

const DraftRecordSchema = z
  .object({
    document_number: z
      .string()
      .describe(
        'Technical RIS document number (BEGUT_… or REGV_-prefixed) — pass together with the stage’s application to ris_get_document.',
      ),
    stage: z
      .string()
      .describe(
        'Pipeline stage the record belongs to: review_drafts (Begut) or government_bills (RegV).',
      ),
    title: z.string().optional().describe('Full document title, HTML markup stripped.'),
    short_title: z.string().optional().describe('Short title (Kurztitel), where assigned.'),
    ministry: z
      .string()
      .optional()
      .describe('Submitting ministry (EinbringendeStelle / Organ), where the record carries one.'),
    review_deadline: z
      .string()
      .optional()
      .describe(
        'End of the public review window (Ende der Begutachtungsfrist) — review_drafts only.',
      ),
    decided: z
      .string()
      .optional()
      .describe('Council-of-ministers adoption date (Beschlussdatum) — government_bills only.'),
    document_url: z
      .string()
      .optional()
      .describe('RIS web view of the draft document (DokumentUrl) — for humans.'),
    materials: z
      .array(MaterialSchema)
      .describe(
        'Companion documents filed with the draft — the Erläuterungen (explanatory notes, carrying the reasoning the bill text omits), Textgegenüberstellung (redline against the current law), Vorblatt/WFA (impact assessment), the covering letter, and any annexes. Read one by passing its url to ris_get_document as document_url. Empty when the ministry filed none; coverage is uneven by design.',
      ),
    content_urls: ContentUrlsSchema,
  })
  .describe('One pipeline document — a review draft or a government bill.');

type DraftRecord = z.infer<typeof DraftRecordSchema>;

/** Pick the four core rendition URLs off a normalized URL set. */
function pickContentUrls(urls: RisKeyedUrls): DraftRecord['content_urls'] {
  const { html, pdf, rtf, xml } = urls;
  return {
    ...(xml !== undefined && { xml }),
    ...(html !== undefined && { html }),
    ...(pdf !== undefined && { pdf }),
    ...(rtf !== undefined && { rtf }),
  };
}

/**
 * Pick the draft's companion documents off a normalized hit. `normalizeHit` parses every
 * content reference; the main document's renditions are already served as `content_urls`,
 * and the inline formula images are per-record temporary files with nothing to read.
 *
 * One URL per companion, not the rendition set RIS lists: `ris_get_document` validates a
 * companion URL's extension and then discards it, rebuilding the rendition from its own
 * `format` input, so every spelling of the URL is the same handle. HTML is preferred — the
 * rendition the default `markdown` format reads, and the one that opens in a browser.
 *
 * The fallback is not a guard against an impossible state. 2,829 of the 23,483 companions
 * across the full live Begut + RegV corpus (12.0%) carry no HTML rendition — 2,820 Begut
 * covering letters and 9 RegV treaty texts — and RIS 404s a rendition it does not list, so
 * those are PDF downloads with no text rendition to render.
 */
function pickMaterials(hit: RisHit): DraftRecord['materials'] {
  return hit.contentReferences.flatMap((reference) => {
    const { name, type, urls } = reference;
    if (type === undefined || !COMPANION_CONTENT_TYPES.has(type)) return [];
    const url = urls.html ?? urls.pdf ?? urls.xml ?? urls.rtf;
    if (url === undefined) return [];
    return [{ type, ...(name !== undefined && { name }), url }];
  });
}

/** Render a rendition-URL set as markdown links; `''` when the set carries none. */
function renditionLinks(urls: DraftRecord['content_urls']): string {
  return (['html', 'pdf', 'rtf', 'xml'] as const)
    .filter((key) => urls[key] !== undefined)
    .map((key) => `[${key.toUpperCase()}](${urls[key]})`)
    .join(' · ');
}

/** Map a normalized RIS hit (Begut/RegV ride the Bundesrecht controller) to the record shape. */
function toRecord(hit: RisHit, stage: string): DraftRecord {
  const base: DraftRecord = {
    content_urls: pickContentUrls(hit.contentUrls),
    document_number: hit.documentNumber,
    materials: pickMaterials(hit),
    stage,
    ...(hit.documentUrl !== undefined && { document_url: hit.documentUrl }),
  };
  const md = hit.metadata;
  if (md.controller === 'Bundesrecht') {
    const ministry = md.ministry ?? hit.submitter ?? hit.organ;
    return {
      ...base,
      ...(md.decided !== undefined && { decided: md.decided }),
      ...(ministry !== undefined && { ministry }),
      ...(md.reviewDeadline !== undefined && { review_deadline: md.reviewDeadline }),
      ...(md.shortTitle !== undefined && { short_title: md.shortTitle }),
      ...(md.title !== undefined && { title: md.title }),
    };
  }
  return base;
}

export const risSearchDrafts = tool('ris_search_drafts', {
  title: 'Search Draft Legislation',
  description:
    'Search Austria’s federal lawmaking pipeline BEFORE promulgation — the monitoring counterpart to ris_search_gazette (what will become law). stage selects the phase: review_drafts (Begutachtungsentwürfe — draft laws a ministry has put into public review, before any government bill exists) or government_bills (Regierungsvorlagen — bills the council of ministers adopted and submitted to parliament, 2004+). Filter by query (full text), title, ministry (accepts an abbreviation like "BMF" — expanded to RIS’s exact designation; the historical name at submission time counts), in_review_on (review_drafts only — drafts whose review window covers the date; today = "what is in Begutachtung right now"), or decided_from/to (government_bills only — council adoption date). changed_since gives coarse recency. Each record carries materials — the companion documents filed with the draft (Erläuterungen, Textgegenüberstellung, Vorblatt/WFA, covering letter, annexes); the Erläuterungen carry the drafting reasoning the bill text omits, and passing a materials[].url to ris_get_document as document_url is the only way to read one (format there picks the rendition returned). Documents are preparatory, not binding law. Ministry codes: ris_list_reference topic ministries.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    stage: z
      .enum(STAGE_CODES)
      .describe(
        'Which pipeline stage to search — one per call. review_drafts (Begut, ministerial review) or government_bills (RegV, council-adopted bills). Details: ris_list_reference topic stages.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search (Suchworte). Boolean operators UND/ODER/NICHT or AND/OR/NOT, parentheses, quoted phrases; wildcard * is trailing-only.',
      ),
    title: z
      .string()
      .optional()
      .describe(
        'Title search (Titel) — phrase field: * allowed leading or trailing with ≥2 characters beside it.',
      ),
    ministry: z
      .string()
      .optional()
      .describe(
        'Submitting ministry (EinbringendeStelle). Accepts an abbreviation ("BMF") — expanded to RIS’s exact-match designation; use the ministry’s name at the time of submission. Table: ris_list_reference topic ministries.',
      ),
    in_review_on: isoDateString
      .optional()
      .describe(
        'review_drafts only. Drafts whose public-review window covers this date (YYYY-MM-DD). Today = drafts currently in Begutachtung.',
      ),
    decided_from: isoDateString
      .optional()
      .describe('government_bills only. Earliest council-of-ministers adoption date (YYYY-MM-DD).'),
    decided_to: isoDateString
      .optional()
      .describe('government_bills only. Latest adoption date (YYYY-MM-DD).'),
    changed_since: z
      .enum(CHANGED_SINCE_CODES)
      .optional()
      .describe(
        'Coarse recency filter — documents changed in RIS within the interval. For exact windows use ris_track_changes.',
      ),
    sort_by: z
      .enum(['date', 'ministry', 'title'])
      .optional()
      .describe(
        'Sort column: date (review deadline or adoption date per stage), ministry, or title. Default: upstream order.',
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
      .array(DraftRecordSchema)
      .describe(
        'Matching pipeline documents for the requested page. Totals and paging in enrichment.',
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
      reason: 'stage_filter_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'in_review_on was combined with stage: government_bills, or decided_from/to with stage: review_drafts — rejected locally before any upstream call; the message names the offending pair.',
      recovery:
        'Drop the named filter or switch stage: in_review_on applies only to stage: review_drafts; decided_from/to only to stage: government_bills.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A page past the last page of results; or a parameter value rejected locally (ministry matched no entry in the RIS ministries table, or matched more than one); or RIS rejecting a value in-band (the Client error message is passed through verbatim, in German, and it does not name the page).',
      recovery:
        'For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message; the message lists the closest ministry matches when a ministry was passed. Ministry codes: ris_list_reference topic ministries.',
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
    const { stage } = input;
    const query = meaningful(input.query);
    const title = meaningful(input.title);
    const ministry = meaningful(input.ministry);
    const inReviewOn = meaningful(input.in_review_on);
    const decidedFrom = meaningful(input.decided_from);
    const decidedTo = meaningful(input.decided_to);

    const mismatch = (message: string) =>
      ctx.fail('stage_filter_mismatch', message, { ...ctx.recoveryFor('stage_filter_mismatch') });

    if (inReviewOn !== undefined && stage === 'government_bills') {
      throw mismatch(
        "in_review_on applies only to stage: review_drafts — got stage: 'government_bills'.",
      );
    }
    if ((decidedFrom !== undefined || decidedTo !== undefined) && stage === 'review_drafts') {
      throw mismatch(
        `${decidedFrom !== undefined ? 'decided_from' : 'decided_to'} applies only to stage: government_bills — got stage: 'review_drafts'.`,
      );
    }

    const params: DraftsSearchParams = {
      stage,
      ...(query !== undefined && { query }),
      ...(title !== undefined && { title }),
      ...(ministry !== undefined && { ministry }),
      ...(inReviewOn !== undefined && { inReviewOn }),
      ...(decidedFrom !== undefined && { decidedFrom }),
      ...(decidedTo !== undefined && { decidedTo }),
      ...(input.changed_since !== undefined && { changedSince: input.changed_since }),
      ...(input.sort_by !== undefined && { sortBy: input.sort_by }),
      ...(input.sort_direction !== undefined && { sortDirection: input.sort_direction }),
      ...(input.page !== undefined && { page: input.page }),
      ...(input.page_size !== undefined && { pageSize: input.page_size }),
    };

    // Map request-builder and service failures onto this tool's declared contract so reason
    // + recovery reach the wire (neither carries them on its own).
    const result = await getRisService()
      .searchDrafts(params, ctx)
      .catch((err: unknown) => {
        throw failSearchError(err, ctx);
      });
    ctx.log.info('Drafts search completed', {
      hits: result.hits.length,
      stage,
      total: result.total,
    });

    ctx.enrich.total(result.total);
    ctx.enrich({ page: result.page, pageSize: result.pageSize });
    if (result.total > (result.page - 1) * result.pageSize + result.hits.length) {
      ctx.enrich({ truncated: true });
    }

    if (result.total === 0) {
      const fragments = [`0 ${stage} matched.`];
      if (ministry !== undefined) {
        fragments.push(
          "ministry must match a RIS ministry designation — abbreviations are expanded; the historical name at submission time counts ('BMDW', not today's successor). Table: ris_list_reference topic ministries.",
        );
      }
      if (inReviewOn !== undefined) {
        fragments.push(
          `No drafts in review on ${inReviewOn} matching the filters — drop in_review_on to search all drafts including closed reviews.`,
        );
      }
      ctx.enrich.notice(fragments.join(' '));
    }

    return { results: result.hits.map((hit) => toRecord(hit, stage)) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals and paging ride the enrichment trailer.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No pipeline documents on this page._' }];
    }
    const blocks = result.results.map((r) => {
      const lines = [`## ${r.title ?? r.short_title ?? r.document_number}`];
      lines.push(`**Document:** ${r.document_number} (${r.stage})`);
      if (r.short_title !== undefined) lines.push(`**Short title:** ${r.short_title}`);
      if (r.ministry !== undefined) lines.push(`**Ministry:** ${r.ministry}`);
      const dates: string[] = [];
      if (r.review_deadline !== undefined) dates.push(`**Review deadline:** ${r.review_deadline}`);
      if (r.decided !== undefined) dates.push(`**Decided:** ${r.decided}`);
      if (dates.length > 0) lines.push(dates.join(' | '));
      if (r.document_url !== undefined) lines.push(`**RIS view:** ${r.document_url}`);
      const urls = renditionLinks(r.content_urls);
      if (urls !== '') lines.push(`**Text:** ${urls}`);
      if (r.materials.length > 0) {
        lines.push('**Materials:**');
        for (const material of r.materials) {
          lines.push(`- ${material.name ?? material.type} (${material.type}) — ${material.url}`);
        }
      }
      return lines.join('\n');
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
