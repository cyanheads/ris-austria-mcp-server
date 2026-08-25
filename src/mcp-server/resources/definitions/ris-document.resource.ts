/**
 * @fileoverview ris://document/{application}/{documentNumber} — the injectable markdown twin
 * of ris_get_document. Reads the same content path (HTML rendition converted to markdown) for
 * an (application, documentNumber) pair. Applications with no text rendition (authentic-PDF-only,
 * PDF-only, or metadata-only) return a short note pointing at the usable artifact instead of
 * text. Oversized text degrades to the same outline the tool emits — §/Artikel/Anlage sections,
 * or `Part n of N` byte windows where the rendition carries no such headings — plus a note
 * pointing at ris_get_document (which carries the sections selector this bare-string resource
 * cannot). Backed by the shared renderDocument helper from the tool definition.
 * @module mcp-server/resources/definitions/ris-document
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

import {
  addressableSections,
  exampleSectionNames,
  outlineDocument,
  renderDocument,
  renderOutlineSections,
} from '@/mcp-server/tools/definitions/ris-get-document.tool.js';
import { RIS_APPLICATIONS } from '@/services/ris/reference/index.js';

const APPLICATION_CODES = RIS_APPLICATIONS.map((app) => app.code) as [string, ...string[]];

export const risDocumentResource = resource('ris://document/{application}/{documentNumber}', {
  name: 'ris_document',
  title: 'RIS Document (Markdown)',
  description:
    'Markdown text of one RIS document — the injectable twin of ris_get_document (markdown format). Addressed by application code and technical document number, both copied verbatim from a ris_search_* or ris_lookup_citation result. Applications that publish no text rendition (district/municipal promulgations, court rules, party-transparency decisions, council minutes, and the 1848–1940 imperial gazettes) return a short note pointing at the authentic PDF or scan instead.',
  mimeType: 'text/markdown',
  cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },
  params: z.object({
    application: z
      .enum(APPLICATION_CODES)
      .describe(
        'RIS application code the document belongs to (e.g. BrKons, Dsk, BgblAuth). Codes: ris_list_reference topic applications.',
      ),
    documentNumber: z
      .string()
      .describe('Technical RIS document number (Technisch.ID), e.g. NOR40262691.'),
  }),
  examples: [
    { name: 'A consolidated federal-law document', uri: 'ris://document/BrKons/NOR40262691' },
  ],
  errors: [
    {
      reason: 'document_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The application/documentNumber pair is not a valid RIS document, or its content URL returned 404.',
      recovery:
        'Copy the application and document number verbatim from a fresh search result, or resolve the citation with ris_lookup_citation. Document numbers are application-specific.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The RIS content host was unreachable or returned a server error.',
      retryable: true,
      recovery:
        'The RIS content host is temporarily unavailable — retry the read after a short delay.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The content host did not return the rendition within the fetch deadline — typically a cold render, which it performs on first request before caching the result.',
      retryable: true,
      recovery:
        'Retry the identical read once or twice — the host renders a document on first request and caches it, so a later read often returns instantly. If it keeps timing out, check the document number against a fresh search result (a wrong number renders a slow 404 that looks identical), or use ris_get_document with format: urls_only and fetch the rendition URL yourself, without this deadline.',
    },
  ],

  async handler(params, ctx) {
    // Map framework errors from resolution/fetch onto this resource's declared contract.
    const rendition = await renderDocument(
      params.application,
      params.documentNumber,
      'markdown',
      ctx,
    ).catch((err: unknown) => {
      if (err instanceof McpError) {
        if (
          err.code === JsonRpcErrorCode.ValidationError ||
          err.code === JsonRpcErrorCode.NotFound
        ) {
          throw ctx.fail('document_not_found', err.message, {
            ...ctx.recoveryFor('document_not_found'),
          });
        }
        if (err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, { ...ctx.recoveryFor('upstream_error') });
        }
        // Its own reason, not a widened upstream_error guard: `ctx.fail` resolves the code
        // from the contract entry, so folding a deadline into upstream_error would report
        // -32000 for it — and the two want different recovery (degraded host vs. cold render).
        if (err.code === JsonRpcErrorCode.Timeout) {
          throw ctx.fail('upstream_timeout', err.message, {
            ...ctx.recoveryFor('upstream_timeout'),
          });
        }
      }
      throw err;
    });

    if (rendition.unavailableNotice !== undefined) return rendition.unavailableNotice;
    if (rendition.text === undefined) return '';

    // Oversized markdown degrades to an outline plus a notice pointing at the
    // ris_get_document tool — this bare-string surface carries no section selector.
    const addressable = addressableSections(rendition.text, 'markdown');
    const size = rendition.byteSize !== undefined ? ` (${rendition.byteSize} bytes)` : '';
    const decision = outlineDocument(rendition.text, addressable, (sections) =>
      addressable[0]?.kind === 'window'
        ? `Document too large to inline${size}. It carries no §/Artikel/Anlage headings, so it is listed as ${sections.length} contiguous windows cut at line breaks — read them in the order they are named. Use the ris_get_document tool with sections:[…] to retrieve one — e.g. ${exampleSectionNames(addressable)}. This resource carries no selector.`
        : `Document too large to inline${size}. Use the ris_get_document tool with sections:[…] to retrieve specific sections — e.g. ${exampleSectionNames(sections)}. This resource carries no section selector.`,
    );
    return decision.kind === 'full'
      ? decision.text
      : `${renderOutlineSections(decision.sections)}\n\n${decision.notice}`;
  },
});
