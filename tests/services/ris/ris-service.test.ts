/**
 * @fileoverview Offline RisService tests: the content-URL SSRF guard, per-application
 * content-URL construction from the path-segment map, the HTTP-500 error-envelope
 * translation (fetch stubbed — no network), and the init/accessor contract.
 * Network-bound methods are otherwise exercised at build time against the live API.
 * @module tests/services/ris/ris-service
 */

import { readFileSync } from 'node:fs';

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertFetchableDocumentUrl,
  getRisService,
  RisService,
} from '@/services/ris/ris-service.js';

const CONTENT_BASE = 'https://www.ris.bka.gv.at';

/** Read a fixture as the raw body text RIS puts on the wire. */
function rawFixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/ris/${name}`, import.meta.url), 'utf8');
}

function expectValidationError(fn: () => unknown, messagePart?: string): void {
  let caught: McpError | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as McpError;
  }
  expect(caught).toBeInstanceOf(McpError);
  expect(caught!.code).toBe(JsonRpcErrorCode.ValidationError);
  if (messagePart !== undefined) expect(caught!.message).toContain(messagePart);
}

describe('assertFetchableDocumentUrl', () => {
  it('accepts content-host URLs under /Dokumente/', () => {
    const url = `${CONTENT_BASE}/Dokumente/Bundesnormen/NOR11013238/NOR11013238.html`;
    expect(assertFetchableDocumentUrl(url, CONTENT_BASE).href).toBe(url);
  });

  it('rejects other hosts, other paths, and malformed URLs', () => {
    expectValidationError(() =>
      assertFetchableDocumentUrl(
        'https://evil.example.com/Dokumente/Bundesnormen/x/x.html',
        CONTENT_BASE,
      ),
    );
    expectValidationError(() =>
      assertFetchableDocumentUrl(`${CONTENT_BASE}/GeltendeFassung.wxe?x=1`, CONTENT_BASE),
    );
    expectValidationError(() =>
      // Same hostname, different scheme/origin.
      assertFetchableDocumentUrl(
        'http://www.ris.bka.gv.at/Dokumente/Bundesnormen/x/x.html',
        CONTENT_BASE,
      ),
    );
    expectValidationError(() => assertFetchableDocumentUrl('not a url', CONTENT_BASE));
  });
});

describe('RisService.buildDocumentContentUrl', () => {
  const service = new RisService('ris-austria-mcp-server/test');

  it('builds content URLs from the per-application path-segment map', () => {
    expect(service.buildDocumentContentUrl('BrKons', 'NOR11013238', 'html')).toBe(
      `${CONTENT_BASE}/Dokumente/Bundesnormen/NOR11013238/NOR11013238.html`,
    );
    expect(service.buildDocumentContentUrl('GrA', 'GEMREA_OB_41203_20260703_3', 'pdf')).toBe(
      `${CONTENT_BASE}/Dokumente/GemeinderechtAuth/GEMREA_OB_41203_20260703_3/GEMREA_OB_41203_20260703_3.pdf`,
    );
    expect(service.buildDocumentContentUrl('Vfgh', 'JFR_20260616_26V00023_01', 'xml')).toBe(
      `${CONTENT_BASE}/Dokumente/Vfgh/JFR_20260616_26V00023_01/JFR_20260616_26V00023_01.xml`,
    );
  });

  it('percent-encodes document numbers with non-ASCII letters', () => {
    const url = service.buildDocumentContentUrl(
      'Upts',
      'UPTS_20260427_2026_0_074_605_UPTS_Grüne',
      'pdf',
    );
    expect(url).toContain('/Dokumente/Upts/UPTS_20260427_2026_0_074_605_UPTS_Gr%C3%BCne/');
    expect(assertFetchableDocumentUrl(url, CONTENT_BASE)).toBeInstanceOf(URL);
  });

  it('rejects BgblAlt (no content URLs), unknown applications, and unsafe document numbers', () => {
    expectValidationError(
      () => service.buildDocumentContentUrl('BgblAlt', 'glo1940_0049_00357', 'html'),
      'BgblAlt',
    );
    expectValidationError(
      () => service.buildDocumentContentUrl('Bogus', 'NOR1', 'html'),
      'Unknown',
    );
    expectValidationError(() =>
      service.buildDocumentContentUrl('BrKons', '../../etc/passwd', 'html'),
    );
    expectValidationError(() => service.buildDocumentContentUrl('BrKons', 'NOR1?x=1', 'html'));
    expectValidationError(() => service.buildDocumentContentUrl('BrKons', '', 'html'));
  });
});

describe('RisService — HTTP 500 carrying a RIS error envelope', () => {
  const service = new RisService('ris-austria-mcp-server/test');

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub the network with one non-2xx response body, and report the call count. */
  function stubFetch(body: string, status = 500): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(body, { status, statusText: 'Internal Server Error' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('translates an out-of-range page into InvalidParams instead of a 500-shaped InternalError', async () => {
    const fetchMock = stubFetch(rawFixture('error-500-page-overflow.json'));
    const err = await service
      .trackChanges({ application: 'Dsk', changedFrom: '2026-07-01', page: 2 }, createMockContext())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    // The bug: HTTP 500 mapped straight to InternalError, discarding RIS's explanation.
    expect((err as McpError).code).not.toBe(JsonRpcErrorCode.InternalError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).message).toBe(
      'Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten',
    );
    // InvalidParams is not a transient code — withRetry must not burn attempts on it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('translates a non-paging rejected parameter the same way (envelope-level, not paging-only)', async () => {
    stubFetch(rawFixture('error-500-unknown-application.json'));
    const err = await service
      .trackChanges({ application: 'Dsk' }, createMockContext())
      .catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).message).toBe('Application NotARealApp not found');
  });

  it('fails fast on a Landesrecht fault rather than retrying it as transient', async () => {
    // Landesrecht wraps its faults in `Bka.Ris.…OgdException: `, pushing the soap:Client
    // prefix off the front. Unclassified faults are ServiceUnavailable — a transient code —
    // so this deterministic input error would otherwise be retried, sleeping ~10s against a
    // rate-limited API before failing anyway.
    const fetchMock = stubFetch(rawFixture('error-500-fulltext-landesrecht.json'));
    const err = await service
      .searchLegislation({ application: 'LrKons', query: '*' }, createMockContext())
      .catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).code).not.toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reclassifies a 500 carrying no RIS envelope as ServiceUnavailable', async () => {
    stubFetch('<!DOCTYPE html><html>502 Bad Gateway</html>');
    // Aborted signal so withRetry surfaces the first attempt's error without sleeping
    // through the backoff — ServiceUnavailable is transient, unlike the InternalError
    // this used to be.
    const err = await service
      .trackChanges({ application: 'Dsk' }, createMockContext({ signal: AbortSignal.abort() }))
      .catch((e: unknown) => e);

    // Nothing to translate, but a generic upstream 5xx is still an upstream failure — the
    // callers declare it as retryable upstream_error, which they can only map from a
    // ServiceUnavailable. InternalError reached the wire bare (#15).
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).code).not.toBe(JsonRpcErrorCode.InternalError);
    expect((err as McpError).message).toContain('HTTP 500');
  });
});

describe('RisService.fetchDocumentContent — upstream classification and retry budget', () => {
  const service = new RisService('ris-austria-mcp-server/test');
  const URL_UNDER_TEST = `${CONTENT_BASE}/Dokumente/Bundesnormen/NOR11013238/NOR11013238.html`;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub the network with one canned non-2xx response, and report the call count. */
  function stubStatus(status: number, body = '<html>error</html>'): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reclassifies a generic 500 as ServiceUnavailable and spends exactly two attempts', async () => {
    const fetchMock = stubStatus(500);
    const err = await service
      .fetchDocumentContent(URL_UNDER_TEST, createMockContext())
      .catch((e: unknown) => e);

    // #15 — the content path had no envelope-translation catch at all, so an unclassified
    // 5xx reached ris_get_document as a bare InternalError with no reason or recovery.
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).message).toContain('HTTP 500');
    // #21 — the raised per-attempt deadline is only affordable at two attempts; four would
    // spend ~93s and blow past the MCP SDK's 60s default request timeout.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves a 404 as NotFound and does not retry it', async () => {
    const fetchMock = stubStatus(404);
    const err = await service
      .fetchDocumentContent(URL_UNDER_TEST, createMockContext())
      .catch((e: unknown) => e);

    // The reclassification is gated on status ≥ 500 — a mistyped document number must stay
    // NotFound so ris_get_document can report document_not_found.
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a caller abort as InternalError — it carries no status to reclassify', async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const err = await service
      .fetchDocumentContent(URL_UNDER_TEST, createMockContext())
      .catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.InternalError);
    expect((err as McpError).data?.errorSource).toBe('FetchAborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('init/accessor', () => {
  it('getRisService throws before initialization', () => {
    expect(() => getRisService()).toThrowError(/not initialized/);
  });
});
