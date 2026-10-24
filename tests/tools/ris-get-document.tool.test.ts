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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addressableSections,
  layoutLabelledItem,
  OUTLINE_BUDGET_BYTES,
  parseDocumentUrl,
  resolveOrdinalEscapes,
  risGetDocument,
  segmentDocument,
  selectDocumentSections,
  toMarkdown,
  windowDocument,
} from '@/mcp-server/tools/definitions/ris-get-document.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import type { RisContentFormat } from '@/services/ris/ris-service.js';

import { contentText, contractError, readCommonMark, type WireError } from './_wire.js';

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

/**
 * HTML rendering to heading-free markdown — a court decision's shape, the case the outline
 * could not reach. Every paragraph opens with its own ordinal token, so a window retrieval
 * can be checked to return one contiguous run and nothing from its neighbours. 400
 * paragraphs render to ~112 KB, 150 to ~42 KB (just over the budget).
 */
function headingFreeDecisionHtml(paragraphs: number): string {
  const body = 'Der Beschwerdeführer brachte vor. '.repeat(8);
  return Array.from({ length: paragraphs }, (_, i) => `<p>xPARAx${i}x ${body}</p>`).join('\n');
}

/**
 * `url` on the default content host. A `document_url`'s origin is dropped, so every rendition
 * URL the tool constructs or fetches lands there, whichever RIS origin the input carried (#75).
 */
function onContentHost(url: string): string {
  return url.replace(/^https:\/\/www\./u, 'https://ogd.');
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

/**
 * A real BrKons rendition excerpt (NOR40262455, DSG § 9): an Absatz list with an inserted
 * (1a), a nested Ziffer list with gaps in its numbering, a litera list, and a Schlussteil.
 */
const ABSATZ_LISTS_HTML = fixture('document-brkons-absatz-lists.html');

/**
 * A real BgblAuth rendition (BGBLA_2026_I_82): ordinals in running text, behind a heading and
 * a table-cell boundary, and amendment Absätze rendered as one-item lists.
 */
const ORDINALS_HTML = fixture('document-bgblauth-ordinals.html');

/** Resolve the tool against canned rendition text. */
async function callTool(html: string, input: Record<string, unknown>) {
  fetchDocumentContent.mockResolvedValue({ text: html, byteSize: html.length, url: 'https://x' });
  const ctx = createMockContext({ errors: risGetDocument.errors });
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
    expect(err.message).toContain(
      'only https://www.ris.bka.gv.at or https://ogd.ris.bka.gv.at URLs are fetchable',
    );
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
    ['a bare sibling filename', 'index.html'],
    ['a percent-encoded traversal out of the document folder', '..%2F..%2Fetc%2Fpasswd.html'],
    ['a double-encoded traversal', '..%252F..%252Fetc%252Fpasswd.html'],
    // The COO object address is accepted whole or not at all. A prefix or substring match
    // would take every one of these — the first is the shape RIS gives the per-record inline
    // formula images, ~55 per draft record, which must stay unaddressable.
    ['a COO stem carrying an embedded-attachment suffix', 'Material-COO_2026_100_2_1739564.html'],
    ['a COO stem with a trailing extra group', 'COO_2026_100_2_1739564_1739565.html'],
    ['a COO stem with a leading extra group', 'X_COO_2026_100_2_1739564.html'],
    ['a COO stem with a non-numeric group', 'COO_2026_100_2_17395a4.html'],
    ['a COO stem missing a group', 'COO_2026_100_2.html'],
  ])('rejects %s as unsupported_url', async (_label, filename) => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: `https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/${filename}`,
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('nor one of its companion documents');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  // The three refusal causes ask different things of the caller, so each names itself. The
  // filename-shape message used to be the only one, and it told a caller holding a refused
  // materials[].url to pass a URL exactly as a result returned it — which is what they did.
  it.each([
    [
      'an unrenderable extension',
      'Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.exe',
      'does not end in a RIS rendition extension',
    ],
    ['the inline formula images', 'Temp32a40c13-0e52-4a37-929c-9a7ec2216f11.0001.gif', 'extension'],
    ['a per-record inline image', 'ff25afc0-fb98-4fca-8fd6-af3cae338755.img1is.jpg', 'extension'],
  ])('rejects %s naming the extension as the cause', async (_label, filename, expected) => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: `https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/${filename}`,
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain(expected);
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
    expect(err.message).toContain('nests below the document folder');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  // Widening the filename set does not widen the host or path guard: a companion stem the
  // tool now accepts is still only reachable on the one allowlisted origin, inside
  // /Dokumente/. Every case here carries a filename the tool would fetch on the real host.
  const COMPANION = 'COO_2026_100_2_1739564.html';
  it.each([
    ['a host suffix', `https://www.ris.bka.gv.at.evil.example/Dokumente/Begut/B/${COMPANION}`],
    ['a host prefix', `https://evil-www.ris.bka.gv.at/Dokumente/Begut/B/${COMPANION}`],
    [
      'a userinfo-disguised host',
      `https://www.ris.bka.gv.at@evil.example/Dokumente/Begut/B/${COMPANION}`,
    ],
    ['a non-default port', `https://www.ris.bka.gv.at:8443/Dokumente/Begut/B/${COMPANION}`],
    ['an IDN homoglyph host', `https://www.ris.bka.gv.аt/Dokumente/Begut/B/${COMPANION}`],
    ['plain http', `http://www.ris.bka.gv.at/Dokumente/Begut/B/${COMPANION}`],
    ['a file: URL', `file:///Dokumente/Begut/B/${COMPANION}`],
    ['an ftp: URL', `ftp://www.ris.bka.gv.at/Dokumente/Begut/B/${COMPANION}`],
  ])('still rejects %s carrying an accepted companion filename', async (_label, documentUrl) => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({ document_url: documentUrl });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain(
      'only https://www.ris.bka.gv.at or https://ogd.ris.bka.gv.at URLs are fetchable',
    );
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it.each([
    ['a raw traversal, normalized out of the tree by the URL parser', '../../../etc/passwd.html'],
    ['a backslash traversal', '..\\..\\..\\etc\\passwd.html'],
  ])('still rejects %s off the allowlisted host', async (_label, tail) => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: `https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_100_2_1907098/${tail}`,
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('outside the /Dokumente/ tree');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects an overlong-UTF-8 encoded separator as a malformed escape', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url:
        'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_100_2_1907098/..%c0%af..%c0%afetc%c0%afpasswd.html',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('malformed % escape');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('rejects a fullwidth-solidus traversal as a non-addressable filename', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url:
        'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_100_2_1907098/..／..／etc／passwd.html',
    });
    const err = await captureError(risGetDocument.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unsupported_url' });
    expect(err.message).toContain('nor one of its companion documents');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  // Both decode sites in parseDocumentUrl are caller-reachable, and `decodeURIComponent`
  // throws a native URIError on a malformed escape. Escaping the errors-as-values boundary
  // would strand the caller with a contract-less "URI malformed" and no recovery hint.
  it('rejects malformed percent-encoding in the document-number position as unsupported_url', async () => {
    const err = await contractError(risGetDocument, {
      document_url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/%ZZ/%ZZ.html',
    });
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

describe('risGetDocument — the two RIS content origins (#43)', () => {
  /**
   * A live Begut search page trimmed to one record — RIS now hands out every rendition and
   * companion URL on `ogd.ris.bka.gv.at`, so these are the URLs a caller copies verbatim.
   */
  const [hit] = parseSearchResponse(JSON.parse(fixture('search-begut-ogd.json')) as unknown).hits;
  const MAIN_URL = hit?.contentUrls.html as string;
  const MATERIAL_URL = hit?.contentReferences.find((ref) => ref.type === 'Material')?.urls
    .html as string;

  it('carries ogd.ris.bka.gv.at URLs in the fixture', () => {
    expect(MAIN_URL).toMatch(/^https:\/\/ogd\.ris\.bka\.gv\.at\/Dokumente\/Begut\//u);
    expect(MATERIAL_URL).toMatch(
      /^https:\/\/ogd\.ris\.bka\.gv\.at\/Dokumente\/Begut\/.+\/Materialien_/u,
    );
  });

  it('resolves a main-document URL copied verbatim from a result', async () => {
    fetchDocumentContent.mockResolvedValue({ text: '<p>Body</p>', byteSize: 11, url: MAIN_URL });
    const result = await runToolContract(risGetDocument, { document_url: MAIN_URL });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      application: 'Begut',
      document_number: 'BEGUT_E811DCEF_7477_4213_9E06_D51ABE13740A',
      kind: 'full',
    });
    expect(fetchDocumentContent).toHaveBeenCalledOnce();
  });

  it('resolves a draft companion materials[].url copied verbatim from a result', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Erläuterungen</p>',
      byteSize: 20,
      url: 'x',
    });
    const result = await runToolContract(risGetDocument, { document_url: MATERIAL_URL });

    expect(result.isError).not.toBe(true);
    const stem = MATERIAL_URL.split('/')
      .pop()
      ?.replace(/\.html$/u, '');
    expect(fetchDocumentContent).toHaveBeenCalledWith(
      expect.stringContaining(
        `/Dokumente/Begut/BEGUT_E811DCEF_7477_4213_9E06_D51ABE13740A/${stem}.html`,
      ),
      expect.anything(),
    );
  });

  it('parses both origins to the same document', () => {
    const www = MAIN_URL.replace('https://ogd.', 'https://www.');
    expect(parseDocumentUrl(MAIN_URL, 'https://www.ris.bka.gv.at')).toEqual(
      parseDocumentUrl(www, 'https://www.ris.bka.gv.at'),
    );
  });

  it.each([
    ['another bka.gv.at host', 'https://data.bka.gv.at/Dokumente/Begut/B/B.html'],
    ['the bare ris.bka.gv.at host', 'https://ris.bka.gv.at/Dokumente/Begut/B/B.html'],
    ['plain http on the OGD host', 'http://ogd.ris.bka.gv.at/Dokumente/Begut/B/B.html'],
    ['an OGD-host suffix', 'https://ogd.ris.bka.gv.at.evil.example/Dokumente/Begut/B/B.html'],
    ['an OGD-host lookalike', 'https://ogd-ris.bka.gv.at/Dokumente/Begut/B/B.html'],
    [
      'a non-default port on the OGD host',
      'https://ogd.ris.bka.gv.at:8443/Dokumente/Begut/B/B.html',
    ],
  ])('still rejects %s as unsupported_url', async (_label, documentUrl) => {
    const result = await runToolContract(risGetDocument, { document_url: documentUrl });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { data?: { reason?: string }; message: string };
    };
    expect(error.data?.reason).toBe('unsupported_url');
    expect(error.message).toContain(
      'only https://www.ris.bka.gv.at or https://ogd.ris.bka.gv.at URLs are fetchable',
    );
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });
});

describe('risGetDocument — the content host (#75)', () => {
  const PATH = '/Dokumente/Bundesnormen/NOR40264172/NOR40264172.html';

  // www. answers automated clients with a bot-check page, so a URL a caller copied from an
  // older result — or from a browser — is only readable because the origin it arrived on is
  // dropped and the rendition is fetched from the configured content host.
  it.each([
    ['www.', `https://www.ris.bka.gv.at${PATH}`],
    ['ogd.', `https://ogd.ris.bka.gv.at${PATH}`],
  ])('fetches a document_url on %s from the default content host', async (_label, url) => {
    fetchDocumentContent.mockResolvedValue({ text: '<p>Body</p>', byteSize: 11, url });
    const result = await runToolContract(risGetDocument, { document_url: url });

    expect(result.isError).not.toBe(true);
    expect(fetchDocumentContent).toHaveBeenCalledOnce();
    const fetched = new URL(fetchDocumentContent.mock.calls[0]?.[0] as string);
    expect(fetched.origin).toBe('https://ogd.ris.bka.gv.at');
    expect(fetched.pathname).toBe(PATH);
  });

  it('maps a bot-check page to content_host_blocked — not retryable, operator recovery on both surfaces', async () => {
    fetchDocumentContent.mockRejectedValue(
      configurationError(
        'RIS content host https://www.ris.bka.gv.at answered with a bot-check page instead of the document.',
        { reason: 'content_host_blocked', retryable: false },
      ),
    );
    const result = await runToolContract(risGetDocument, {
      document_number: 'NOR40264172',
      application: 'BrKons',
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as { error: WireError };
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.data).toMatchObject({ reason: 'content_host_blocked', retryable: false });
    const hint = (error.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
    expect(hint).toContain('RIS_CONTENT_BASE_URL');
    expect(hint).toContain('https://ogd.ris.bka.gv.at');
    expect(hint).toContain('server operator');

    const text = readCommonMark(contentText(result));
    expect(text).toContain(error.message);
    expect(text).toContain(hint);
    expect(text).toContain('reason content_host_blocked · not retryable');
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'NOR40262691',
      application: 'BgblAuth',
      format: 'urls_only',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBeUndefined();
    expect(result.binding_status).toBe('authentic');
    expect(result.content_urls.html).toBe(
      'https://ogd.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.html',
    );
    expect(result.content_urls.pdf).toBe(
      'https://ogd.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.pdf',
    );
    expect(result.content_urls.rtf).toBe(
      'https://ogd.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.rtf',
    );
    expect(result.content_urls.xml).toBe(
      'https://ogd.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.xml',
    );
    // BgblAuth is authentic-binding — the signed .pdfsig is derived from the .pdf URL.
    expect(result.authentic_pdf_url).toBe(
      'https://ogd.ris.bka.gv.at/Dokumente/BgblAuth/NOR40262691/NOR40262691.pdfsig',
    );
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('resolves a main-document rendition document_url and fetches it', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Body</p>',
      byteSize: 11,
      url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const result = await risGetDocument.handler(input, ctx);
    // Reverse-mapped from the URL's path segment; the fetch is not over-rejected.
    expect(result.application).toBe('BrKons');
    expect(result.document_number).toBe('NOR40262691');
    expect(fetchDocumentContent).toHaveBeenCalledWith(expect.stringContaining('.html'), ctx);
  });

  it('reads a blank document_url beside document_number + application as unset, not as a second address', async () => {
    // Unlike the search tools' text filters, a blank addressing field never widens anything:
    // it cannot select a document, so a form client's empty document_url stays harmless.
    fetchDocumentContent.mockResolvedValue({ text: '<p>Body</p>', byteSize: 11, url: 'https://x' });
    const result = await runToolContract(risGetDocument, {
      application: 'BrKons',
      document_number: 'NOR40262691',
      document_url: '',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      application: 'BrKons',
      document_number: 'NOR40262691',
    });
    expect(fetchDocumentContent).toHaveBeenCalledOnce();
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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

    expect(fetchDocumentContent).toHaveBeenCalledWith(
      onContentHost(`${FOLDER}/${ERLAEUTERUNGEN}.html`),
      ctx,
    );
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
    expect(fetchDocumentContent).toHaveBeenCalledWith(onContentHost(`${FOLDER}/${stem}.html`), ctx);
  });

  it('fetches the companion XML rendition for format: xml', async () => {
    const { ctx } = await callWithUrl(`${FOLDER}/${ERLAEUTERUNGEN}.html`, 'xml');
    expect(fetchDocumentContent).toHaveBeenCalledWith(
      onContentHost(`${FOLDER}/${ERLAEUTERUNGEN}.xml`),
      ctx,
    );
  });

  // RIS names companions two ways and the ordinal+UUID shape belongs to its 2026 records
  // only: across the full live Begut + RegV corpus (7,185 records, 23,483 companions, drafts
  // from 2003 through 2026) every companion filed before 2026 carries the Fabasoft object
  // address instead — 18,719 of them, four URLs in five that ris_search_drafts hands out.
  const LEGACY_FOLDER = 'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_100_2_1907098';
  const LEGACY_COMPANION = 'COO_2026_100_2_1907114';

  it.each([
    ['the Fabasoft object address', LEGACY_FOLDER, LEGACY_COMPANION],
    [
      'an ordinal+UUID stem with no prefix',
      'https://www.ris.bka.gv.at/Dokumente/RegV/REGV_E4CDB2DB_B883_4091_A779_6D901258C2BB',
      '0001_F303A247_1202_45A5_8C35_1B19542E0A7E',
    ],
  ])('fetches a companion named with %s', async (_label, folder, stem) => {
    const { ctx, result } = await callWithUrl(`${folder}/${stem}.html`);

    expect(fetchDocumentContent).toHaveBeenCalledWith(onContentHost(`${folder}/${stem}.html`), ctx);
    expect(result.text).toContain('Erläuterungen');
    expect(result.document_number).toBe(folder.split('/').pop());
  });

  it.each(['markdown', 'html', 'xml'] as const)(
    'serves format: %s from a Fabasoft-named companion URL',
    async (format) => {
      const { ctx, result } = await callWithUrl(`${LEGACY_FOLDER}/${LEGACY_COMPANION}.pdf`, format);
      // The extension passed in is discarded — format picks the rendition, for a legacy-named
      // companion exactly as for a 2026-named one.
      expect(fetchDocumentContent).toHaveBeenCalledWith(
        onContentHost(`${LEGACY_FOLDER}/${LEGACY_COMPANION}.${format === 'xml' ? 'xml' : 'html'}`),
        ctx,
      );
      expect(result.format).toBe(format);
      expect(result.text).toBeDefined();
    },
  );

  it('carries a Fabasoft-named companion’s own content_urls for urls_only', async () => {
    const { result } = await callWithUrl(`${LEGACY_FOLDER}/${LEGACY_COMPANION}.html`, 'urls_only');

    expect(result.content_urls).toEqual({
      xml: onContentHost(`${LEGACY_FOLDER}/${LEGACY_COMPANION}.xml`),
      html: onContentHost(`${LEGACY_FOLDER}/${LEGACY_COMPANION}.html`),
      pdf: onContentHost(`${LEGACY_FOLDER}/${LEGACY_COMPANION}.pdf`),
    });
    expect(result.document_number).toBe('BEGUT_COO_2026_100_2_1907098');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  // 2,829 of the 23,483 live companions (12.0%) are filed as PDF, or PDF and RTF, with no
  // html or xml twin — nearly all of them review-draft covering letters — and RIS answers 404
  // for a rendition it does not list. The contract's own recovery is written for the
  // document_number + application mode and would send this caller to re-copy an identifier
  // they never passed.
  it('recovers a companion 404 by naming the missing rendition, not the document number', async () => {
    fetchDocumentContent.mockRejectedValue(
      notFound('RIS content host returned 404.', { url: 'https://x' }),
    );
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_url: `${LEGACY_FOLDER}/COO_2026_100_2_1907117.html`,
    });
    const err = await captureError(risGetDocument.handler(input, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'document_not_found' });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('no markdown rendition'),
    });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('urls_only'),
    });
    expect(err.data?.recovery).not.toMatchObject({
      hint: expect.stringContaining('document_number'),
    });
  });

  it('keeps the document-number recovery for a main-document 404', async () => {
    fetchDocumentContent.mockRejectedValue(
      notFound('RIS content host returned 404.', { url: 'https://x' }),
    );
    const err = await contractError(risGetDocument, {
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('ris_lookup_citation'),
    });
  });

  // RIS 404s the renditions it does not list for a companion: RTF is published for many but
  // not all of them and the signed .pdfsig for none, so advertising either would hand the
  // caller a dead URL.
  it('carries the companion’s own content_urls and no authentic PDF', async () => {
    const { result } = await callWithUrl(`${FOLDER}/${ERLAEUTERUNGEN}.html`, 'urls_only');

    expect(result.content_urls).toEqual({
      xml: onContentHost(`${FOLDER}/${ERLAEUTERUNGEN}.xml`),
      html: onContentHost(`${FOLDER}/${ERLAEUTERUNGEN}.html`),
      pdf: onContentHost(`${FOLDER}/${ERLAEUTERUNGEN}.pdf`),
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

/** Indentation plus first token of every non-blank line — the label column of a list. */
function lineHeads(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => /^\s*\S+/u.exec(line)?.[0] ?? '');
}

/** A generated list ordinal standing in front of a statutory label (`1. (2)`, `3. 6.`, `2. b)`). */
const ORDINAL_BEFORE_LABEL = /^\s*\d+\. („?\(\d+[a-z]*\)|„?\d+[a-z]*\.|„?[a-z]{1,2}\))/mu;

describe('risGetDocument — statutory list labels in markdown (#52)', () => {
  // RIS labels every Absatz (span.Absatzzahl) and Ziffer/litera (div.SymE1/2/3) itself; the
  // generated list ordinal in front of it numbered (1a) as "2." and every one-item amendment
  // list as "1.", so a caller quoting "Abs. 2" read a competing "3.".
  it('renders each label once, then one space, then its text, indented by nesting level', async () => {
    const { result } = await callTool(ABSATZ_LISTS_HTML, {});
    const text = result.text as string;
    const paragraph = text.slice(text.indexOf('### § 9.'));

    expect(lineHeads(paragraph)).toEqual([
      '###',
      '(1)',
      '  1.',
      '  2.',
      '  6.',
      '    a)',
      '    b)',
      '    c)',
      // Ziffer 6's Schlussteil, after its litera list, at Ziffer 6's indentation.
      '  In',
      '  7.',
      '(1a)',
      '(2)',
    ]);
    expect(paragraph).toContain('\n(1) Für die Verarbeitung personenbezogener Daten');
    expect(paragraph).toContain('\n  6. Art. 16 (Recht auf Berichtigung)');
    expect(paragraph).toContain(
      '\n    a) in Bezug auf personenbezogene Daten, auf deren Grundlage',
    );
    expect(paragraph).toContain('\n  In allen anderen Fällen ist der Verantwortliche');
    expect(paragraph).toContain('\n(1a) Für die nicht von Abs. 1 erfasste Verarbeitung');
    // No break of any kind between a label and its text.
    for (const line of paragraph.split('\n').slice(1)) {
      if (line.trim() !== '') expect(line).toMatch(/^\s*\S+ \S/u);
    }
  });

  it('never puts a generated ordinal in front of a label', async () => {
    for (const html of [ABSATZ_LISTS_HTML, ORDINALS_HTML, ARTIKEL_SECTIONS_HTML]) {
      const { result } = await callTool(html, {});
      expect(result.text).not.toMatch(ORDINAL_BEFORE_LABEL);
    }
  });

  it('renders one-item amendment lists with their quoted label, Schlussteil at the item indent', async () => {
    const { result } = await callTool(ORDINALS_HTML, {});
    const text = result.text as string;
    const amendments = text.slice(text.indexOf('\n1. Dem § 63'));

    expect(lineHeads(amendments)).toEqual([
      '1.',
      '„(12)',
      '2.',
      '„(5)',
      '  a)',
      '  b)',
      'ermäßigen,',
      'Van',
      'Stocker',
    ]);
    expect(amendments).toContain('\n„(12) § 64 Abs. 5 in der Fassung');
    expect(amendments).toContain('\n„(5) Abweichend von Abs. 1 und 2');
    expect(amendments).toContain('\n  a) 67 Euro je 1 000 l bei Benzin');
  });

  // The rule keys on the label element. A list item without one keeps the converter's
  // marker, whatever its list's class; a labelled item drops it, whatever its list's class.
  it('keeps the generated marker on an item with no statutory label', async () => {
    const { result } = await callTool(
      '<ol class="wai-list"><li><div class="content"><div>Erstens</div></div></li><li><div class="content"><div>Zweitens</div></div></li></ol><ul><li>Punkt</li></ul>',
      {},
    );
    expect(result.text).toBe('1. Erstens\n2. Zweitens\n* Punkt');
  });

  it('drops the generated marker on a labelled item in a list of any class', async () => {
    const { result } = await callTool(
      '<ol><li><div class="SymE1"><div><span aria-hidden="true">4.</span><span class="sr-only">Ziffer 4</span></div></div><div class="content"><div>Vierte Ziffer</div></div></li></ol>',
      {},
    );
    expect(result.text).toBe('4. Vierte Ziffer');
  });

  // RIS's stylesheet defines SymE1–SymE7, one per nesting level below the Absatz.
  it('drops the generated marker below the third nesting level (div.SymE4–SymE7)', async () => {
    for (const [level, label] of [
      [4, 'aaa)'],
      [7, 'aaaaaa)'],
    ] as const) {
      const { result } = await callTool(
        `<ol class="wai-list"><li><div class="SymE${level}"><div>${label}</div></div><div class="content"><div>Tiefe Ebene</div></div></li></ol>`,
        {},
      );
      expect(result.text).toBe(`${label} Tiefe Ebene`);
    }
  });

  it('leaves an item labelled by any other SymE class to the converter', async () => {
    const { result } = await callTool(
      '<ol class="wai-list"><li><div class="SymE0"><div>x)</div></div><div class="content"><div>Text</div></div></li></ol>',
      {},
    );
    expect(result.text).toMatch(/^1\. x\)/u);
  });

  // The generated list used to keep every line apart; without it, a renderer joins two lines
  // that are not separated by a hard break (two trailing spaces) into one paragraph.
  it('keeps every line of a labelled list on its own rendered line', async () => {
    const { result } = await callTool(ABSATZ_LISTS_HTML, {});
    const text = result.text as string;
    const lines = text.slice(text.indexOf('\n(1) Für') + 1).split('\n');

    expect(lines).toHaveLength(11);
    for (const line of lines.slice(0, -1)) expect(line).toMatch(/\S {2}$/u);
    expect(lines.at(-1)).toMatch(/anzuwenden\.$/u);
    expect(text).toContain('besteht.  \n  In allen anderen Fällen');
  });

  it('keeps the hard breaks between the sentences, Ziffern, and notes of one Absatz', async () => {
    const { result } = await callTool(
      '<ol class="wai-absatz-list"><li><div class="content"><div class="Abs"><span class="Absatzzahl">(2)</span>Dazu gehören:</div><ol class="wai-list"><li><div class="SymE1"><div>1.</div></div><div class="content"><div>Satz eins.</div><div>Satz zwei.</div></div></li><li><div class="SymE1"><div>2.</div></div><div class="content"><div>Letzte Ziffer.</div></div></li></ol><p>(Anm.: Abs. 3 aufgehoben)</p></div></li><li><div class="content"><div class="Abs"><span class="Absatzzahl">(4)</span>Weiter.</div></div></li></ol>',
      {},
    );
    expect(result.text).toBe(
      '(2) Dazu gehören:  \n  1. Satz eins.  \n  Satz zwei.  \n  2. Letzte Ziffer.  \n(Anm.: Abs. 3 aufgehoben)  \n(4) Weiter.',
    );
  });

  it('carries the labels and unescaped ordinals into content[] as well', async () => {
    for (const [html, expected] of [
      [ABSATZ_LISTS_HTML, '\n(1a) Für die nicht von Abs. 1'],
      [ORDINALS_HTML, 'tritt mit 1. Oktober 2026 in Kraft'],
    ] as const) {
      fetchDocumentContent.mockResolvedValue({ text: html, byteSize: 1, url: 'https://x' });
      const result = await runToolContract(risGetDocument, {
        document_number: 'NOR40262455',
        application: 'BrKons',
      });
      const text = (result.structuredContent as { text: string }).text;
      expect(text).toContain(expected);
      expect(contentText(result)).toContain(text);
      expect(contentText(result)).not.toMatch(ORDINAL_BEFORE_LABEL);
    }
  });

  it('keeps html and xml byte-identical for a list-bearing document', async () => {
    for (const format of ['html', 'xml'] as const) {
      const { result } = await callTool(ABSATZ_LISTS_HTML, { format });
      expect(result.text).toBe(ABSATZ_LISTS_HTML);
    }
  });

  it('still drops the screen-reader twins inside list items', async () => {
    const { result } = await callTool(ABSATZ_LISTS_HTML, {});
    const text = result.text as string;
    expect(text).not.toContain('Absatz eins');
    expect(text).not.toContain('Ziffer eins');
    expect(text).toContain('MedienG, BGBl. Nr. 314/1981');
    expect(text).not.toContain('Bundesgesetzblatt Nr. 314 aus 1981');
  });

  it('leaves the §/Artikel/Anlage section names of list-bearing documents unchanged', async () => {
    const names = async (html: string) => {
      const { result } = await callTool(html, {});
      return segmentDocument(result.text as string).map((section) => section.name);
    };
    expect(await names(ABSATZ_LISTS_HTML)).toEqual(['Präambel', '§ 9']);
    expect(await names(ORDINALS_HTML)).toEqual([]);
    expect(await names(ARTIKEL_SECTIONS_HTML)).toEqual(['Artikel 1', 'Artikel 2', 'Artikel 3']);
  });

  // byte_size and every outline entry's size are measured on the text the caller receives.
  it('sizes byte_size and outline entries from the rendered labels', async () => {
    const block = ABSATZ_LISTS_HTML.slice(
      ABSATZ_LISTS_HTML.indexOf('<ol class="wai-absatz-list">'),
      ABSATZ_LISTS_HTML.lastIndexOf('</ol>') + '</ol>'.length,
    );
    const html = Array.from({ length: 12 }, (_, i) => `<h2>Artikel ${i + 1}</h2>${block}`).join('');

    const { result: outline } = await callTool(html, {});
    expect(outline.kind).toBe('outline');
    const entry = outline.sections?.find((section) => section.name === 'Artikel 3');
    const { result: picked } = await callTool(html, { sections: ['Artikel 3'] });
    const text = picked.text as string;

    expect(text).toContain('\n(1a) Für die nicht von Abs. 1');
    expect(text).not.toMatch(ORDINAL_BEFORE_LABEL);
    expect(entry?.bytes).toBe(new TextEncoder().encode(text).length);
    expect(picked.byte_size).toBe(new TextEncoder().encode(text).length);
  });
});

describe('risGetDocument — ordinal escapes in markdown (#60)', () => {
  // node-html-markdown escapes every "N. " in a text node, not just one that starts a line, so
  // quoted dates and enumerations carried a stray backslash: "mit 1\. Oktober 2026".
  it('leaves no backslash in an ordinal that does not start a line', async () => {
    const { result } = await callTool(ORDINALS_HTML, {});
    const text = result.text as string;

    expect(text).toContain('Ausgegeben am 30. September 2026');
    expect(text).toContain(
      'tritt mit 1. Oktober 2026 in Kraft und mit Ablauf des 30. November 2026 außer Kraft',
    );
    expect(text).toContain('vor dem 1. Dezember 2026 entsteht');
    // A text node that opens behind a heading marker or a table-cell boundary.
    expect(text).toContain('\n# 82. Bundesgesetz, mit dem das Bundesgesetz');
    expect(text).toContain('| 82. Bundesgesetz:');
    expect(text).toContain('S. 99. BR: AB 11867');
    expect(text).not.toMatch(/\d\\\./u);
  });

  it('leaves no backslash in an ordinal behind an inline element', async () => {
    const { result } = await callTool(
      '<p>Kundgemacht in <span class="Fett">BGBl. I Nr. 82/2026</span> 1. Oktober 2026</p>',
      {},
    );
    expect(result.text).toBe('Kundgemacht in BGBl. I Nr. 82/2026 1. Oktober 2026');
  });

  // A "N. " that does start an output line would read as a list item, so it keeps its escape.
  it('keeps the escape on an ordinal that starts a line', async () => {
    const { result } = await callTool(
      '<p class="ErlText AlignLeft"><span>30. Juli 2026</span></p>',
      {},
    );
    expect(result.text).toBe('30\\. Juli 2026');
  });

  it('escapes only the line-start ordinal in a document holding both', async () => {
    const { result } = await callTool(
      '<p class="ErlText AlignLeft">Am 8. Juli 2026 beschloss der Nationalrat</p><p class="ErlText AlignLeft"><span>30. Juli 2026</span></p>',
      {},
    );
    expect(result.text).toBe('Am 8. Juli 2026 beschloss der Nationalrat\n\n30\\. Juli 2026');
  });

  it('leaves the other escapes and every backslash from the source as they were', async () => {
    const { result } = await callTool(
      '<p>- Strich</p><p>+ Plus</p><p># Raute</p><p>&gt; Zitat</p><p>= Gleich</p><p>Pfad 1\\. Teil</p><pre>1\\. roh</pre><p>Code <code>2\\. x</code> Ende</p>',
      {},
    );
    expect(result.text).toBe(
      '\\- Strich\n\n\\+ Plus\n\n\\# Raute\n\n\\> Zitat\n\n\\= Gleich\n\nPfad 1\\\\. Teil\n\n1\\. roh\n\nCode `2\\. x` Ende',
    );
  });

  // Decoded text never holds a lone surrogate; one passed in anyway is read as decoding would
  // read it (U+FFFD), never as an escape the converter inserted.
  it('treats a lone surrogate in the input as text, not as an inserted escape', async () => {
    const { result } = await callTool('<p>1\uD800. Oktober</p>', {});
    expect(result.text).toBe('1�. Oktober');
  });

  // U+10000–U+103FF encode with U+D800 as their high surrogate; the escape mark is a lone one.
  it('keeps a character whose high surrogate is U+D800 intact, mid-line and at a line start', async () => {
    for (const [html, expected] of [
      ['<p>1\u{10330} x and 2\u{10000}. y</p>', '1\u{10330} x and 2\u{10000}. y'],
      ['<p>x<br>1\u{10000} b</p>', 'x  \n1\u{10000} b'],
    ] as const) {
      const { result } = await callTool(html, {});
      expect(result.text).toBe(expected);
      expect((result.text as string).isWellFormed()).toBe(true);
    }
  });

  // Behind a blockquote or list marker, CommonMark still reads `N. ` as a list item.
  it('keeps the escape on an ordinal behind a blockquote or list marker', async () => {
    for (const [html, expected] of [
      ['<ul><li>1. foo</li></ul>', '* 1\\. foo'],
      ['<ol><li>1. foo</li></ol>', '1. 1\\. foo'],
      ['<blockquote><p>1. foo</p></blockquote>', '> 1\\. foo'],
      [
        '<ol class="wai-list"><li><div class="SymE1"><div>3.</div></div><div class="content"><div>1. Jänner 2027</div></div></li></ol>',
        '3. 1\\. Jänner 2027',
      ],
    ] as const) {
      const { result } = await callTool(html, {});
      expect(result.text).toBe(expected);
    }
  });

  it('leaves an ordinal behind a heading marker or a litera label unescaped', async () => {
    const { result } = await callTool(
      '<h2>1. Abschnitt</h2><ol class="wai-list"><li><div class="SymE2"><div>a)</div></div><div class="content"><div>1. Jänner 2027</div></div></li></ol>',
      {},
    );
    expect(result.text).toBe('## 1. Abschnitt\n\na) 1. Jänner 2027');
  });
});

describe('risGetDocument — format_unavailable degradation (notice, not error)', () => {
  it('surfaces authentic_pdf_url and a notice for an authentic_pdf_only application', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'BVB_BU_JE_20260703_9',
      application: 'Bvb',
      format: 'markdown',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBeUndefined();
    expect(result.content_urls).toEqual({});
    expect(result.authentic_pdf_url).toBe(
      'https://ogd.ris.bka.gv.at/Dokumente/Bvb/BVB_BU_JE_20260703_9/BVB_BU_JE_20260703_9.pdfsig',
    );
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Bvb publishes only the signed authentic PDF');
    expect(notice).toContain(result.authentic_pdf_url as string);
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('surfaces content_urls.pdf and a notice for a pdf_only application', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
    const input = risGetDocument.input.parse({
      document_number: 'UPTS_2026_1',
      application: 'Upts',
      format: 'html',
    });
    const result = await risGetDocument.handler(input, ctx);
    expect(result.text).toBeUndefined();
    expect(result.content_urls.pdf).toBe(
      'https://ogd.ris.bka.gv.at/Dokumente/Upts/UPTS_2026_1/UPTS_2026_1.pdf',
    );
    expect(result.authentic_pdf_url).toBeUndefined();
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Upts publishes a PDF only');
    expect(notice).toContain(result.content_urls.pdf as string);
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });

  it('surfaces no content URLs and the ÖNB guidance for a metadata-only application', async () => {
    const ctx = createMockContext({ errors: risGetDocument.errors });
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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

  // The budget used to bound segmentable markdown only: a court decision, gazette body or
  // consolidated promulgation record carries no §/Artikel/Anlage headings, so the extractor
  // returned nothing and `outlineOnOverflow`'s two-entry floor sent the document back whole
  // at any size. Those renditions are now cut into contiguous byte windows, which is what
  // the roster advertises and what a sections:[…] re-call retrieves.
  it('windows a heading-free rendition that overflows the budget', async () => {
    const { ctx, result } = await callTool(headingFreeDecisionHtml(400), {
      document_number: 'JJT_20260101_BVWG_001',
      application: 'Bvwg',
    });

    expect(result.byte_size).toBeGreaterThan(OUTLINE_BUDGET_BYTES);
    expect(result.kind).toBe('outline');
    expect(result.truncated).toBe(true);
    expect(result.text).toBeUndefined();

    // Document order, not the largest-first sort `outlineOnOverflow` applies: a caller that
    // walks sections[] in array order — the obvious way to read a windowed roster — has to
    // get the document in the order it was written.
    const names = result.sections?.map((section) => section.name) ?? [];
    const count = names.length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(names).toEqual(Array.from({ length: count }, (_, i) => `Part ${i + 1} of ${count}`));
    // Every window fits the budget, and together they account for the document exactly.
    expect(result.sections?.every((section) => section.bytes <= OUTLINE_BUDGET_BYTES)).toBe(true);
    expect(result.sections?.reduce((sum, section) => sum + section.bytes, 0)).toBe(
      result.byte_size,
    );

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('contiguous windows');
    expect(notice).toContain('line breaks');
    expect(notice).toContain('"Part 1 of');
  });

  it('splits a barely-over-budget decision evenly rather than into a runt tail', async () => {
    const { result } = await callTool(headingFreeDecisionHtml(150), {
      document_number: 'JJT_20260101_BVWG_002',
      application: 'Bvwg',
    });

    expect(result.byte_size).toBeGreaterThan(OUTLINE_BUDGET_BYTES);
    expect(result.byte_size).toBeLessThan(2 * OUTLINE_BUDGET_BYTES);
    expect(result.sections).toHaveLength(2);
    // Filling the budget would leave a scrap behind the first window; an even split does not.
    const half = (result.byte_size ?? 0) / 2;
    for (const section of result.sections ?? []) {
      expect(section.bytes).toBeGreaterThan(half * 0.9);
      expect(section.bytes).toBeLessThan(half * 1.1);
    }
  });

  it('retrieves one named window and nothing from its neighbours', async () => {
    const html = headingFreeDecisionHtml(400);
    const { result: outline } = await callTool(html, {
      document_number: 'JJT_20260101_BVWG_001',
      application: 'Bvwg',
    });
    const target = outline.sections?.find((section) => section.name.startsWith('Part 2 of '));
    expect(target).toBeDefined();

    const { ctx, result } = await callTool(html, {
      document_number: 'JJT_20260101_BVWG_001',
      application: 'Bvwg',
      sections: [target?.name as string],
    });

    expect(result.kind).toBe('full');
    expect(result.truncated).toBeUndefined();
    expect(result.byte_size).toBe(target?.bytes);
    // The document opens in the first window and ends in the last — neither is this one.
    expect(result.text).not.toContain('xPARAx0x');
    expect(result.text).not.toContain('xPARAx399x');
    expect(result.text).toContain('xPARAx');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // The property the whole roster rests on: what the outline advertises is what a re-call can
  // retrieve. Every advertised name resolves on its own, and the windows account for the
  // document byte for byte.
  it.each([
    ['a windowed roster', () => headingFreeDecisionHtml(400)],
    ['a section roster', midSizedArticlesHtml],
  ])('resolves every entry %s advertises', async (_label, buildHtml) => {
    const html = buildHtml();
    const { result: outline } = await callTool(html, {});
    const entries = outline.sections ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(2);

    let retrieved = 0;
    for (const entry of entries) {
      const { result } = await callTool(html, { sections: [entry.name] });
      expect(result.kind).toBe('full');
      expect(result.text).toBeDefined();
      expect(result.byte_size).toBe(entry.bytes);
      retrieved += result.byte_size ?? 0;
    }
    expect(retrieved).toBe(entries.reduce((sum, entry) => sum + entry.bytes, 0));
  });

  // The roster exists so a caller can retrieve the document in pieces, which only holds if
  // the pieces go back together. Naming every window in one call has to return the document
  // and nothing else — a separator between entries would put bytes on the wire that are not
  // in the document, and in a table-heavy body would split a table at the seam.
  it.each([
    ['every window', () => headingFreeDecisionHtml(400)],
    ['every section', midSizedArticlesHtml],
  ])('reassembles the document byte for byte when %s is named at once', async (_l, buildHtml) => {
    const html = buildHtml();
    const { result: outline } = await callTool(html, {});
    const entries = outline.sections ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const { result } = await callTool(html, { sections: entries.map((entry) => entry.name) });
    expect(result.kind).toBe('full');
    expect(result.byte_size).toBe(entries.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(result.byte_size).toBe(outline.byte_size);
  });

  it('discloses a windowed roster as an overflow, not a selector mismatch', async () => {
    const { ctx, result } = await callTool(headingFreeDecisionHtml(400), {
      document_number: 'JJT_20260101_BVWG_001',
      application: 'Bvwg',
      sections: ['Artikel 2'],
    });

    expect(result.kind).toBe('outline');
    expect(result.truncated).toBe(true);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('"Artikel 2"');
    expect(notice).toContain('contiguous byte windows');
    // The under-budget wording would be false here — this roster exists because of the budget.
    expect(notice).not.toContain('not a size overflow');
  });

  it('returns full text unchanged for a document under the budget', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Hello <b>World</b></p>',
      byteSize: 25,
      url: 'https://x',
    });
    const ctx = createMockContext({ errors: risGetDocument.errors });
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

  // Windowing is markdown-only. A raw rendition is the published artifact byte for byte and a
  // mid-document slice of either is not well-formed, so neither is ever cut into sections —
  // an oversized one is handed back as a link to the whole artifact instead (#36).
  it.each(['html', 'xml'] as const)(
    'never outlines an oversized raw %s rendition',
    async (format) => {
      const bigText =
        format === 'html' ? 'A'.repeat(500_050) : `<Dokument>${'B'.repeat(500_050)}\n`.repeat(2);
      const { result } = await callTool(bigText, { format });

      expect(result.kind).toBe('link');
      expect(result.text).toBeUndefined();
      expect(result.sections).toBeUndefined();
      expect(result.content_urls.html).toBe(
        'https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
      );
    },
  );
});

describe('risGetDocument — raw html/xml output budget (#36)', () => {
  const encoder = new TextEncoder();
  const CONTENT_URLS = {
    xml: 'https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.xml',
    html: 'https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    pdf: 'https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.pdf',
    rtf: 'https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.rtf',
  };

  /**
   * A raw rendition of exactly `bytes` UTF-8 bytes. It carries multi-byte characters, so its
   * UTF-16 length and its byte size differ — the budget is measured on byte_size.
   */
  function rawOfBytes(format: 'html' | 'xml', bytes: number): string {
    const head =
      format === 'html'
        ? '<!DOCTYPE html><html><head><style>.grüße { width: 100% }</style></head><body><p>'
        : '<?xml version="1.0" encoding="utf-8"?><risdok><p>Übergangsbestimmung ';
    const tail = format === 'html' ? '</p></body></html>' : '</p></risdok>';
    const pad = bytes - encoder.encode(head + tail).length;
    const text = `${head}${'x'.repeat(pad)}${tail}`;
    expect(encoder.encode(text).length).toBe(bytes);
    return text;
  }

  /** Run the tool end to end, both surfaces, against canned rendition text. */
  function call(text: string, input: Record<string, unknown>) {
    fetchDocumentContent.mockResolvedValue({ text, byteSize: text.length, url: 'https://x' });
    return runToolContract(risGetDocument, {
      document_number: 'NOR40262691',
      application: 'BrKons',
      ...input,
    });
  }

  it.each(['html', 'xml'] as const)(
    'returns a %s rendition of exactly 40,000 bytes whole, fenced in content[]',
    async (format) => {
      const text = rawOfBytes(format, OUTLINE_BUDGET_BYTES);
      const result = await call(text, { format });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ kind: 'full', text, byte_size: 40_000 });
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(
        contentText(result).endsWith(`\n\n${markdown().codeBlock(text, format).build()}`),
      ).toBe(true);
    },
  );

  it.each(['html', 'xml'] as const)(
    'returns a %s rendition of 40,001 bytes as kind: link, with no text on either surface',
    async (format) => {
      const text = rawOfBytes(format, OUTLINE_BUDGET_BYTES + 1);
      const result = await call(text, { format });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        application: 'BrKons',
        binding_status: 'consolidated_informational',
        byte_size: 40_001,
        content_urls: CONTENT_URLS,
        document_number: 'NOR40262691',
        format,
        kind: 'link',
        notice: expect.any(String),
        truncated: true,
      });
      const content = contentText(result);
      expect(content).not.toContain('x'.repeat(64));
      expect(content).not.toContain(text.slice(0, 30));
      expect(content).toContain(CONTENT_URLS[format]);
    },
  );

  it.each(['html', 'xml'] as const)(
    'points a %s link result at the whole artifact and at format: "markdown"',
    async (format) => {
      const result = await call(rawOfBytes(format, 90_119), { format });
      const { notice } = result.structuredContent as { notice: string };

      expect(notice).toContain(`content_urls.${format}`);
      expect(notice).toContain(CONTENT_URLS[format]);
      expect(notice).toContain('format: "markdown"');
      expect(notice).toContain('90119 bytes');
      const content = contentText(result);
      expect(content).toContain(notice);
      // The Size line describes the arm it renders — there is no outline below a link.
      const sizeLine = content.split('\n').find((line) => line.startsWith('**Size:**')) ?? '';
      expect(sizeLine).toContain('90119 bytes');
      expect(sizeLine).toContain(`content_urls.${format}`);
      expect(sizeLine).not.toContain('outline');
    },
  );

  it.each(['html', 'xml'] as const)(
    'ignores sections:[…] on an over-budget %s rendition, says so, and never promises the document',
    async (format) => {
      const result = await call(rawOfBytes(format, 50_000), {
        format,
        sections: ['Artikel 2', 'Artikel 2'],
      });

      expect(result.structuredContent).toMatchObject({ kind: 'link', truncated: true });
      expect(result.structuredContent).not.toHaveProperty('text');
      const { notice } = result.structuredContent as { notice: string };
      expect(notice).toContain('sections:[…] was ignored');
      expect(notice).toContain('"Artikel 2"');
      expect(notice).toContain(`content_urls.${format}`);
      expect(notice).not.toContain('The whole document follows');
    },
  );

  it('keeps the under-budget selector notice, which still returns the document', async () => {
    const text = rawOfBytes('xml', 2_000);
    const result = await call(text, { format: 'xml', sections: ['Artikel 2'] });

    expect(result.structuredContent).toMatchObject({ kind: 'full', text });
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'The whole document follows',
    );
  });

  // The fence the framework emits is one backtick longer than the longest run in the text,
  // so nothing inside the rendition can close it early, open a link, or run script.
  it('fences hostile raw text so content[] carries it verbatim', async () => {
    const hostile = [
      '<p>`one` ``two`` ```three``` ``````six``````</p>',
      '``````',
      '</code></pre><script>alert(1)</script><img src=x onerror=alert(2)>',
      '[x]: javascript:alert(3)',
      '[x] [click](javascript:alert(4))',
      '<!-- closed --> <!-- unclosed',
      '~~~',
      '    indented four',
      '\tindented tab',
      '        indented eight\r',
      '```',
    ].join('\n');
    const result = await call(hostile, { format: 'html' });

    expect(result.structuredContent).toMatchObject({ kind: 'full', text: hostile });
    const fence = '`'.repeat(7);
    expect(contentText(result).endsWith(`\n\n${fence}html\n${hostile}\n${fence}`)).toBe(true);
  });

  it('returns a real Nutzdaten XML rendition under the budget byte-identical to the artifact', async () => {
    const xml = fixture('document-begut-nutzdaten.xml');
    const result = await call(xml, { format: 'xml' });

    expect(result.structuredContent).toMatchObject({
      kind: 'full',
      text: xml,
      byte_size: encoder.encode(xml).length,
    });
    expect(contentText(result)).toContain(markdown().codeBlock(xml, 'xml').build());
  });

  it('applies the same rule to a companion document addressed by document_url', async () => {
    const folder =
      'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_8E53444F_FF2D_4C7A_944B_B79785E8F290';
    const stem = 'Materialien_0001_2716E555_EB43_4642_A87A_3CF88FFCDB08';
    fetchDocumentContent.mockResolvedValue({
      text: rawOfBytes('html', 255_292),
      byteSize: 1,
      url: 'https://x',
    });
    const result = await runToolContract(risGetDocument, {
      document_url: `${folder}/${stem}.html`,
      format: 'html',
    });

    expect(result.structuredContent).toMatchObject({
      kind: 'link',
      truncated: true,
      byte_size: 255_292,
      content_urls: { html: onContentHost(`${folder}/${stem}.html`) },
    });
    expect((result.structuredContent as { notice: string }).notice).toContain(
      onContentHost(`${folder}/${stem}.html`),
    );
  });
});

// Every markdown arm — whole, selected, selector miss, selector ignored, section outline,
// window outline — digested on both surfaces. Any byte that moves on the markdown path fails
// here. The sr-only and synthetic rows are the output this code produced before the
// raw-format budget existed; the four RegV rows carry the statutory list labels (#52) and
// mid-line ordinals without a backslash (#60) of that fixture's Absatz and Ziffer lists, and
// the two that include Artikel 1 carry the hard breaks between its Absatz (72) list lines.
// Every row's content_urls sit on the default content host, https://ogd.ris.bka.gv.at (#75).
describe('risGetDocument — markdown output unchanged by the raw-format budget (#36)', () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  const BASELINE: Record<string, [structured: string, content: string]> = {
    'whole, sr-only twins': ['3618bb356cb6d1d1', '42dc3255e35eec5f'],
    'whole, Artikel sections under budget': ['a4358f7346a268cd', '8af8e3a6bd0e0b78'],
    'selected section': ['b0dccc140973b627', '8e33eb4dd297f7ba'],
    'partial selector miss': ['435c2a4f0233c771', '450c921055b870e5'],
    'total selector miss': ['b46dc06024b4776a', '9946c17767cdf80e'],
    'section outline': ['bd5fe148be19cf31', '893c9be4a5f9789b'],
    'window outline': ['7303b0c1463eaad0', '8be13cea4cca90a3'],
    'selector ignored': ['3917182db880452a', '2f9fb0e8a236af87'],
  };

  it.each<[label: string, buildHtml: () => string, input: { sections?: string[] }]>([
    ['whole, sr-only twins', () => SR_ONLY_HTML, {}],
    ['whole, Artikel sections under budget', () => ARTIKEL_SECTIONS_HTML, {}],
    ['selected section', () => ARTIKEL_SECTIONS_HTML, { sections: ['Artikel 2'] }],
    [
      'partial selector miss',
      () => ARTIKEL_SECTIONS_HTML,
      { sections: ['Artikel 2', 'Artikel 9'] },
    ],
    ['total selector miss', () => ARTIKEL_SECTIONS_HTML, { sections: ['Artikel 9999'] }],
    ['section outline', midSizedArticlesHtml, {}],
    ['window outline', () => headingFreeDecisionHtml(400), {}],
    ['selector ignored', () => headingFreeDecisionHtml(20), { sections: ['Artikel 2'] }],
  ])('%s', async (label, buildHtml, input) => {
    fetchDocumentContent.mockResolvedValue({ text: buildHtml(), byteSize: 1, url: 'https://x' });
    const result = await runToolContract(risGetDocument, {
      document_number: 'NOR40262691',
      application: 'BrKons',
      ...input,
    });
    expect([digest(JSON.stringify(result.structuredContent)), digest(contentText(result))]).toEqual(
      BASELINE[label],
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

  // Two paths reach an empty roster now, and the notice names both: a raw rendition, which is
  // never sliced, and markdown that is under the budget and carries no headings. A caller told
  // only about headings would retry the same selector on a larger document of the same shape.
  it('says the selector was ignored on a raw rendition, naming both causes', async () => {
    const { ctx, result } = await callTool(SR_ONLY_HTML, {
      format: 'html',
      sections: ['Artikel 2'],
    });

    expect(result.kind).toBe('full');
    expect(result.text).toBe(SR_ONLY_HTML);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('no addressable entries');
    expect(notice).toContain('Raw html and xml are never sliced');
    expect(notice).toContain('§/Artikel/Anlage headings');
    expect(notice).toContain(String(OUTLINE_BUDGET_BYTES));
    expect(notice).toContain('"Artikel 2"');
  });

  it('says the selector was ignored on under-budget heading-free markdown', async () => {
    const { ctx, result } = await callTool(headingFreeDecisionHtml(20), {
      document_number: 'JJT_20260101_BVWG_003',
      application: 'Bvwg',
      sections: ['Artikel 2'],
    });

    expect(result.kind).toBe('full');
    expect(result.byte_size).toBeLessThan(OUTLINE_BUDGET_BYTES);
    expect(result.text).toContain('xPARAx0x');
    expect(getEnrichment(ctx).notice).toContain('no addressable entries');
  });
});

describe('selectDocumentSections', () => {
  const markdown = ['## Artikel 1\n\nxONEx', `## Artikel 2\n\n${'xTWOx '.repeat(40)}`].join('\n\n');

  it('reports matched text, unmatched names, and the largest-first roster', () => {
    const selection = selectDocumentSections(markdown, ['Artikel 2', 'Artikel 7'], 'markdown');
    expect(selection.text).toContain('xTWOx');
    expect(selection.text).not.toContain('xONEx');
    expect(selection.unmatched).toEqual(['Artikel 7']);
    expect(selection.windowed).toBe(false);
    // Largest first — Artikel 2 carries the bigger body.
    expect(selection.available.map((section) => section.name)).toEqual(['Artikel 2', 'Artikel 1']);
  });

  it('reports an empty text and every requested name when nothing matches', () => {
    const selection = selectDocumentSections(
      markdown,
      ['Artikel 7', 'Artikel 7', 'Anlage 1'],
      'markdown',
    );
    expect(selection.text).toBe('');
    // Deduplicated, in the order requested.
    expect(selection.unmatched).toEqual(['Artikel 7', 'Anlage 1']);
    expect(selection.available).toHaveLength(2);
  });

  it('reports an empty roster for under-budget text with no structural headings', () => {
    const selection = selectDocumentSections('kein Titel', ['Artikel 1'], 'markdown');
    expect(selection.available).toEqual([]);
    expect(selection.text).toBe('');
    expect(selection.unmatched).toEqual(['Artikel 1']);
    expect(selection.windowed).toBe(false);
  });

  // The over-budget counterpart of the case above: the same heading-free shape is addressable
  // once it crosses the budget, and it resolves through the same roster the outline advertises.
  it('reports a window roster for over-budget text with no structural headings', () => {
    const text = `${'Der Beschwerdeführer brachte vor.\n'.repeat(2000)}`;
    const selection = selectDocumentSections(text, ['Part 2 of 2'], 'markdown');

    expect(selection.windowed).toBe(true);
    expect(selection.available.map((entry) => entry.name).sort()).toEqual([
      'Part 1 of 2',
      'Part 2 of 2',
    ]);
    expect(selection.unmatched).toEqual([]);
    expect(selection.text).not.toBe('');
    expect(new TextEncoder().encode(selection.text).length).toBe(
      selection.available.find((entry) => entry.name === 'Part 2 of 2')?.bytes,
    );
  });

  it('never windows a raw rendition, however far over the budget', () => {
    const text = `${'<p>Nutzdaten</p>\n'.repeat(4000)}`;
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(OUTLINE_BUDGET_BYTES);
    for (const format of ['html', 'xml'] as const) {
      expect(addressableSections(text, format)).toEqual([]);
      expect(selectDocumentSections(text, ['Part 1 of 2'], format).available).toEqual([]);
    }
  });
});

describe('windowDocument', () => {
  /** Heading-free prose of roughly `bytes` UTF-8 bytes, one sentence per line. */
  function prose(bytes: number): string {
    const line = 'Der Beschwerdeführer brachte vor, dass die Behörde geirrt habe.\n';
    return line.repeat(Math.ceil(bytes / new TextEncoder().encode(line).length));
  }

  it('returns nothing under the budget', () => {
    expect(windowDocument(prose(1_000), OUTLINE_BUDGET_BYTES)).toEqual([]);
  });

  it('returns nothing for text with no line break to cut on', () => {
    expect(windowDocument('A'.repeat(100_000), OUTLINE_BUDGET_BYTES)).toEqual([]);
  });

  it.each([41_000, 90_000, 206_425, 594_555])(
    'cuts %d bytes into even windows that all fit the budget',
    (size) => {
      const text = prose(size);
      const total = new TextEncoder().encode(text).length;
      const windows = windowDocument(text, OUTLINE_BUDGET_BYTES);

      expect(windows.length).toBeGreaterThanOrEqual(Math.ceil(total / OUTLINE_BUDGET_BYTES));
      // The property the budget exists for: no window is itself too large to return.
      for (const window of windows) expect(window.bytes).toBeLessThanOrEqual(OUTLINE_BUDGET_BYTES);
      // Nothing dropped, nothing double-counted — the windows are the document.
      expect(windows.reduce((sum, window) => sum + window.bytes, 0)).toBe(total);
      expect(windows.map((window) => window.text).join('')).toBe(text);
      // Named in document order, so the outline's largest-first sort stays readable.
      expect(windows.map((window) => window.name)).toEqual(
        windows.map((_, i) => `Part ${i + 1} of ${windows.length}`),
      );
      // Even, not fill-then-runt: the smallest window is close to the largest.
      const sizes = windows.map((window) => window.bytes);
      expect(Math.min(...sizes)).toBeGreaterThan(Math.max(...sizes) * 0.8);
    },
  );

  // Snapping to the next line break overshoots the even target by up to one line, so a
  // document sitting just under `count × budget` and carrying long lines lands a window over
  // it — measured live on a 594,555-byte Erv translation whose longest line is 3,427 bytes.
  // The count rises until every window fits rather than shipping one over the budget.
  it('adds a window rather than letting the even split overshoot the budget', () => {
    // 166 × 3,606 B = 598,596 B — 15 even windows of 39,906 B, each of which snaps up to
    // 43,272 B on the next line break. Sixteen windows of 37,412 B fit.
    const line = `${'Der Beschwerdeführer brachte vor. '.repeat(103)}\n`;
    const text = line.repeat(166);
    const total = new TextEncoder().encode(text).length;
    const windows = windowDocument(text, OUTLINE_BUDGET_BYTES);

    expect(windows.length).toBeGreaterThan(Math.ceil(total / OUTLINE_BUDGET_BYTES));
    expect(Math.max(...windows.map((window) => window.bytes))).toBeLessThanOrEqual(
      OUTLINE_BUDGET_BYTES,
    );
    expect(windows.reduce((sum, window) => sum + window.bytes, 0)).toBe(total);
  });

  // A line longer than the budget cannot be split without cutting mid-line, which would put
  // the boundary somewhere the caller cannot see. It sits alone in a window that goes over,
  // and the count stops rising there — no count makes that line fit, so a retry that keeps
  // going has no fixed point and shreds the rest of the document into one-line windows.
  it.each([40_000, 50_000, 120_000])(
    'isolates a %d-byte line in its own window and stops raising the count',
    (lineSize) => {
      const text = `${'x'.repeat(lineSize)}\n${prose(50_000)}`;
      const total = new TextEncoder().encode(text).length;
      const windows = windowDocument(text, OUTLINE_BUDGET_BYTES);

      expect(windows).toHaveLength(Math.ceil(total / OUTLINE_BUDGET_BYTES));
      expect(windows[0]?.text).toBe(`${'x'.repeat(lineSize)}\n`);
      // Only the unsplittable line is over budget; every other window fits.
      expect(windows.slice(1).every((w) => w.bytes <= OUTLINE_BUDGET_BYTES)).toBe(true);
      expect(windows.map((window) => window.text).join('')).toBe(text);
    },
  );

  // The shape that made the retry degenerate: many small lines behind one it cannot split.
  it('does not shred a long document around a single over-budget line', () => {
    const text = `${'x'.repeat(60_000)}\n${'kurze Zeile.\n'.repeat(50_000)}`;
    const total = new TextEncoder().encode(text).length;
    const windows = windowDocument(text, OUTLINE_BUDGET_BYTES);

    expect(windows.length).toBeLessThan(2 * Math.ceil(total / OUTLINE_BUDGET_BYTES));
    expect(windows.reduce((sum, window) => sum + window.bytes, 0)).toBe(total);
    expect(windows.filter((window) => window.bytes > OUTLINE_BUDGET_BYTES)).toHaveLength(1);
  });

  it('prefers §/Artikel/Anlage sections over windows when the markdown has both', () => {
    const text = ['## Artikel 1', prose(30_000), '## Artikel 2', prose(30_000)].join('\n');
    const roster = addressableSections(text, 'markdown');
    expect(roster.map((entry) => entry.kind)).toEqual(['section', 'section']);
    expect(roster.map((entry) => entry.name)).toEqual(['Artikel 1', 'Artikel 2']);
  });
});

describe('layoutLabelledItem', () => {
  it('joins a label on its own line to its text and indents the item’s own lines', () => {
    const content = '6.\n\nArt. 16 gilt.  \n\n    a) erstens\n    b) zweitens\nSchlussteil.  ';
    expect(layoutLabelledItem(content, '  ', '    ', true)).toBe(
      '6. Art. 16 gilt.  \n    a) erstens  \n    b) zweitens  \n  Schlussteil.',
    );
  });

  it('keeps a label alone when a nested list follows it directly', () => {
    expect(layoutLabelledItem('(1)\n\n  1. erstens', '', '  ', false)).toBe('(1)  \n  1. erstens');
    expect(layoutLabelledItem('a)\n\n    aa) erstens', '  ', '    ', true)).toBe(
      'a)  \n    aa) erstens',
    );
  });

  it('ends every line but the last in exactly one hard break', () => {
    expect(
      layoutLabelledItem('1.\nSatz eins. \nSatz zwei.   \n\n\n(Anm.: x)', '', '  ', true),
    ).toBe('1. Satz eins.  \nSatz zwei.  \n(Anm.: x)');
  });
});

describe('resolveOrdinalEscapes', () => {
  const MARK = '\uD800';

  it('keeps the escape at a line start, drops it everywhere else', () => {
    expect(
      resolveOrdinalEscapes(`30${MARK}. Juli\nam 8${MARK}. Juli\n  1${MARK}. x\n| 82${MARK}. B |`),
    ).toBe('30\\. Juli\nam 8. Juli\n  1\\. x\n| 82. B |');
  });

  it('leaves every backslash it did not mark', () => {
    const text = '1\\. roh\nPfad 1\\\\. Teil\n`2\\. x`';
    expect(resolveOrdinalEscapes(text)).toBe(text);
  });

  it('keeps the escape behind blockquote and list markers, where a list item still starts', () => {
    expect(
      resolveOrdinalEscapes(
        `* 1${MARK}. a\n+ 2${MARK}. b\n- 3${MARK}. c\n> 4${MARK}. d\n> > 5${MARK}. e\n1. 6${MARK}. f\n1) 7${MARK}. g\n  * 8${MARK}. h`,
      ),
    ).toBe('* 1\\. a\n+ 2\\. b\n- 3\\. c\n> 4\\. d\n> > 5\\. e\n1. 6\\. f\n1) 7\\. g\n  * 8\\. h');
  });

  it('drops the escape behind a heading, a table pipe, a litera, or an Absatz label', () => {
    expect(
      resolveOrdinalEscapes(`## 1${MARK}. a\n| 2${MARK}. b |\na) 3${MARK}. c\n(1) 4${MARK}. d`),
    ).toBe('## 1. a\n| 2. b |\na) 3. c\n(1) 4. d');
  });

  // U+10000–U+103FF encode with U+D800 as their high surrogate.
  it('never touches the high surrogate of a character in U+10000–U+103FF', () => {
    const text = `1\u{10000} a\n2\u{10330}. b\nc 3\u{103FF}`;
    expect(resolveOrdinalEscapes(text)).toBe(text);
    expect(resolveOrdinalEscapes(`1${MARK}. \u{10000}\nx 2${MARK}. \u{10330}`)).toBe(
      `1\\. \u{10000}\nx 2. \u{10330}`,
    );
  });
});

// Both run over a whole rendition (to ~200 KB of markdown) or one list item's share of it.
describe('markdown post-passes — time on adversarial input', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  /** Bound on one call at 320,000 characters; linear work there takes about a millisecond. */
  const BOUND_MS = 50;

  /** Thread-CPU milliseconds of one call, the fastest of three samples of ≥ 10 ms each. */
  function cpuMs(run: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 3; sample++) {
      const start = process.threadCpuUsage();
      let runs = 0;
      let ms = 0;
      do {
        run();
        runs++;
        const { user, system } = process.threadCpuUsage(start);
        ms = (user + system) / 1_000;
      } while (ms < 10);
      best = Math.min(best, ms / runs);
    }
    return best;
  }

  /** Time `run` on each doubling size, bounding every size before the next, then the span. */
  function expectLinear(make: (size: number) => string, run: (input: string) => unknown): void {
    const times: number[] = [];
    for (const size of SIZES) {
      const input = make(size);
      const ms = cpuMs(() => run(input));
      expect(ms, `${size} characters`).toBeLessThan(BOUND_MS);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
  }

  const MARK = '\uD800';
  it.each<[string, (size: number) => string]>([
    ['a long digit run with no mark', (size) => '1'.repeat(size)],
    [
      'a whitespace run, then digits, with no mark',
      (size) => `${' '.repeat(size / 2)}${'1'.repeat(size / 2)}`,
    ],
    ['indented digits on every line, no mark', (size) => '\n  12'.repeat(size / 5)],
    ['marks inside running text', (size) => `a 1${MARK}. `.repeat(size / 6)],
    ['marks at every line start', (size) => `\n1${MARK}. x`.repeat(size / 6)],
    // `\r`, U+2028, and U+2029 end a line for a multiline `^`, so a scan anchored that way
    // re-reads the rest of the run from every position in it.
    ['a carriage-return run', (size) => '\r'.repeat(size)],
    ['a line-separator run', (size) => String.fromCharCode(0x2028).repeat(size)],
    ['nested list markers on one line, no mark', (size) => `${'> 1. '.repeat(size / 5)}x`],
  ])('resolveOrdinalEscapes stays linear on %s', (_shape, make) => {
    expectLinear(make, resolveOrdinalEscapes);
  });

  // The converter's own escape pass runs over every text node of the rendition.
  it('toMarkdown stays linear on a long digit run', () => {
    expectLinear((size) => `<p>${'1'.repeat(size)}</p>`, toMarkdown);
  });

  it.each<[string, (size: number) => string]>([
    ['one long line', (size) => 'x'.repeat(size)],
    ['a whitespace run with no text', (size) => ' '.repeat(size)],
    ['blank and whitespace-only lines', (size) => ' \n\n'.repeat(size / 3)],
    ['short own lines', (size) => 'Text\n'.repeat(size / 5)],
    ['nested item lines', (size) => '    a) x\n'.repeat(size / 9)],
  ])('layoutLabelledItem stays linear on %s', (_shape, make) => {
    expectLinear(make, (input) => layoutLabelledItem(`1.\n${input}`, '  ', '    ', true));
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
    const err = await contractError(risGetDocument, {
      document_number: 'NOR40262691',
      application: 'BrKons',
    });
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
    const ctx = createMockContext({ errors: risGetDocument.errors });
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

  // Every filename shape the live corpus files a companion under. The prefixed ordinal+UUID
  // is the 2026 shape (4,763 of 23,483 companions); the Fabasoft object address is what
  // every record before 2026 carries (18,719); the prefix-less ordinal+UUID appears once.
  it.each([
    ['Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    ['Anlagen_0002_1A2B3C4D_5E6F_7081_9A0B_C1D2E3F40506.pdf'],
    ['Schreiben_0002_C0BFE98B_E9CD_4ABB_A7C2_A339C59413FB.rtf'],
    ['COO_2026_100_2_1739564.html'],
    ['COO_2026_100_2_17395.xml'],
    ['COO_2026_100_2_1739564.pdf'],
    ['0001_F303A247_1202_45A5_8C35_1B19542E0A7E.html'],
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

  // Every accepted stem stays free of the characters that would let it address something
  // other than one file inside the already-validated document folder — the second guard in
  // `buildDocumentContentUrl` rejects them again, but nothing reaches it.
  it('accepts no stem carrying a path, encoding, or escape character', () => {
    for (const filename of [
      'Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html',
      'COO_2026_100_2_1739564.html',
      '0001_F303A247_1202_45A5_8C35_1B19542E0A7E.html',
    ]) {
      const parsed = parseDocumentUrl(
        `https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/${filename}`,
        CONTENT_BASE,
      );
      const stem = 'contentName' in parsed ? (parsed.contentName as string) : '';
      expect(stem).not.toBe('');
      expect(stem).toMatch(/^[0-9A-Za-z_]+$/u);
    }
  });

  // The accepted set widens by adding whole anchored shapes, never by matching a prefix or a
  // substring: a filename that merely contains one is still unaddressable, so a caller cannot
  // steer the fetch at an arbitrary file in the folder. `Material-COO_…` is not hypothetical —
  // it is what RIS names the per-record inline formula images, ~55 on every draft record.
  it.each([
    ['Beilagen_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    ['Materialien_0001_9D11747B.html'],
    ['MaterialienX_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.html'],
    ['..%2F..%2FDokumente%2Fother.html'],
    ['Material-COO_2026_100_2_1739564.html'],
    ['Anlage-COO_2026_100_2_1739564.html'],
    ['COO_2026_100_2_1739564_Temp32a40c13.html'],
    ['COO_2026_100_2.html'],
    ['COO_2026_100_2_1739564_9.html'],
    ['COO_2026_100_2_173956z.html'],
    ['COO.2026.100.2.1739564.html'],
    ['0001_F303A247_1202_45A5_8C35.html'],
  ])('rejects the non-addressable filename %s', (filename) => {
    const parsed = parseDocumentUrl(
      `https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/${filename}`,
      CONTENT_BASE,
    );
    expect(parsed).toHaveProperty('error');
    if ('error' in parsed) expect(parsed.error).toContain('nor one of its companion documents');
  });

  it('rejects a companion stem carrying an extension RIS does not render', () => {
    const parsed = parseDocumentUrl(
      'https://www.ris.bka.gv.at/Dokumente/RegV/REGV_0D93A1E0_FE0C_4A35_AC66_1A875F7B9E39/Materialien_0001_9D11747B_A91B_4FCA_BFD4_3F08E37B1D15.exe',
      CONTENT_BASE,
    );
    expect(parsed).toHaveProperty('error');
    if ('error' in parsed) expect(parsed.error).toContain('RIS rendition extension');
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
