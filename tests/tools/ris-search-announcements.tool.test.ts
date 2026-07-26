/**
 * @fileoverview Tests for the ris_search_announcements tool — local per-collection
 * filter-matrix guards (rejected before any network call), the binding label assigned
 * per collection, error-contract mapping, zero-hit notices, and record-mapping/
 * format() parity across the Sonstige controller's collections. The RIS service
 * module is mocked so the suite is fully offline; success-path fixtures are run
 * through the real normalizer so results stay realistic.
 * @module tests/tools/ris-search-announcements.tool.test
 */

import { readFileSync } from 'node:fs';

import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import {
  type AnnouncementsSearchParams,
  buildAnnouncementsRequest,
} from '@/services/ris/request-builder.js';

const { searchAnnouncements } = vi.hoisted(() => ({ searchAnnouncements: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchAnnouncements }),
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
  searchAnnouncements.mockReset();
});

describe('risSearchAnnouncements — local guards (no service call)', () => {
  it('rejects number sent to court_rules (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'court_rules', number: '12' });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("number is not a valid filter for collection 'court_rules'");
    expect(err.message).toContain(
      'it accepts: query, title, published_from, published_to, in_force_as_of, type',
    );
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects title sent to council_minutes (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'council_minutes',
      title: 'Ministerrat',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("title is not a valid filter for collection 'council_minutes'");
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects norm sent to social_insurance (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      norm: 'DSG §1',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("norm is not a valid filter for collection 'social_insurance'");
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects published_from sent to ministerial_decrees (decrees date by force, not publication)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'ministerial_decrees',
      published_from: '2020-01-01',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain(
      "published_from is not a valid filter for collection 'ministerial_decrees'",
    );
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects case_number sent to health_structure_plans (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'health_structure_plans',
      case_number: 'G 1/2020',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain(
      "case_number is not a valid filter for collection 'health_structure_plans'",
    );
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects issuer sent to trade_exam_rules (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'trade_exam_rules',
      issuer: 'BMF',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("issuer is not a valid filter for collection 'trade_exam_rules'");
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });
});

describe('risSearchAnnouncements — binding label per collection', () => {
  // `binding` is looked up purely from the requested `collection` — independent of the
  // mocked hit's actual shape — so a single realistic fixture is enough to sweep every
  // collection's designated label.
  const collectionBindings: [collection: string, binding: string][] = [
    ['social_insurance', 'authentic'],
    ['veterinary', 'authentic'],
    ['court_rules', 'authentic'],
    ['trade_exam_rules', 'authentic'],
    ['health_structure_plans', 'authentic'],
    ['ministerial_decrees', 'administrative_directive'],
    ['council_minutes', 'preparatory'],
  ];

  it('labels each collection with its designated binding value', async () => {
    for (const [collection, binding] of collectionBindings) {
      searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-mrp.json')));
      const ctx = createMockContext();
      const input = risSearchAnnouncements.input.parse({ collection });
      const result = await risSearchAnnouncements.handler(input, ctx);
      expect(result.results[0]!.binding).toBe(binding);
      expect(result.results[0]!.collection).toBe(collection);
    }
  });
});

describe('risSearchAnnouncements — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchAnnouncements.mockResolvedValue(zeroHitsResult);
  });

  it('names the collection in the base fragment', async () => {
    const ctx = createMockContext();
    const input = risSearchAnnouncements.input.parse({ collection: 'social_insurance' });
    await risSearchAnnouncements.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 documents in social_insurance.');
  });

  it('includes the norm-format guidance when norm is set', async () => {
    const ctx = createMockContext();
    const input = risSearchAnnouncements.input.parse({ collection: 'veterinary', norm: 'DSG §1' });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain("norm must match RIS's cited-norm format");
  });

  it('includes the issuer-designation guidance when issuer is set', async () => {
    const ctx = createMockContext();
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      issuer: 'ÖGK',
    });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('issuer must match the RIS designation');
  });

  it('includes the KmGer coverage caveat for collection: court_rules', async () => {
    const ctx = createMockContext();
    const input = risSearchAnnouncements.input.parse({ collection: 'court_rules' });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 documents in court_rules.');
    expect(notice).toContain('KmGer currently carries LVwG Tirol and Vorarlberg rules only.');
  });
});

describe('risSearchAnnouncements — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (InvalidParams) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service InvalidParams rejection to the invalid_query contract error', async () => {
    const upstreamError = invalidParams("The 'Kundmachung.Von' element is invalid.", {
      risApplication: 'Avsv',
    });
    searchAnnouncements.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      query: 'Beitragsgrundlage',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'Kundmachung.Von' element is invalid.");
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    searchAnnouncements.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      query: 'Beitragsgrundlage',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    searchAnnouncements.mockRejectedValue(
      timeout('fetch GET https://data.bka.gv.at timed out.', {}),
    );
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'social_insurance' });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
  });

  // Both rejections below pass the input schema and are then refused by the request builder.
  // The real builder runs on the params the handler produced, so the assertions pin the
  // actual rejection rather than an invented one. Each reached the wire as a bare -32007
  // with no reason and no recovery (#12).
  it('maps a builder rejection of a schema-valid sort_by to invalid_query', async () => {
    searchAnnouncements.mockImplementation(async (params: AnnouncementsSearchParams) => {
      buildAnnouncementsRequest(params);
      throw new Error('unreachable — the builder was expected to reject these params');
    });
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'health_structure_plans',
      sort_by: 'published',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('no confirmed RIS mapping for application Spg');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('Correct the parameter named in the message'),
    });
  });

  it('maps a builder rejection of an unknown issuer to invalid_query', async () => {
    searchAnnouncements.mockImplementation(async (params: AnnouncementsSearchParams) => {
      buildAnnouncementsRequest(params);
      throw new Error('unreachable — the builder was expected to reject these params');
    });
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'ministerial_decrees',
      issuer: 'BMXX',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Unknown ministry "BMXX"');
    expect(err.data?.recovery).toBeDefined();
  });
});

describe('risSearchAnnouncements — record mapping and format() parity', () => {
  it('renders every populated field for a multi-hit council_minutes result, title falls back to document_number', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-mrp.json')));
    const ctx = createMockContext();
    const input = risSearchAnnouncements.input.parse({ collection: 'council_minutes' });
    const result = await risSearchAnnouncements.handler(input, ctx);
    expect(result.results).toHaveLength(2);

    const first = result.results[0]!;
    const second = result.results[1]!;
    // Neither hit carries a title or summary — the header must fall all the way back to
    // the document number rather than rendering an empty heading.
    expect(first.title).toBeUndefined();
    expect(first.summary).toBeUndefined();
    expect(first.issuers).toHaveLength(5);
    expect(second.issuers).toHaveLength(1);
    expect(first.session_date).toBe('2026-07-01');
    expect(first.authentic_pdf_url).toBeUndefined();

    const text = (risSearchAnnouncements.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('## MRP_20260701_59');
    for (const record of result.results) {
      expect(record.binding).toBe('preparatory');
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.collection);
      if (record.session_date !== undefined) expect(text).toContain(record.session_date);
      for (const issuer of record.issuers) expect(text).toContain(issuer);
    }
  });

  it('maps an Avsv (social_insurance) hit — number, summary, and the authentic PDF surface', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-avsv.json')));
    const ctx = createMockContext();
    const input = risSearchAnnouncements.input.parse({ collection: 'social_insurance' });
    const result = await risSearchAnnouncements.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.binding).toBe('authentic');
    expect(record.number).toBe('40');
    expect(record.published).toBe('2026-07-02');
    expect(record.summary).toContain('Höchstbeitragsgrundlage');
    expect(record.issuers).toEqual(['ÖGK']);
    expect(record.authentic_pdf_url).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Avsv/AVSV_2026_0040/AVSV_2026_0040.pdfsig',
    );
    expect(record.content_urls.pdf).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Avsv/AVSV_2026_0040/AVSV_2026_0040.pdf',
    );

    const text = (risSearchAnnouncements.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(record.document_number);
    expect(text).toContain('**Number:** 40');
    expect(text).toContain(record.summary!);
    expect(text).toContain('ÖGK');
    expect(text).toContain(record.authentic_pdf_url!);
  });
});
