/**
 * @fileoverview Tests for the ris_search_case_law tool — local court-conditional-filter
 * guards (rejected before any network call), error-contract mapping, zero-hit notices,
 * and record-mapping/format() parity. The RIS service module is mocked so the suite is
 * fully offline; success-path fixtures are run through the real normalizer so results
 * stay realistic.
 * @module tests/tools/ris-search-case-law.tool.test
 */

import { readFileSync } from 'node:fs';

import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risSearchCaseLaw } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';

const { searchCaseLaw } = vi.hoisted(() => ({ searchCaseLaw: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchCaseLaw }),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(promise: Promise<unknown>): Promise<McpError> {
  const err = await promise.catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

beforeEach(() => {
  searchCaseLaw.mockReset();
});

describe('risSearchCaseLaw — local guards (no service call)', () => {
  it('rejects issuing_body sent with a court outside dsk/dok/pvak/verg', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'vfgh',
      issuing_body: 'Datenschutzbehoerde',
    });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('issuing_body');
    expect(err.message).toContain("got 'vfgh'");
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects collection_number sent with a court outside vfgh/vwgh/uvs', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'justiz',
      collection_number: 'VfSlg 19.632/2012',
    });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('collection_number');
    expect(err.message).toContain("got 'justiz'");
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects state sent with a court outside lvwg/uvs', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', state: 'wien' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('state');
    expect(err.message).toContain('lvwg/uvs');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects party sent with a non-upts court', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', party: 'SPÖ' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('party');
    expect(err.message).toContain('upts');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects case_number sent with court normenliste (a norm index, not decisions)', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'normenliste', case_number: 'G 287/2022' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('case_number');
    expect(err.message).toContain('normenliste');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects a non-default decision_type sent with court upts', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'upts', decision_type: 'headnote' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('decision_type');
    expect(err.message).toContain('upts');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects decision_kind for a court with no Entscheidungsart parameter', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'normenliste', decision_kind: 'anything' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('decision_kind');
    expect(err.message).toContain('normenliste');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects an invalid decision_kind value for a court that has the parameter (invalid_query)', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', decision_kind: 'NotARealKind' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("decision_kind 'NotARealKind'");
    expect(err.message).toContain('Erkenntnis');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects a subject_area value outside the Justiz Fachgebiet taxonomy (invalid_query)', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'justiz', subject_area: 'NotARealArea' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("subject_area 'NotARealArea'");
    expect(err.message).toContain('justiz_subject_areas');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });
});

describe('risSearchCaseLaw — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (InvalidParams) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service InvalidParams rejection to the invalid_query contract error', async () => {
    const upstreamError = invalidParams("The 'Entscheidungsart' element is invalid.", {
      risApplication: 'Vfgh',
    });
    searchCaseLaw.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', query: 'Datenschutz' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'Entscheidungsart' element is invalid.");
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    searchCaseLaw.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', query: 'Datenschutz' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });
});

describe('risSearchCaseLaw — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchCaseLaw.mockResolvedValue(zeroHitsResult);
  });

  it('includes the per-court base fragment', async () => {
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 decisions in vfgh. Other courts are separate calls');
  });

  it('includes the Geschäftszahl-format guidance when case_number is set', async () => {
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', case_number: 'G 287/2022' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Geschäftszahl formats differ per court');
  });

  it('includes the norm-format guidance when norm is set', async () => {
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', norm: 'DSG §1' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain("norm must match RIS's cited-norm format");
  });

  it('includes the coverage-start-year guidance when decided_to predates the court window', async () => {
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'bvwg', decided_to: '2010-01-01' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('bvwg coverage starts 2014');
  });

  it('includes the historical-court successor guidance', async () => {
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'uvs' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('uvs is historical');
    expect(notice).toContain('its successor is lvwg');
  });

  it('flags the unpopulated Fachgebiet/decision_kind tags for justiz', async () => {
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({
      court: 'justiz',
      decision_kind: 'Ordentliche Erledigung (Sachentscheidung)',
    });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('not yet populated in the RIS corpus');
  });
});

describe('risSearchCaseLaw — enrichment: truncation disclosure', () => {
  // A declared enrichment field, once set via ctx.enrich, is merged into structuredContent
  // AND auto-appended to content[] as the framework's enrichment trailer; getEnrichment(ctx)
  // reads that merged surface, so it stands in for both what structured- and content-only
  // clients receive (matching how ris-track-changes asserts its own truncated field).
  it('sets truncated=true when the total exceeds the current page', async () => {
    // Mirrors issue #3's live case: page 1 of pageSize 10 with far more matches beyond it.
    const base = parseSearchResponse(fixture('search-vfgh.json'));
    searchCaseLaw.mockResolvedValue({ ...base, total: 625, page: 1, pageSize: 10 });
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({
      court: 'vwgh',
      query: 'Datenschutz',
      page_size: 10,
    });
    await risSearchCaseLaw.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(625);
    expect(enrichment.page).toBe(1);
    expect(enrichment.pageSize).toBe(10);
    expect(enrichment.truncated).toBe(true);
  });

  it('leaves truncated unset when the page holds every match', async () => {
    const base = parseSearchResponse(fixture('search-vfgh.json'));
    // total equals the hits on this single page → nothing exists beyond it.
    searchCaseLaw.mockResolvedValue({ ...base, total: base.hits.length, page: 1, pageSize: 10 });
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({
      court: 'vwgh',
      query: 'Datenschutz',
      page_size: 10,
    });
    await risSearchCaseLaw.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(base.hits.length);
    expect(enrichment.truncated).toBeUndefined();
  });
});

describe('risSearchCaseLaw — record mapping and format() parity', () => {
  it('normalizes an array Geschäftszahl into multiple case_numbers, all rendered in format()', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-gz-array.json')));
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.case_numbers.length).toBeGreaterThan(1);
    expect(record.case_numbers[0]).toBe('E33/2026 ua');
    const text = (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const gz of record.case_numbers) expect(text).toContain(gz);
  });

  it('renders every populated field for a multi-hit result', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    expect(result.results).toHaveLength(2);
    const text = (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const record of result.results) {
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.court);
      for (const gz of record.case_numbers) expect(text).toContain(gz);
      if (record.decision_date !== undefined) expect(text).toContain(record.decision_date);
      if (record.decision_type !== undefined) expect(text).toContain(record.decision_type);
      if (record.decision_kind !== undefined) expect(text).toContain(record.decision_kind);
      if (record.ecli !== undefined) expect(text).toContain(record.ecli);
      if (record.keywords !== undefined) expect(text).toContain(record.keywords);
      if (record.guiding_principle !== undefined) expect(text).toContain(record.guiding_principle);
      for (const norm of record.norms_cited) expect(text).toContain(norm);
    }
  });

  it('surfaces the guiding principle (Leitsatz) from a VfGH Rechtssatz and renders it', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext();
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    const withPrinciple = result.results.find((r) => r.guiding_principle !== undefined);
    expect(withPrinciple, 'a VfGH hit should surface guiding_principle (Leitsatz)').toBeDefined();
    const text = (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**Guiding principle:**');
    expect(text).toContain(withPrinciple!.guiding_principle!);
  });
});
