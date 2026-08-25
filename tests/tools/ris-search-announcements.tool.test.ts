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
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
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
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
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
      const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
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
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'social_insurance' });
    await risSearchAnnouncements.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 documents in social_insurance.');
  });

  it('includes the norm-format guidance when norm is set', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'veterinary', norm: 'DSG §1' });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain("norm must match RIS's cited-norm format");
  });

  it('includes the issuer-designation guidance when issuer is set', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      issuer: 'ÖGK',
    });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('issuer must match the RIS designation');
  });

  it('includes the KmGer coverage caveat for collection: court_rules', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'court_rules' });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 documents in court_rules.');
    expect(notice).toContain('KmGer currently carries LVwG Tirol and Vorarlberg rules only.');
  });
});

describe('risSearchAnnouncements — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (ValidationError) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service ValidationError rejection to the invalid_query contract error', async () => {
    const upstreamError = validationError("The 'Kundmachung.Von' element is invalid.", {
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

  // Each case below passes the input schema and is then refused by the request builder. The
  // real builder runs on the params the handler produced, so the asserted message is the one
  // a caller actually receives. The builder names the service param and the RIS application
  // code the caller never sent; the handler restates both over the collection value and the
  // tool's own field name, and names the sort columns the collection does have where it has
  // any (#12, #29).
  it.each([
    [
      'a collection that sorts by number only',
      { collection: 'health_structure_plans', sort_by: 'published' },
      "sort_by: 'published' is not available for collection 'health_structure_plans'. Use sort_by: 'number', or drop sort_by.",
    ],
    [
      'a collection with no sortable column at all',
      { collection: 'court_rules', sort_by: 'number' },
      "sort_by: 'number' is not available for collection 'court_rules'. Drop sort_by — this collection carries no sortable column.",
    ],
    [
      'a decrees collection with no sortable column',
      { collection: 'ministerial_decrees', sort_by: 'published' },
      "sort_by: 'published' is not available for collection 'ministerial_decrees'. Drop sort_by — this collection carries no sortable column.",
    ],
  ])(
    'states a builder sort_by rejection for %s in the caller’s vocabulary',
    async (_label, raw, message) => {
      searchAnnouncements.mockImplementation(async (params: AnnouncementsSearchParams) => {
        buildAnnouncementsRequest(params);
        throw new Error('unreachable — the builder was expected to reject these params');
      });
      const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
      const input = risSearchAnnouncements.input.parse(raw);
      const err = await captureError(risSearchAnnouncements.handler(input, ctx));
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'invalid_query' });
      expect(err.message).toBe(message);
      // Nothing the caller could not have written itself survives into the message.
      expect(err.message).not.toMatch(/Spg|KmGer|Erlaesse|sortBy/u);
      expect(err.message).not.toContain('silently ignored upstream');
      expect(err.data?.recovery).toMatchObject({
        hint: expect.stringContaining('correct the parameter named in the message'),
      });
    },
  );

  it('leads the recovery hint with the page for an out-of-range page (#30)', async () => {
    // RIS answers a page past the end with a German message that names no element, so
    // "correct the parameter named in the message" resolves to nothing and the reference
    // topics are dead ends. The page has to come first in the hint.
    searchAnnouncements.mockRejectedValue(
      validationError('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten', {}),
    );
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      page: 9999,
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Seitennummer');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringMatching(
        /^For a page past the end, request a lower page, starting from 1\./u,
      ),
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
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
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
    // Council minutes are PDF-only, so the RIS web view is the only surface a person can
    // open — and it was the field this record dropped.
    expect(first.document_url).toBe(
      'https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Mrp&Dokumentnummer=MRP_20260701_59',
    );

    const text = (risSearchAnnouncements.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('## MRP_20260701_59');
    for (const record of result.results) {
      expect(record.binding).toBe('preparatory');
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.collection);
      if (record.session_date !== undefined) expect(text).toContain(record.session_date);
      for (const issuer of record.issuers) expect(text).toContain(issuer);
      expect(text).toContain(`**RIS view:** ${record.document_url}`);
    }
  });

  it('maps an Avsv (social_insurance) hit — number, summary, and the authentic PDF surface', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-avsv.json')));
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
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
    expect(record.document_url).toBe(
      'https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Avsv&Dokumentnummer=AVSV_2026_0040',
    );

    const text = (risSearchAnnouncements.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(record.document_number);
    expect(text).toContain('**Number:** 40');
    expect(text).toContain(record.summary!);
    expect(text).toContain('ÖGK');
    expect(text).toContain(record.authentic_pdf_url!);
    expect(text).toContain(`**RIS view:** ${record.document_url}`);
  });
});
