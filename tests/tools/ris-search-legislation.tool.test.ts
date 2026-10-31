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
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type LegislationRecord,
  risSearchLegislation,
} from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import type { RisSearchResult } from '@/services/ris/types.js';

import {
  contentText,
  contractError,
  expectArgumentRejection,
  expectReadBack,
  HOSTILE_TEXT,
  hostileHit,
  readCommonMark,
  WEB_URL,
} from './_wire.js';

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

describe('risSearchLegislation — reversed force windows (#92)', () => {
  it('names both reversed force windows in one notice, without a RIS request', async () => {
    const result = await runToolContract(risSearchLegislation, {
      title: 'DSG',
      entered_force_from: '2026-06-30',
      entered_force_to: '2026-01-01',
      left_force_from: '2025-12-31',
      left_force_to: '2025-07-01',
    });
    const notice =
      'entered_force_from 2026-06-30 is after entered_force_to 2026-01-01; left_force_from 2025-12-31 is after left_force_to 2025-07-01 — a reversed window holds no dates, so nothing matches and RIS was not queried. Retry with the bounds swapped: entered_force_from 2026-01-01, entered_force_to 2026-06-30; left_force_from 2025-07-01, left_force_to 2025-12-31.';

    expect(result.isError).not.toBe(true);
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      notice,
      page: 1,
      pageSize: 20,
      results: [],
      totalCount: 0,
    });
    expect(contentText(result).split('\n')).toContain(`> ${notice}`);
  });

  it('still rejects a reversed window beside in_force_as_of as scope_filter_mismatch', async () => {
    const ctx = createMockContext({ errors: risSearchLegislation.errors });
    const input = risSearchLegislation.input.parse({
      entered_force_from: '2026-06-30',
      entered_force_to: '2026-01-01',
      in_force_as_of: '2026-03-01',
    });
    const err = await captureError(risSearchLegislation.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('in_force_as_of');
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
    const err = await contractError(risSearchLegislation, { query: 'Datenschutz' });
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

    const err = await contractError(risSearchLegislation, { title: 'DSG', page: 9999 });

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

// RIS reads a missing Ausserkrafttretensdatum as the latest date and a missing
// Inkrafttretensdatum as the earliest, so a window open toward that side keeps every such
// version. The page is served as RIS sends it; the notice counts those rows and names the bound
// that closes the window.
describe('risSearchLegislation — undated versions under a one-sided force window (#98)', () => {
  /** search-brkons-multi.json: three versions, one of them with no Ausserkrafttretensdatum. */
  const LEFT_OPEN =
    '1 of 3 on this page has no in_force_until — without left_force_to, RIS returns all versions with no recorded end date for left_force_from, so totalCount counts them too. Add left_force_to to keep only versions that left force in the window.';
  /** The same three versions with their Inkrafttretensdatum removed. */
  const ENTERED_OPEN =
    '3 of 3 on this page have no in_force_from — without entered_force_from, RIS returns all versions with no recorded entry-into-force date for entered_force_to, so totalCount counts them too. Add entered_force_from to keep only versions that entered force in the window.';

  /** Run one call over the wire; return the records and the enrichment fields. */
  async function callWire(input: Record<string, unknown>) {
    const result = await runToolContract(risSearchLegislation, input as never);
    expect(result.isError).not.toBe(true);
    const { results } = risSearchLegislation.output.parse(result.structuredContent);
    return { result, results, structured: result.structuredContent as Record<string, unknown> };
  }

  /** The notice reaches content[] as one block-quoted trailer line a client reads as plain text. */
  function expectNoticeLine(
    result: Awaited<ReturnType<typeof runToolContract>>,
    notice: string,
  ): void {
    const lines = contentText(result).split('\n');
    expect(lines.filter((line) => line === `> ${notice}`)).toHaveLength(1);
    expect(readCommonMark(`> ${notice}`)).toBe(
      `⟨blockquote_open⟩\n\n${notice}\n\n⟨blockquote_close⟩`,
    );
  }

  /** search-brkons-multi.json with every version's Inkrafttretensdatum removed. */
  function undatedEntryPage(): RisSearchResult {
    const raw = fixture('search-brkons-multi.json') as {
      OgdSearchResult: {
        OgdDocumentResults: {
          OgdDocumentReference: {
            Data: { Metadaten: { Bundesrecht: { BrKons: { Inkrafttretensdatum?: string } } } };
          }[];
        };
      };
    };
    for (const doc of raw.OgdSearchResult.OgdDocumentResults.OgdDocumentReference) {
      delete doc.Data.Metadaten.Bundesrecht.BrKons.Inkrafttretensdatum;
    }
    return parseSearchResponse(raw);
  }

  it('counts the versions with no in_force_until under left_force_from alone, on both surfaces', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-multi.json')));
    const { result, results, structured } = await callWire({ left_force_from: '2026-01-01' });
    expect(structured.notice).toBe(LEFT_OPEN);
    expectNoticeLine(result, LEFT_OPEN);
    // Served as RIS sent it: every row, the request, and the paging untouched.
    expect(results.map((r) => r.document_number)).toEqual([
      'NOR11013238',
      'NOR12158924',
      'NOR40148597',
    ]);
    expect(searchLegislation.mock.calls[0]![0]).toEqual({
      application: 'BrKons',
      leftForceFrom: '2026-01-01',
    });
    expect(structured).toMatchObject({
      page: 1,
      pageSize: 10,
      totalCount: 439471,
      truncated: true,
    });
  });

  it('counts the versions with no in_force_from under entered_force_to alone, on both surfaces', async () => {
    searchLegislation.mockResolvedValue(undatedEntryPage());
    const { result, results, structured } = await callWire({ entered_force_to: '1800-01-01' });
    expect(structured.notice).toBe(ENTERED_OPEN);
    expectNoticeLine(result, ENTERED_OPEN);
    expect(results).toHaveLength(3);
    expect(searchLegislation.mock.calls[0]![0]).toEqual({
      application: 'BrKons',
      enteredForceTo: '1800-01-01',
    });
    expect(structured).toMatchObject({ page: 1, pageSize: 10, totalCount: 439471 });
  });

  it('discloses the same rule under a state scope, sending the state search unchanged', async () => {
    searchLegislation.mockResolvedValue(
      parseSearchResponse(fixture('search-lrkons-abkuerzung.json')),
    );
    const { result, results, structured } = await callWire({
      left_force_from: '2026-01-01',
      scope: 'wien',
    });
    const notice =
      '4 of 4 on this page have no in_force_until — without left_force_to, RIS returns all versions with no recorded end date for left_force_from, so totalCount counts them too. Add left_force_to to keep only versions that left force in the window.';
    expect(structured.notice).toBe(notice);
    expectNoticeLine(result, notice);
    expect(results).toHaveLength(4);
    expect(searchLegislation.mock.calls[0]![0]).toEqual({
      application: 'LrKons',
      leftForceFrom: '2026-01-01',
      state: 'wien',
    });
    expect(structured).toMatchObject({ page: 1, pageSize: 20, totalCount: 4 });
  });

  it.each([
    ['a two-sided repeal window', { left_force_from: '2026-01-01', left_force_to: '2026-12-31' }],
    ['left_force_to alone', { left_force_to: '2026-12-31' }],
  ])('adds no notice under %s, though rows lack in_force_until', async (_label, input) => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-multi.json')));
    const { results, structured } = await callWire(input);
    expect(results.filter((r) => r.in_force_until === undefined)).toHaveLength(1);
    expect(structured).not.toHaveProperty('notice');
  });

  it.each([
    [
      'a two-sided entry window',
      { entered_force_from: '1700-01-01', entered_force_to: '1800-01-01' },
    ],
    ['entered_force_from alone', { entered_force_from: '1800-01-01' }],
  ])('adds no notice under %s, though rows lack in_force_from', async (_label, input) => {
    searchLegislation.mockResolvedValue(undatedEntryPage());
    const { results, structured } = await callWire(input);
    expect(results.filter((r) => r.in_force_from === undefined)).toHaveLength(3);
    expect(structured).not.toHaveProperty('notice');
  });

  it('states both rules when the window is open on both undated sides', async () => {
    searchLegislation.mockResolvedValue(undatedEntryPage());
    const { result, structured } = await callWire({
      entered_force_to: '2026-12-31',
      left_force_from: '2026-01-01',
    });
    const notice = `${ENTERED_OPEN} ${LEFT_OPEN}`;
    expect(structured.notice).toBe(notice);
    expectNoticeLine(result, notice);
  });

  it('leads with the page-size sentence, in one notice', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-multi.json')));
    const { result, structured } = await callWire({ left_force_from: '2026-01-01', page_size: 50 });
    const notice = structured.notice as string;
    expect(notice.startsWith('page_size 50 served as 20 — ')).toBe(true);
    expect(notice.endsWith(` ${LEFT_OPEN}`)).toBe(true);
    expectNoticeLine(result, notice);
  });
});

describe('risSearchLegislation — text filters: blank rejected, non-blank passed through (#39)', () => {
  /** Every optional free-text input: [field, the sibling input it needs, a value, builder key]. */
  const TEXT_FILTERS = [
    ['query', {}, ' Datenschutz UND DSGVO ', 'query'],
    ['title', {}, 'DSG', 'title'],
    ['municipality', { scope: 'wien' }, 'Wien', 'municipality'],
    ['section_from', {}, '6', 'sectionFrom'],
    ['section_to', {}, '1a', 'sectionTo'],
    ['law_id', {}, '10001597', 'lawId'],
    ['index', {}, '10/10 Datenschutz', 'index'],
  ] as const;

  beforeEach(() => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
  });

  it.each(TEXT_FILTERS)(
    '%s: a non-blank value reaches RIS unchanged',
    async (field, base, value, key) => {
      const result = await runToolContract(risSearchLegislation, {
        ...base,
        [field]: value,
      } as never);
      expect(result.isError).not.toBe(true);
      expect(searchLegislation).toHaveBeenCalledTimes(1);
      expect(searchLegislation.mock.calls[0]![0]).toMatchObject({ [key]: value });
    },
  );

  it.each(
    TEXT_FILTERS.flatMap((row) =>
      ['', '   ', '\t\n'].map((blank) => [row[0], blank, row[1]] as const),
    ),
  )('%s: %j is rejected over the wire before any RIS call', async (field, blank, base) => {
    const result = await runToolContract(risSearchLegislation, {
      ...base,
      [field]: blank,
    } as never);
    expectArgumentRejection(result, [`${field}: `, 'omit the field to leave it unfiltered']);
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('rejects a blank municipality under a state scope instead of searching state law', async () => {
    // municipality: "" used to fall back to consolidated state law (LrKons) — a silent
    // re-route from municipal to state law, not an unfiltered municipal search.
    const result = await runToolContract(risSearchLegislation, {
      municipality: '',
      scope: 'wien',
    });
    expectArgumentRejection(result, ['municipality: ']);
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('sends none of the text filters when every one is omitted', async () => {
    const result = await runToolContract(risSearchLegislation, {});
    expect(result.isError).not.toBe(true);
    const params = searchLegislation.mock.calls[0]![0] as Record<string, unknown>;
    for (const [, , , key] of TEXT_FILTERS) expect(params).not.toHaveProperty(key);
    expect(params).toMatchObject({ application: 'BrKons' });
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

  it('carries the consolidated federal abbreviation on both surfaces (#51)', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const result = await runToolContract(risSearchLegislation, {
      scope: 'federal',
      title: 'Datenschutzgesetz',
    });
    expect(result.isError).not.toBe(true);
    const [record] = (result.structuredContent as { results: LegislationRecord[] }).results;
    expect(record).toMatchObject({ document_number: 'NOR40262691', abbreviation: 'DSG' });
    expect(contentText(result)).toContain('**Abbreviation:** DSG');
  });

  it('carries the trimmed state abbreviation on both surfaces, absent where RIS sends none (#51)', async () => {
    searchLegislation.mockResolvedValue(
      parseSearchResponse(fixture('search-lrkons-abkuerzung.json')),
    );
    const result = await runToolContract(risSearchLegislation, {
      scope: 'wien',
      title: 'BO für Wien',
    });
    expect(result.isError).not.toBe(true);
    const { results } = result.structuredContent as { results: LegislationRecord[] };
    expect(results.map((r) => r.application)).toEqual(Array(4).fill('LrKons'));
    expect(results.map((r) => r.abbreviation)).toEqual([
      'BO für Wien',
      'BO für Wien',
      'ALHVO 2022',
      undefined,
    ]);
    expect(results[3]).not.toHaveProperty('abbreviation');
    const blocks = contentText(result)
      .split('\n\n')
      .filter((block) => block.startsWith('## '));
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toContain('**Abbreviation:** BO für Wien');
    expect(blocks[2]).toContain('**Abbreviation:** ALHVO 2022 |');
    expect(blocks[3]).not.toContain('**Abbreviation:**');
  });

  it('carries federal keywords (Schlagworte) on both surfaces (#63)', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const result = await runToolContract(risSearchLegislation, { title: 'Datenschutzgesetz' });
    expect(result.isError).not.toBe(true);
    const [record] = (result.structuredContent as { results: LegislationRecord[] }).results;
    expect(record!.keywords).toMatch(/^e-rk3, Inh, Gewinnabsicht, /u);
    expect(record!.keywords).toContain(
      'Informationsfreiheits-Anpassungsgesetz (BGBl. I Nr. 50/2025)',
    );
    // RIS's <br/> between keyword groups no longer breaks the line: the whole list stays on it.
    const keywordsLine = contentText(result)
      .split('\n')
      .find((line) => line.startsWith('**Keywords:** '));
    expect(keywordsLine).toBe(`**Keywords:** ${record!.keywords}`);
  });

  it('carries state keywords on both surfaces, absent where RIS sends none (#63)', async () => {
    searchLegislation.mockResolvedValue(
      parseSearchResponse(fixture('search-lrkons-abkuerzung.json')),
    );
    const result = await runToolContract(risSearchLegislation, { scope: 'wien' });
    expect(result.isError).not.toBe(true);
    const { results } = result.structuredContent as { results: LegislationRecord[] };
    expect(results[0]!.keywords).toMatch(/^Bauordnung, Bau, Stadtentwicklung,/u);
    expect(results[1]).not.toHaveProperty('keywords');
    expect(results[2]).not.toHaveProperty('keywords');
    expect(results[3]!.keywords).toMatch(/^Pensionsordnung, /u);
    const blocks = contentText(result)
      .split('\n\n')
      .filter((block) => block.startsWith('## '));
    expect(blocks[0]).toContain(`**Keywords:** ${results[0]!.keywords}`);
    expect(blocks[1]).not.toContain('**Keywords:**');
    expect(blocks[2]).not.toContain('**Keywords:**');
    expect(blocks[3]).toContain(`**Keywords:** ${results[3]!.keywords}`);
  });

  it('leaves keywords absent on an English translation (#63)', async () => {
    searchLegislation.mockResolvedValue(
      parseSearchResponse(fixture('search-erv-translations.json')),
    );
    const result = await runToolContract(risSearchLegislation, { language: 'english' });
    const { results } = result.structuredContent as { results: LegislationRecord[] };
    for (const record of results) expect(record).not.toHaveProperty('keywords');
    expect(contentText(result)).not.toContain('**Keywords:**');
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

describe('risSearchLegislation — in-force line (#69)', () => {
  async function versions() {
    searchLegislation.mockResolvedValue(
      parseSearchResponse(fixture('search-brkons-estg-section-2.json')),
    );
    const result = await runToolContract(risSearchLegislation, {
      include_all_versions: true,
      title: 'EStG',
    });
    expect(result.isError).not.toBe(true);
    const { results } = risSearchLegislation.output.parse(result.structuredContent);
    const text = contentText(result);
    const blockFor = (documentNumber: string) =>
      text.split('\n\n').find((block) => block.includes(`**Document:** ${documentNumber}`)) ?? '';
    return { blockFor, byId: new Map(results.map((r) => [r.document_number, r])), text };
  }

  it('renders a version with no end date as "→ no end date", never as still in force', async () => {
    const { blockFor, byId, text } = await versions();
    expect(byId.get('NOR40261333')!.in_force_from).toBe('2024-01-01');
    expect(byId.get('NOR40261333')).not.toHaveProperty('in_force_until');
    expect(blockFor('NOR40261333')).toContain('\n**In force:** 2024-01-01 → no end date\n');
    expect(text).not.toMatch(/still in force/iu);
  });

  it('keeps the from → until line of a version with an end date (regression)', async () => {
    const { blockFor, byId } = await versions();
    expect(byId.get('NOR40246516')).toMatchObject({
      in_force_from: '2022-07-29',
      in_force_until: '2026-12-31',
    });
    expect(blockFor('NOR40246516')).toContain('\n**In force:** 2022-07-29 → 2026-12-31\n');
  });

  it('describes in_force_until by the in-force rule, not as "absent while in force"', () => {
    const field = risSearchLegislation.output.shape.results.element.shape.in_force_until;
    expect(field.description).not.toMatch(/absent while in force|still in force/iu);
    expect(field.description).toContain(
      'in force on date D when in_force_from ≤ D and in_force_until is absent or ≥ D',
    );
    expect(field.description).toContain('9000-01-01');
  });
});

// The fold itself is swept across every state parameter in _shared.test.ts; this pins that the
// folded code is what reaches the request on the wire path.
describe('risSearchLegislation — state names in scope (#58)', () => {
  it.each([
    ['Wien', 'wien'],
    ['niederösterreich', 'niederoesterreich'],
    ['Upper Austria', 'oberoesterreich'],
  ])('searches the state named %j as scope: %s', async (scope, code) => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
    const result = await runToolContract(risSearchLegislation, { scope, title: 'Bauordnung' });
    expect(result.isError).not.toBe(true);
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      application: 'LrKons',
      state: code,
    });
  });
});

describe('risSearchLegislation — content[] reads back RIS text verbatim (#79)', () => {
  it('reads back every hostile-shaped field of federal, state, municipal, and translation records', async () => {
    const page = parseSearchResponse(fixture('search-brkons-multi.json'));
    const pick = (name: string) => (parseSearchResponse(fixture(name)) as RisSearchResult).hits[0]!;
    const [federal] = page.hits;
    const hits = [
      {
        ...hostileHit(federal!, 0, { title: HOSTILE_TEXT.multiLineTitle }),
        documentNumber: `~~${federal!.documentNumber}~~`,
      },
      hostileHit(pick('search-lrkons-abkuerzung.json'), 1, { title: HOSTILE_TEXT.listOpener }),
      hostileHit(pick('search-gra.json'), 2, { municipality: HOSTILE_TEXT.inline }),
      hostileHit(pick('search-erv-translations.json'), 3, {
        source: HOSTILE_TEXT.blockMarkers,
        title: undefined,
      }),
    ];
    searchLegislation.mockResolvedValue({ ...page, hits });
    const result = await runToolContract(risSearchLegislation, { query: 'Gesetz' });
    expect(result.isError).not.toBe(true);
    const { results } = risSearchLegislation.output.parse(result.structuredContent);
    // structuredContent relays the RIS strings as written.
    expect(results[0]).toMatchObject({
      document_number: `~~${federal!.documentNumber}~~`,
      title: HOSTILE_TEXT.multiLineTitle,
    });
    expect(results[2]!.municipality).toBe(HOSTILE_TEXT.inline);
    expect(results[3]!.translation?.source).toBe(HOSTILE_TEXT.blockMarkers);
    expect(results[0]!.law_url).toMatch(WEB_URL);
    expect(results[0]!.eli).toMatch(WEB_URL);

    const blocks = expectReadBack(result, results);
    results.forEach((record, i) => {
      const read = readCommonMark(blocks[i]!);
      expect(
        read.startsWith(`⟨heading_open⟩\n\n${record.document_number}\n\n⟨heading_close⟩`),
      ).toBe(true);
      if (record.title !== undefined) {
        expect(read).toContain(`⟨strong⟩Title:⟨/strong⟩ ${record.title}\n`);
      }
    });
    expect(readCommonMark(blocks[0]!)).toContain(`⟨strong⟩ELI:⟨/strong⟩ ⟨a⟩${results[0]!.eli}⟨/a⟩`);
    expect(readCommonMark(blocks[3]!)).not.toContain('Title:');
    expect(readCommonMark(blocks[3]!)).toContain(
      `⟨strong⟩Translation of:⟨/strong⟩ ${HOSTILE_TEXT.blockMarkers}\n`,
    );
  });

  it('keeps a consolidated title’s StF line out of the heading and reads it back', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const result = await runToolContract(risSearchLegislation, { title: 'Datenschutzgesetz' });
    expect(result.isError).not.toBe(true);
    const { results } = risSearchLegislation.output.parse(result.structuredContent);
    expect(results[0]!.title).toMatch(/\nStF: BGBl\. I Nr\. 165\/1999/u);
    const [block] = expectReadBack(result, results);
    expect(readCommonMark(block!)).toMatch(
      /^⟨heading_open⟩\n\nNOR40262691\n\n⟨heading_close⟩\n\n⟨strong⟩Title:⟨\/strong⟩ /u,
    );
    expect(readCommonMark(block!)).toContain(`⟨strong⟩Title:⟨/strong⟩ ${results[0]!.title}\n`);
  });
});
