/**
 * @fileoverview Tests for the ris://document/{application}/{documentNumber} resource — the
 * markdown-only twin of ris_get_document, backed by the shared `renderDocument` helper,
 * including overflow degradation to a section outline plus a tool-retrieval notice.
 * Mocked the same way as the get_document tool suite: `buildDocumentContentUrl` delegates
 * to a real `RisService` instance (pure URL construction), `fetchDocumentContent` is a
 * `vi.fn()` resolving canned content.
 * @module tests/resources/ris-document.resource.test
 */

import { readFileSync } from 'node:fs';

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risDocumentResource } from '@/mcp-server/resources/definitions/ris-document.resource.js';
import type { RisContentFormat } from '@/services/ris/ris-service.js';

const { buildDocumentContentUrl, fetchDocumentContent } = vi.hoisted(() => ({
  buildDocumentContentUrl: vi.fn(),
  fetchDocumentContent: vi.fn(),
}));

vi.mock('@/services/ris/ris-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ris/ris-service.js')>();
  // buildDocumentContentUrl is pure (no network) — delegate to a real instance so
  // constructed URLs stay correct without duplicating the per-application segment map.
  const real = new actual.RisService('test-agent/0.0.0');
  buildDocumentContentUrl.mockImplementation(
    (application: string, documentNumber: string, format: RisContentFormat, contentName?: string) =>
      real.buildDocumentContentUrl(application, documentNumber, format, contentName),
  );
  return {
    ...actual,
    getRisService: () => ({ buildDocumentContentUrl, fetchDocumentContent }),
  };
});

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

/** HTML whose markdown conversion exceeds the outline budget, split into `## Artikel N` sections. */
function oversizedArticlesHtml(): string {
  const body = (n: number) => `<p>${`xSECTIONx${n}x `.repeat(4000)}</p>`;
  return Array.from({ length: 15 }, (_, i) => `<h2>Artikel ${i + 1}</h2>${body(i + 1)}`).join('\n');
}

beforeEach(() => {
  buildDocumentContentUrl.mockClear();
  fetchDocumentContent.mockReset();
});

describe('risDocumentResource — resolves via the shared renderDocument helper', () => {
  it('returns markdown-converted document text for a full-text application', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Hello <b>World</b></p>',
      byteSize: 25,
      url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const result = await risDocumentResource.handler(params, ctx);
    expect(result).toContain('World');
    expect(result).not.toContain('<b>');
    expect(fetchDocumentContent).toHaveBeenCalledWith(expect.stringContaining('.html'), ctx);
  });

  // The resource renders through the same renderDocument helper, so the markdown-boundary
  // strip of RIS's screen-reader twins has to reach this surface too — it is markdown-only,
  // and a duplicated citation here would corrupt injected context the same way.
  it('drops the screen-reader expansions and keeps the visible citation', async () => {
    const html = readFileSync(
      new URL('../fixtures/ris/document-brkons-sr-only.html', import.meta.url),
      'utf8',
    );
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const result = await risDocumentResource.handler(params, ctx);

    expect(result).toContain('BGBl. I Nr. 165/1999 zuletzt geändert durch BGBl. I Nr. 70/2024');
    expect(result).not.toContain('Bundesgesetzblatt Teil eins');
    expect(result).toContain('§ 0');
    expect(result).not.toContain('Paragraph 0');
  });

  it('falls back to the unavailable-format notice text for an authentic_pdf_only application', async () => {
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/Bvb/BVB_BU_JE_20260703_9'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'Bvb',
      documentNumber: 'BVB_BU_JE_20260703_9',
    });
    const result = await risDocumentResource.handler(params, ctx);
    expect(result).toContain('Bvb publishes only the signed authentic PDF');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });
});

describe('risDocumentResource — overflow degradation', () => {
  it('degrades an oversized document to a section outline plus a tool-retrieval notice', async () => {
    const html = oversizedArticlesHtml();
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const result = await risDocumentResource.handler(params, ctx);

    expect(typeof result).toBe('string');
    // Lists section names and points the caller at the tool (the resource has no selector).
    expect(result).toContain('Artikel 1');
    expect(result).toContain('sections');
    expect(result).toContain('ris_get_document');
    // The full document body is not inlined — only the outline.
    expect(result).not.toContain('xSECTIONx1x');
  });

  // The resource shares outlineDocument() with the tool, so it follows the byte budget
  // wherever that lands — including the band that stopped overflowing once the
  // screen-reader strip halved every rendered byte count.
  it('degrades a document sized between the current budget and the pre-strip calibration', async () => {
    const body = (n: number) => `<p>${`xSECTIONx${n}x `.repeat(1000)}</p>`;
    const html = Array.from(
      { length: 6 },
      (_, i) => `<h2>Artikel ${i + 1}</h2>${body(i + 1)}`,
    ).join('\n');
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const result = await risDocumentResource.handler(params, ctx);

    expect(result).toContain('6 sections');
    expect(result).toContain('ris_get_document');
    expect(result).not.toContain('xSECTIONx1x');
  });

  // The resource degrades through the same roster helper, so a heading-free decision — which
  // used to be inlined whole at any size — now lists the windows the tool can retrieve.
  it('degrades an oversized heading-free document to a window outline', async () => {
    const body = 'Der Beschwerdeführer brachte vor. '.repeat(8);
    const html = Array.from({ length: 400 }, (_, i) => `<p>xPARAx${i}x ${body}</p>`).join('\n');
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/Bvwg/JJT_20260101_BVWG_001'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'Bvwg',
      documentNumber: 'JJT_20260101_BVWG_001',
    });
    const result = await risDocumentResource.handler(params, ctx);

    expect(result).toContain('Part 1 of ');
    expect(result).toContain('contiguous windows');
    expect(result).toContain('ris_get_document');
    // The roster is windows, and the heading says so — this surface carries only names and
    // byte sizes, so calling them sections is the only thing that could correct the reader.
    expect(result).toMatch(/\*\*\d+ windows\*\*/u);
    expect(result).not.toContain('sections** (retrieve');
    // The body is not inlined — only the roster and the notice.
    expect(result).not.toContain('xPARAx0x');
  });

  it('returns markdown text in full for a document under the budget', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Kurzer <b>Text</b></p>',
      byteSize: 24,
      url: 'https://x',
    });
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const result = await risDocumentResource.handler(params, ctx);
    expect(result).toContain('Text');
    expect(result).not.toContain('sections');
  });
});

describe('risDocumentResource — error mapping', () => {
  // The handler's `.catch()` re-maps errors surfaced while resolving/fetching the document
  // onto this resource's declared contract: NotFound becomes document_not_found and
  // ServiceUnavailable becomes upstream_error.
  it('maps a fetchDocumentContent NotFound rejection to the document_not_found contract error', async () => {
    fetchDocumentContent.mockRejectedValue(notFound('RIS content host returned 404.', {}));
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const err = await captureError(risDocumentResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'document_not_found' });
  });

  it('maps a fetchDocumentContent ServiceUnavailable rejection to the upstream_error contract error', async () => {
    fetchDocumentContent.mockRejectedValue(
      serviceUnavailable('RIS returned HTTP 500 with no error envelope.', { status: 500 }),
    );
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const err = await captureError(risDocumentResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a content-fetch deadline to upstream_timeout with the cold-render recovery', async () => {
    // Since 0.10.17 a fetch deadline is Timeout, not ServiceUnavailable — undeclared here, it
    // reached the wire as a bare -32004. It gets its own reason rather than a widened
    // upstream_error guard, since ctx.fail resolves the code from the contract entry.
    fetchDocumentContent.mockRejectedValue(
      timeout('fetch GET https://www.ris.bka.gv.at/Dokumente timed out.', {}),
    );
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const err = await captureError(risDocumentResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('renders a document on first request'),
    });
  });
});
