/**
 * @fileoverview Tests for the ris_search_gazette tool — local scope/filter guards
 * (rejected before any network call), the Vbl non-Tirol short-circuit, federal
 * era-tier routing, error-contract mapping, zero-hit notices, and record-mapping/
 * format() parity across the five gazette scopes (federal, state, district,
 * municipal, non-authentic state). The RIS service module is mocked so the suite
 * is fully offline; success-path fixtures are run through the real normalizer so
 * results stay realistic.
 * @module tests/tools/ris-search-gazette.tool.test
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

import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';

const { searchGazette } = vi.hoisted(() => ({ searchGazette: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchGazette }),
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
  searchGazette.mockReset();
});

describe('risSearchGazette — local guards (no service call)', () => {
  it('rejects part combined with a non-federal scope', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'wien', part: 'part1' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('part applies only to scope: federal');
    expect(err.message).toContain("scope: 'wien'");
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects series combined with scope: federal', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'federal', series: 'law_gazette' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('series applies only to a state scope');
    expect(err.message).toContain("scope: 'federal'");
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects include_non_authentic combined with a non-state scope', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'district', include_non_authentic: true });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('include_non_authentic applies only to a state scope');
    expect(err.message).toContain("scope: 'district'");
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects district_authority combined with a non-district scope', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({
      scope: 'municipal',
      district_authority: 'Bezirkshauptmannschaft Liezen',
    });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('district_authority applies only to scope: district');
    expect(err.message).toContain("scope: 'municipal'");
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects municipality combined with scope: federal', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'federal', municipality: 'Graz' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('municipality applies only to scope: municipal');
    expect(err.message).toContain("scope: 'federal'");
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects issuer combined with a state law-gazette scope (names the law_gazette default)', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'tirol', issuer: 'BMF' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('issuer applies only to federal or ordinance gazettes');
    expect(err.message).toContain("scope: 'tirol'");
    expect(err.message).toContain('with law_gazette');
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects issuer combined with a non-federal, non-state scope (no law_gazette suffix)', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'district', issuer: 'BMF' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('issuer applies only to federal or ordinance gazettes');
    expect(err.message).toContain("scope: 'district'");
    expect(err.message).not.toContain('law_gazette');
    expect(searchGazette).not.toHaveBeenCalled();
  });
});

describe('risSearchGazette — Vbl non-Tirol short-circuit', () => {
  it('returns a zero-hit success without calling the service for a non-Tirol ordinance-gazette request', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'wien', series: 'ordinance_gazette' });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results).toEqual([]);
    expect(searchGazette).not.toHaveBeenCalled();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.servedApplication).toBe('Vbl');
    expect(enrichment.notice).toContain(
      "Verordnungsblätter in RIS currently cover Tirol (2022+) — other states' ordinance gazettes are not yet published here.",
    );
  });

  it('calls the service normally for scope: tirol (the one state Vbl covers)', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'tirol', series: 'ordinance_gazette' });
    await risSearchGazette.handler(input, ctx);
    expect(searchGazette).toHaveBeenCalledOnce();
    expect(getEnrichment(ctx).servedApplication).toBe('Vbl');
  });
});

describe('risSearchGazette — federal era-tier routing (servedApplication)', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchGazette.mockResolvedValue(zeroHitsResult);
  });

  it('routes a bare current-era number to BgblAuth', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ number: '171/2026' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblAuth');
  });

  it('routes a pre-2004 number to BgblPdf', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ number: '50/1998' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblPdf');
  });

  it('routes a pre-1945 date range to BgblAlt', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ published_from: '1900-01-01' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblAlt');
  });

  it('forces the postwar tier for part: pre_1997 regardless of number', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ part: 'pre_1997' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblPdf');
  });
});

describe('risSearchGazette — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchGazette.mockResolvedValue(zeroHitsResult);
  });

  it('contains only the base fragment for a plain current-era query', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ query: 'Datenschutz' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 gazette entries matched.');
  });

  it('includes the number/citation guidance when number is set', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ number: '171/2026' });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Verify part and year');
    expect(notice).toContain('ris_lookup_citation resolves it directly');
  });

  it('flags a number/part Roman-numeral mismatch', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ number: 'BGBl. II Nr. 171/2026', part: 'part1' });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('number names part II but the part filter is I — drop one.');
  });

  it('includes the issuer phrase-field guidance when issuer is set', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ issuer: 'BMF' });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(
      "issuer is a phrase field — try the ministry abbreviation with a trailing * ('BMK*').",
    );
  });

  it('includes the historical-era caveat for an imperial-era federal range', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ published_from: '1900-01-01' });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(
      'Range served by BgblAlt 1848–1940; pre-1848 gazettes are not in RIS.',
    );
  });

  it('includes the district-coverage guidance for scope: district', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'district' });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('District promulgations cover NÖ (2021+)');
  });

  it('includes the Tirol-only ordinance-gazette caveat for scope: tirol with series: ordinance_gazette', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'tirol', series: 'ordinance_gazette' });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(
      "Verordnungsblätter in RIS currently cover Tirol (2022+) — other states' ordinance gazettes are not yet published here.",
    );
  });
});

describe('risSearchGazette — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (InvalidParams) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service InvalidParams rejection to the invalid_query contract error', async () => {
    const upstreamError = invalidParams("The 'Bgblnummer' element is invalid.", {
      risApplication: 'BgblAuth',
    });
    searchGazette.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ query: 'Datenschutz' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'Bgblnummer' element is invalid.");
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    searchGazette.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ query: 'Datenschutz' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });
});

describe('risSearchGazette — record mapping, binding labels, and format() parity', () => {
  it('maps a Bvb (district) hit — authentic binding, PDF surfaced only via authentic_pdf_url', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bvb.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'district' });
    const result = await risSearchGazette.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.binding).toBe('authentic');
    expect(record.district_authority).toBe('Bezirkshauptmannschaft Jennersdorf');
    expect(record.gazette_number).toBe('9/2026');
    expect(record.issuer).toBe('Bezirkshauptmannschaft Jennersdorf');
    // Bvb publishes the authentic PDF only (Authentisch DataType) — no core rendition URLs.
    expect(record.content_urls).toEqual({});
    expect(record.authentic_pdf_url).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Bvb/BVB_BU_JE_20260703_9/BVB_BU_JE_20260703_9.pdf',
    );
    const text = (risSearchGazette.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(record.document_number);
    expect(text).toContain('**District authority:** Bezirkshauptmannschaft Jennersdorf');
    expect(text).toContain('**Binding:** authentic');
    expect(text).toContain(record.authentic_pdf_url);
  });

  it('maps a GrA (municipal) hit — sparse payload with no municipality field, never fabricated', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-gra.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'municipal' });
    const result = await risSearchGazette.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.binding).toBe('authentic');
    expect(record.gazette_number).toBe('VBl. Nr. 3/2026');
    expect(record.issuer).toBe('Aurolzmünster');
    expect(record.short_title).toBe('Hebesatzverordnung 2026');
    // The live payload omits the Gemeinde field entirely — must stay absent, not defaulted.
    expect(record.municipality).toBeUndefined();
    const text = (risSearchGazette.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**Issuer:** Aurolzmünster');
    expect(text).not.toContain('**Municipality:**');
  });

  it('renders every populated field for a multi-hit LgblAuth result (format() parity)', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'salzburg' });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results).toHaveLength(2);
    const text = (risSearchGazette.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const record of result.results) {
      expect(record.binding).toBe('authentic');
      expect(text).toContain(record.document_number);
      if (record.gazette_number !== undefined) expect(text).toContain(record.gazette_number);
      if (record.type !== undefined) expect(text).toContain(record.type);
      if (record.published !== undefined) expect(text).toContain(record.published);
      if (record.issuer !== undefined) expect(text).toContain(record.issuer);
      if (record.short_title !== undefined) expect(text).toContain(record.short_title);
      if (record.eli !== undefined) expect(text).toContain(record.eli);
      if (record.authentic_pdf_url !== undefined) expect(text).toContain(record.authentic_pdf_url);
      if (record.alex_url !== undefined) expect(text).toContain(record.alex_url);
      if (record.document_url !== undefined) expect(text).toContain(record.document_url);
      for (const key of ['html', 'pdf', 'rtf', 'xml'] as const) {
        const url = record.content_urls[key];
        if (url !== undefined) expect(text).toContain(url);
      }
    }
    expect(getEnrichment(ctx).servedApplication).toBe('LgblAuth');
  });

  it('maps BgblAlt hits — historical_record, ÖNB scan surfaced via alex_url (the metadata-only tier’s only doc path)', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblalt.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      published_from: '1940-01-01',
      published_to: '1940-12-31',
    });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results).toHaveLength(2);
    const first = result.results[0]!;
    expect(first.binding).toBe('historical_record');
    expect(first.gazette_number).toBe('49/1940');
    expect(first.type).toBe('Kundmachung');
    expect(first.published).toBe('1940-03-31');
    // BgblAlt carries no Dokumentliste — no rendition URLs, no authentic PDF. Its only path to
    // the document is the ÖNB ALEX scan (alex_url) plus the RIS web view (document_url); without
    // them a BgblAlt hit would be a dead end (design "No dead ends").
    expect(first.content_urls).toEqual({});
    expect(first.authentic_pdf_url).toBeUndefined();
    expect(first.alex_url).toContain('alex.onb.ac.at');
    expect(first.document_url).toContain('ris.bka.gv.at');
    const text = (risSearchGazette.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(`**ÖNB scan:** ${first.alex_url}`);
    expect(text).toContain(`**RIS view:** ${first.document_url}`);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblAlt');
  });

  it('labels an LgblNO (non-authentic Niederösterreich) result as consolidated_informational', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      scope: 'niederoesterreich',
      include_non_authentic: true,
    });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results[0]!.binding).toBe('consolidated_informational');
    expect(getEnrichment(ctx).servedApplication).toBe('LgblNO');
  });

  it('labels a Lgbl (non-authentic, non-NÖ) result as historical_record', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'salzburg', include_non_authentic: true });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results[0]!.binding).toBe('historical_record');
    expect(getEnrichment(ctx).servedApplication).toBe('Lgbl');
  });
});
