/**
 * @fileoverview Tests for the ris_search_gazette tool — local scope/filter guards
 * (rejected before any network call), the Vbl non-Tirol short-circuit, federal
 * era-tier routing, state_era series routing, error-contract mapping, zero-hit
 * notices, and record-mapping/format() parity across the five gazette scopes
 * (federal, state, district, municipal, legacy state). The RIS service module is
 * mocked so the suite is fully offline; success-path fixtures are run through the
 * real normalizer so results stay realistic.
 * @module tests/tools/ris-search-gazette.tool.test
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

import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import { buildGazetteRequest, type GazetteSearchParams } from '@/services/ris/request-builder.js';

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

  it('rejects state_era combined with a non-state scope', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'district', state_era: 'legacy' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain('state_era applies only to a state scope');
    expect(err.message).toContain("scope: 'district'");
    expect(searchGazette).not.toHaveBeenCalled();
  });

  // Vbl is authentic-only (documentClass: authentic_promulgation) — there is no archival
  // ordinance-gazette application to route to, so the pair is rejected rather than arbitrated.
  // Before state_era, the equivalent input silently resolved to Vbl and discarded the flag.
  it('rejects series: ordinance_gazette combined with state_era: legacy', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({
      scope: 'tirol',
      series: 'ordinance_gazette',
      state_era: 'legacy',
    });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'scope_filter_mismatch' });
    expect(err.message).toContain("state_era: 'legacy' cannot be combined with");
    expect(err.message).toContain("series: 'ordinance_gazette'");
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

  // Both bounds are set: a one-sided published_from is open into every later tier and is
  // rejected as cross-tier, so it can no longer stand in for "an imperial-era range".
  it('routes a pre-1941 date range to BgblAlt', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      published_from: '1900-01-01',
      published_to: '1930-12-31',
    });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblAlt');
  });

  it('routes a date range inside the post-war window to BgblPdf', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      published_from: '1961-01-01',
      published_to: '1961-12-31',
    });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblPdf');
  });

  it('routes a query with no date bound at all to the current tier', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ query: 'Datenschutz' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblAuth');
  });

  it('forces the postwar tier for part: pre_1997 regardless of number', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ part: 'pre_1997' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblPdf');
  });
});

// state_era selects a series, it does not add one: each value resolves to exactly one
// application, and the authentic LgblAuth stays the default. The two series cover disjoint
// eras, so a caller who wants both makes two calls.
describe('risSearchGazette — state_era series routing (servedApplication)', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchGazette.mockResolvedValue(zeroHitsResult);
  });

  it('routes an omitted state_era to the authentic LgblAuth', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'salzburg' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('LgblAuth');
  });

  it('routes state_era: current to the authentic LgblAuth', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'salzburg', state_era: 'current' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('LgblAuth');
  });

  it('routes state_era: legacy to Lgbl for a state the historical series carries', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'salzburg', state_era: 'legacy' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('Lgbl');
  });

  it('routes state_era: legacy to LgblNO for Niederösterreich', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'niederoesterreich', state_era: 'legacy' });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('LgblNO');
  });

  // Only legacy conflicts with the ordinance gazette — current must still resolve to Vbl.
  it('routes series: ordinance_gazette with state_era: current to Vbl', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      scope: 'tirol',
      series: 'ordinance_gazette',
      state_era: 'current',
    });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('Vbl');
  });
});

// One call serves one application, so a federal publication-date interval must lie inside a
// single era tier. Before this, the interval was collapsed to the start year and the query was
// served entirely by whichever tier that named — a successful-looking result missing every
// record from the other side of the boundary (#11).
describe('risSearchGazette — cross-tier federal date ranges', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  it('rejects the 2003/2004 boundary span, naming both tiers and the split date', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({
      scope: 'federal',
      published_from: '2003-12-01',
      published_to: '2004-01-31',
      page_size: 10,
    });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'cross_tier_range' });
    expect(err.message).toContain('published_from 2003-12-01 / published_to 2004-01-31');
    expect(err.message).toContain('spans 2 federal era tiers');
    expect(err.message).toContain('BgblAuth (2004 and later)');
    expect(err.message).toContain('BgblPdf (1945–2003)');
    expect(err.message).toContain('Split it at 2004-01-01');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('2004-01-01 (BgblAuth begins)'),
    });
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('serves the December-only control from BgblPdf, with December dates only', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblpdf-2003-12.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      scope: 'federal',
      published_from: '2003-12-01',
      published_to: '2003-12-31',
      page_size: 10,
    });
    const result = await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblPdf');
    expect(getEnrichment(ctx).totalCount).toBe(140);
    expect(result.results).toHaveLength(2);
    for (const record of result.results) {
      expect(record.published).toMatch(/^2003-12-/u);
      expect(record.binding).toBe('historical_record');
    }
  });

  it('serves the January-only control from BgblAuth, with January dates only', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblauth-2004-01.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      scope: 'federal',
      published_from: '2004-01-01',
      published_to: '2004-01-31',
      page_size: 10,
    });
    const result = await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblAuth');
    expect(getEnrichment(ctx).totalCount).toBe(72);
    expect(result.results).toHaveLength(2);
    for (const record of result.results) {
      expect(record.published).toMatch(/^2004-01-/u);
      expect(record.binding).toBe('authentic');
    }
  });

  it('rejects a three-tier span, naming every tier and both boundaries in order', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({
      published_from: '1900-01-01',
      published_to: '2010-12-31',
    });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'cross_tier_range' });
    expect(err.message).toContain('spans 3 federal era tiers');
    expect(err.message).toContain('BgblAlt (1848–1940)');
    expect(err.message).toContain('Split it at 1945-01-01 and 2004-01-01');
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects a one-sided published_from that is open into a later tier', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ published_from: '2003-12-01' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'cross_tier_range' });
    expect(err.message).toContain(
      'published_from 2003-12-01 with no published_to (open-ended) spans 2 federal era tiers',
    );
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('rejects a one-sided published_to that is open into an earlier tier', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ published_to: '2003-12-31' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'cross_tier_range' });
    expect(err.message).toContain(
      'published_to 2003-12-31 with no published_from (open-ended) spans 2 federal era tiers',
    );
    expect(searchGazette).not.toHaveBeenCalled();
  });

  // No application covers 1941–1944: BgblAlt ends in 1940, BgblPdf resumes in 1945. The
  // interval owns no tier, so it is a legitimate zero-hit answer with a notice, not a
  // cross-tier rejection.
  it('serves a range falling entirely in the 1941–1944 gap as zero hits with a notice', async () => {
    searchGazette.mockResolvedValue(zeroHitsResult);
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({
      published_from: '1941-01-01',
      published_to: '1944-12-31',
    });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results).toEqual([]);
    expect(searchGazette).toHaveBeenCalledOnce();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.servedApplication).toBe('BgblAlt');
    expect(enrichment.notice).toContain(
      'RIS carries no federal gazette for 1941–1944 — BgblAlt ends in 1940 (GBlÖ) and BgblPdf resumes in 1945 (StGBl).',
    );
  });

  it('rejects a range that straddles the gap and both tiers around it', async () => {
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({
      published_from: '1939-01-01',
      published_to: '1946-12-31',
    });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'cross_tier_range' });
    expect(err.message).toContain('spans 2 federal era tiers');
    expect(err.message).toContain('Split it at 1945-01-01');
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('serves a range that starts in the gap and ends in one tier, noting the gap', async () => {
    searchGazette.mockResolvedValue(zeroHitsResult);
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      published_from: '1941-01-01',
      published_to: '1946-12-31',
    });
    await risSearchGazette.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.servedApplication).toBe('BgblPdf');
    expect(enrichment.notice).toContain('RIS carries no federal gazette for 1941–1944');
  });

  // part: pre_1997 and a year-bearing number name the tier outright — the date range is a
  // secondary filter there, so neither is refused for spanning.
  it('keeps part: pre_1997 pinned to BgblPdf despite a spanning range', async () => {
    searchGazette.mockResolvedValue(zeroHitsResult);
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      part: 'pre_1997',
      published_from: '2003-12-01',
      published_to: '2004-01-31',
    });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblPdf');
    expect(searchGazette).toHaveBeenCalledOnce();
  });

  it("keeps a number's trailing year in charge of the tier despite a spanning range", async () => {
    searchGazette.mockResolvedValue(zeroHitsResult);
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      number: '146/2003',
      published_from: '2003-12-01',
      published_to: '2004-01-31',
    });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('BgblPdf');
    expect(searchGazette).toHaveBeenCalledOnce();
  });

  it('leaves non-federal scopes untouched by the tier check', async () => {
    searchGazette.mockResolvedValue(zeroHitsResult);
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      scope: 'salzburg',
      published_from: '1900-01-01',
      published_to: '2026-12-31',
    });
    await risSearchGazette.handler(input, ctx);
    expect(getEnrichment(ctx).servedApplication).toBe('LgblAuth');
    expect(searchGazette).toHaveBeenCalledOnce();
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

  // The two historical tiers get their own fragment. BgblAlt's floor (1848) and its
  // metadata-only status are not BgblPdf's — a shared string told a post-war caller its
  // results carried no content_urls when that tier is exactly the one that has them (#24).
  it('names only BgblAlt’s window and caveats for an imperial-era federal range', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      published_from: '1900-01-01',
      published_to: '1930-12-31',
    });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(
      'Range served by BgblAlt 1848–1940; pre-1848 gazettes are not in RIS. BgblAlt is metadata-only — hits carry no content_urls, and the scans are ÖNB-hosted, linked as alex_url.',
    );
    expect(notice).not.toContain('BgblPdf');
  });

  it('names only BgblPdf’s window and caveats for a post-war federal range', async () => {
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({
      published_from: '1950-01-01',
      published_to: '1950-12-31',
      title: 'Zzzqxnonexistent',
    });
    await risSearchGazette.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(
      'Range served by BgblPdf 1945–2003 (Staats- und Bundesgesetzblatt), which carries full HTML/PDF renditions.',
    );
    expect(notice).toContain('Gazette parts I/II/III exist only from 1997');
    expect(notice).toContain('part: pre_1997');
    // BgblAlt's floor and its metadata-only caveat belong to the imperial branch alone.
    expect(notice).not.toContain('BgblAlt');
    expect(notice).not.toContain('metadata-only');
    expect(notice).not.toContain('1848');
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

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    searchGazette.mockRejectedValue(timeout('fetch GET https://data.bka.gv.at timed out.', {}));
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ query: 'Datenschutz' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
  });

  // Each case below passes the input schema and is then refused by the request builder. The
  // real builder runs on the params the handler produced, so the asserted message is the one
  // a caller actually receives. The builder names the service param and the RIS application
  // code the caller never sent; the handler restates every one of them over the tool's own
  // field names and the scope/series/state_era — or, for a federal era tier, the window plus
  // the input that routed there (#12, #29).
  it.each([
    [
      'sort_by on the current federal tier',
      { scope: 'federal', sort_by: 'number' },
      "sort_by: 'number' is not available for the 2004-and-later federal gazette. Use sort_by: 'published', or drop sort_by.",
    ],
    [
      'type on district gazettes',
      { scope: 'district', type: 'laws' },
      "type is not available for scope 'district'. Drop type — it filters the federal gazette from 1945 on and state law gazettes.",
    ],
    [
      'number on the Niederösterreich legacy series',
      { scope: 'niederoesterreich', state_era: 'legacy', number: '61/2026' },
      "number is not available for the Niederösterreich systematic collection (scope 'niederoesterreich', state_era 'legacy'). Drop number, or set state_era: 'current' to search Niederösterreich's authentic Landesgesetzblatt by number.",
    ],
    [
      'part on the imperial tier a pre-1941 number routed to',
      { scope: 'federal', number: '189/1902', part: 'part1' },
      "part is not available for the 1848–1940 federal gazette, which number '189/1902' selected — federal gazette parts I/II/III exist only from 1997. Drop part.",
    ],
    [
      'issuer on the post-war tier a pre-2004 number routed to',
      { scope: 'federal', number: '171/1980', issuer: 'BMF' },
      "issuer is not available for the 1945–2003 federal gazette, which number '171/1980' selected — the issuing-body filter covers the 2004-and-later federal gazette and ordinance gazettes. Drop issuer.",
    ],
    [
      'issuer on the post-war tier a pre-2004 date range routed to',
      { scope: 'federal', published_from: '1980-01-01', published_to: '1980-12-31', issuer: 'BMF' },
      'issuer is not available for the 1945–2003 federal gazette, which published_from 1980-01-01 / published_to 1980-12-31 selected — the issuing-body filter covers the 2004-and-later federal gazette and ordinance gazettes. Drop issuer.',
    ],
  ])(
    'states a builder rejection of %s in the caller’s vocabulary',
    async (_label, raw, message) => {
      searchGazette.mockImplementation(async (params: GazetteSearchParams) => {
        buildGazetteRequest(params);
        throw new Error('unreachable — the builder was expected to reject these params');
      });
      const ctx = createMockContext({ errors: risSearchGazette.errors });
      const input = risSearchGazette.input.parse(raw);
      const err = await captureError(risSearchGazette.handler(input, ctx));
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'invalid_query' });
      expect(err.message).toBe(message);
      // Nothing the caller could not have written itself survives into the message.
      expect(err.message).not.toMatch(/BgblAuth|BgblPdf|BgblAlt|LgblNO|Bvb|sortBy/u);
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
    searchGazette.mockRejectedValue(
      invalidParams('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten', {}),
    );
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ query: 'Datenschutz', page: 9999 });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Seitennummer');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringMatching(
        /^For a page past the end, request a lower page, starting from 1\./u,
      ),
    });
  });

  it('maps a builder rejection of a state absent from the legacy series to invalid_query', async () => {
    searchGazette.mockImplementation(async (params: GazetteSearchParams) => {
      buildGazetteRequest(params);
      throw new Error('unreachable — the builder was expected to reject these params');
    });
    const ctx = createMockContext({ errors: risSearchGazette.errors });
    const input = risSearchGazette.input.parse({ scope: 'wien', state_era: 'legacy' });
    const err = await captureError(risSearchGazette.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('The historical Lgbl gazette has no Wien');
    expect(err.data?.recovery).toBeDefined();
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
      state_era: 'legacy',
    });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results[0]!.binding).toBe('consolidated_informational');
    expect(getEnrichment(ctx).servedApplication).toBe('LgblNO');
  });

  it('labels a Lgbl (non-authentic, non-NÖ) result as historical_record', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext();
    const input = risSearchGazette.input.parse({ scope: 'salzburg', state_era: 'legacy' });
    const result = await risSearchGazette.handler(input, ctx);
    expect(result.results[0]!.binding).toBe('historical_record');
    expect(getEnrichment(ctx).servedApplication).toBe('Lgbl');
  });
});
