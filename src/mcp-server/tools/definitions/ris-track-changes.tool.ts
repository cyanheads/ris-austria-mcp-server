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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';

import type { RisApplication, RisBindingStatus } from '@/services/ris/reference/index.js';
import { RIS_APPLICATIONS } from '@/services/ris/reference/index.js';
import type { TrackChangesParams } from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisChange } from '@/services/ris/types.js';

import {
  failSearchError,
  isoDateString,
  joinNotices,
  pageSizeParam,
  renditionLinks,
  reversedWindowNotice,
  servePageSize,
} from './_shared.js';

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
    section_label: z
      .string()
      .optional()
      .describe(
        'Section, article, or annex the changed document holds (ArtikelParagraphAnlage, e.g. "§ 16", "Anl. 1"; "§ 0" is the law’s heading document) — consolidated-law rows (BrKons, LrKons) only.',
      ),
    law_id: z
      .string()
      .optional()
      .describe(
        'RIS law number (Gesetzesnummer) the section belongs to — consolidated-law rows only. Group a feed by law with it, or pass it to ris_search_legislation law_id for the law’s versions.',
      ),
    in_force_from: z
      .string()
      .optional()
      .describe(
        'First day this version is in force (Inkrafttretensdatum), relayed as RIS writes it — consolidated-law rows only. RIS writes 9000-01-01 for a start still awaiting an event. The version is in force on date D when in_force_from ≤ D and in_force_until is absent or ≥ D.',
      ),
    in_force_until: z
      .string()
      .optional()
      .describe(
        'Last day this version is in force (Ausserkrafttretensdatum), relayed as RIS writes it — consolidated-law rows only. Absent when RIS records no end date, which does not mean the version is in force now: it can start in the future. RIS writes 9000-01-01 for an end still awaiting an event, the day the version after it starts. The version is in force on date D when in_force_from ≤ D and in_force_until is absent or ≥ D.',
      ),
    case_numbers: z
      .array(z.string().describe('One case number (Geschäftszahl).'))
      .optional()
      .describe(
        'Case numbers (Geschäftszahl), one per element in upstream order — a headnote row lists every decision it covers, the leading decision first. Court-decision rows only, which carry no title.',
      ),
    decision_date: z
      .string()
      .optional()
      .describe('Decision date (Entscheidungsdatum) — court-decision rows only.'),
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
  const consolidated = md.controller === 'Bundesrecht' || md.controller === 'Landesrecht';
  const sectionLabel = consolidated ? md.sectionLabel : undefined;
  const lawId = consolidated ? md.lawId : undefined;
  const inForceFrom = consolidated ? md.inForceFrom : undefined;
  const inForceUntil = consolidated ? md.inForceUntil : undefined;
  const caseNumbers = md.controller === 'Judikatur' ? md.caseNumbers : [];
  const decisionDate = md.controller === 'Judikatur' ? md.decisionDate : undefined;
  const { html, pdf, rtf, xml } = hit.contentUrls;
  return {
    binding_status: bindingStatus,
    ...(caseNumbers.length > 0 && { case_numbers: [...caseNumbers] }),
    ...(decisionDate !== undefined && { decision_date: decisionDate }),
    ...(inForceFrom !== undefined && { in_force_from: inForceFrom }),
    ...(inForceUntil !== undefined && { in_force_until: inForceUntil }),
    ...(lawId !== undefined && { law_id: lawId }),
    ...(sectionLabel !== undefined && { section_label: sectionLabel }),
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
    'Track every document added or changed in one RIS application within an exact date window (changed_from/changed_to), optionally including deletions (include_deleted) — the delta-sync and monitoring primitive for mirrors and watchers, and the only surface that reports removals. Unlike the search tools’ coarse, additive-only changed_since intervals, this is exact-dated and deletion-aware. application accepts every RIS application code listed by ris_list_reference topic applications, including BrKons, LrKons, Dsk, and BgblAuth. Each changed document comes back in a compact cross-class record — document_number (for ris_get_document), title, the section_label, law_id, and in-force window (in_force_from/in_force_until) of a consolidated-law row or the case_numbers and decision_date of a court decision, dates, binding_status, and rendition URLs — plus its last-changed date; removed documents come back as deleted records with a deletion timestamp. One application per call; page explicitly for large windows.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    application: z
      .enum(APPLICATION_CODES)
      .describe(
        'RIS application whose change feed to read, e.g. BrKons, LrKons, Dsk, or BgblAuth. All supported codes: ris_list_reference topic applications.',
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
    page_size: pageSizeParam,
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
      .describe('The changed_from bound as requested (echo), when set.'),
    changedTo: z
      .string()
      .optional()
      .describe('The changed_to bound as requested (echo), when set.'),
    notice: z
      .string()
      .optional()
      .describe(
        'The served page size when it differs from page_size, then zero-hit guidance — the likely cause and the concrete next call. A reversed window (changed_from later than changed_to) is answered without a RIS request: 0 changes, and the swapped bounds to retry with in place of the guidance.',
      ),
  },
  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'RIS rejected a parameter value in-band — its Client error message is passed through verbatim and names the offending element (e.g. a page past the last page of the change window).',
      recovery:
        'Correct the parameter named in the message — for a page past the end, request a lower page, starting from 1.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'RIS is unreachable, returned a server error, or served an HTML error page.',
      retryable: true,
      recovery:
        'RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size to 10 or narrow the window.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'RIS did not answer the change feed within the request deadline.',
      retryable: true,
      recovery:
        'RIS did not answer in time — retry the same call shortly, or make it cheaper upstream: reduce page_size to 10 or narrow the change window.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { changed_from: changedFrom, changed_to: changedTo } = input;
    // application is a Zod enum of the reference codes, so the lookup always resolves.
    const bindingStatus = (APPLICATION_BY_CODE.get(input.application) as RisApplication).binding;
    const served = servePageSize(input.page_size);

    // A reversed window holds no dates — answer it here, since RIS's empty page for it reads as
    // a real zero-hit.
    const reversed = reversedWindowNotice([['changed_from', changedFrom, 'changed_to', changedTo]]);
    if (reversed !== undefined) {
      ctx.enrich.total(0);
      ctx.enrich({
        application: input.application,
        page: input.page ?? 1,
        pageSize: served.pageSize ?? 20,
        ...(changedFrom !== undefined && { changedFrom }),
        ...(changedTo !== undefined && { changedTo }),
      });
      ctx.enrich.notice(joinNotices(served.notice, reversed));
      return { results: [] };
    }

    const params: TrackChangesParams = {
      application: input.application,
      ...(changedFrom !== undefined && { changedFrom }),
      ...(changedTo !== undefined && { changedTo }),
      ...(input.include_deleted === true && { includeDeleted: true }),
      ...(input.page !== undefined && { page: input.page }),
      ...(served.pageSize !== undefined && { pageSize: served.pageSize }),
    };

    // Map request-builder and service failures onto this tool's declared contract so reason
    // + recovery reach the wire (neither carries them on its own).
    const result = await getRisService()
      .trackChanges(params, ctx)
      .catch((err: unknown) => {
        throw failSearchError(err, ctx);
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

    const notice = joinNotices(
      served.notice,
      result.total === 0
        ? `0 changes in ${input.application} between ${changedFrom ?? 'the start of the feed'} and ${changedTo ?? 'now'}. Windows are exact dates — widen the range, or use the search tools' changed_since for coarse recency filtering.`
        : undefined,
    );
    if (notice !== undefined) ctx.enrich.notice(notice);

    return { results: result.changes.map((change) => toRecord(change, bindingStatus)) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals, paging, and the applied window ride the enrichment trailer. Every
  // RIS string goes through escapeMarkdownInline and every URL through markdownLink, so a
  // CommonMark parse reads back the structuredContent value.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No changes on this page._' }];
    }
    const esc = escapeMarkdownInline;
    const blocks = result.results.map((r) => {
      // The heading holds only a line-free identifier — a title carries line breaks, which end an
      // ATX heading at its first line. A court-decision row is named by its leading case number,
      // with a count of the rest (a headnote row can list 50 decisions); every other row by its
      // document number. Titles, labels, and the full case list follow on their own lines.
      const [leadCase, ...otherCases] = r.case_numbers ?? [];
      const heading =
        leadCase !== undefined
          ? `${esc(leadCase)}${otherCases.length > 0 ? ` (+${otherCases.length} more)` : ''}`
          : esc(r.document_number);
      const lines = [`## ${heading}${r.deleted ? ' — deleted' : ''}`];
      const field = (label: string, value: string | undefined) => {
        if (value !== undefined) lines.push(`**${label}:** ${esc(value)}`);
      };
      field('Title', r.title);
      lines.push(`**Document:** ${esc(r.document_number)}`);
      field('Short title', r.short_title);
      field('Section', r.section_label);
      if (r.case_numbers !== undefined && otherCases.length > 0) {
        lines.push(`**Case numbers:** ${r.case_numbers.map(esc).join(', ')}`);
      }
      field('Law ID', r.law_id);
      // A missing end date is not "in force now": a version can start in the future.
      if (r.in_force_from !== undefined || r.in_force_until !== undefined) {
        const from = r.in_force_from !== undefined ? esc(r.in_force_from) : 'unknown';
        const until = r.in_force_until !== undefined ? esc(r.in_force_until) : 'no end date';
        lines.push(`**In force:** ${from} → ${until}`);
      }
      field('Decided', r.decision_date);
      field('Organ', r.organ);
      lines.push(`**Binding:** ${r.binding_status}`);
      if (r.changed !== undefined || r.published !== undefined) {
        lines.push(
          `**Changed:** ${r.changed !== undefined ? esc(r.changed) : 'unknown'}${r.published !== undefined ? ` | **Published:** ${esc(r.published)}` : ''}`,
        );
      }
      lines.push(
        `**Deleted:** ${r.deleted ? `yes${r.deleted_at !== undefined ? ` (${esc(r.deleted_at)})` : ''}` : 'no'}`,
      );
      if (r.document_url !== undefined) {
        lines.push(`**RIS view:** ${markdownLink(r.document_url, r.document_url)}`);
      }
      if (r.authentic_pdf_url !== undefined) {
        lines.push(`**Authentic PDF:** ${markdownLink(r.authentic_pdf_url, r.authentic_pdf_url)}`);
      }
      const urls = renditionLinks(r.content_urls);
      if (urls.length > 0) lines.push(`**Text:** ${urls.join(' · ')}`);
      return lines.join('\n');
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
