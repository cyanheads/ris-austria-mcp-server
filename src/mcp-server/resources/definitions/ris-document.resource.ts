/**
 * @fileoverview ris://document/{application}/{documentNumber} — the injectable markdown twin
 * of ris_get_document. Reads the same content path (HTML rendition converted to markdown) for
 * an (application, documentNumber) pair. Applications with no text rendition (authentic-PDF-only,
 * PDF-only, or metadata-only) return a short note pointing at the usable artifact instead of
 * text. Oversized text degrades to the same §/Artikel/Anlage section outline the tool emits,
 * plus a note pointing at ris_get_document (which carries the sections selector this bare-string
 * resource cannot). Backed by the shared renderDocument helper from the tool definition.
 * @module mcp-server/resources/definitions/ris-document
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

import {
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
      }
      throw err;
    });

    if (rendition.unavailableNotice !== undefined) return rendition.unavailableNotice;
    if (rendition.text === undefined) return '';

    // Oversized markdown degrades to a section outline plus a notice pointing at the
    // ris_get_document tool — this bare-string surface carries no section selector.
    const decision = outlineDocument(
      rendition.text,
      (sections) =>
        `Document too large to inline${rendition.byteSize !== undefined ? ` (${rendition.byteSize} bytes)` : ''}. Use the ris_get_document tool with sections:[…] to retrieve specific sections — e.g. ${exampleSectionNames(sections)}. This resource carries no section selector.`,
    );
    return decision.kind === 'full'
      ? decision.text
      : `${renderOutlineSections(decision.sections)}\n\n${decision.notice}`;
  },
});
