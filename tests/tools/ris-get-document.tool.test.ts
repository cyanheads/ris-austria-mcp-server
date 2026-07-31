/**
 * @fileoverview Tests for the ris_get_document tool — local addressing/URL-allowlist guards
 * (rejected before any network call), format handling (markdown/html/xml/urls_only) across
 * full, authentic_pdf_only, pdf_only, and metadata-only applications, screen-reader-twin
 * stripping at the markdown boundary, overflow-to-outline and selective section retrieval
 * (including unmatched-selector disclosure), error-contract mapping, and format() parity. The
 * RIS service module is mocked so the suite is fully offline: `buildDocumentContentUrl`
 * delegates to a real `RisService` instance (pure URL construction — no network),
 * `fetchDocumentContent` is a `vi.fn()` resolving canned content — for the rendering cases,
 * real RIS markup captured under `tests/fixtures/ris/`.
 * @module tests/tools/ris-get-document.tool.test
 */

import { readFileSync } from 'node:fs';

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OUTLINE_BUDGET_BYTES,
  parseDocumentUrl,
  risGetDocument,
  selectDocumentSections,
} from '@/mcp-server/tools/definitions/ris-get-document.tool.js';
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

/**
 * HTML rendering to ~60 KB of markdown across 6 `## Artikel N` sections — a real government
 * bill's order of magnitude, and the band the budget moved through: over the current budget,
 * far under the 500,000 it used to be.
 */
function midSizedArticlesHtml(): string {
  const body = (n: number) => `<p>${`xSECTIONx${n}x `.repeat(1000)}</p>`;
  return Array.from({ length: 6 }, (_, i) => `<h2>Artikel ${i + 1}</h2>${body(i + 1)}`).join('\n');
}

/** Read a captured RIS rendition fixture as its raw body text. */
function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8');
}

/**
 * A real BrKons rendition excerpt carrying four `aria-hidden` / `sr-only` twin shapes.
 * Under the outline budget, no §/Artikel/Anlage headings.
 */
const SR_ONLY_HTML = fixture('document-brkons-sr-only.html');

/**
 * A real RegV rendition excerpt — three `Artikel N` sections, far under the outline budget.
 * The arm where an unmatched `sections` selector used to return the whole document silently.
 */
const ARTIKEL_SECTIONS_HTML = fixture('document-regv-artikel-sections.html');

/** Resolve the tool against canned rendition text. */
async function callTool(
  html: string,
  input: Record<string, unknown>,
): Promise<{
  ctx: ReturnType<typeof createMockContext>;
  result: Awaited<ReturnType<typeof risGetDocument.handler>>;
}> {
  fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
  const ctx = createMockContext();
  const parsed = risGetDocument.input.parse({
    document_number: 'NOR40262691',
    application: 'BrKons',
    ...input,
  });
  return { ctx, result: await risGetDocument.handler(parsed, ctx) };
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

  // Widening the accepted filename set is the whole security surface of this tool: a stem
  // that is neither the document number nor a companion document is content the tool would
  // fetch blind. The host + /Dokumente/ allowlist is unchanged and still rejects everything
  // outside it (the two cases above).
  it.each([
    ['an unknown filename prefix', 'Beilagen_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    ['a companion prefix with a non-UUID tail', 'Materialien_0001_not-a-uuid.html'],
    ['a companion prefix with no ordinal', 'Materialien_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    [
      'a companion filename with an unrenderable extension',
      'Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.exe',
    ],
    ['a bare sibling filename', 'index.html'],
    ['a percent-encoded traversal out of the document folder', '..%2F..%2Fetc%2Fpasswd.html'],
  ])('rejects %s as unsupported_url', async (_label, filename) => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: `https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/${filename}`,
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('neither a main-document rendition');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects a companion filename nested below the document folder as unsupported_url', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url:
        'https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15/payload.html',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  // Both decode sites in parseDocumentUrl are caller-reachable, and `decodeURIComponent`
  // throws a native URIError on a malformed escape. Escaping the errors-as-values boundary
  // would strand the caller with a contract-less "URI malformed" and no recovery hint.
  it('rejects malformed percent-encoding in the document-number position as unsupported_url', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/%ZZ/%ZZ.html',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('malformed % escape');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('content_urls'),
    });
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects malformed percent-encoding in the filename position as unsupported_url', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      // The document-number segment decodes cleanly — only the trailing filename is malformed.
      document_url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/%E0%A4%A.html',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('malformed % escape');
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

  it('resolves a main-document rendition document_url and fetches it', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Body</p>',
      byteSize: 11,
      url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const result = await risGetDocument.handler(input, ctx);
    // Reverse-mapped from the URL's path segment; the fetch is not over-rejected.
    expect(result.application).toBe('BrKons');
    expect(result.document_number).toBe('NOR40262691');
    expect(fetchDocumentContent).toHaveBeenCalledWith(expect.stringContaining('.html'), ctx);
  });
});

describe('risGetDocument — companion documents (materials)', () => {
  const FOLDER =
    'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_8E53444F_FF2D_4C7A_944B_B79785E8F290';
  const ERLAEUTERUNGEN = 'Materialien_0001_2716E555_EB43_4642_A87A_3CF88FFCDB08';

  /** Resolve a companion document_url against canned rendition text. */
  async function callWithUrl(
    documentUrl: string,
    format?: 'markdown' | 'html' | 'xml' | 'urls_only',
  ) {
    fetchDocumentContent.mockResolvedValue({
      text: '<h1>Erläuterungen</h1><p>Zu Artikel 1</p>',
      byteSize: 40,
      url: documentUrl,
    });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_url: documentUrl,
      ...(format !== undefined && { format }),
    });
    return { ctx, result: await risGetDocument.handler(input, ctx) };
  }

  // A companion's filename is opaque and per-record, so the URL from a ris_search_drafts
  // record's materials is the only handle — reconstructing {documentNumber}.{ext} fetches
  // the bill instead. That substitution is what #6 stopped by rejecting the URL outright;
  // the fetch now carries the companion stem through.
  it('fetches the companion rendition itself, not the parent document', async () => {
    const { ctx, result } = await callWithUrl(`${FOLDER}/${ERLAEUTERUNGEN}.html`);

    expect(fetchDocumentContent).toHaveBeenCalledWith(`${FOLDER}/${ERLAEUTERUNGEN}.html`, ctx);
    expect(result.text).toContain('Erläuterungen');
    expect(result.application).toBe('Begut');
    expect(result.document_number).toBe('BEGUT_8E53444F_FF2D_4C7A_944B_B79785E8F290');
  });

  it.each([
    ['Materialien', `${FOLDER}/Materialien_0002_55843001_EEE2_4D11_AFF3_79A7A2A9D637.rtf`],
    ['Schreiben', `${FOLDER}/Schreiben_0002_C0BFE98B_E9CD_4ABB_A7C2_A339C59413FB.pdf`],
    ['Anlagen', `${FOLDER}/Anlagen_0001_3B3F31A7_CD7C_49D0_A5F6_D08C607C1620.xml`],
  ])('accepts a %s_ companion URL whatever rendition it names', async (_prefix, documentUrl) => {
    // The requested format still selects the rendition, exactly as for a main document —
    // markdown reads the companion's HTML twin rather than the .rtf/.pdf/.xml passed in.
    const { ctx } = await callWithUrl(documentUrl);
    const stem = documentUrl
      .split('/')
      .pop()
      ?.replace(/\.\w+$/u, '');
    expect(fetchDocumentContent).toHaveBeenCalledWith(`${FOLDER}/${stem}.html`, ctx);
  });

  it('fetches the companion XML rendition for format: xml', async () => {
    const { ctx } = await callWithUrl(`${FOLDER}/${ERLAEUTERUNGEN}.html`, 'xml');
    expect(fetchDocumentContent).toHaveBeenCalledWith(`${FOLDER}/${ERLAEUTERUNGEN}.xml`, ctx);
  });

  // RIS 404s the renditions it does not list for a companion: RTF is published for well
  // under half of them and the signed .pdfsig for none, so advertising either would hand
  // the caller a dead URL.
  it('carries the companion’s own content_urls and no authentic PDF', async () => {
    const { result } = await callWithUrl(`${FOLDER}/${ERLAEUTERUNGEN}.html`, 'urls_only');

    expect(result.content_urls).toEqual({
      xml: `${FOLDER}/${ERLAEUTERUNGEN}.xml`,
      html: `${FOLDER}/${ERLAEUTERUNGEN}.html`,
      pdf: `${FOLDER}/${ERLAEUTERUNGEN}.pdf`,
    });
    expect(result.content_urls.rtf).toBeUndefined();
    expect(result.authentic_pdf_url).toBeUndefined();
  });
});

describe('risGetDocument — screen-reader twins (markdown only)', () => {
  // RIS ships each abbreviated citation twice: the visible form in <span aria-hidden="true">
  // and a spelled-out expansion in <span class="sr-only">. Translated as-is they concatenate
  // with no separator, corrupting the legal text and inflating every derived byte figure.
  it('keeps the visible citation and drops its screen-reader expansion', async () => {
    const { result } = await callTool(SR_ONLY_HTML, {});
    const text = result.text as string;

    expect(text).toContain('BGBl. I Nr. 165/1999 zuletzt geändert durch BGBl. I Nr. 70/2024');
    expect(text).not.toContain('Bundesgesetzblatt Teil eins');
    // The heading twins used to concatenate into "§/Artikel/AnlageParagraph/Artikel/Anlage".
    expect(text).toContain('# §/Artikel/Anlage\n');
    expect(text).not.toContain('Paragraph/Artikel/Anlage');
    expect(text).toContain('§ 0');
    expect(text).not.toContain('Paragraph 0');
    // A visible twin wrapping a nested element survives whole.
    expect(text).toContain('(Anm.: §§ 2 und 3 aufgehoben durch BGBl. I Nr. 14/2019)');
    expect(text).not.toContain('Anmerkung,');
  });

  // node-html-markdown swaps to a separate translator collection inside a table cell, so a
  // strip registered only on the top-level collection leaves RIS's Inhaltsverzeichnis and
  // Anmerkungen tables — which carry twins of their own — duplicated.
  it('drops the twins inside table cells too', async () => {
    const { result } = await callTool(SR_ONLY_HTML, {});
    const text = result.text as string;

    expect(text).toContain('Inhaltsverzeichnis');
    expect(text).toContain('§ 1');
    expect(text).not.toContain('Paragraph eins');
    expect(text).toContain('Artikel 1');
    expect(text).not.toContain('Artikel 1, (Verfassungsbestimmung)');
  });

  it('reports byte_size as the real size of the returned text', async () => {
    const { result } = await callTool(SR_ONLY_HTML, {});
    expect(result.byte_size).toBe(new TextEncoder().encode(result.text as string).length);
  });

  // The authentic renditions are what a caller cites from — stripping anything there would
  // corrupt them. The strip lives at the markdown conversion boundary and nowhere else.
  it('passes the html rendition through byte-for-byte, sr-only spans intact', async () => {
    const { result } = await callTool(SR_ONLY_HTML, { format: 'html' });
    expect(result.text).toBe(SR_ONLY_HTML);
    expect(result.text).toContain('class="sr-only"');
    expect(result.text).toContain('Bundesgesetzblatt Teil eins');
  });

  it('passes the xml rendition through byte-for-byte, sr-only spans intact', async () => {
    const xml =
      '<Dokument><Text><span aria-hidden="true">§ 0</span><span class="sr-only">Paragraph 0</span></Text></Dokument>';
    const { result } = await callTool(xml, { format: 'xml' });
    expect(result.text).toBe(xml);
    expect(result.text).toContain('class="sr-only"');
    expect(result.text).toContain('Paragraph 0');
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
    expect(result.byte_size).toBeGreaterThan(OUTLINE_BUDGET_BYTES);
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

  // The budget was calibrated before the screen-reader strip roughly halved every rendered
  // byte count, and stopped reaching the government bills it was written for — they came
  // back whole at 144–199 KB. A document in this band routes through the outline again.
  it('outlines a document sized between the current budget and the pre-#16 calibration', async () => {
    const html = midSizedArticlesHtml();
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const result = await risGetDocument.handler(input, ctx);

    expect(result.byte_size).toBeGreaterThan(OUTLINE_BUDGET_BYTES);
    expect(result.byte_size).toBeLessThan(500_000);
    expect(result.kind).toBe('outline');
    expect(result.truncated).toBe(true);
    expect(result.text).toBeUndefined();
    expect(result.sections).toHaveLength(6);
    expect(getEnrichment(ctx).notice).toContain('too large to return in full');
  });

  // The budget bounds only segmentable markdown. Court decisions, gazette bodies and
  // consolidated promulgation records carry no §/Artikel/Anlage headings, so there is
  // nothing to outline and nothing for a sections:[…] re-call to name — they come back
  // whole rather than cut, which is what the tool description and docs/design.md state.
  it('returns a heading-free rendition whole however far over the budget', async () => {
    const html = `<p>${'Der Beschwerdeführer brachte vor. '.repeat(4000)}</p>`;
    fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
    const ctx = createMockContext();
    const input = risGetDocument.input.parse({
      document_number: 'JJT_20260101_BVWG_001',
      application: 'Bvwg',
    });
    const result = await risGetDocument.handler(input, ctx);

    expect(result.byte_size).toBeGreaterThan(OUTLINE_BUDGET_BYTES);
    expect(result.kind).toBe('full');
    expect(result.truncated).toBeUndefined();
    expect(result.sections).toBeUndefined();
    expect(result.text).toContain('Der Beschwerdeführer');
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

describe('risGetDocument — sections selector disclosure (under budget)', () => {
  // The overflow arm always disclosed a mismatch by re-emitting an outline. Under the byte
  // budget the same no-match used to fall through and return the whole document with
  // kind: full and no signal — the caller could not tell "your names were wrong" from
  // "that section really is that large".
  it('returns just the named section when the selector matches', async () => {
    const { ctx, result } = await callTool(ARTIKEL_SECTIONS_HTML, { sections: ['Artikel 2'] });

    expect(result.kind).toBe('full');
    expect(result.text).toContain('Änderung des Kinderbetreuungsgeldgesetzes');
    expect(result.text).not.toContain('Änderung des Familienlastenausgleichsgesetzes');
    expect(result.byte_size).toBe(new TextEncoder().encode(result.text as string).length);
    expect(result.sections).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('returns the section roster with a notice when the selector matches nothing', async () => {
    const { ctx, result } = await callTool(ARTIKEL_SECTIONS_HTML, { sections: ['Artikel 9999'] });

    expect(result.kind).toBe('outline');
    expect(result.truncated).toBe(true);
    expect(result.text).toBeUndefined();
    expect(result.sections?.map((section) => section.name)).toEqual([
      'Artikel 1',
      'Artikel 2',
      'Artikel 3',
    ]);
    const bytes = result.sections?.map((section) => section.bytes) ?? [];
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a));

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('"Artikel 9999"');
    expect(notice).toContain('matched nothing');
    // The disclosure a caller needs: this outline is a selector miss, not an oversized document.
    expect(notice).toContain('not a size overflow');
  });

  it('names the dropped entries when only some of the selector matches', async () => {
    const { ctx, result } = await callTool(ARTIKEL_SECTIONS_HTML, {
      sections: ['Artikel 2', 'Artikel 9999'],
    });

    expect(result.kind).toBe('full');
    expect(result.text).toContain('Änderung des Kinderbetreuungsgeldgesetzes');
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('"Artikel 9999"');
    expect(notice).toContain('was skipped');
  });

  // The notice used to send the caller back without sections:[…] "for the outline of all N
  // sections" — a re-call that only outlines a document over the byte budget and returns the
  // whole text for every document under it, which is where a partial miss is disclosed at
  // all. It names candidates from the roster it already holds instead.
  it('offers section names on a partial miss instead of promising an unreachable outline', async () => {
    const { ctx } = await callTool(ARTIKEL_SECTIONS_HTML, {
      sections: ['Artikel 2', 'Artikel 9999'],
    });
    const notice = getEnrichment(ctx).notice as string;

    expect(notice).toContain('3 §/Artikel/Anlage sections');
    expect(notice).toContain('copy a name verbatim');
    expect(notice).toContain('"Artikel 1"');
    expect(notice).not.toContain('without sections');

    // And the promise the old wording made is genuinely unreachable here: the same call
    // without sections:[…] returns the whole document, not an outline.
    const { result: reCall } = await callTool(ARTIKEL_SECTIONS_HTML, {});
    expect(reCall.kind).toBe('full');
    expect(reCall.sections).toBeUndefined();
  });

  it('says the selector was ignored on a rendition with no addressable sections', async () => {
    const { ctx, result } = await callTool(SR_ONLY_HTML, {
      format: 'html',
      sections: ['Artikel 2'],
    });

    expect(result.kind).toBe('full');
    expect(result.text).toBe(SR_ONLY_HTML);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('no §/Artikel/Anlage headings');
    expect(notice).toContain('"Artikel 2"');
  });
});

describe('selectDocumentSections', () => {
  const markdown = ['## Artikel 1\n\nxONEx', `## Artikel 2\n\n${'xTWOx '.repeat(40)}`].join('\n\n');

  it('reports matched text, unmatched names, and the largest-first roster', () => {
    const selection = selectDocumentSections(markdown, ['Artikel 2', 'Artikel 7']);
    expect(selection.text).toContain('xTWOx');
    expect(selection.text).not.toContain('xONEx');
    expect(selection.unmatched).toEqual(['Artikel 7']);
    // Largest first — Artikel 2 carries the bigger body.
    expect(selection.available.map((section) => section.name)).toEqual(['Artikel 2', 'Artikel 1']);
  });

  it('reports an empty text and every requested name when nothing matches', () => {
    const selection = selectDocumentSections(markdown, ['Artikel 7', 'Artikel 7', 'Anlage 1']);
    expect(selection.text).toBe('');
    // Deduplicated, in the order requested.
    expect(selection.unmatched).toEqual(['Artikel 7', 'Anlage 1']);
    expect(selection.available).toHaveLength(2);
  });

  it('reports an empty roster for text with no structural headings', () => {
    const selection = selectDocumentSections('<p>kein Titel</p>', ['Artikel 1']);
    expect(selection.available).toEqual([]);
    expect(selection.text).toBe('');
    expect(selection.unmatched).toEqual(['Artikel 1']);
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
    fetchDocumentContent.mockRejectedValue(
      serviceUnavailable('RIS returned HTTP 500 with no error envelope.', { status: 500 }),
    );
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a content-fetch deadline to upstream_timeout with the cold-render recovery', async () => {
    // fetchWithTimeout classifies its own deadline as Timeout, not ServiceUnavailable, so a
    // widened upstream_error guard would report -32000 for it (ctx.fail resolves the code
    // from the contract entry). The deadline also wants its own recovery: the content host
    // keeps rendering afterwards, so the caller should repeat the identical call.
    fetchDocumentContent.mockRejectedValue(
      timeout('fetch GET https://www.ris.bka.gv.at/Dokumente timed out.', {}),
    );
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('renders a document on first request'),
    });
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

describe('parseDocumentUrl (errors-as-values)', () => {
  const CONTENT_BASE = 'https://www.ris.bka.gv.at';

  it.each([
    ['Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    ['Anlagen_0002_1A2B3C4D_5E6F_7081_9A0B_C1D2E3F40506.pdf'],
    ['Schreiben_0002_C0BFE98B_E9CD_4ABB_A7C2_A339C59413FB.rtf'],
  ])('parses the companion URL %s to its filename stem', (filename) => {
    const parsed = parseDocumentUrl(
      `https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/${filename}`,
      CONTENT_BASE,
    );
    expect(parsed).toEqual({
      application: 'RegV',
      contentName: filename.replace(/\.\w+$/u, ''),
      documentNumber: 'REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39',
    });
  });

  // The accepted set widened by exactly three filename shapes; everything else in the
  // folder stays unaddressable, so a caller cannot steer the fetch at an arbitrary file.
  it.each([
    ['Beilagen_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    ['Materialien_0001_9D11747B.html'],
    ['Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.exe'],
    ['MaterialienX_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    ['..%2F..%2FDokumente%2Fother.html'],
  ])('rejects the non-addressable filename %s', (filename) => {
    const parsed = parseDocumentUrl(
      `https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/${filename}`,
      CONTENT_BASE,
    );
    expect(parsed).toHaveProperty('error');
    if ('error' in parsed) expect(parsed.error).toContain('neither a main-document rendition');
  });

  it('rejects a companion filename with a path segment below it', () => {
    const parsed = parseDocumentUrl(
      'https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15/payload.html',
      CONTENT_BASE,
    );
    expect(parsed).toHaveProperty('error');
  });

  it('parses main-document rendition URLs (.html/.pdf/.pdfsig) to {application, documentNumber}', () => {
    for (const ext of ['html', 'pdf', 'pdfsig'] as const) {
      const parsed = parseDocumentUrl(
        `https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.${ext}`,
        CONTENT_BASE,
      );
      expect(parsed).toEqual({ application: 'BrKons', documentNumber: 'NOR40262691' });
    }
  });

  it('returns a value, not a thrown URIError, for a malformed escape in either position', () => {
    for (const url of [
      'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/%ZZ/%ZZ.html',
      'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/%E0%A4%A.html',
    ]) {
      const parsed = parseDocumentUrl(url, CONTENT_BASE);
      expect(parsed).toHaveProperty('error');
      if ('error' in parsed) expect(parsed.error).toContain('malformed % escape');
    }
  });

  it('parses a folder URL with and without a trailing slash', () => {
    for (const suffix of ['', '/'] as const) {
      const parsed = parseDocumentUrl(
        `https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691${suffix}`,
        CONTENT_BASE,
      );
      expect(parsed).toEqual({ application: 'BrKons', documentNumber: 'NOR40262691' });
    }
  });
});
