/**
 * @fileoverview Tests for the ris_get_document tool — local addressing/URL-allowlist guards
 * (rejected before any network call), format handling (markdown/html/xml/urls_only) across
 * full, authentic_pdf_only, pdf_only, and metadata-only applications, overflow-to-outline and
 * selective section retrieval, error-contract mapping, and format() parity. The RIS service module is mocked so the
 * suite is fully offline: `buildDocumentContentUrl` delegates to a real `RisService`
 * instance (pure URL construction — no network), `fetchDocumentContent` is a `vi.fn()`
 * resolving canned content.
 * @module tests/tools/ris-get-document.tool.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risGetDocument } from '@/mcp-server/tools/definitions/ris-get-document.tool.js';
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
    (application: string, documentNumber: string, format: RisContentFormat) =>
      real.buildDocumentContentUrl(application, documentNumber, format),
  );
  return {
    ...actual,
    getRisService: () => ({ buildDocumentContentUrl, fetchDocumentContent }),
  };
});

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(promise: Promise<unknown>): Promise<McpError> {
  const err = await promise.catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

/**
 * HTML whose markdown conversion exceeds the outline budget (~720 KB), split into 15
 * `## Artikel N` sections each carrying a section-unique `xSECTIONxNx` token so a selective
 * re-call can be checked to return only the requested section's text.
 */
function oversizedArticlesHtml(): string {
  const body = (n: number) => `<p>${`xSECTIONx${n}x `.repeat(4000)}</p>`;
  return Array.from({ length: 15 }, (_, i) => `<h2>Artikel ${i + 1}</h2>${body(i + 1)}`).join('\n');
}

beforeEach(() => {
  buildDocumentContentUrl.mockClear();
  fetchDocumentContent.mockReset();
});

describe('risGetDocument — addressing guards (no fetch)', () => {
  it('rejects when neither addressing mode is provided', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({});
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_addressing' });
    expect(err.message).toContain('document_number together with application');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects when both addressing modes are provided', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
      document_url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_addressing' });
    expect(err.message).toContain('not both addressing modes');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects document_number without application', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({ document_number: 'NOR40262691' });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_addressing' });
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects application without document_number', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({ application: 'BrKons' });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_addressing' });
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects a document_url on the wrong host as unsupported_url', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: 'https://example.com/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('only https://www.ris.bka.gv.at URLs are fetchable');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects a document_url outside the /Dokumente/ tree as unsupported_url', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('outside the /Dokumente/ tree');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });
});

describe('risGetDocument — format handling', () => {
  it('converts the HTML rendition to markdown by default', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Hello <b>World</b></p>',
      byteSize: 25,
      contentType: 'text/html',
      url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.format).toBe('markdown');
    expect(result.text).toContain('World');
    expect(result.text).not.toContain('<b>');
    expect(result.binding_status).toBe('consolidated_informational');
    expect(fetchDocumentContent).toHaveBeenCalledWith(expect.stringContaining('.html'), ctx);
  });

  it('returns the raw HTML rendition unconverted for format: html', async () => {
    const html = '<p>Hello <b>World</b></p>';
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
      format: 'html',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBe(html);
    expect(fetchDocumentContent).toHaveBeenCalledWith(expect.stringContaining('.html'), ctx);
  });

  it('fetches the XML rendition and returns it raw for format: xml', async () => {
    const xml = '<Dokument><Titel>Test</Titel></Dokument>';
    fetchDocumentContent.mockResolvedValue({ text: xml, byteSize: xml.length, url: 'https://x' });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
      format: 'xml',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBe(xml);
    expect(fetchDocumentContent).toHaveBeenCalledWith(expect.stringContaining('.xml'), ctx);
  });

  it('returns every rendition URL and skips the fetch for format: urls_only', async () => {
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BgblAuth',
      format: 'urls_only',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBeUndefined();
    expect(result.binding_status).toBe('authentic');
    expect(result.content_urls.html).toBe(
      'https://www.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.html',
    );
    expect(result.content_urls.pdf).toBe(
      'https://www.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.pdf',
    );
    expect(result.content_urls.rtf).toBe(
      'https://www.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.rtf',
    );
    expect(result.content_urls.xml).toBe(
      'https://www.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.xml',
    );
    // BgblAuth is authentic-binding — the signed .pdfsig is derived from the .pdf URL.
    expect(result.authentic_pdf_url).toBe(
      'https://www.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.pdfsig',
    );
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });
});

describe('risGetDocument — format_unavailable degradation (notice, not error)', () => {
  it('surfaces authentic_pdf_url and a notice for an authentic_pdf_only application', async () => {
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'BVB_BU_JE_20260703_9',
      application: 'Bvb',
      format: 'markdown',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBeUndefined();
    expect(result.content_urls).toEqual({});
    expect(result.authentic_pdf_url).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Bvb/BVB_BU_JE_20260703_9/BVB_BU_JE_20260703_9.pdfsig',
    );
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Bvb publishes only the signed authentic PDF');
    expect(notice).toContain(result.authentic_pdf_url as string);
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('surfaces content_urls.pdf and a notice for a pdf_only application', async () => {
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'UPTS_2026_1',
      application: 'Upts',
      format: 'html',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBeUndefined();
    expect(result.content_urls.pdf).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Upts/UPTS_2026_1/UPTS_2026_1.pdf',
    );
    expect(result.authentic_pdf_url).toBeUndefined();
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Upts publishes a PDF only');
    expect(notice).toContain(result.content_urls.pdf as string);
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('surfaces no content URLs and the ÖNB guidance for a metadata-only application', async () => {
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR12345',
      application: 'BgblAlt',
      format: 'xml',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBeUndefined();
    expect(result.content_urls).toEqual({});
    expect(result.authentic_pdf_url).toBeUndefined();
    expect(result.binding_status).toBe('historical_record');
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('metadata-only');
    expect(notice).toContain('ris_search_gazette');
    expect(buildDocumentContentUrl).not.toHaveBeenCalled();
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });
});

describe('risGetDocument — overflow (outline + selective retrieval)', () => {
  it('returns a §/Artikel section outline for an oversized markdown document', async () => {
    const html = oversizedArticlesHtml();
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const result = await risGetDocument.handler(input, ctx);

    expect(result.kind).toBe('outline');
    expect(result.truncated).toBe(true);
    expect(result.text).toBeUndefined();
    expect(result.byte_size).toBeGreaterThan(500_000);
    expect(result.sections?.length).toBeGreaterThanOrEqual(2);
    expect(result.sections?.map((section) => section.name)).toContain('Artikel 1');
    // Sections come largest-first with a positive byte size.
    expect(result.sections?.every((section) => section.bytes > 0)).toBe(true);
    // The content URLs for the whole artifact stay on the outline arm.
    expect(result.content_urls.html).toContain('/Dokumente/');

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('ris_get_document');
    expect(notice).toContain('sections');

    // format() renders the outline arm (kind + section names/sizes) for content[] clients.
    const text = (risGetDocument.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('outline');
    expect(text).toContain('Artikel 1');
    expect(text).toContain('truncated');
  });

  it('returns the selected section’s text on a sections re-call', async () => {
    const html = oversizedArticlesHtml();
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
      sections: ['Artikel 2'],
    });
    const result = await risGetDocument.handler(input, ctx);

    expect(result.kind).toBe('full');
    expect(result.sections).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.text).toContain('xSECTIONx2x');
    expect(result.text).not.toContain('xSECTIONx5x');
    expect(result.byte_size).toBeGreaterThan(0);
  });

  it('returns full text unchanged for a document under the budget', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Hello <b>World</b></p>',
      byteSize: 25,
      url: 'https://x',
    });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const result = await risGetDocument.handler(input, ctx);

    expect(result.kind).toBe('full');
    expect(result.text).toContain('World');
    expect(result.truncated).toBeUndefined();
    expect(result.sections).toBeUndefined();
    expect(result.byte_size).toBeLessThan(1000);
  });

  it('returns oversized raw html in full — no structural headings to outline', async () => {
    const bigText = 'A'.repeat(500_050);
    fetchDocumentContent.mockResolvedValue({
      text: bigText,
      byteSize: bigText.length,
      url: 'https://x',
    });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
      format: 'html',
    });
    const result = await risGetDocument.handler(input, ctx);

    expect(result.kind).toBe('full');
    expect(result.text).toHaveLength(500_050);
    expect(result.truncated).toBeUndefined();
    expect(result.sections).toBeUndefined();
    expect(result.content_urls.html).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    );
  });
});

describe('risGetDocument — error mapping', () => {
  // The handler's `.catch()` re-maps errors surfaced while resolving/fetching the document
  // onto this tool's declared contract: NotFound becomes document_not_found and
  // ServiceUnavailable becomes upstream_error — each carrying the original message plus
  // reason + recovery on the wire.
  it('maps a fetchDocumentContent NotFound rejection to the document_not_found contract error', async () => {
    fetchDocumentContent.mockRejectedValue(
      notFound('RIS content host returned 404.', { url: 'https://x' }),
    );
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'document_not_found' });
    expect(err.message).toContain('404');
  });

  it('maps a fetchDocumentContent ServiceUnavailable rejection to the upstream_error contract error', async () => {
    fetchDocumentContent.mockRejectedValue(serviceUnavailable('RIS content host timed out.', {}));
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });
});

describe('risGetDocument — format() parity', () => {
  it('renders every populated output field in format() text', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Hello <b>World</b></p>',
      byteSize: 25,
      url: 'https://www.ris.bka.gv.at/Dokumente/BgblAuth/NOR1/NOR1.html',
    });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({ document_number: 'NOR1', application: 'BgblAuth' });
    const result = await risGetDocument.handler(input, ctx);
    const text = (risGetDocument.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(result.document_number);
    expect(text).toContain(result.application);
    expect(text).toContain(result.binding_status);
    expect(text).toContain(String(result.byte_size));
    expect(text).toContain(result.authentic_pdf_url as string);
    for (const key of ['html', 'pdf', 'rtf', 'xml'] as const) {
      const url = result.content_urls[key];
      if (url !== undefined) expect(text).toContain(url);
    }
    expect(text).toContain('World');
  });
});
