/**
 * @fileoverview Tests for the ris_search_legislation tool — local scope/version-filter
 * guards (rejected before any network call), in_force_as_of defaulting, error-contract
 * mapping, zero-hit notices, and record-mapping/format() parity. The RIS service module
 * is mocked so the suite is fully offline; success-path fixtures are run through the real
 * normalizer so results stay realistic.
 * @module tests/tools/ris-search-legislation.tool.test
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
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risSearchLegislation } from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';

const { searchLegislation } = vi.hoisted(() => ({ searchLegislation: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchLegislation }),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** Read a fixture as the raw body text RIS puts on the wire. */
function rawFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8');
}

/** Mirrors the tool's own (unexported) `todayInAustria()` for asserting the defaulted date. */
function todayInAustria(): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Vienna',
    year: 'numeric',
  }).format(new Date());
}

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

beforeEach(() => {
  searchLegislation.mockReset();
});

describe('risSearchLegislation — local guards (no service call)', () => {
  it('rejects language: english combined with a non-federal scope', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ language: 'english', scope: 'wien' });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain("scope: 'wien'");
    expect(err.message).toContain('Erv');
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('rejects municipality combined with scope: federal', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ municipality: 'Graz', scope: 'federal' });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('Graz');
    expect(err.message).toContain("scope: 'federal'");
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('rejects a consolidated-only filter (law_id) combined with municipality', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({
      municipality: 'Graz',
      scope: 'wien',
      law_id: '10001597',
    });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('law_id');
    expect(err.message).toContain('Graz');
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('rejects a consolidated-only filter (section_from) combined with language: english', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ language: 'english', section_from: '6' });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('section_from');
    expect(err.message).toContain("language: 'english'");
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('rejects in_force_as_of combined with language: english', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({
      language: 'english',
      in_force_as_of: '2020-01-01',
    });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('in_force_as_of');
    expect(err.message).toContain("language: 'english'");
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('rejects a force-window combined with in_force_as_of (version filters are exclusive)', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({
      entered_force_from: '2020-01-01',
      in_force_as_of: '2021-06-01',
    });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('entered_force_from');
    expect(err.message).toContain('in_force_as_of');
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('rejects a force-window combined with include_all_versions', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({
      left_force_to: '2021-01-01',
      include_all_versions: true,
    });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('left_force_to');
    expect(err.message).toContain('include_all_versions');
    expect(searchLegislation).not.toHaveBeenCalled();
  });
});

describe('risSearchLegislation — in_force_as_of defaulting', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchLegislation.mockResolvedValue(zeroHitsResult);
  });

  it('defaults to today in Austria and echoes appliedInForceAsOf when omitted', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Test' });
    await risSearchLegislation.handler(input, ctx);
    expect(getEnrichment(ctx).appliedInForceAsOf).toBe(todayInAustria());
  });

  it('suppresses the echo when include_all_versions is true', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ include_all_versions: true });
    await risSearchLegislation.handler(input, ctx);
    expect(getEnrichment(ctx).appliedInForceAsOf).toBeUndefined();
  });

  it('suppresses the echo when a force-window is set', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ entered_force_from: '2020-01-01' });
    await risSearchLegislation.handler(input, ctx);
    expect(getEnrichment(ctx).appliedInForceAsOf).toBeUndefined();
  });

  it('suppresses the echo for language: english', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ language: 'english' });
    await risSearchLegislation.handler(input, ctx);
    expect(getEnrichment(ctx).appliedInForceAsOf).toBeUndefined();
  });
});

describe('risSearchLegislation — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (ValidationError) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service ValidationError rejection to the invalid_query contract error', async () => {
    const upstreamError = validationError("The 'FassungVom' element is invalid.", {
      risApplication: 'BrKons',
    });
    searchLegislation.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Datenschutz' });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'FassungVom' element is invalid.");
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    searchLegislation.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Datenschutz' });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    // fetchWithTimeout classifies its own deadline as Timeout, not ServiceUnavailable. A
    // widened upstream_error guard would report -32000 for it, since ctx.fail resolves the
    // code from the contract entry — so the deadline needs its own declared reason.
    searchLegislation.mockRejectedValue(timeout('fetch GET https://data.bka.gv.at timed out.', {}));
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Datenschutz' });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('retry the same search'),
    });
  });

  it('leads the recovery hint with the page for an out-of-range page (#30)', async () => {
    // End-to-end across the seam: the REAL service, fetch stubbed with RIS's verbatim HTTP
    // 500 body, so the assertion pins what a caller receives rather than a hand-built error.
    // RIS names no element for a page past the end, so "correct the parameter named in the
    // message" resolves to nothing and the four reference topics the hint used to end on
    // are dead ends. The page has to come first.
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
    searchLegislation.mockImplementation((params, ctx) =>
      realService.searchLegislation(params, ctx),
    );

    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ title: 'DSG', page: 9999 });
    const err = await captureError(risSearchLegislation.handler(input, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Seitennummer');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringMatching(
        /^For a page past the end, request a lower page, starting from 1\./u,
      ),
    });
    vi.unstubAllGlobals();
  });

  it('leaves an unmapped service code untouched rather than folding it into a neighbour', async () => {
    // The shared mapper resolves only the four codes the contract covers. Anything else —
    // a 429, a 403 — must reach the framework classifier with its own code intact rather
    // than being collapsed into invalid_query or upstream_error.
    searchLegislation.mockRejectedValue(
      new McpError(JsonRpcErrorCode.RateLimited, 'RIS is throttling this client.', {}),
    );
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Datenschutz' });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data?.reason).toBeUndefined();
  });
});

describe('risSearchLegislation — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchLegislation.mockResolvedValue(zeroHitsResult);
  });

  it('includes the in-force-date and query-wildcard guidance for a plain query', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Datenschutz*' });
    await risSearchLegislation.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 documents matched.');
    expect(notice).toContain(`Only versions in force on ${todayInAustria()}`);
    expect(notice).toContain('wildcards are trailing-only');
  });

  it('includes the title guidance fragment when title is set', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ title: 'DSG' });
    await risSearchLegislation.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('title matches title, short title, and abbreviation');
  });

  it('includes the municipal-coverage guidance when municipality is set', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ municipality: 'Graz', scope: 'wien' });
    await risSearchLegislation.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Municipal coverage is selected norms in 6 Bundesländer');
  });

  it('includes the Erv coverage caveat for language: english', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ language: 'english' });
    await risSearchLegislation.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Erv holds ~138 selected translations only');
  });

  it('includes the citation-lookup hint for a citation-shaped query', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: '§ 6 DSG' });
    await risSearchLegislation.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('ris_lookup_citation resolves it deterministically');
  });

  it('omits the in-force-date fragment when include_all_versions is set', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ include_all_versions: true });
    await risSearchLegislation.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).not.toContain('Only versions in force on');
  });
});

describe('risSearchLegislation — record mapping and format() parity', () => {
  it('parses CELEX references into celex_references, rendered in format()', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Datenschutzgesetz' });
    const result = await risSearchLegislation.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.celex_references).toEqual(
      expect.arrayContaining(['395L0046', '32009L0133', '32010L0024', '32016L0680']),
    );
    const text = (risSearchLegislation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**CELEX:**');
    for (const celex of record.celex_references) expect(text).toContain(celex);
  });

  it('surfaces English-translation provenance on both surfaces (#22)', async () => {
    // An Erv record carries no in_force_from, no promulgation, and no eli, so without this
    // the returned document could not say which German version it renders or how stale it is.
    searchLegislation.mockResolvedValue(
      parseSearchResponse(fixture('search-erv-translations.json')),
    );
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ language: 'english', query: 'penal' });
    const result = await risSearchLegislation.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.application).toBe('Erv');
    expect(record.translation).toEqual({
      author: 'Federal Chancellery',
      source:
        'Original version: Federal Law Gazette No. 52/1991\nas amended by: Federal Law Gazette I No. 50/2025\ndate of the version: 1 November 2025',
    });

    const text = (risSearchLegislation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**Translation of:** Original version: Federal Law Gazette No. 52/1991');
    expect(text).toContain('date of the version: 1 November 2025');
    expect(text).toContain('**Translated by:** Federal Chancellery');
    // The second record's author names the amending body too — rendered whole, markup gone.
    expect(text).toContain('amendment: Federal Chancellery');
    expect(text).not.toContain('<br');
  });

  it('leaves translation absent for the German corpus', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-multi.json')));
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Bundesstraßengesetz' });
    const result = await risSearchLegislation.handler(input, ctx);
    for (const record of result.results) expect(record.translation).toBeUndefined();
  });

  it('renders every populated identity field for a multi-hit result', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-multi.json')));
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({ query: 'Bundesstraßengesetz' });
    const result = await risSearchLegislation.handler(input, ctx);
    expect(result.results).toHaveLength(3);
    const text = (risSearchLegislation.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const record of result.results) {
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.application);
      if (record.law_id !== undefined) expect(text).toContain(record.law_id);
      if (record.section_label !== undefined) expect(text).toContain(record.section_label);
      if (record.eli !== undefined) expect(text).toContain(record.eli);
      if (record.in_force_from !== undefined) expect(text).toContain(record.in_force_from);
      if (record.promulgation !== undefined) expect(text).toContain(record.promulgation);
      for (const idx of record.indexes) expect(text).toContain(idx);
      for (const celex of record.celex_references) expect(text).toContain(celex);
    }
  });
});
