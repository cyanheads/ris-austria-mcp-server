/**
 * @fileoverview Tests for the ris_track_changes tool — deletion-record surfacing, the
 * cross-class changed-document record shape, enrichment (totals/paging/applied window),
 * the zero-hit notice, error-contract mapping, and format() parity. The RIS service module
 * is mocked so the suite is fully offline; success-path fixtures are run through the real
 * normalizer so results stay realistic.
 * @module tests/tools/ris-track-changes.tool.test
 */

import { readFileSync } from 'node:fs';

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';
import { parseHistoryResponse } from '@/services/ris/normalizer.js';

const { trackChanges } = vi.hoisted(() => ({ trackChanges: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ trackChanges }),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** Read a fixture as the raw body text RIS puts on the wire. */
function rawFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8');
}

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

beforeEach(() => {
  trackChanges.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('risTrackChanges — deletion records', () => {
  it('surfaces deletion records with document_number and deleted_at, alongside changed documents', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);

    expect(result.results).toHaveLength(7);
    const deletions = result.results.filter((r) => r.deleted);
    expect(deletions).toHaveLength(5);
    const first = deletions.find((r) => r.document_number === 'NOR30003318');
    expect(first).toBeDefined();
    expect(first?.deleted_at).toBe('2026-06-17T14:46:31');
    expect(first?.content_urls).toEqual({});
    // Deletion records carry the issuing Organ too (RawDeletedNode.Organ).
    expect(first?.organ).toBe('BKA');

    const changed = result.results.filter((r) => !r.deleted);
    expect(changed).toHaveLength(2);
  });

  it('renders deleted records distinctly (with the deletion timestamp) in format()', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    const text = (risTrackChanges.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('NOR30003318 — deleted');
    expect(text).toContain('**Deleted:** yes (2026-06-17T14:46:31)');
  });

  it('renders an explicit "**Deleted:** no" line for a non-deleted changed record', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    const changed = result.results.find((r) => !r.deleted);
    expect(changed, 'fixture should carry a non-deleted changed record').toBeDefined();
    // Isolate the single deleted:false record so the assertion is unambiguous — content-only
    // clients must see its explicit "no", which the old truthy-gated render dropped entirely.
    const text = (
      risTrackChanges.format!({ results: [changed!] })[0] as { type: 'text'; text: string }
    ).text;
    expect(text).toContain('**Deleted:** no');
    expect(text).not.toContain('**Deleted:** yes');
  });
});

describe('risTrackChanges — changed-document record shape', () => {
  it('maps a changed BrKons document to the cross-class record shape', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    const result = await risTrackChanges.handler(input, ctx);
    const record = result.results.find((r) => r.document_number === 'NOR40278538');
    expect(record).toBeDefined();
    expect(record?.deleted).toBe(false);
    expect(record?.short_title).toBe('Grundausbildungsverordnung BMLV – M BUO 2017');
    expect(record?.title).toBeUndefined();
    expect(record?.changed).toBe('2026-06-17');
    expect(record?.published).toBe('2026-06-17');
    expect(record?.document_url).toBe(
      'https://www.ris.bka.gv.at/eli/bgbl/ii/2016/442/P7/NOR40278538',
    );
    expect(record?.content_urls).toEqual({
      xml: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.xml',
      html: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.html',
      rtf: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.rtf',
      pdf: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.pdf',
    });
    // The fixture's content list carries no Authentisch DataType — authentic_pdf_url must
    // stay genuinely absent, not defaulted.
    expect(record?.authentic_pdf_url).toBeUndefined();
    expect(record?.binding_status).toBe('consolidated_informational');
    expect(record?.organ).toBe('BKA (Bundeskanzleramt)');
  });

  it('applies the same binding_status (per queried application) to every record, deleted or changed', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    expect(result.results.length).toBeGreaterThan(0);
    for (const record of result.results) {
      expect(record.binding_status).toBe('consolidated_informational');
    }
  });
});

describe('risTrackChanges — enrichment: totals, paging, applied window', () => {
  it('reports total, page, pageSize, application, and the applied changed_from/changed_to window', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({
      application: 'BrKons',
      changed_from: '2026-06-01',
      changed_to: '2026-06-30',
      include_deleted: true,
    });
    await risTrackChanges.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    // Fixture: total 101, page 1, pageSize 100, 7 entries on this page — 101 > 7, so more
    // pages exist beyond this one.
    expect(enrichment.totalCount).toBe(101);
    expect(enrichment.page).toBe(1);
    expect(enrichment.pageSize).toBe(100);
    expect(enrichment.application).toBe('BrKons');
    expect(enrichment.changedFrom).toBe('2026-06-01');
    expect(enrichment.changedTo).toBe('2026-06-30');
    expect(enrichment.truncated).toBe(true);
  });

  it('omits changedFrom/changedTo from enrichment when the window is not provided', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    await risTrackChanges.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.changedFrom).toBeUndefined();
    expect(enrichment.changedTo).toBeUndefined();
  });
});

describe('risTrackChanges — zero-hit notice', () => {
  it('includes the exact-date-window guidance when changed_from/changed_to are set', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('search-zero-hits.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({
      application: 'BrKons',
      changed_from: '2020-01-01',
      changed_to: '2020-01-02',
    });
    await risTrackChanges.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 changes in BrKons between 2020-01-01 and 2020-01-02.');
    expect(notice).toContain("use the search tools' changed_since for coarse recency filtering");
  });

  it('defaults to "the start of the feed" and "now" when the window is omitted', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('search-zero-hits.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    await risTrackChanges.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 changes in BrKons between the start of the feed and now.');
  });
});

describe('risTrackChanges — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (ValidationError) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service ValidationError rejection to the invalid_query contract error', async () => {
    const upstreamError = validationError("The 'Anwendung' element is invalid.", {
      risApplication: 'BrKons',
    });
    trackChanges.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    const err = await captureError(risTrackChanges.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'Anwendung' element is invalid.");
  });

  it('surfaces an out-of-range page as an actionable invalid_query, not an opaque InternalError', async () => {
    // End-to-end across the seam the fix depends on: the REAL service (fetch stubbed with
    // RIS's verbatim HTTP 500 body) must throw the code this tool's unmodified .catch()
    // matches. Mocking the service here instead would assume the very thing under test.
    const actual = await vi.importActual<typeof import('@/services/ris/ris-service.js')>(
      '@/services/ris/ris-service.js',
    );
    const realService = new actual.RisService('ris-austria-mcp-server/test');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(rawFixture('error-500-page-overflow.json'), { status: 500 })),
      ),
    );
    trackChanges.mockImplementation((params, ctx) => realService.trackChanges(params, ctx));

    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({
      application: 'Dsk',
      changed_from: '2026-07-01',
      changed_to: '2026-07-15',
      page: 2,
    });
    const err = await captureError(risTrackChanges.handler(input, ctx));

    // The caller must not be told this server broke — the page number is their input.
    expect(err.code).not.toBe(JsonRpcErrorCode.InternalError);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    // RIS's own explanation reaches the caller…
    expect(err.message).toContain('Seitennummer');
    // …alongside this tool's recovery hint, which a contract-less throw would have lost.
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('Correct the parameter named in the message'),
    });
    // invalid_query declares no retryable flag — an input error is not worth retrying.
    expect(err.data?.retryable).toBeUndefined();
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    trackChanges.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    const err = await captureError(risTrackChanges.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    trackChanges.mockRejectedValue(timeout('fetch GET https://data.bka.gv.at timed out.', {}));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    const err = await captureError(risTrackChanges.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('narrow the change window'),
    });
  });
});

describe('risTrackChanges — format() parity', () => {
  it('renders every populated field for both changed and deleted records', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    const text = (risTrackChanges.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const record of result.results) {
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.binding_status);
      // deleted renders for BOTH states — true → "yes"/"yes (ts)", false → "no" (was truthy-gated).
      expect(text).toContain(`**Deleted:** ${record.deleted ? 'yes' : 'no'}`);
      if (record.short_title !== undefined) expect(text).toContain(record.short_title);
      if (record.organ !== undefined) expect(text).toContain(record.organ);
      if (record.title !== undefined) expect(text).toContain(record.title);
      if (record.changed !== undefined) expect(text).toContain(record.changed);
      if (record.published !== undefined) expect(text).toContain(record.published);
      if (record.deleted_at !== undefined) expect(text).toContain(record.deleted_at);
      if (record.document_url !== undefined) expect(text).toContain(record.document_url);
      if (record.authentic_pdf_url !== undefined) expect(text).toContain(record.authentic_pdf_url);
      for (const key of ['html', 'pdf', 'rtf', 'xml'] as const) {
        const url = record.content_urls[key];
        if (url !== undefined) expect(text).toContain(url);
      }
    }
  });

  it('renders the empty-page fallback when results is empty', () => {
    const blocks = risTrackChanges.format!({ results: [] });
    expect((blocks[0] as { type: 'text'; text: string }).text).toBe('_No changes on this page._');
  });
});
