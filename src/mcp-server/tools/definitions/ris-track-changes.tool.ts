/**
 * @fileoverview ris_track_changes — the precise, deletion-aware change feed over RIS's
 * History controller: every document added or changed in one application within an exact
 * date window, optionally including deletions. The delta-sync and monitoring primitive the
 * coarse, additive-only `changed_since` (ImRisSeit) intervals cannot express. History
 * responses reuse the standard normalized envelope, so each changed document surfaces in a
 * cross-class record shape (identity, label, dates, binding, renditions) plus `changed`;
 * removed documents surface as `deleted` records. The service maps the four History
 * application-name aliases (BrKons→Bundesnormen, LrKons→Landesnormen, Gr→Gemeinderecht,
 * GrA→GemeinderechtAuth) internally.
 * @module mcp-server/tools/definitions/ris-track-changes
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

import type { RisApplication, RisBindingStatus } from '@/services/ris/reference/index.js';
import { RIS_APPLICATIONS } from '@/services/ris/reference/index.js';
import type { TrackChangesParams } from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisChange } from '@/services/ris/types.js';

import { isoDateString } from './_shared.js';

const APPLICATION_CODES = RIS_APPLICATIONS.map((app) => app.code) as [string, ...string[]];

const APPLICATION_BY_CODE = new Map<string, RisApplication>(
  RIS_APPLICATIONS.map((app) => [app.code, app]),
);

const BINDING_STATUSES = [
  'authentic',
  'consolidated_informational',
  'historical_record',
  'decision',
  'preparatory',
  'administrative_directive',
  'translation',
] as const satisfies readonly RisBindingStatus[];

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
  .describe('Rendition URLs of the changed document. Empty for a deletion record.');

const ChangeRecordSchema = z
  .object({
    document_number: z
      .string()
      .describe(
        'Technical RIS document number (Technisch.ID) — pass with application to ris_get_document.',
      ),
    title: z.string().optional().describe('Document title, HTML markup stripped, where present.'),
    short_title: z.string().optional().describe('Short title (Kurztitel), where assigned.'),
    organ: z
      .string()
      .optional()
      .describe('Issuing body (Organ) of the document, where the record carries one.'),
    changed: z
      .string()
      .optional()
      .describe('Date this document last changed in RIS (Allgemein.Geaendert).'),
    published: z
      .string()
      .optional()
      .describe('Date this document was first published in RIS (Allgemein.Veroeffentlicht).'),
    document_url: z
      .string()
      .optional()
      .describe('RIS web view of the document (Allgemein.DokumentUrl) — for humans.'),
    binding_status: z
      .enum(BINDING_STATUSES)
      .describe(
        'Legal binding status of the queried application — authentic (amtssigniert, legally binding), consolidated_informational, historical_record, decision, preparatory, administrative_directive, or translation.',
      ),
    deleted: z
      .boolean()
      .describe('True when this record marks a document removed from RIS (include_deleted only).'),
    deleted_at: z
      .string()
      .optional()
      .describe('Deletion import timestamp (ImportTimestamp) — deletion records only.'),
    content_urls: ContentUrlsSchema,
    authentic_pdf_url: z
      .string()
      .optional()
      .describe(
        'The amtssigniert authentic PDF (.pdfsig, Authentisch DataType), where the changed document publishes one.',
      ),
  })
  .describe('One change-feed entry — a changed document, or a deletion record.');

type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

/** Map a normalized History change to the tool's record shape. */
function toRecord(change: RisChange, bindingStatus: RisBindingStatus): ChangeRecord {
  if (change.kind === 'deleted') {
    const { deletedAt, documentNumber, organ } = change.record;
    return {
      binding_status: bindingStatus,
      content_urls: {},
      deleted: true,
      document_number: documentNumber,
      ...(deletedAt !== undefined && { deleted_at: deletedAt }),
      ...(organ !== undefined && { organ }),
    };
  }
  const { hit } = change;
  const md = hit.metadata;
  const title = md.title;
  const shortTitle = 'shortTitle' in md ? md.shortTitle : undefined;
  const { html, pdf, rtf, xml } = hit.contentUrls;
  return {
    binding_status: bindingStatus,
    content_urls: {
      ...(xml !== undefined && { xml }),
      ...(html !== undefined && { html }),
      ...(pdf !== undefined && { pdf }),
      ...(rtf !== undefined && { rtf }),
    },
    deleted: false,
    document_number: hit.documentNumber,
    ...(hit.contentUrls.authentic !== undefined && {
      authentic_pdf_url: hit.contentUrls.authentic,
    }),
    ...(hit.changed !== undefined && { changed: hit.changed }),
    ...(hit.documentUrl !== undefined && { document_url: hit.documentUrl }),
    ...(hit.organ !== undefined && { organ: hit.organ }),
    ...(hit.published !== undefined && { published: hit.published }),
    ...(shortTitle !== undefined && { short_title: shortTitle }),
    ...(title !== undefined && { title }),
  };
}

export const risTrackChanges = tool('ris_track_changes', {
  title: 'Track RIS Changes',
  description:
    'Track every document added or changed in one RIS application within an exact date window (changed_from/changed_to), optionally including deletions (include_deleted) — the delta-sync and monitoring primitive for mirrors and watchers, and the only surface that reports removals. Unlike the search tools’ coarse, additive-only changed_since intervals, this is exact-dated and deletion-aware. application takes any RIS application code (e.g. BrKons, Dsk, BgblAuth); the four applications with a different History-feed name are mapped automatically. Each changed document comes back in a compact cross-class record — document_number (for ris_get_document), title, dates, binding_status, and rendition URLs — plus its last-changed date; removed documents come back as deleted records with a deletion timestamp. One application per call; page explicitly for large windows. Application codes and coverage: ris_list_reference topic applications.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    application: z
      .enum(APPLICATION_CODES)
      .describe(
        'RIS application whose change feed to read (standard code, e.g. BrKons, LrKons, Dsk, BgblAuth). History’s four aliased names are mapped internally. Codes: ris_list_reference topic applications.',
      ),
    changed_from: isoDateString
      .optional()
      .describe(
        'Include documents changed on/after this date (YYYY-MM-DD, AenderungenVon). Exact date, not a coarse interval.',
      ),
    changed_to: isoDateString
      .optional()
      .describe('Include documents changed on/before this date (YYYY-MM-DD, AenderungenBis).'),
    include_deleted: z
      .boolean()
      .optional()
      .describe(
        'true also returns documents removed from RIS in the window, as deleted records — the only way to observe deletions.',
      ),
    page: z.number().int().min(1).optional().describe('1-based result page. Default 1.'),
    page_size: z
      .union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)])
      .optional()
      .describe('Documents per page — RIS accepts 10, 20, 50, or 100. Default 20.'),
  }),
  output: z.object({
    results: z
      .array(ChangeRecordSchema)
      .describe(
        'Change-feed entries for the requested page. Totals, paging, and the applied window in enrichment.',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Total change-feed entries across all pages.'),
    page: z.number().describe('1-based page number RIS served.'),
    pageSize: z.number().describe('Page size RIS applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true when more pages exist beyond this one — raise page to continue.'),
    application: z.string().describe('The application whose change feed was read.'),
    changedFrom: z
      .string()
      .optional()
      .describe('The changed_from bound the server applied (echo), when set.'),
    changedTo: z
      .string()
      .optional()
      .describe('The changed_to bound the server applied (echo), when set.'),
    notice: z
      .string()
      .optional()
      .describe('Zero-hit guidance — names the likely cause and the concrete next call.'),
  },
  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'RIS rejected a parameter value — its Client error message is passed through verbatim and names the offending element (e.g. a page past the last page of the change window).',
      recovery:
        'Correct the parameter RIS names in the message — for a page past the end, request a lower page, starting from 1.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'RIS is unreachable, returned a server error, or served an HTML error page.',
      retryable: true,
      recovery:
        'RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size or narrow the window.',
    },
  ],

  async handler(input, ctx) {
    const changedFrom = meaningful(input.changed_from);
    const changedTo = meaningful(input.changed_to);
    // application is a Zod enum of the reference codes, so the lookup always resolves.
    const bindingStatus = (APPLICATION_BY_CODE.get(input.application) as RisApplication).binding;

    const params: TrackChangesParams = {
      application: input.application,
      ...(changedFrom !== undefined && { changedFrom }),
      ...(changedTo !== undefined && { changedTo }),
      ...(input.include_deleted === true && { includeDeleted: true }),
      ...(input.page !== undefined && { page: input.page }),
      ...(input.page_size !== undefined && { pageSize: input.page_size }),
    };

    // Map in-band RIS errors onto this tool's declared contract so reason +
    // recovery reach the wire (service-level throws carry neither).
    const result = await getRisService()
      .trackChanges(params, ctx)
      .catch((err: unknown) => {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
          throw ctx.fail('invalid_query', err.message, { ...ctx.recoveryFor('invalid_query') });
        }
        if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, { ...ctx.recoveryFor('upstream_error') });
        }
        throw err;
      });
    ctx.log.info('Change feed read', {
      application: input.application,
      entries: result.changes.length,
      total: result.total,
    });

    ctx.enrich.total(result.total);
    ctx.enrich({ application: input.application, page: result.page, pageSize: result.pageSize });
    if (changedFrom !== undefined) ctx.enrich({ changedFrom });
    if (changedTo !== undefined) ctx.enrich({ changedTo });
    if (result.total > (result.page - 1) * result.pageSize + result.changes.length) {
      ctx.enrich({ truncated: true });
    }

    if (result.total === 0) {
      ctx.enrich.notice(
        `0 changes in ${input.application} between ${changedFrom ?? 'the start of the feed'} and ${changedTo ?? 'now'}. Windows are exact dates — widen the range, or use the search tools' changed_since for coarse recency filtering.`,
      );
    }

    return { results: result.changes.map((change) => toRecord(change, bindingStatus)) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals, paging, and the applied window ride the enrichment trailer.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No changes on this page._' }];
    }
    const blocks = result.results.map((r) => {
      const lines = [
        `## ${r.title ?? r.short_title ?? r.document_number}${r.deleted ? ' — deleted' : ''}`,
        `**Document:** ${r.document_number}`,
      ];
      if (r.short_title !== undefined) lines.push(`**Short title:** ${r.short_title}`);
      if (r.organ !== undefined) lines.push(`**Organ:** ${r.organ}`);
      lines.push(`**Binding:** ${r.binding_status}`);
      if (r.changed !== undefined || r.published !== undefined) {
        lines.push(
          `**Changed:** ${r.changed ?? 'unknown'}${r.published !== undefined ? ` | **Published:** ${r.published}` : ''}`,
        );
      }
      lines.push(
        `**Deleted:** ${r.deleted ? `yes${r.deleted_at !== undefined ? ` (${r.deleted_at})` : ''}` : 'no'}`,
      );
      if (r.document_url !== undefined) lines.push(`**RIS view:** ${r.document_url}`);
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
