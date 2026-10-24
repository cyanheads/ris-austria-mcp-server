/**
 * @fileoverview Tests for the ris_lookup_citation tool — deterministic classification
 * across the four resolvable routes (norm, gazette, case number, collection number), the
 * `found: false` never-throw contract for unparseable or unresolved citations, the
 * `upstream_error` throw contract, the `kind`/court/state hint overrides, alternatives_count,
 * and structuredContent/format() parity. The RIS service module is mocked (all three search
 * methods this tool routes to) so the suite is fully offline; success-path records are
 * computed with the sibling search tools' own `toRecord` mappers (the same functions this
 * tool imports) so expected values are never hand-typed against the normalizer's internals.
 * @module tests/tools/ris-lookup-citation.tool.test
 */

import { readFileSync } from 'node:fs';

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risLookupCitation } from '@/mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import {
  risSearchCaseLaw,
  toRecord as toCaseLawRecord,
} from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import {
  risSearchGazette,
  toRecord as toGazetteRecord,
} from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import {
  risSearchLegislation,
  toRecord as toLegislationRecord,
} from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import { RIS_CITATION_FORMATS, RIS_COURTS } from '@/services/ris/reference/index.js';
import {
  buildCaseLawRequest,
  buildGazetteRequest,
  buildLegislationRequest,
  type RisRequest,
} from '@/services/ris/request-builder.js';
import type { RisHit } from '@/services/ris/types.js';

const { searchCaseLaw, searchGazette, searchLegislation } = vi.hoisted(() => ({
  searchCaseLaw: vi.fn(),
  searchGazette: vi.fn(),
  searchLegislation: vi.fn(),
}));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchCaseLaw, searchGazette, searchLegislation }),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** A zero-hit `RisSearchResult`, reused across every route's zero-hit found:false path. */
function zeroHits() {
  return parseSearchResponse(fixture('search-zero-hits.json'));
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

/** The norm route's guidance for a citation it could not read — nothing was searched. */
const UNREADABLE_NORM = (citation: string) =>
  `Could not read a norm citation from '${citation}'. A norm citation names a law by its abbreviation, with or without a §/Artikel number: '§ 6 DSG', 'Art 10 B-VG', 'DSG §1', or 'ABGB'. Formats: ris_list_reference topic citation_formats. For keyword search use ris_search_legislation with query.`;

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

/**
 * Assert every populated scalar/array/nested-object-string field of a resolved record is
 * rendered somewhere in the format() text — the same generic walk `renderRecord()` performs,
 * so this checks structuredContent/format() parity without hand-listing fields per route.
 */
function expectRecordRendered(text: string, record: object): void {
  for (const value of Object.values(record)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) expect(text).toContain(String(item));
    } else if (typeof value === 'object') {
      for (const subValue of Object.values(value as Record<string, unknown>)) {
        if (typeof subValue === 'string') expect(text).toContain(subValue);
      }
    } else {
      expect(text).toContain(String(value));
    }
  }
}

beforeEach(() => {
  searchCaseLaw.mockReset();
  searchGazette.mockReset();
  searchLegislation.mockReset();
});

describe('risLookupCitation — unclassifiable citations', () => {
  it('returns found:false, kind:"unknown" with the verbatim guidance, and calls no service method', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '42/2020' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'unknown',
      guidance:
        "Could not classify '42/2020'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' or year-first 'BGBl I 2018/24' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ro 2026/03/0016', court-prefixed 'VfGH G 13/2025', or an ECLI 'ECLI:AT:VFGH:2026:G13.2025'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law.",
    });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchGazette).not.toHaveBeenCalled();
  });
});

describe('risLookupCitation — norm route', () => {
  it('classifies "§ 6 DSG", routes to searchLegislation with the parsed section, and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '§ 6 DSG' });
    const result = await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'BrKons',
      inForceAsOf: today,
      pageSize: 100,
      title: 'DSG',
      sectionFrom: '6',
      sectionTo: '6',
      sectionType: 'Paragraph',
    });

    const hit = parseSearchResponse(fixture('search-brkons-celex.json')).hits[0]!;
    const expectedRecord = toLegislationRecord(hit, 'BrKons');
    expect(result.found).toBe(true);
    expect(result.kind).toBe('norm');
    expect(result.record).toEqual(expectedRecord);
    expect(result.record).toMatchObject({ abbreviation: 'DSG' }); // BrKons Abkuerzung (#51)
    expect(result.alternatives_count).toBe(76); // total 77 - the one returned hit
    expect(result.resolution_note).toBe(
      `Resolved via ris_search_legislation (BrKons) — title "DSG", § 6, in force ${today}. 76 more matched — list them with ris_search_legislation title: "DSG", section_from: "6", section_to: "6", section_type: Paragraph, in_force_as_of: "${today}".`,
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**found**: true');
    expect(text).toContain('**kind**: norm');
    expect(text).toContain(`**resolution_note**: ${result.resolution_note}`);
    expect(text).toContain('**alternatives_count**: 76');
    expectRecordRendered(text, expectedRecord);
  });

  it('classifies "Art 10 B-VG" as an Artikel citation and returns found:false with normGuidance on a zero-hit resolution (#17)', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'Art 10 B-VG' });
    const result = await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'BrKons',
      inForceAsOf: today,
      pageSize: 100,
      title: 'B-VG',
      sectionFrom: '10',
      sectionTo: '10',
      sectionType: 'Artikel',
    });
    // The guidance must label the section with the marker that was parsed and carry
    // section_type into the retry recipe — a recipe without it defaults to Paragraph and
    // searches § 10 instead of Artikel 10, returning zero even when the Artikel exists.
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for B-VG Art 10 in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'B-VG', section_from/to: '10', section_type: 'Artikel', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'B-VG*'. State law resolves only with an explicit state hint.`,
    });
  });

  it('carries the Artikel retry recipe back into ris_search_legislation verbatim — the recipe reproduces the filter the lookup used (#17)', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'Art 10 B-VG', in_force_as_of: '1910-01-01' }),
      ctx,
    );
    const lookupFilter = searchLegislation.mock.calls[0]?.[0] as {
      sectionFrom: string;
      sectionTo: string;
      sectionType: string;
      title: string;
    };

    // Parse the recipe out of the guidance prose, then feed it through the search tool's own
    // input schema — what an agent following the guidance verbatim would send.
    const recipe = /retry ris_search_legislation with (.+?)\. If the abbreviation/.exec(
      result.guidance ?? '',
    )?.[1];
    expect(recipe).toBeDefined();
    const field = (name: string): string | undefined =>
      new RegExp(`${name}: '([^']+)'`).exec(recipe ?? '')?.[1];

    const retryInput = risSearchLegislation.input.parse({
      title: field('title'),
      section_from: field('section_from/to'),
      section_to: field('section_from/to'),
      section_type: field('section_type'),
      include_all_versions: true,
    });
    expect(retryInput.section_type).toBe('Artikel');
    expect(retryInput.title).toBe(lookupFilter.title);
    expect(retryInput.section_from).toBe(lookupFilter.sectionFrom);
    expect(retryInput.section_type).toBe(lookupFilter.sectionType);
  });

  it('classifies a bare abbreviation "ABGB" with no section — the zero-hit guidance omits the section clause', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'ABGB' });
    const result = await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'BrKons',
      inForceAsOf: today,
      pageSize: 100,
      title: 'ABGB',
    });
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for ABGB in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'ABGB', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'ABGB*'. State law resolves only with an explicit state hint.`,
    });
  });

  it('applies a state hint by switching the application to LrKons and passing state through', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '§ 16 ABGB', state: 'wien' });
    await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'LrKons',
      inForceAsOf: today,
      pageSize: 100,
      title: 'ABGB',
      sectionFrom: '16',
      sectionTo: '16',
      sectionType: 'Paragraph',
      state: 'wien',
    });
  });

  it('a state-law miss keeps the state in both retries, which otherwise search federal law', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: '§ 16 ABGB', state: 'wien' });
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for ABGB § 16 in force on ${todayInAustria()}. If the provision existed at another time, retry ris_search_legislation with title: 'ABGB', section_from/to: '16', section_type: 'Paragraph', scope: 'wien', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'ABGB*', scope: 'wien'.`,
    });
    const recipe = /retry ris_search_legislation with (.+?)\. If the abbreviation/.exec(
      result.guidance ?? '',
    )?.[1];
    const retry = risSearchLegislation.input.parse({
      title: /title: '([^']+)'/.exec(recipe ?? '')?.[1],
      scope: /scope: '([^']+)'/.exec(recipe ?? '')?.[1],
      include_all_versions: true,
    });
    expect(retry.scope).toBe('wien');
  });

  it('resolves to found:false (never throws) when the routed search rejects with ValidationError', async () => {
    searchLegislation.mockRejectedValue(
      validationError("The 'FassungVom' element is invalid.", {}),
    );
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '§ 6 DSG' });
    const result = await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for DSG § 6 in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'DSG', section_from/to: '6', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'DSG*'. State law resolves only with an explicit state hint.`,
    });
  });

  it('throws the upstream_error contract when the routed search rejects with ServiceUnavailable', async () => {
    searchLegislation.mockRejectedValue(
      serviceUnavailable('RIS returned a non-JSON response.', {}),
    );
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '§ 6 DSG' });
    const err = await captureError(risLookupCitation.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('throws the upstream_timeout contract when the routed search hits its deadline', async () => {
    searchLegislation.mockRejectedValue(timeout('fetch GET https://data.bka.gv.at timed out.', {}));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '§ 6 DSG' });
    const err = await captureError(risLookupCitation.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
  });

  it.each([
    ['RIS semantic error', validationError("The 'FassungVom' element is invalid.", {})],
    [
      'local request-builder validation',
      validationError('sortBy has no confirmed RIS mapping.', {}),
    ],
  ])(
    'treats a routed-search %s as a failed filter — found: false, not a throw',
    async (_label, rejection) => {
      // The deliberate divergence from the search family: for this tool a rejected
      // deterministic filter means the citation did not resolve, so it must stay a result.
      searchLegislation.mockRejectedValue(rejection);
      const ctx = createMockContext({ errors: risLookupCitation.errors });
      const input = risLookupCitation.input.parse({ citation: '§ 6 DSG' });
      const result = await risLookupCitation.handler(input, ctx);
      expect(result.found).toBe(false);
    },
  );
});

describe('risLookupCitation — in_force_as_of validation (#14)', () => {
  it('rejects an impossible calendar date at the input schema, so it never becomes a citation miss', () => {
    // The reported failure: "2026-99-99" matched the old shape-only pattern, went upstream, and
    // RIS's rejection was converted to found:false — telling the caller the provision does not
    // exist on that date rather than that the date is not a date.
    const parsed = risLookupCitation.input.safeParse({
      citation: '§ 1 DSG',
      in_force_as_of: '2026-99-99',
    });
    expect(parsed.success).toBe(false);
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  it('still resolves the same citation with a real date — the control the report compares against', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({
      citation: '§ 1 DSG',
      in_force_as_of: '2026-07-26',
    });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ inForceAsOf: '2026-07-26' });
    expect(result.found).toBe(true);
  });

  it('accepts a leap day', () => {
    expect(
      risLookupCitation.input.safeParse({ citation: '§ 1 DSG', in_force_as_of: '2024-02-29' })
        .success,
    ).toBe(true);
  });

  it('keeps found:false for a valid-but-unresolvable citation — the meaning the tool description promises', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({
      citation: '§ 9999 NichtExistierendesGesetz',
      in_force_as_of: '2026-07-26',
    });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result.found).toBe(false);
    expect(result.kind).toBe('norm');
    expect(result.guidance).toContain('No document for NichtExistierendesGesetz § 9999');
  });

  it('rejects court: normenliste at the input schema — a norm index carries no case numbers', () => {
    // The other route by which an input error reached found:false. normenliste indexes norms,
    // so the request builder rejects a Geschäftszahl filter there with a ValidationError, which
    // runSearch maps to null — surfacing "No decision for '…' in Normenliste. Pass court
    // explicitly if known" for a court hint the caller had already passed explicitly.
    const parsed = risLookupCitation.input.safeParse({
      citation: 'Ro 2026/03/0016',
      court: 'normenliste',
    });
    expect(parsed.success).toBe(false);
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('still accepts every other court as a hint', () => {
    for (const { code } of RIS_COURTS.filter((court) => court.code !== 'normenliste')) {
      expect(
        risLookupCitation.input.safeParse({ citation: 'Ro 2026/03/0016', court: code }).success,
        `court: ${code} should be accepted`,
      ).toBe(true);
    }
  });
});

describe('risLookupCitation — abbreviation-first norm citations (#5)', () => {
  // The abbreviation-first shape ("DSG §1") is what ris_search_case_law emits in `norms_cited`;
  // parsing it lets a cited norm round-trip straight back into lookup. Each row is [citation,
  // expected title, expected section, expected sectionType] — the parser anchors on the
  // §/Artikel marker, so the abbreviation (before the marker) is the search title and any trailing
  // sub-provision (Abs / Z / lit) is dropped. The fixture rows are verbatim norms_cited strings
  // lifted from the two search fixtures (asserted real below). The issue's DSGVO rows name an EU
  // act RIS does not consolidate, so they are decided offline instead (#67 suite below).
  const CASES: ReadonlyArray<[string, string, string, 'Paragraph' | 'Artikel']> = [
    // The Austrian shapes from the issue.
    ['DSG §1', 'DSG', '1', 'Paragraph'],
    ['DSG § 1', 'DSG', '1', 'Paragraph'],
    ['DSG §24', 'DSG', '24', 'Paragraph'],
    // The dominant real shape — a trailing sub-provision stripped back to the core norm.
    ['DSG §22 Abs1', 'DSG', '22', 'Paragraph'],
    // Multi-token abbreviations (hyphen, embedded year) — anchored on the marker, not whitespace.
    ['B-VG Art7', 'B-VG', '7', 'Artikel'],
    ['TKG 2021 §5', 'TKG 2021', '5', 'Paragraph'],
    // Verbatim norms_cited strings from the two search fixtures.
    ['VfGG §7 Abs2', 'VfGG', '7', 'Paragraph'],
    ['B-VG Art139 Abs1 Z2', 'B-VG', '139', 'Artikel'],
    ['BienenseuchenG §3a', 'BienenseuchenG', '3a', 'Paragraph'],
    ['EMRK Art8', 'EMRK', '8', 'Artikel'],
    ['FremdenpolizeiG 2005 §26', 'FremdenpolizeiG 2005', '26', 'Paragraph'],
  ];

  it.each(CASES)(
    'parses "%s" to a norm and routes to searchLegislation with { title: "%s", section: "%s" }',
    async (citation, title, section, sectionType) => {
      searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
      const ctx = createMockContext({ errors: risLookupCitation.errors });
      const input = risLookupCitation.input.parse({ citation });
      const result = await risLookupCitation.handler(input, ctx);
      const today = todayInAustria();

      expect(searchLegislation).toHaveBeenCalledTimes(1);
      expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
        application: 'BrKons',
        inForceAsOf: today,
        pageSize: 100,
        title,
        sectionFrom: section,
        sectionTo: section,
        sectionType,
      });
      expect(result.found).toBe(true);
      expect(result.kind).toBe('norm');
    },
  );

  it('resolves an abbreviation-first citation under an explicit kind: "norm" (the case the live review reported as found:false)', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'DSG §1', kind: 'norm' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      title: 'DSG',
      sectionFrom: '1',
      sectionTo: '1',
      sectionType: 'Paragraph',
    });
    expect(result.found).toBe(true);
  });

  it('parses order-independently — "DSG §1" and "§ 1 DSG" yield identical searchLegislation params (section-first regression intact)', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });

    await risLookupCitation.handler(risLookupCitation.input.parse({ citation: 'DSG §1' }), ctx);
    await risLookupCitation.handler(risLookupCitation.input.parse({ citation: '§ 1 DSG' }), ctx);

    const abbrevFirst = searchLegislation.mock.calls[0]?.[0];
    const sectionFirst = searchLegislation.mock.calls[1]?.[0];
    expect(abbrevFirst).toMatchObject({ title: 'DSG', sectionFrom: '1', sectionType: 'Paragraph' });
    expect(sectionFirst).toEqual(abbrevFirst);
  });

  it('confirms the fixture test inputs are verbatim norms_cited strings the search fixtures actually emit', () => {
    const vfgh = JSON.stringify(fixture('search-vfgh.json'));
    const gz = JSON.stringify(fixture('search-gz-array.json'));
    expect(vfgh).toContain('VfGG §7 Abs2');
    expect(vfgh).toContain('B-VG Art139 Abs1 Z2');
    expect(vfgh).toContain('BienenseuchenG §3a');
    expect(gz).toContain('EMRK Art8');
    expect(gz).toContain('FremdenpolizeiG 2005 §26');
  });
});

describe('risLookupCitation — gazette route', () => {
  it('routes a current-era federal citation to BgblAuth with the Roman-numeral part, and returns gazetteGuidance on a zero-hit resolution', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'BGBl. I Nr. 171/2026' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblAuth',
      number: '171/2026',
      part: 'part1',
    });
    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'No gazette entry for 171/2026 in BgblAuth. Part I was applied as a filter — verify it and the year against the cite. Browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number.',
    });
  });

  it('routes a pre-2004 federal citation to BgblPdf', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'BGBl. I Nr. 165/1999' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblPdf',
      number: '165/1999',
      part: 'part1',
    });
    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'No gazette entry for 165/1999 in BgblPdf. Part I was applied as a filter — verify it and the year against the cite. Parts I/II/III exist only from 1997; ris_search_gazette takes part: pre_1997 for an earlier issue. Browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number.',
    });
  });

  it('routes an imperial citation to BgblAlt regardless of year, and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    // search-bgblalt.json is a 1940 page of the Gesetzblatt für das Land Österreich (GBlÖ).
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblalt.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'GBlÖ Nr. 49/1940' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblAlt',
      number: '49/1940',
    });

    const hit = parseSearchResponse(fixture('search-bgblalt.json')).hits[0]!;
    const expectedRecord = toGazetteRecord(hit, 'BgblAlt');
    expect(result.found).toBe(true);
    expect(result.kind).toBe('gazette');
    expect(result.record).toEqual(expectedRecord);
    expect(result.alternatives_count).toBe(28546); // total 28547 - the one returned hit
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (BgblAlt) — number "49/1940". 28546 more matched — list them with ris_search_gazette number: "49/1940".',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, expectedRecord);
  });

  it('requires a state hint for an LGBl citation — returns found:false without calling the service when the hint is missing', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'LGBl. Nr. 61/2026' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'Cannot resolve LGBl. Nr. 61/2026 without a state — each of the nine Bundesländer keeps its own Landesgesetzblatt, so nothing was searched. Set state to the issuing Bundesland and retry; codes: ris_list_reference topic states.',
    });
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('routes an LGBl citation with a state hint to LgblAuth, passing state through, and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({
      citation: 'LGBl. Nr. 62/2026',
      state: 'salzburg',
    });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'LgblAuth',
      number: '62/2026',
      state: 'salzburg',
    });

    const hit = parseSearchResponse(fixture('search-lgblauth.json')).hits[0]!;
    const expectedRecord = toGazetteRecord(hit, 'LgblAuth');
    expect(result.found).toBe(true);
    expect(result.record).toEqual(expectedRecord);
    expect(result.alternatives_count).toBe(11838); // total 11839 - the one returned hit
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (LgblAuth) — number "62/2026", scope: salzburg. 11838 more matched — list them with ris_search_gazette number: "62/2026", scope: salzburg.',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, expectedRecord);
  });

  it('carries the gazette CELEX list on a resolved BgblAuth record, in both surfaces (#55)', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblauth-celex.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'BGBl. I Nr. 8/2026' }),
      ctx,
    );
    const seven = [
      '32019L0633',
      '32019L1161',
      '32022L2041',
      '32022L2381',
      '32023L0970',
      '32023L1791',
      '32024L1760',
    ];
    const parsed = risLookupCitation.output.parse(result);
    expect(parsed.record).toMatchObject({
      document_number: 'BGBLA_2026_I_8',
      celex_references: seven,
    });
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(`**celex_references**: ${seven.join(', ')}`);
  });

  it('keeps a stray state hint out of a federal resolution_note — only the state series ever took it', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblauth-2004-01.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'BGBl. I Nr. 171/2026', state: 'tirol' }),
      ctx,
    );

    expect(searchGazette.mock.calls[0]?.[0]).not.toHaveProperty('state');
    expect(result.resolution_note).toContain('(BgblAuth)');
    expect(result.resolution_note).not.toContain('scope:');
  });

  it('classifies as gazette by keyword but returns found:false when the citation has no extractable number', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'BGBl. ohne Nummer' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        "Could not read a gazette number from 'BGBl. ohne Nummer'. A gazette citation needs a number and a year — 'BGBl. I Nr. 165/1999', 'BGBl. Nr. 194/1961', 'RGBl. Nr. 189/1902', or 'LGBl. Nr. 61/2026' with a state hint. Formats: ris_list_reference topic citation_formats. To search without a number, browse with ris_search_gazette published_from/published_to.",
    });
    expect(searchGazette).not.toHaveBeenCalled();
  });
});

describe('risLookupCitation — state gazette legacy-series fallback (#27)', () => {
  it('probes the legacy Lgbl series after a zero-hit LgblAuth resolution and resolves a pre-e-Recht citation there', async () => {
    searchGazette
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({
      citation: 'LGBl. Nr. 158/2013',
      state: 'tirol',
    });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchGazette).toHaveBeenCalledTimes(2);
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'LgblAuth',
      number: '158/2013',
      state: 'tirol',
    });
    expect(searchGazette.mock.calls[1]?.[0]).toEqual({
      application: 'Lgbl',
      number: '158/2013',
      state: 'tirol',
    });

    const hit = parseSearchResponse(fixture('search-lgblauth.json')).hits[0]!;
    expect(result.found).toBe(true);
    expect(result.kind).toBe('gazette');
    // The record is mapped against the application that actually served it, not the primary.
    expect(result.record).toEqual(toGazetteRecord(hit, 'Lgbl'));
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (Lgbl) — number "158/2013", scope: tirol, state_era: legacy. 11838 more matched — list them with ris_search_gazette number: "158/2013", scope: tirol, state_era: legacy.',
    );
  });

  it('surfaces an upstream failure on the first probe instead of falling through to a clean miss', async () => {
    searchGazette
      .mockRejectedValueOnce(serviceUnavailable('RIS returned an HTML error page.', {}))
      .mockResolvedValueOnce(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const err = await captureError(
      risLookupCitation.handler(
        risLookupCitation.input.parse({ citation: 'LGBl. Nr. 158/2013', state: 'tirol' }),
        ctx,
      ),
    );

    // The legacy probe must never run on a degraded upstream — a Lgbl hit would report the
    // wrong series, and a Lgbl miss would report "both were searched" when one never answered.
    expect(searchGazette).toHaveBeenCalledTimes(1);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('stops at LgblAuth when the citation resolves there — no legacy probe for a post-switch number', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'LGBl. Nr. 1/2014', state: 'tirol' }),
      ctx,
    );

    expect(searchGazette).toHaveBeenCalledTimes(1);
    expect(result.resolution_note).toContain('(LgblAuth)');
    expect(result.resolution_note).toContain('scope: tirol');
    expect(result.resolution_note).not.toContain('state_era: legacy');
  });

  it('does not probe a legacy series for Wien, which is carried in neither, and says so', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'LGBl. Nr. 12/1990', state: 'wien' }),
      ctx,
    );

    expect(searchGazette).toHaveBeenCalledTimes(1);
    expect(searchGazette.mock.calls[0]?.[0]).toMatchObject({ application: 'LgblAuth' });
    expect(result.found).toBe(false);
    expect(result.guidance).toContain('Wien is carried in neither legacy series');
    expect(result.guidance).not.toContain('state_era: legacy');
  });

  it('does not probe LgblNO for Niederösterreich — it carries no number param — and routes the caller to it by another key', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({
        citation: 'LGBl. Nr. 12/1990',
        state: 'niederoesterreich',
      }),
      ctx,
    );

    expect(searchGazette).toHaveBeenCalledTimes(1);
    expect(searchGazette.mock.calls[0]?.[0]).toMatchObject({ application: 'LgblAuth' });
    expect(result.guidance).toContain('Gliederungszahl');
    expect(result.guidance).toContain('state_era: legacy');
  });
});

describe('risLookupCitation — gazette miss guidance is composed per route (#28)', () => {
  /**
   * Every route's guidance, gathered once. The point of the fix is which hints are ABSENT
   * per route — one shared string carried all of them everywhere, so three of the four
   * routes were told to do something they could not act on.
   */
  async function guidanceFor(input: Record<string, unknown>): Promise<string> {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(risLookupCitation.input.parse(input), ctx);
    searchGazette.mockReset();
    expect(result.guidance).toBeDefined();
    return result.guidance as string;
  }

  it('drops the state-hint sentence from every federal route', async () => {
    for (const citation of ['BGBl. I Nr. 99999/2026', 'BGBl. Nr. 99999/1961', 'RGBl. Nr. 9/1902']) {
      const guidance = await guidanceFor({ citation });
      expect(guidance, citation).not.toContain('state hint');
      expect(guidance, citation).not.toContain('State gazettes');
    }
  });

  it('drops the part sentence from BgblAlt and names its window and the 1941–1944 gap instead', async () => {
    const guidance = await guidanceFor({ citation: 'RGBl. Nr. 189/1902' });
    expect(guidance).toContain('1848–1940');
    expect(guidance).toContain('1941–1944');
    expect(guidance).toContain('carries no part split');
    expect(guidance).not.toContain('Part I');
    expect(guidance).not.toContain('part: pre_1997');
  });

  it('tells a federal caller whether a part filter was actually applied', async () => {
    expect(await guidanceFor({ citation: 'BGBl. I Nr. 99999/2026' })).toContain(
      'Part I was applied as a filter',
    );
    expect(await guidanceFor({ citation: 'BGBl. Nr. 99999/2026' })).toContain(
      'No part filter was applied',
    );
  });

  it('drops both the state-hint and part sentences from a state route that already has its hint', async () => {
    const guidance = await guidanceFor({ citation: 'LGBl. Nr. 999/2026', state: 'tirol' });
    expect(guidance).not.toContain('state hint');
    expect(guidance).not.toContain('part');
    expect(guidance).toContain('ris_search_gazette scope: tirol');
    expect(guidance).toContain('state_era: legacy');
  });

  it('keeps the state-hint sentence for the one route it belongs to, and drops the part sentence there too', async () => {
    const guidance = await guidanceFor({ citation: 'LGBl. Nr. 999/2026' });
    expect(guidance).toContain('Set state to the issuing Bundesland');
    expect(guidance).toContain('ris_list_reference topic states');
    expect(guidance).not.toContain('part');
  });
});

describe('risLookupCitation — case_number route', () => {
  it('matches a VfGH-shaped Geschäftszahl and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'G 287/2022' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw).toHaveBeenCalledTimes(1);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: 'G 287/2022',
      court: 'vfgh',
      pageSize: 100,
    });

    const hit = parseSearchResponse(fixture('search-vfgh.json')).hits[0]!;
    const expectedRecord = toCaseLawRecord(hit, 'Vfgh');
    expect(result.found).toBe(true);
    expect(result.kind).toBe('case_number');
    expect(result.record).toEqual(expectedRecord);
    expect(result.alternatives_count).toBe(24056); // total 24057 - the one returned hit
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_case_law (Vfgh) — Geschäftszahl "G 287/2022". 24056 more matched — list them with ris_search_case_law court: vfgh, case_number: "G 287/2022".',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, expectedRecord);
  });

  it('asks RIS for headnotes and decision texts alike on the case-number and collection routes (#62)', async () => {
    // Neither route names a decision type, and RIS serves only Rechtssätze on vfgh, vwgh,
    // and justiz without a Dokumenttyp flag — so the unset type has to reach the wire as both.
    const actual = await vi.importActual<typeof import('@/services/ris/ris-service.js')>(
      '@/services/ris/ris-service.js',
    );
    const realService = new actual.RisService('ris-austria-mcp-server/test');
    const fetchMock = vi.fn((_url: unknown) =>
      Promise.resolve(new Response(JSON.stringify(fixture('search-justiz-gz-joined.json')))),
    );
    vi.stubGlobal('fetch', fetchMock);
    searchCaseLaw.mockImplementation((params, ctx) => realService.searchCaseLaw(params, ctx));

    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const byCase = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '6Ob236/23h' }),
      ctx,
    );
    await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VfSlg 19.632/2012' }),
      ctx,
    );
    vi.unstubAllGlobals();

    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.searchParams.get('Applikation'))).toEqual(['Justiz', 'Vfgh']);
    for (const url of urls) {
      expect(url.searchParams.get('Dokumenttyp.SucheInRechtssaetzen')).toBe('true');
      expect(url.searchParams.get('Dokumenttyp.SucheInEntscheidungstexten')).toBe('true');
    }
    // The case-number route ranks a 100-hit page (#48); the collection route keeps the default.
    expect(urls.map((url) => url.searchParams.get('DokumenteProSeite'))).toEqual([
      'OneHundred',
      null,
    ]);
    // This Rechtssätze-only page leads with a 1952 headnote listing 6Ob236/23h among its
    // split case numbers (#53); the pick is a headnote the cited decision leads (#48).
    expect(byCase.found).toBe(true);
    expect(byCase.record).toMatchObject({
      document_number: 'JJR_20240221_OGH0002_0060OB00236_23H0000_002',
    });
    expect((byCase.record as { case_numbers: string[] }).case_numbers).toEqual(['6Ob236/23h']);
  });

  it('matches a VwGH-shaped Geschäftszahl ("Ra …") and routes to court vwgh', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'Ro 2026/03/0016' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: 'Ro 2026/03/0016',
      court: 'vwgh',
      pageSize: 100,
    });
    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "No decision for 'Ro 2026/03/0016' in Vwgh. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.",
    });
  });

  it('matches a Justiz-shaped Geschäftszahl ("14Os49/26a") and routes to court justiz', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '14Os49/26a' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: '14Os49/26a',
      court: 'justiz',
      pageSize: 100,
    });
    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "No decision for '14Os49/26a' in Justiz. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.",
    });
  });

  it('probes dsk then dok in order for the shared DSB/Dok Geschäftszahl shape, resolving on the second candidate', async () => {
    // The second resolved value is reused generically for its non-empty shape only — the
    // fixture's own embedded court identity is irrelevant to what this test verifies (the
    // probe order and which candidate the resolution settles on).
    searchCaseLaw
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: '2025-0.934.677' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw).toHaveBeenCalledTimes(2);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: '2025-0.934.677',
      court: 'dsk',
      pageSize: 100,
    });
    expect(searchCaseLaw.mock.calls[1]?.[0]).toEqual({
      caseNumber: '2025-0.934.677',
      court: 'dok',
      pageSize: 100,
    });
    expect(result.found).toBe(true);
    expect(result.kind).toBe('case_number');
    expect(result.resolution_note).toContain('Resolved via ris_search_case_law (Dok)');
    expect(result.resolution_note).toContain('list them with ris_search_case_law court: dok');
  });

  it('honors an explicit court hint, bypassing format-based court detection entirely', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    // "2025-0.934.677" auto-detects to ['dsk', 'dok'] by shape alone — the court hint overrides
    // both candidates and probes only the named court.
    const input = risLookupCitation.input.parse({ citation: '2025-0.934.677', court: 'justiz' });
    await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw).toHaveBeenCalledTimes(1);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: '2025-0.934.677',
      court: 'justiz',
      pageSize: 100,
    });
  });

  it('says no court was searched when a forced case_number kind has no recognizable shape and no court hint', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({
      citation: 'not a case number',
      kind: 'case_number',
    });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "Could not tell which court 'not a case number' belongs to from its format, so no court was searched. Pass court — Geschäftszahl format examples per court: ris_list_reference topic courts. Keyword fallback: ris_search_case_law with query.",
    });
    expect(searchCaseLaw).not.toHaveBeenCalled();
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(result.guidance);
  });
});

describe('risLookupCitation — collection_number route', () => {
  it('parses a VfSlg citation (dot-thousands kept) and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'VfSlg 19.632/2012' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({ collectionNumber: '19.632', court: 'vfgh' });

    const hit = parseSearchResponse(fixture('search-vfgh.json')).hits[0]!;
    const expectedRecord = toCaseLawRecord(hit, 'Vfgh');
    expect(result.found).toBe(true);
    expect(result.kind).toBe('collection_number');
    expect(result.record).toEqual(expectedRecord);
    expect(result.alternatives_count).toBe(24056); // total 24057 - the one returned hit
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_case_law (Vfgh) — Sammlungsnummer "19.632". 24056 more matched — list them with ris_search_case_law court: vfgh, collection_number: "19.632".',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, expectedRecord);
  });

  it('returns the parse-failure message when a forced collection_number kind does not match the VfSlg/VwSlg shape', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({
      citation: 'VfSlgXXX',
      kind: 'collection_number',
    });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'collection_number',
      guidance:
        "Could not read a collection number from 'VfSlgXXX'. Expected 'VfSlg 19.632/2012' or 'VwSlg 18.000 A/2010'. Fallback: ris_search_case_law court: vfgh | vwgh with query.",
    });
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('returns collectionGuidance when a parsed VwSlg collection number resolves to zero hits', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'VwSlg 18.000 A/2010' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      collectionNumber: 'VwSlg 18000 A*',
      court: 'vwgh',
    });
    expect(result).toEqual({
      found: false,
      kind: 'collection_number',
      guidance:
        'No decision for VwSlg 18.000 — Sammlungsnummer "VwSlg 18000 A*" matched nothing. That filter already carries the labelled undotted form VwGH stores, so the number or the part letter (A administrative, F finance) is the mismatch — verify both against the cite. Keyword fallback: ris_search_case_law court: vwgh with query.',
    });
  });
});

describe('risLookupCitation — VwGH collection numbers use the labelled cite (#25)', () => {
  /*
   * RIS stores Sammlungsnummer differently per court (live-confirmed against
   * data.bka.gv.at/ris/api/v2.6/judikatur): Vfgh holds the bare number, Vwgh the full
   * labelled undotted cite. Every row is [citation, expected Sammlungsnummer filter].
   */
  const FILTERS: ReadonlyArray<[string, string]> = [
    // The thousands dot must go — "VwSlg 18.000 A/2010" returns 0 upstream, undotted returns 3.
    ['VwSlg 18.000 A/2010', 'VwSlg 18000 A*'],
    ['VwSlg 18000 A/2010', 'VwSlg 18000 A*'],
    // A cite without the part letter or year still resolves through the space-anchored prefix.
    ['VwSlg 18014', 'VwSlg 18014 *'],
    ['VwSlg 18.014', 'VwSlg 18014 *'],
    // The A and F series reuse numbers, so a cited part letter is kept and wildcarded in place.
    ['VwSlg 8000 F/2005', 'VwSlg 8000 F*'],
    ['VwSlg 1800 f/1958', 'VwSlg 1800 F*'],
    // VfGH is unaffected — it stores the bare number and matches it dotted or undotted.
    ['VfSlg 19.632/2012', '19.632'],
    ['VfSlg 19632/2012', '19632'],
  ];

  it.each(FILTERS)(
    'sends "%s" to searchCaseLaw as Sammlungsnummer "%s"',
    async (citation, collectionNumber) => {
      searchCaseLaw.mockResolvedValue(zeroHits());
      const ctx = createMockContext({ errors: risLookupCitation.errors });
      await risLookupCitation.handler(risLookupCitation.input.parse({ citation }), ctx);
      expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ collectionNumber });
    },
  );

  it('names the filter it sent in resolution_note, so the resolution is reproducible in ris_search_case_law', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VwSlg 18.000 A/2010' }),
      ctx,
    );

    expect(result.found).toBe(true);
    expect(result.resolution_note).toContain('Sammlungsnummer "VwSlg 18000 A*"');
    // The as-cited dotted number is display-only and must never reach the filter.
    expect(result.resolution_note).not.toContain('"18.000"');
  });

  it('tells a VwGH miss the filter was already in the accepted form, rather than sending it back through the same query', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const vwgh = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VwSlg 18.000 A/2010' }),
      ctx,
    );
    searchCaseLaw.mockClear();
    const vfgh = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VfSlg 19.632/2012' }),
      ctx,
    );

    expect(vwgh.guidance).toContain('already carries the labelled undotted form');
    expect(vwgh.guidance).toContain('part letter');
    // The retry it must NOT offer: the same collection_number the tool just sent upstream.
    expect(vwgh.guidance).not.toContain('collection_number');
    // The VfGH branch keeps the shorter recipe — its bare number already is the accepted form.
    expect(vfgh.guidance).toContain('bare number VfGH stores');
    expect(vfgh.guidance).not.toContain('labelled undotted');
  });
});

describe('risLookupCitation — a VwSlg number without its part letter names two decisions', () => {
  /*
   * The A and F series reuse numbers, so the space-anchored wildcard a part-letter-less cite
   * produces ("VwSlg 8000 *") spans both. The fixture is that live response verbatim: five
   * Rechtssätze across VwSlg 8000 F/2005 and VwSlg 8000 A/1971. Resolving to hits[0] would
   * hand back the 2005 finance decision for a cite that names the 1971 one just as well.
   */
  const spanned = () => parseSearchResponse(fixture('search-vwgh-collection-span.json'));

  it('reports the distinct cites it matched instead of resolving to the first hit', async () => {
    searchCaseLaw.mockResolvedValue(spanned());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VwSlg 8000' }),
      ctx,
    );

    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ collectionNumber: 'VwSlg 8000 *' });
    expect(result.found).toBe(false);
    expect(result.record).toBeUndefined();
    expect(result.alternatives_count).toBeUndefined();
    expect(result.guidance).toContain('names more than one decision');
    expect(result.guidance).toContain('VwSlg 8000 F/2005');
    expect(result.guidance).toContain('VwSlg 8000 A/1971');
    expect(result.guidance).toContain('ris_search_case_law court: vwgh');
  });

  it('resolves normally when the cite carries the part letter that separates the two series', async () => {
    searchCaseLaw.mockResolvedValue(spanned());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VwSlg 8000 A/1971' }),
      ctx,
    );

    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ collectionNumber: 'VwSlg 8000 A*' });
    expect(result.found).toBe(true);
    expect(result.resolution_note).toContain('Sammlungsnummer "VwSlg 8000 A*"');
  });

  it('leaves a single-decision match resolved — the check fires on distinct cites, not on hit count', async () => {
    const singleDecision = spanned();
    searchCaseLaw.mockResolvedValue({
      ...singleDecision,
      hits: singleDecision.hits.filter((hit) =>
        hit.metadata.controller === 'Judikatur'
          ? hit.metadata.collectionNumber === 'VwSlg 8000 A/1971'
          : false,
      ),
    });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VwSlg 8000' }),
      ctx,
    );

    expect(result.found).toBe(true);
    expect(result.alternatives_count).toBe(4);
  });
});

/** A real capture, normalized — the page the mocked service hands the tool. */
function page(name: string) {
  return parseSearchResponse(fixture(name));
}

/** Resolve one citation against one mocked page and return the result. */
async function resolveAgainst(
  search: typeof searchLegislation,
  fixtureName: string,
  input: Record<string, unknown>,
) {
  search.mockResolvedValue(page(fixtureName));
  const ctx = createMockContext({ errors: risLookupCitation.errors });
  return await risLookupCitation.handler(risLookupCitation.input.parse(input), ctx);
}

/** The resolved record's document number. */
function documentNumberOf(result: { record?: object | undefined }): unknown {
  return (result.record as { document_number?: unknown } | undefined)?.document_number;
}

describe('risLookupCitation — citations that already resolve keep resolving (#48)', () => {
  /*
   * Each row is a real RIS page captured 2026-10-17 for that citation's routed search. RIS
   * already lists the cited document first on every one of them, so the ranking must leave
   * every pick where it is: the prefixed-only label (DSG "Art. 2 § 6"), the abbreviation plus
   * year (KFG "KFG 1967"), the exact label against its lettered neighbours (KSchG "§ 5" ahead
   * of § 5a–5d), an Artikel, a state law, and a court whose page carries no Rechtssätze.
   */
  const NORMS: ReadonlyArray<[Record<string, unknown>, string, string]> = [
    [{ citation: '§ 6 DSG' }, 'search-brkons-dsg-section-6.json', 'NOR40195902'],
    [{ citation: '§ 1 KFG' }, 'search-brkons-kfg-section-1.json', 'NOR40277066'],
    [{ citation: '§ 5 KSchG' }, 'search-brkons-kschg-section-5.json', 'NOR12031487'],
    [{ citation: 'Art 10 B-VG' }, 'search-brkons-bvg-article-10.json', 'NOR40211941'],
    [
      { citation: '§ 1 BO für Wien', state: 'wien' },
      'search-lrkons-bo-wien-section-1.json',
      'LWI40016426',
    ],
  ];

  it.each(NORMS)('%o resolves to the first RIS hit of %s, %s', async (input, name, expected) => {
    const result = await resolveAgainst(searchLegislation, name, input);
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe(expected);
  });

  it('keeps the label of a prefixed-only match — DSG § 6 is filed as "Art. 2 § 6"', async () => {
    const result = await resolveAgainst(searchLegislation, 'search-brkons-dsg-section-6.json', {
      citation: '§ 6 DSG',
    });
    expect(result.record).toMatchObject({ abbreviation: 'DSG', section_label: 'Art. 2 § 6' });
  });

  it('resolves a BVwG Geschäftszahl to its one decision text', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-bvwg-w213-2337298-1.json', {
      citation: 'W213 2337298-1',
    });
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe('BVWGT_20261014_W213_2337298_1_00');
    expect(result.alternatives_count).toBeUndefined();
  });

  it('resolves a part-cited BGBl number to its one entry', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblauth-50-2025-part1.json', {
      citation: 'BGBl. I Nr. 50/2025',
    });
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblAuth',
      number: '50/2025',
      part: 'part1',
    });
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe('BGBLA_2025_I_50');
  });

  it('resolves a partless pre-1997 BGBl number — that era runs one series', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblpdf-194-1961.json', {
      citation: 'BGBl. Nr. 194/1961',
    });
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblPdf',
      number: '194/1961',
    });
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe('1961_194_0');
  });

  it('resolves a VwGH decision whose text RIS already lists first', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-vwgh-ra-2025-07-0289-both.json', {
      citation: 'Ra 2025/07/0289',
    });
    expect(documentNumberOf(result)).toBe('JWT_2025070289_20260921L00');
    expect(result.alternatives_count).toBe(4);
  });

  it('resolves a VfSlg number to the decision text RIS already lists first', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-vfgh-vfslg-19632-both.json', {
      citation: 'VfSlg 19.632/2012',
    });
    expect(documentNumberOf(result)).toBe('JFT_09879686_11U00466_2_00');
    expect(result.alternatives_count).toBe(1);
  });
});

describe('risLookupCitation — a norm citation picks the cited law, not the first title match (#48)', () => {
  it('"§ 1 UGB" resolves to the Unternehmensgesetzbuch § 1, hit 3 of 7 on the RIS page', async () => {
    const result = await resolveAgainst(searchLegislation, 'search-brkons-ugb-section-1.json', {
      citation: '§ 1 UGB',
    });
    const today = todayInAustria();
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe('NOR40069773');
    expect(result.record).toMatchObject({ abbreviation: 'UGB', section_label: '§ 1' });
    // Every other hit still counts as an alternative — the field's meaning does not change.
    expect(result.alternatives_count).toBe(6);
    expect(result.resolution_note).toBe(
      `Resolved via ris_search_legislation (BrKons) — title "UGB", § 1, in force ${today}. 6 more matched — list them with ris_search_legislation title: "UGB", section_from: "1", section_to: "1", section_type: Paragraph, in_force_as_of: "${today}".`,
    );
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**document_number**: NOR40069773');
    expect(text).toContain('**alternatives_count**: 6');
  });

  it('"§ 2 EStG" resolves to the EStG 1988 § 2 — the cited abbreviation plus a year', async () => {
    const result = await resolveAgainst(searchLegislation, 'search-brkons-estg-section-2.json', {
      citation: '§ 2 EStG',
    });
    expect(documentNumberOf(result)).toBe('NOR40246516');
    expect(result.record).toMatchObject({ abbreviation: 'EStG 1988' });
    expect(result.alternatives_count).toBe(6);
  });

  it('compares abbreviations case-insensitively with whitespace collapsed', async () => {
    const lower = await resolveAgainst(searchLegislation, 'search-brkons-ugb-section-1.json', {
      citation: '§ 1 ugb',
    });
    expect(documentNumberOf(lower)).toBe('NOR40069773');
    searchLegislation.mockReset();
    const spaced = await resolveAgainst(searchLegislation, 'search-brkons-estg-section-2.json', {
      citation: '§ 2 EStG  1988',
    });
    expect(documentNumberOf(spaced)).toBe('NOR40246516');
  });

  it('ranks the exact abbreviation ahead of the abbreviation plus a year', async () => {
    // Derived from the EStG capture: a copy of the EStG 1988 § 2 hit re-labelled with the bare
    // abbreviation, placed last — it has to win over the year-suffixed hit RIS listed earlier.
    const base = page('search-brkons-estg-section-2.json');
    const year = base.hits[1]!;
    const exact = {
      ...year,
      documentNumber: 'NOR_EXACT',
      metadata: { ...year.metadata, abbreviation: 'EStG' },
    } as typeof year;
    searchLegislation.mockResolvedValue({ ...base, hits: [...base.hits, exact] });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '§ 2 EStG' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe('NOR_EXACT');
  });

  it('within one abbreviation rank, an exact section label beats a prefixed one', async () => {
    // The UGB capture reordered so the four "Art. N § 1" hits come before the plain "§ 1".
    const base = page('search-brkons-ugb-section-1.json');
    const [first, second, plain, ...prefixed] = base.hits;
    searchLegislation.mockResolvedValue({
      ...base,
      hits: [first!, second!, ...prefixed, plain!],
    });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '§ 1 UGB' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe('NOR40069773');
  });

  it('applies no label preference to a bare abbreviation — the first hit of the cited law wins', async () => {
    const base = page('search-brkons-ugb-section-1.json');
    const [first, second, plain, ...prefixed] = base.hits;
    searchLegislation.mockResolvedValue({
      ...base,
      hits: [first!, second!, ...prefixed, plain!],
    });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'UGB' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe(prefixed[0]!.documentNumber);
    expect(documentNumberOf(result)).not.toBe(first!.documentNumber);
  });

  it('keeps RIS order on a page where no hit carries an abbreviation', async () => {
    // The EStG capture without its one abbreviated hit: six Verordnungen, none with Abkuerzung.
    const base = page('search-brkons-estg-section-2.json');
    const hits = base.hits.filter((hit) => hit.documentNumber !== 'NOR40246516');
    expect(hits.every((hit) => !('abbreviation' in hit.metadata))).toBe(true);
    searchLegislation.mockResolvedValue({ ...base, hits, total: hits.length });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '§ 2 EStG' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe('NOR40069297');
    expect(result.alternatives_count).toBe(5);
  });

  it('keeps RIS order when no abbreviation on the page is the cited one', async () => {
    const result = await resolveAgainst(
      searchLegislation,
      'search-brkons-praemien-section-2.json',
      { citation: '§ 2 Prämienbegünstigte' },
    );
    expect(documentNumberOf(result)).toBe('NOR40046402');
    expect(result.alternatives_count).toBe(2);
  });

  it('asks RIS for a 100-hit page, so a bare abbreviation ranks past the first 20 titles', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    await risLookupCitation.handler(risLookupCitation.input.parse({ citation: 'UGB' }), ctx);
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ pageSize: 100 });
  });
});

describe('risLookupCitation — a case number picks the decision text, then its own Rechtssatz (#48)', () => {
  it('"6Ob236/23h" resolves to the decision text, hit 2 behind a 1952 Rechtssatz that lists it', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-justiz-6ob236-23h-both.json', {
      citation: '6Ob236/23h',
    });
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe('JJT_20240221_OGH0002_0060OB00236_23H0000_000');
    expect(result.record).toMatchObject({ decision_type: 'Text' });
    expect(result.alternatives_count).toBe(5);
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_case_law (Justiz) — Geschäftszahl "6Ob236/23h". 5 more matched — list them with ris_search_case_law court: justiz, case_number: "6Ob236/23h".',
    );
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**document_number**: JJT_20240221_OGH0002_0060OB00236_23H0000_000');
  });

  it('"G 13/2025" resolves to the VfGH decision text, not its Rechtssatz', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-vfgh-g13-2025-both.json', {
      citation: 'G 13/2025',
    });
    expect(documentNumberOf(result)).toBe('JFT_20260928_25G00013_00');
  });

  it('ranks the decision text ahead of a Rechtssatz whose first case number is the cite', async () => {
    // 1Ob948/52: the 1952 Rechtssatz leads with 1Ob948/52 and RIS lists it first.
    const result = await resolveAgainst(searchCaseLaw, 'search-justiz-1ob948-52-both.json', {
      citation: '1Ob948/52',
    });
    expect(documentNumberOf(result)).toBe('JJT_19521210_OGH0002_0010OB00948_5200000_000');
  });

  it('with no decision text on the page, picks a Rechtssatz the cited decision leads', async () => {
    // A Rechtssätze-only page (no Dokumenttyp flag): the 1952 Rechtssatz lists 6Ob236/23h
    // among 44 case numbers; the four after it lead with it.
    const result = await resolveAgainst(searchCaseLaw, 'search-justiz-gz-joined.json', {
      citation: '6Ob236/23h',
    });
    expect(documentNumberOf(result)).toBe('JJR_20240221_OGH0002_0060OB00236_23H0000_002');
  });

  it.each([
    ['G8/2026', 'JFR_20260625_26G00008_01'],
    ['G155/2025', 'JFR_20260317_25G00155_01'],
    ['E3811/2025', 'JFR_20260701_25E03811_01'],
    ['E3811/2025 ua', 'JFR_20260701_25E03811_01'],
  ])(
    'compares "%s" without its trailing ua or parenthesized suffix',
    async (citation, expected) => {
      const result = await resolveAgainst(searchCaseLaw, 'search-vfgh-gz-joined.json', {
        citation,
        court: 'vfgh',
      });
      expect(documentNumberOf(result)).toBe(expected);
    },
  );

  it('compares without whitespace or case', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-justiz-6ob236-23h-both.json', {
      citation: '6 ob 236/23H',
      court: 'justiz',
    });
    expect(documentNumberOf(result)).toBe('JJT_20240221_OGH0002_0060OB00236_23H0000_000');
  });

  it('a decision text matches on any of its case numbers, not only the first', async () => {
    // Derived from the VfGH capture: the joint G179/2024, V113/2024 hit re-typed as a decision
    // text and listed after an unrelated Rechtssatz.
    const base = page('search-vfgh-gz-joined.json');
    const [joint, other] = base.hits;
    const jointText = {
      ...joint!,
      metadata: { ...joint!.metadata, decisionDocumentType: 'Text' },
    } as typeof joint;
    searchCaseLaw.mockResolvedValue({ ...base, hits: [other!, jointText!] });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'V113/2024', court: 'vfgh' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe(joint!.documentNumber);
  });

  it('a Rechtssatz that lists the cite after another case number does not outrank RIS order', async () => {
    // The joint Rechtssatz leads with G179/2024; V113/2024 is its second case number.
    const base = page('search-vfgh-gz-joined.json');
    const [joint, other] = base.hits;
    searchCaseLaw.mockResolvedValue({ ...base, hits: [other!, joint!] });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'V113/2024', court: 'vfgh' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe(other!.documentNumber);
  });

  it('asks RIS for a 100-hit page — a much-cited decision text sits past the first 20', async () => {
    // Measured 2026-10-17: 2Ob1/09z matches 78 documents with its decision text at 57.
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    await risLookupCitation.handler(risLookupCitation.input.parse({ citation: '2Ob1/09z' }), ctx);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: '2Ob1/09z',
      court: 'justiz',
      pageSize: 100,
    });
  });

  it('a collection number picks the decision text ahead of a Rechtssatz RIS listed first', async () => {
    // The VfSlg 19.632 capture reversed.
    const base = page('search-vfgh-vfslg-19632-both.json');
    searchCaseLaw.mockResolvedValue({ ...base, hits: [...base.hits].reverse() });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'VfSlg 19.632/2012' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe('JFT_09879686_11U00466_2_00');
    expect(result.alternatives_count).toBe(1);
  });
});

describe('risLookupCitation — a partless BGBl number in more than one part is ambiguous (#48)', () => {
  it('"BGBl. Nr. 50/2025" returns found:false naming Teil I, II, and III', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblauth-50-2025.json', {
      citation: 'BGBl. Nr. 50/2025',
    });
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblAuth',
      number: '50/2025',
    });
    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'BGBl. Nr. 50/2025 names more than one gazette entry — number "50/2025" matched BGBl. I Nr. 50/2025, BGBl. II Nr. 50/2025 and BGBl. III Nr. 50/2025. From 1997 the federal gazette runs three parts that reuse numbers (I laws, II ordinances, III treaties), so the part is what picks one — retry with it, e.g. \'BGBl. I Nr. 50/2025\'. All matches: ris_search_gazette number: "50/2025".',
    });
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**found**: false');
    expect(text).toContain(result.guidance);
    expect(text).not.toContain('### Resolved document');
  });

  it('applies to the 1997–2003 BgblPdf tier, which carries the part split too', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblpdf-50-1999.json', {
      citation: 'BGBl. Nr. 50/1999',
    });
    expect(result.found).toBe(false);
    expect(result.guidance).toContain(
      'matched BGBl. I Nr. 50/1999, BGBl. II Nr. 50/1999 and BGBl. III Nr. 50/1999',
    );
  });

  it('resolves a partless number that only one part carries', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblauth-50-2025-part1.json', {
      citation: 'BGBl. Nr. 50/2025',
    });
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe('BGBLA_2025_I_50');
  });

  it('two parts are named with "and"', async () => {
    const base = page('search-bgblauth-50-2025.json');
    searchGazette.mockResolvedValue({ ...base, hits: base.hits.slice(0, 2), total: 2 });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'BGBl. Nr. 50/2025' }),
      ctx,
    );
    expect(result.guidance).toContain('matched BGBl. I Nr. 50/2025 and BGBl. III Nr. 50/2025.');
  });
});

describe('risLookupCitation — a gazette cite picks the hit from its own series (#65)', () => {
  /*
   * search-bgblpdf-1-1945.json is BgblPdf `Bundesgesetzblatt=1/1945`, captured 2026-10-17: RIS
   * files the 1945 Staatsgesetzblatt there beside the Bundesgesetzblatt, and the two share
   * Bgblnummer "1/1945" — BGBl. Nr. 1/1945 (1945_0_0) first, StGBl. Nr. 1/1945 (1945_1_0)
   * second. BgblAlt holds no 1945 entry at all, so the old StGBl.-to-BgblAlt route found nothing.
   */
  const PDF_1945 = 'search-bgblpdf-1-1945.json';

  /** The 1945 page with its hits reordered or cut — RIS order must never decide the series. */
  function pdf1945(pick: (hits: RisHit[]) => RisHit[]) {
    const base = page(PDF_1945);
    const hits = pick([...base.hits]);
    return { ...base, hits, total: hits.length };
  }

  it('"StGBl. Nr. 1/1945" searches BgblPdf and resolves to the Staatsgesetzblatt entry', async () => {
    const result = await resolveAgainst(searchGazette, PDF_1945, { citation: 'StGBl. Nr. 1/1945' });
    expect(searchGazette).toHaveBeenCalledTimes(1);
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({ application: 'BgblPdf', number: '1/1945' });

    const parsed = risLookupCitation.output.parse(result);
    expect(parsed.found).toBe(true);
    expect(parsed.record).toMatchObject({
      document_number: '1945_1_0',
      promulgation: 'StGBl. Nr. 1/1945',
      short_title: '1. Proklamation über die Selbständigkeit Österreichs.',
    });
    // The BGBl. entry is another law that happens to share the number, not an alternative.
    expect(parsed.alternatives_count).toBeUndefined();
    expect(parsed.resolution_note).toBe(
      'Resolved via ris_search_gazette (BgblPdf) — number "1/1945". Number "1/1945" also names BGBl. Nr. 1/1945, an entry in another gazette series that shares its numbering — not an alternative.',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(`**resolution_note**: ${parsed.resolution_note}`);
    expect(text).toContain('**promulgation**: StGBl. Nr. 1/1945');
    expect(text).not.toContain('**alternatives_count**');
    expectRecordRendered(text, parsed.record as object);
  });

  it('"BGBl. Nr. 1/1945" resolves to the Bundesgesetzblatt entry, never the StGBl. one', async () => {
    const result = await resolveAgainst(searchGazette, PDF_1945, { citation: 'BGBl. Nr. 1/1945' });
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({ application: 'BgblPdf', number: '1/1945' });
    expect(documentNumberOf(result)).toBe('1945_0_0');
    expect(result.record).toMatchObject({ promulgation: 'BGBl. Nr. 1/1945' });
    expect(result.alternatives_count).toBeUndefined();
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (BgblPdf) — number "1/1945". Number "1/1945" also names StGBl. Nr. 1/1945, an entry in another gazette series that shares its numbering — not an alternative.',
    );
  });

  it.each([
    ['StGBl. Nr. 1/1945', '1945_1_0'],
    ['BGBl. Nr. 1/1945', '1945_0_0'],
  ])('%s keeps its pick whichever entry RIS lists first', async (citation, expected) => {
    for (const order of [(hits: RisHit[]) => hits, (hits: RisHit[]) => hits.reverse()]) {
      searchGazette.mockResolvedValue(pdf1945(order));
      const result = await risLookupCitation.handler(
        risLookupCitation.input.parse({ citation }),
        createMockContext({ errors: risLookupCitation.errors }),
      );
      expect(documentNumberOf(result)).toBe(expected);
    }
  });

  it('reads a year-first "StGBl. 1945/1" the same way', async () => {
    const result = await resolveAgainst(searchGazette, PDF_1945, { citation: 'StGBl. 1945/1' });
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({ application: 'BgblPdf', number: '1/1945' });
    expect(documentNumberOf(result)).toBe('1945_1_0');
  });

  it('a number only the other series carries is a miss that names the entry it did match', async () => {
    // BGBl. ran no number 5 in 1945; RIS answers with StGBl. Nr. 5/1945 alone.
    searchGazette.mockResolvedValue(
      pdf1945((hits) => hits.filter((hit) => hit.documentNumber === '1945_1_0')),
    );
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'BGBl. Nr. 1/1945' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'No BGBl. entry for 1/1945 in BgblPdf — number "1/1945" matched only StGBl. Nr. 1/1945, an entry in another gazette series that shares its numbering. Verify the series against the cite; if StGBl. Nr. 1/1945 is the entry meant, retry with that citation. All matches: ris_search_gazette number: "1/1945".',
    });
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(result.guidance);
    expect(text).not.toContain('### Resolved document');
  });

  it('a 1945 StGBl. miss gets guidance about the StGBl., not about BGBl. parts', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'StGBl. Nr. 999/1945' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblPdf',
      number: '999/1945',
    });
    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'No gazette entry for 999/1945 in BgblPdf. RIS carries the Staatsgesetzblatt for 1918–1920 (BgblAlt) and 1945 (BgblPdf); from 1946 the federal gazette is the BGBl. Verify the number and year against the cite; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number.',
    });
  });

  /*
   * BgblAlt files several gazettes under one Gesetzblattnummer space and names each entry's
   * gazette in Kundmachungsorgan. Captured 2026-10-17 (Gesetzblattnummer=1/<year>): 1918 lists
   * the Staatsgesetzblatt entry first, then the Reichsgesetzblatt one; 1920 lists BGBl. ahead of
   * StGBl.; 1938 lists the Gesetzblatt für das Land Österreich ahead of BGBl.
   */
  it.each([
    ['StGBl. Nr. 1/1918', 'search-bgblalt-1-1918.json', 'sgb1918_0001_00001', 'RGBl. Nr. 1/1918'],
    ['RGBl. Nr. 1/1918', 'search-bgblalt-1-1918.json', 'rgb1918_0001_00001', 'StGBl. Nr. 1/1918'],
    ['StGBl. Nr. 1/1920', 'search-bgblalt-1-1920.json', 'sgb1920_0001_00001', 'BGBl. Nr. 1/1920'],
    ['BGBl. Nr. 1/1920', 'search-bgblalt-1-1920.json', 'bgb1920_0001_00001', 'StGBl. Nr. 1/1920'],
    ['BGBl. Nr. 1/1938', 'search-bgblalt-1-1938.json', 'bgl1938_0001_00001', 'GBlÖ Nr. 1/1938'],
    ['GBlÖ Nr. 1/1938', 'search-bgblalt-1-1938.json', 'glo1938_0001_00001', 'BGBl. Nr. 1/1938'],
  ])(
    '%s stays on BgblAlt and resolves in its own gazette (%s → %s)',
    async (citation, name, expected, other) => {
      const result = await resolveAgainst(searchGazette, name, { citation });
      const number = citation.slice(citation.lastIndexOf(' ') + 1);
      expect(searchGazette.mock.calls[0]?.[0]).toEqual({ application: 'BgblAlt', number });
      expect(documentNumberOf(result)).toBe(expected);
      expect(result.alternatives_count).toBeUndefined();
      expect(result.resolution_note).toBe(
        `Resolved via ris_search_gazette (BgblAlt) — number "${number}". Number "${number}" also names ${other}, an entry in another gazette series that shares its numbering — not an alternative.`,
      );
    },
  );

  it('keeps every other-series hit out of alternatives_count, not one per distinct cite', async () => {
    // Two StGBl. entries share the number with the cited BGBl. one: both are another gazette's
    // documents, so nothing the cite could mean is left over.
    const base = page(PDF_1945);
    const stgbl = base.hits.find((hit) => hit.documentNumber === '1945_1_0')!;
    const hits = [...base.hits, { ...stgbl, documentNumber: '1945_2_0' }];
    searchGazette.mockResolvedValue({ ...base, hits, total: hits.length });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'BGBl. Nr. 1/1945' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(documentNumberOf(result)).toBe('1945_0_0');
    expect(result.alternatives_count).toBeUndefined();
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (BgblPdf) — number "1/1945". Number "1/1945" also names StGBl. Nr. 1/1945, an entry in another gazette series that shares its numbering — not an alternative.',
    );
  });

  it('keeps a hit whose gazette is not recorded, rather than reading it as another series', async () => {
    const base = page('search-bgblalt-1-1920.json');
    const unlabelled = base.hits.map((hit) => ({
      ...hit,
      metadata: { ...hit.metadata, promulgation: undefined },
    }));
    searchGazette.mockResolvedValue({ ...base, hits: unlabelled });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'StGBl. Nr. 1/1920' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(result.found).toBe(true);
    expect(result.alternatives_count).toBe(1);
  });
});

/** Thread CPU time of one resolution of `input`, in microseconds. */
async function cpuMicros(input: Record<string, unknown>): Promise<number> {
  const ctx = createMockContext({ errors: risLookupCitation.errors });
  const parsed = risLookupCitation.input.parse(input);
  const start = process.threadCpuUsage();
  await risLookupCitation.handler(parsed, ctx);
  const used = process.threadCpuUsage(start);
  return used.user + used.system;
}

/**
 * Resolve `build(size)` as the citation, beside `input`, at each doubling size across a 64×
 * span — 5,000 to 320,000 characters by default: every size stays under 250 ms of CPU, and the
 * largest under 256× the smallest. A regex-heavy shape starts lower (`from` 1,250 tops out at
 * 80,000) to stay under the input size where Bun's regex engine switches modes. Every size
 * also ends the same way as the smallest — the same found, kind, and request count — so a size
 * that turned fast by taking another route fails.
 */
async function expectLinearResolution(
  build: (size: number) => string,
  input: Record<string, unknown>,
  from = 5_000,
): Promise<void> {
  const requests = () =>
    searchLegislation.mock.calls.length +
    searchCaseLaw.mock.calls.length +
    searchGazette.mock.calls.length;
  const outcome = async (size: number) => {
    const before = requests();
    const { found, kind } = await lookup({ ...input, citation: build(size) });
    return { found, kind, requests: requests() - before };
  };
  const time = (size: number) => cpuMicros({ ...input, citation: build(size) });
  const expected = await outcome(from);
  await time(from); // warm-up
  const timings: number[] = [];
  for (let size = from; size <= from * 64; size *= 2) {
    expect(await outcome(size), `${size} chars`).toStrictEqual(expected);
    const micros = Math.min(await time(size), await time(size));
    expect(micros, `${size} chars`).toBeLessThan(250_000);
    timings.push(Math.max(micros, 1));
  }
  expect(timings.at(-1)! / timings[0]!).toBeLessThan(256);
}

describe('risLookupCitation — ranking stays linear in the citation length (#48)', () => {
  it.each([
    ['a whitespace run', (n: number) => `G${' '.repeat(n)}13/2025`],
    ['repeated openers with one closer', (n: number) => `G13/2025${'('.repeat(n)})`],
    ['repeated ua suffixes', (n: number) => `G13/2025${' ua'.repeat(Math.floor(n / 3))}`],
  ])('%s', async (_shape, build) => {
    searchCaseLaw.mockResolvedValue(page('search-vfgh-gz-joined.json'));
    await expectLinearResolution(build, { court: 'vfgh', kind: 'case_number' });
  });
});

describe('risLookupCitation — kind override', () => {
  it('honors an explicit kind: forcing norm on a case-number-shaped citation takes the norm branch instead of auto-classifying it as case_number', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'Ro 2026/03/0016', kind: 'norm' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: UNREADABLE_NORM('Ro 2026/03/0016'),
    });
    // Auto-classification would have routed "Ro 2026/03/0016" to case_number (court vwgh) —
    // the forced kind: 'norm' must bypass that entirely, calling neither search method.
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchLegislation).not.toHaveBeenCalled();
  });
});

// The fold itself is swept across every state parameter in _shared.test.ts; this pins that the
// folded code is the state hint the routed search receives on the wire path.
describe('risLookupCitation — state names in the state hint (#58)', () => {
  it.each([
    ['Wien', 'wien'],
    ['Vienna', 'wien'],
    ['Oberösterreich', 'oberoesterreich'],
  ])('routes a norm to the consolidated law of the state named %j (%s)', async (state, code) => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await runToolContract(risLookupCitation, { citation: '§ 16 ABGB', state });
    expect(result.isError).not.toBe(true);
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      application: 'LrKons',
      state: code,
    });
  });
});

/** Auto-classify one citation against zero-hit pages; return the result and the courts probed. */
async function probedCourts(input: Record<string, unknown>) {
  searchCaseLaw.mockResolvedValue(zeroHits());
  const ctx = createMockContext({ errors: risLookupCitation.errors });
  const result = await risLookupCitation.handler(risLookupCitation.input.parse(input), ctx);
  const courts = searchCaseLaw.mock.calls.map(([params]) => (params as { court: string }).court);
  return { courts, result };
}

describe('risLookupCitation — each court’s own Geschäftszahl formats detect that court (#49)', () => {
  /*
   * Every row is a Geschäftszahl as ris_search_case_law returns it in case_numbers, and each
   * resolves when its court is passed explicitly — detection is what has to find it.
   */
  it.each([
    ['G13/2025', 'vfgh'],
    ['E151/2026', 'vfgh'],
    ['WIII1/2026', 'vfgh'],
    ['E3811/2025', 'vfgh'],
    ['Fr 2026/04/0013', 'vwgh'],
    ['AW 2010/10/0040', 'vwgh'],
    ['2006/01/0488', 'vwgh'],
    // A two-digit-year VwGH number, the form ris_search_case_law and ris_track_changes return.
    ['83/16/0049', 'vwgh'],
    ['I413 2345386-1', 'bvwg'],
    ['E 301/18/2026.019/006', 'lvwg'],
    ['VGW-101/070/875/2026', 'lvwg'],
    ['LVwG 47.14-2930/2026-8', 'lvwg'],
    ['KLVwG-1709/6/2026', 'lvwg'],
    ['405-10/1827/1/2-2026', 'lvwg'],
  ])('"%s" detects %s', async (citation, court) => {
    const { courts, result } = await probedCourts({ citation });
    expect(result.kind).toBe('case_number');
    expect(courts).toEqual([court]);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: citation,
      court,
      pageSize: 100,
    });
  });

  it.each([
    ['G 287/2022', ['vfgh']],
    ['Ro 2026/03/0016', ['vwgh']],
    ['Ra 2025/07/0289', ['vwgh']],
    ['14Os49/26a', ['justiz']],
    ['6 Ob 236/23h', ['justiz']],
    ['W122 2312999-1', ['bvwg']],
    ['L515 2000000-1', ['bvwg']],
    ['G307 2000000-1', ['bvwg']],
    ['LVwG-AV-757/001-2026', ['lvwg']],
    ['2026-0.092.118', ['dsk', 'dok']],
    ['B10-PVAB/25', ['pvak']],
    ['B-GBK II/307/26', ['gbk']],
    ['VKS-961040/13', ['verg']],
    ['2026-0.074.605/UPTS/Grüne', ['upts']],
  ])('"%s" still detects %o', async (citation, expected) => {
    const { courts } = await probedCourts({ citation });
    expect(courts).toEqual(expected);
  });

  it.each([{ citation: 'W213-2337298-1' }, { citation: 'W213-2337298-1', court: 'bvwg' }])(
    'detects a hyphenated BVwG number and searches the spaced form RIS stores: %o',
    async (input) => {
      const result = await resolveAgainst(searchCaseLaw, 'search-bvwg-w213-2337298-1.json', input);
      expect(searchCaseLaw).toHaveBeenCalledTimes(1);
      expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
        caseNumber: 'W213 2337298-1',
        court: 'bvwg',
        pageSize: 100,
      });
      expect(documentNumberOf(result)).toBe('BVWGT_20261014_W213_2337298_1_00');
      expect(result.resolution_note).toBe(
        'Resolved via ris_search_case_law (Bvwg) — Geschäftszahl "W213 2337298-1".',
      );
    },
  );
});

describe('risLookupCitation — a leading court name sets the court (#50)', () => {
  it('"VfGH G 13/2025" searches Vfgh for "G 13/2025" and resolves to the decision text', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-vfgh-g13-2025-both.json', {
      citation: 'VfGH G 13/2025',
    });
    expect(searchCaseLaw).toHaveBeenCalledTimes(1);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: 'G 13/2025',
      court: 'vfgh',
      pageSize: 100,
    });
    expect(result.found).toBe(true);
    expect(result.kind).toBe('case_number');
    expect(documentNumberOf(result)).toBe('JFT_20260928_25G00013_00');
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_case_law (Vfgh) — Geschäftszahl "G 13/2025". 1 more matched — list them with ris_search_case_law court: vfgh, case_number: "G 13/2025".',
    );
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, result.record!);
  });

  it('"OGH 6 Ob 236/23h" resolves to the OGH decision text', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-justiz-6ob236-23h-both.json', {
      citation: 'OGH 6 Ob 236/23h',
    });
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: '6 Ob 236/23h',
      court: 'justiz',
      pageSize: 100,
    });
    expect(documentNumberOf(result)).toBe('JJT_20240221_OGH0002_0060OB00236_23H0000_000');
  });

  it('"VwGH Ra 2025/07/0289" resolves to the VwGH decision text', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-vwgh-ra-2025-07-0289-both.json', {
      citation: 'VwGH Ra 2025/07/0289',
    });
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({
      caseNumber: 'Ra 2025/07/0289',
      court: 'vwgh',
    });
    expect(documentNumberOf(result)).toBe('JWT_2025070289_20260921L00');
  });

  it.each([
    ['vfgh G 13/2025', 'vfgh', 'G 13/2025'],
    ['BVWG W213 2337298-1', 'bvwg', 'W213 2337298-1'],
    ['BVwG  W213 2337298-1', 'bvwg', 'W213 2337298-1'],
    ['DSB 2026-0.690.562', 'dsk', '2026-0.690.562'],
    ['ogh 14Os49/26a', 'justiz', '14Os49/26a'],
  ])('"%s" probes only %s for "%s"', async (citation, court, caseNumber) => {
    const { courts, result } = await probedCourts({ citation });
    expect(result.kind).toBe('case_number');
    expect(courts).toEqual([court]);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ caseNumber });
    expect(result.guidance).toBe(
      `No decision for '${caseNumber}' in ${court === 'justiz' ? 'Justiz' : court === 'dsk' ? 'Dsk' : court === 'bvwg' ? 'Bvwg' : 'Vfgh'}. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.`,
    );
  });

  it('keeps "LVwG " as part of a Steiermark number rather than a prefix', async () => {
    const { courts } = await probedCourts({ citation: 'LVwG 47.14-2930/2026-8' });
    expect(courts).toEqual(['lvwg']);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({
      caseNumber: 'LVwG 47.14-2930/2026-8',
    });
  });

  it('an explicit court hint wins over the prefix', async () => {
    const { courts } = await probedCourts({ citation: 'VfGH G 13/2025', court: 'vwgh' });
    expect(courts).toEqual(['vwgh']);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ caseNumber: 'G 13/2025' });
  });

  it('strips the prefix under a forced kind: case_number too', async () => {
    const { courts } = await probedCourts({ citation: 'OGH 6 Ob 236/23h', kind: 'case_number' });
    expect(courts).toEqual(['justiz']);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ caseNumber: '6 Ob 236/23h' });
  });

  /*
   * A court name in front of a law, not a Geschäftszahl: no digits joined by "/" or "-" follow
   * it. These auto-classified as norm citations before the prefix existed and still do.
   */
  it.each([
    ['VwGH Gesetz', { title: 'VwGH Gesetz' }],
    ['OGH Geo', { title: 'OGH Geo' }],
    [
      'VfGH Art 140 B-VG',
      { title: 'VfGH', sectionFrom: '140', sectionTo: '140', sectionType: 'Artikel' },
    ],
  ])('"%s" stays a norm citation', async (citation, params) => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(result.kind).toBe('norm');
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      application: 'BrKons',
      ...params,
    });
  });
});

describe('risLookupCitation — an ECLI resolves through a full-text search of its court (#50)', () => {
  it('"ECLI:AT:VFGH:2026:G13.2025" resolves to the decision text that carries it', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-ecli-vfgh-g13-2025.json', {
      citation: 'ECLI:AT:VFGH:2026:G13.2025',
    });
    expect(searchCaseLaw).toHaveBeenCalledTimes(1);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      court: 'vfgh',
      pageSize: 100,
      query: '"ECLI:AT:VFGH:2026:G13.2025"',
    });
    expect(result.found).toBe(true);
    expect(result.kind).toBe('case_number');
    expect(documentNumberOf(result)).toBe('JFT_20260928_25G00013_00');
    expect(result.record).toMatchObject({ ecli: 'ECLI:AT:VFGH:2026:G13.2025' });
    expect(result.alternatives_count).toBe(1);
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_case_law (Vfgh) — ECLI "ECLI:AT:VFGH:2026:G13.2025". 1 more matched — list them with ris_search_case_law court: vfgh, query: "\\"ECLI:AT:VFGH:2026:G13.2025\\"".',
    );
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, result.record!);
    expect(text).toContain('**alternatives_count**: 1');
  });

  it('prefers the decision text when RIS lists the Rechtssatz that shares its ECLI first', async () => {
    const base = page('search-ecli-vfgh-g13-2025.json');
    searchCaseLaw.mockResolvedValue({ ...base, hits: [...base.hits].reverse() });
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'ECLI:AT:VFGH:2026:G13.2025' }),
      ctx,
    );
    expect(documentNumberOf(result)).toBe('JFT_20260928_25G00013_00');
  });

  it.each([
    [
      'ECLI:AT:OGH0002:2024:0060OB00236.23H.0221.000',
      'search-ecli-ogh-6ob236-23h.json',
      'justiz',
      'JJT_20240221_OGH0002_0060OB00236_23H0000_000',
    ],
    [
      'ECLI:AT:BVWG:2026:W213.2337298.1.00',
      'search-ecli-bvwg-w213-2337298-1.json',
      'bvwg',
      'BVWGT_20261014_W213_2337298_1_00',
    ],
    [
      'ECLI:AT:VWGH:2026:RA2025070289.L00',
      'search-ecli-vwgh-ra-2025-07-0289.json',
      'vwgh',
      'JWT_2025070289_20260921L00',
    ],
    [
      'ecli:at:vfgh:2026:g13.2025',
      'search-ecli-vfgh-g13-2025.json',
      'vfgh',
      'JFT_20260928_25G00013_00',
    ],
  ])('"%s" resolves via %s', async (citation, name, court, expected) => {
    const result = await resolveAgainst(searchCaseLaw, name, { citation });
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ court });
    expect(result.found).toBe(true);
    expect(documentNumberOf(result)).toBe(expected);
  });

  it.each([
    ['ECLI:AT:LVWGNI:2026:LVwG.S.1023.001.2026', 'lvwg'],
    ['ECLI:AT:DSB:2026:2026.0.690.562', 'dsk'],
    // The Parlamentarisches Datenschutzkomitee decides in the Dsk application under its own segment.
    ['ECLI:AT:PDK:2026:2026.0.092.118', 'dsk'],
    ['ECLI:AT:PVAB:2026:B5.PVAB.26', 'pvak'],
    ['ECLI:AT:OLG0009:2025:0330BS00012.25X.0213.000', 'justiz'],
    ['ECLI:AT:LG00003:2026:03400R00058.26W.0805.000', 'justiz'],
    ['ECLI:AT:BG00320:2013:00600C00618.13P.0807.000', 'justiz'],
  ])('maps the court segment of "%s" to %s', async (citation, court) => {
    const { courts } = await probedCourts({ citation });
    expect(courts).toEqual([court]);
  });

  it('a fabricated ECLI returns found:false naming the court searched', async () => {
    const { result } = await probedCourts({ citation: 'ECLI:AT:VFGH:2026:G99999.2025' });
    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "No decision in Vfgh carries ECLI 'ECLI:AT:VFGH:2026:G99999.2025' — a full-text search for it found no document with that identifier. Verify the ECLI against the cite, or resolve the decision by its Geschäftszahl with court: vfgh. Keyword fallback: ris_search_case_law court: vfgh with query.",
    });
    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(result.guidance);
  });

  it('never picks a hit that only mentions the ECLI — its own ecli has to equal the cite', async () => {
    // The joined VfGH page carries other decisions' ECLIs, the shape of a page whose texts
    // quote the cited ECLI without being that decision.
    const result = await resolveAgainst(searchCaseLaw, 'search-vfgh-gz-joined.json', {
      citation: 'ECLI:AT:VFGH:2026:G13.2025',
    });
    expect(result.found).toBe(false);
    expect(result.record).toBeUndefined();
  });

  it('an unmapped court segment returns found:false listing the mapped ones, with no search', async () => {
    const { result } = await probedCourts({ citation: 'ECLI:AT:UVS:2012:1' });
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "No court this lookup knows uses the ECLI court segment 'UVS' in 'ECLI:AT:UVS:2012:1'. Mapped segments: VFGH, VWGH, OGH/OLG/LG/BG with a court number (Justiz), BVWG, LVWG with a state code (LVWGNI), DSB, PDK, PVAB. Pass court to search that court for the ECLI.",
    });
  });

  it('an unmapped segment with a court hint searches the hinted court', async () => {
    const { courts } = await probedCourts({ citation: 'ECLI:AT:ASG0001:2026:1', court: 'justiz' });
    expect(courts).toEqual(['justiz']);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ query: '"ECLI:AT:ASG0001:2026:1"' });
  });

  it('a mapped segment outranks a conflicting court hint', async () => {
    const { courts } = await probedCourts({
      citation: 'ECLI:AT:VFGH:2026:G13.2025',
      court: 'vwgh',
    });
    expect(courts).toEqual(['vfgh']);
  });

  it('a non-Austrian ECLI returns found:false with no search', async () => {
    const { result } = await probedCourts({ citation: 'ECLI:EU:C:2014:317' });
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "'ECLI:EU:C:2014:317' is not an Austrian ECLI — RIS carries Austrian decisions only, so an ECLI resolves here when it starts 'ECLI:AT:'.",
    });
  });

  it.each(['ECLI:AT:VFGH', 'ECLI:AT:VFGH:26:G13.2025', 'ECLI:AT::2026:G13.2025', 'ECLI:'])(
    'a malformed ECLI "%s" returns found:false with the expected shape, with no search',
    async (citation) => {
      const { result } = await probedCourts({ citation });
      expect(searchCaseLaw).not.toHaveBeenCalled();
      expect(result).toEqual({
        found: false,
        kind: 'case_number',
        guidance: `Could not read an ECLI from '${citation}'. An Austrian ECLI has five colon-separated parts — 'ECLI:AT:VFGH:2026:G13.2025': country, court, decision year, and the court's own identifier. Formats: ris_list_reference topic citation_formats.`,
      });
    },
  );
});

describe('risLookupCitation — a year-first gazette cite reads year and number (#50)', () => {
  it('"BGBl I 2018/24" resolves to BGBl. I Nr. 24/2018', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblauth-24-2018-part1.json', {
      citation: 'BGBl I 2018/24',
    });
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblAuth',
      number: '24/2018',
      part: 'part1',
    });
    expect(result.found).toBe(true);
    expect(result.kind).toBe('gazette');
    expect(documentNumberOf(result)).toBe('BGBLA_2018_I_24');
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (BgblAuth) — number "24/2018", part 1.',
    );
  });

  it('"BGBl. II Nr. 2018/24" resolves to BGBl. II Nr. 24/2018', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblauth-24-2018-part2.json', {
      citation: 'BGBl. II Nr. 2018/24',
    });
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblAuth',
      number: '24/2018',
      part: 'part2',
    });
    expect(documentNumberOf(result)).toBe('BGBLA_2018_II_24');
  });

  it.each([
    ['BGBl. I 2018/1234', { application: 'BgblAuth', number: '1234/2018', part: 'part1' }],
    ['BGBl. Nr. 1005/1994', { application: 'BgblPdf', number: '1005/1994' }],
    ['BGBl. 1961/194', { application: 'BgblPdf', number: '194/1961' }],
    ['RGBl. 1902/189', { application: 'BgblAlt', number: '189/1902' }],
    ['StGBl. 1945/4', { application: 'BgblPdf', number: '4/1945' }],
    ['StGBl. 1919/4', { application: 'BgblAlt', number: '4/1919' }],
    ['GBlÖ 1938/278', { application: 'BgblAlt', number: '278/1938' }],
  ])('"%s" searches %o', async (citation, params) => {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation }),
      ctx,
    );
    expect(result.kind).toBe('gazette');
    expect(searchGazette.mock.calls[0]?.[0]).toEqual(params);
  });

  it('reads a year-first LGBl. cite with a state hint', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'LGBl. 2026/61', state: 'wien' }),
      ctx,
    );
    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'LgblAuth',
      number: '61/2026',
      state: 'wien',
    });
  });

  it('a pair with no four-digit year on either side stays unreadable', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'BGBl. I 24/18' }),
      ctx,
    );
    expect(searchGazette).not.toHaveBeenCalled();
    expect(result.found).toBe(false);
    expect(result.guidance).toMatch(/^Could not read a gazette number from 'BGBl\. I 24\/18'\./);
  });
});

describe('risLookupCitation — the accepted forms are advertised (#50)', () => {
  it('names the court-prefixed, ECLI, and year-first forms in the description and citation field', () => {
    const citationField = risLookupCitation.input.shape.citation.description ?? '';
    for (const surface of [risLookupCitation.description, citationField]) {
      expect(surface).toContain('VfGH G 13/2025');
      expect(surface).toContain('ECLI:AT:VFGH:2026:G13.2025');
      expect(surface).toContain('BGBl I 2018/24');
    }
  });

  // The handler side of both rules is pinned in the #50 court-prefix and ECLI suites above.
  it('states on court that an ECLI’s own segment outranks the hint and a leading court name does not', () => {
    const courtField = risLookupCitation.input.shape.court.description ?? '';
    expect(courtField).toContain('An ECLI’s own court segment takes precedence');
    expect(courtField).toContain('and a leading court name');
  });

  it('names them in the unclassifiable-citation guidance too', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '42/2020' }),
      ctx,
    );
    expect(result.guidance).toContain('VfGH G 13/2025');
    expect(result.guidance).toContain('ECLI:AT:VFGH:2026:G13.2025');
  });
});

describe('risLookupCitation — the case-number, ECLI, and gazette parsers stay linear in the citation length (#49, #50)', () => {
  it.each([
    ['a digit run after a register letter', (n: number) => `G${'1'.repeat(n)}`],
    ['a digit run after a gazette prefix', (n: number) => `BGBl. I Nr. ${'1'.repeat(n)}`],
    ['a digit run before a gazette slash', (n: number) => `BGBl. I ${'1'.repeat(n)}/24`],
    ['a whitespace run after a court prefix', (n: number) => `VfGH${' '.repeat(n)}G 13/2025`],
    ['repeated court prefixes', (n: number) => `${'VfGH '.repeat(Math.floor(n / 5))}G13/2025`],
    ['a whitespace run before a gazette slash', (n: number) => `BGBl. I Nr. 24${' '.repeat(n)}x`],
    [
      'an ECLI with a long identifier',
      (n: number) => `ECLI:AT:VFGH:2026:${'G1.'.repeat(Math.floor(n / 3))}`,
    ],
    ['an ECLI with a long court segment', (n: number) => `ECLI:AT:OGH${'0'.repeat(n)}:2026:G1`],
    ['repeated ECLI openers', (n: number) => 'ECLI:'.repeat(Math.floor(n / 5))],
  ])('%s', async (_shape, build) => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    searchGazette.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, { state: 'wien' });
  });
});

describe('risLookupCitation — the norm and collection parsers stay linear in the citation length', () => {
  /*
   * Each shape made a parser rescan the rest of the citation from every position it tried: a
   * whitespace run behind an abbreviation, a run of section signs, and — since `.` stops at a
   * line break — every § or Artikel cite and the collection rest before a line break the
   * citation carries inside it.
   */
  it.each([
    ['a whitespace run inside a norm cite', 'norm', (n: number) => `A${' '.repeat(n)}x`],
    ['a run of section signs', 'auto', (n: number) => '§'.repeat(n)],
    [
      'repeated section cites before a line break',
      'auto',
      (n: number) => `${'§1 x'.repeat(Math.floor(n / 4))}\ny`,
    ],
    [
      'repeated Artikel cites before a line break',
      'norm',
      (n: number) => `A ${'art1 x '.repeat(Math.floor(n / 7))}\ny`,
    ],
    [
      'a collection cite with a whitespace run before a line break',
      'auto',
      (n: number) => `VwSlg${' '.repeat(n)}\nx\ny`,
    ],
    [
      'a court prefix before a run of spaced digits',
      'auto',
      (n: number) => `VfGH ${'1 '.repeat(Math.floor(n / 2))}`,
    ],
  ] as const)('%s', async (_shape, kind, build) => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, { kind });
  });

  it('reads a line break inside a citation as a space', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '§ 6\nDSG\r\n2000' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      sectionFrom: '6',
      title: 'DSG 2000',
    });
  });
});

describe('risLookupCitation — a "list them" recipe reproduces the search that matched (#64)', () => {
  /**
   * The search-tool call a note or guidance closes with, read the way a caller copies it: the
   * tool name, then `key: value` pairs — a quoted value parsed as JSON, a bare one as a code.
   */
  function recipeOf(text: string | undefined): { input: Record<string, string>; tool: string } {
    const match = /(?:list them with|All matches:) (ris_\w+)(?: (.+))?\.$/.exec(text ?? '');
    if (match?.[1] === undefined) throw new Error(`no search recipe in: ${text}`);
    const input: Record<string, string> = {};
    for (const [, key, value] of (match[2] ?? '').matchAll(/(\w+): ("(?:[^"\\]|\\.)*"|[^,\s]+)/g)) {
      if (key !== undefined && value !== undefined) {
        input[key] = value.startsWith('"') ? (JSON.parse(value) as string) : value;
      }
    }
    return { input, tool: match[1] };
  }

  /** A built upstream request minus its paging — page and page size slice the set, never pick it. */
  function matchedSet({ controller, params }: RisRequest): Record<string, string> {
    const { DokumenteProSeite: _pageSize, Seitennummer: _page, ...filter } = params;
    return { controller, ...filter };
  }

  /**
   * Run the recipe in `text` through its search tool's own input schema and handler, and
   * assert the upstream request it builds selects the same documents as the lookup's last
   * routed search — the one whose total the note counted.
   */
  async function expectRecipeReproduces(text: string | undefined): Promise<void> {
    const { input, tool } = recipeOf(text);
    let lookup: RisRequest;
    let recipe: RisRequest;
    if (tool === 'ris_search_case_law') {
      lookup = buildCaseLawRequest(searchCaseLaw.mock.calls.at(-1)?.[0]);
      searchCaseLaw.mockClear();
      await risSearchCaseLaw.handler(
        risSearchCaseLaw.input.parse(input),
        createMockContext({ errors: risSearchCaseLaw.errors }),
      );
      recipe = buildCaseLawRequest(searchCaseLaw.mock.calls[0]?.[0]);
    } else if (tool === 'ris_search_legislation') {
      lookup = buildLegislationRequest(searchLegislation.mock.calls.at(-1)?.[0]);
      searchLegislation.mockClear();
      await risSearchLegislation.handler(
        risSearchLegislation.input.parse(input),
        createMockContext({ errors: risSearchLegislation.errors }),
      );
      recipe = buildLegislationRequest(searchLegislation.mock.calls[0]?.[0]);
    } else if (tool === 'ris_search_gazette') {
      lookup = buildGazetteRequest(searchGazette.mock.calls.at(-1)?.[0]);
      searchGazette.mockClear();
      await risSearchGazette.handler(
        risSearchGazette.input.parse(input),
        createMockContext({ errors: risSearchGazette.errors }),
      );
      recipe = buildGazetteRequest(searchGazette.mock.calls[0]?.[0]);
    } else {
      throw new Error(`unexpected recipe tool ${tool}`);
    }
    expect(matchedSet(recipe)).toEqual(matchedSet(lookup));
  }

  it('case number: court plus case_number, the court prefix stripped', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-vfgh-g13-2025-both.json', {
      citation: 'VfGH G 13/2025',
    });
    await expectRecipeReproduces(result.resolution_note);
  });

  it('case number: the candidate court that resolved, not the first one probed', async () => {
    searchCaseLaw.mockResolvedValueOnce(zeroHits()).mockResolvedValue(page('search-vfgh.json'));
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '2025-0.934.677' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(result.resolution_note).toContain(
      'list them with ris_search_case_law court: dok, case_number: "2025-0.934.677".',
    );
    await expectRecipeReproduces(result.resolution_note);
  });

  it.each([
    ['VfSlg 19.632/2012', 'search-vfgh.json', 'court: vfgh, collection_number: "19.632"'],
    [
      'VwSlg 8000 A/1971',
      'search-vwgh-collection-span.json',
      'court: vwgh, collection_number: "VwSlg 8000 A*"',
    ],
  ])(
    'Sammlungsnummer %s: court plus the collection_number filter sent',
    async (citation, name, recipe) => {
      const result = await resolveAgainst(searchCaseLaw, name, { citation });
      expect(result.resolution_note).toContain(
        `more matched — list them with ris_search_case_law ${recipe}.`,
      );
      await expectRecipeReproduces(result.resolution_note);
    },
  );

  it('norm: title, the section range and type, and the in-force date applied', async () => {
    const result = await resolveAgainst(searchLegislation, 'search-brkons-celex.json', {
      citation: '§ 6 DSG',
    });
    await expectRecipeReproduces(result.resolution_note);
  });

  it.each([
    [
      { citation: 'Art 10 B-VG', in_force_as_of: '2020-01-01' },
      'search-brkons-bvg-article-10.json',
      'title: "B-VG", section_from: "10", section_to: "10", section_type: Artikel, in_force_as_of: "2020-01-01"',
    ],
    [
      { citation: '§ 1 BO für Wien', in_force_as_of: '2026-10-17', state: 'wien' },
      'search-lrkons-bo-wien-section-1.json',
      'title: "BO für Wien", section_from: "1", section_to: "1", section_type: Paragraph, in_force_as_of: "2026-10-17", scope: wien',
    ],
    [
      { citation: 'ABGB', in_force_as_of: '2026-10-17' },
      'search-brkons-celex.json',
      'title: "ABGB", in_force_as_of: "2026-10-17"',
    ],
  ])('norm %o: an Artikel, a state law, and a bare abbreviation', async (input, name, recipe) => {
    const result = await resolveAgainst(searchLegislation, name, input);
    expect(result.resolution_note).toContain(`list them with ris_search_legislation ${recipe}.`);
    await expectRecipeReproduces(result.resolution_note);
  });

  it.each([
    ['BGBl. II Nr. 171/2026', 'search-bgblauth-celex.json', 'number: "171/2026", part: part2'],
    ['BGBl. I Nr. 165/1999', 'search-bgblpdf-celex.json', 'number: "165/1999", part: part1'],
    ['GBlÖ Nr. 49/1940', 'search-bgblalt.json', 'number: "49/1940"'],
  ])(
    'federal gazette %s: number, plus the part when one was cited',
    async (citation, name, recipe) => {
      const result = await resolveAgainst(searchGazette, name, { citation });
      expect(result.resolution_note).toContain(`list them with ris_search_gazette ${recipe}.`);
      await expectRecipeReproduces(result.resolution_note);
    },
  );

  it('state gazette: number and scope, resolved in LgblAuth', async () => {
    const result = await resolveAgainst(searchGazette, 'search-lgblauth.json', {
      citation: 'LGBl. Nr. 62/2026',
      state: 'salzburg',
    });
    await expectRecipeReproduces(result.resolution_note);
  });

  it('state gazette: number, scope, and state_era legacy when the legacy Lgbl probe resolved', async () => {
    searchGazette.mockResolvedValueOnce(zeroHits()).mockResolvedValue(page('search-lgblauth.json'));
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'LGBl. Nr. 158/2013', state: 'tirol' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    await expectRecipeReproduces(result.resolution_note);
  });

  it('ECLI: court plus the quoted ECLI as query', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-ecli-vfgh-g13-2025.json', {
      citation: 'ECLI:AT:VFGH:2026:G13.2025',
    });
    await expectRecipeReproduces(result.resolution_note);
  });

  it('the VwSlg part-letter collision names the collection_number filter it matched with', async () => {
    const result = await resolveAgainst(searchCaseLaw, 'search-vwgh-collection-span.json', {
      citation: 'VwSlg 8000',
    });
    expect(result.guidance).toMatch(
      /All matches: ris_search_case_law court: vwgh, collection_number: "VwSlg 8000 \*"\.$/,
    );
    await expectRecipeReproduces(result.guidance);
  });

  it('the partless BGBl. collision names the number it matched with', async () => {
    const result = await resolveAgainst(searchGazette, 'search-bgblauth-50-2025.json', {
      citation: 'BGBl. Nr. 50/2025',
    });
    expect(result.guidance).toMatch(/All matches: ris_search_gazette number: "50\/2025"\.$/);
    await expectRecipeReproduces(result.guidance);
  });

  it('a 1945 cite counts only its own series, names the other, and still closes on the recipe (#65)', async () => {
    const base = page('search-bgblpdf-1-1945.json');
    const stgbl = base.hits.find((hit) => hit.documentNumber === '1945_1_0')!;
    searchGazette.mockResolvedValue({ ...base, hits: [...base.hits, stgbl], total: 3 });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'StGBl. Nr. 1/1945' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    expect(result.alternatives_count).toBe(1);
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (BgblPdf) — number "1/1945". Number "1/1945" also names BGBl. Nr. 1/1945, an entry in another gazette series that shares its numbering — not an alternative. 1 more matched — list them with ris_search_gazette number: "1/1945".',
    );
    await expectRecipeReproduces(result.resolution_note);
  });

  it('a cite whose number only another series carries names the search that matched it (#65)', async () => {
    const base = page('search-bgblpdf-1-1945.json');
    const stgblOnly = base.hits.filter((hit) => hit.documentNumber === '1945_1_0');
    searchGazette.mockResolvedValue({ ...base, hits: stgblOnly, total: 1 });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: 'BGBl. Nr. 1/1945' }),
      createMockContext({ errors: risLookupCitation.errors }),
    );
    await expectRecipeReproduces(result.guidance);
  });
});

/** Resolve one citation with no mock queued beyond `beforeEach`'s reset. */
async function lookup(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: risLookupCitation.errors });
  return await risLookupCitation.handler(risLookupCitation.input.parse(input), ctx);
}

const EUR_LEX = 'https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:';
const CASE_LAW_HINT =
  'ris_search_case_law with a court (vfgh, vwgh, bvwg, dsk, or justiz) and norm:';
const RIS_DOES_NOT_CONSOLIDATE = 'RIS does not consolidate EU law, so nothing was searched.';

/**
 * The EU-miss guidance for `label` (the cite as the miss names it), the act it is (`null`: a
 * CELEX the EU-act set does not hold, named alone), and the case-law norm (`null`: no section).
 */
const euMiss = (label: string, act: string | null, celex: string, norm: string | null) =>
  `${label} is EU law: ${act === null ? '' : `${act}, `}CELEX ${celex}. ${RIS_DOES_NOT_CONSOLIDATE} Read it on EUR-Lex: ${EUR_LEX}${celex}.${norm === null ? '' : ` Austrian decisions citing it: ${CASE_LAW_HINT} '${norm}'.`}`;

describe('risLookupCitation — an EU-act cite is decided offline as an EU miss (#67)', () => {
  /*
   * Every search mock resolves a real BrKons page, so a cite that still reached RIS would come
   * back found: true (the old route ranked the DSG hit first for "DSGVO") — the miss below can
   * only come from the offline decision.
   */
  beforeEach(() => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    searchCaseLaw.mockResolvedValue(page('search-brkons-celex.json'));
    searchGazette.mockResolvedValue(page('search-brkons-celex.json'));
  });

  const DSGVO = 'Regulation (EU) 2016/679';
  const CHARTER = 'the Charter of Fundamental Rights of the European Union';
  // [citation, the guidance every hint gets]
  const EU_CITES: ReadonlyArray<[string, string]> = [
    ['DSGVO Art32', euMiss('DSGVO Art 32', DSGVO, '32016R0679', 'DSGVO Art32')],
    ['Art 32 DSGVO', euMiss('DSGVO Art 32', DSGVO, '32016R0679', 'DSGVO Art32')],
    ['GRC Art47', euMiss('GRC Art 47', CHARTER, '12016P/TXT', 'GRC Art47')],
    ['EU-GRC Art8', euMiss('EU-GRC Art 8', CHARTER, '12016P/TXT', 'EU-GRC Art8')],
    [
      'EU-Grundrechte-Charta Art47',
      euMiss('EU-Grundrechte-Charta Art 47', CHARTER, '12016P/TXT', 'EU-Grundrechte-Charta Art47'),
    ],
    [
      'EuGVVO 2012 Art25',
      euMiss(
        'EuGVVO 2012 Art 25',
        'Regulation (EU) No 1215/2012',
        '32012R1215',
        'EuGVVO 2012 Art25',
      ),
    ],
    // Courts cite two regulations as EuGVVO, so EUR-Lex is named without a CELEX.
    [
      'EuGVVO Art5',
      `EuGVVO Art 5 is EU law: Regulation (EC) No 44/2001 or Regulation (EU) No 1215/2012, which courts both cite as EuGVVO. ${RIS_DOES_NOT_CONSOLIDATE} Find the act on EUR-Lex: https://eur-lex.europa.eu. Austrian decisions citing it: ${CASE_LAW_HINT} 'EuGVVO Art5'.`,
    ],
    [
      'EuInsVO 2015 Art6',
      euMiss('EuInsVO 2015 Art 6', 'Regulation (EU) 2015/848', '32015R0848', 'EuInsVO 2015 Art6'),
    ],
    ['EuUVO Art5', euMiss('EuUVO Art 5', 'Regulation (EC) No 4/2009', '32009R0004', 'EuUVO Art5')],
    ['DSGVO', euMiss('DSGVO', DSGVO, '32016R0679', null)],
    ['GRC', euMiss('GRC', CHARTER, '12016P/TXT', null)],
    ['DSGVO ErwGr47', euMiss('DSGVO', DSGVO, '32016R0679', null)],
    ['DSGVO Erwägungsgrund141', euMiss('DSGVO', DSGVO, '32016R0679', null)],
    // The #5 rows that cite the DSGVO with a trailing sub-provision.
    ['DSGVO Art6 Abs1 litc', euMiss('DSGVO Art 6', DSGVO, '32016R0679', 'DSGVO Art6')],
    ['DSGVO Art4 Z2', euMiss('DSGVO Art 4', DSGVO, '32016R0679', 'DSGVO Art4')],
    // Matching is case-insensitive with whitespace collapsed.
    ['dsgvo  art 32', euMiss('dsgvo Art 32', DSGVO, '32016R0679', 'dsgvo Art32')],
  ];

  it.each(EU_CITES)(
    '"%s" returns the same EU miss with no hint, a state hint, or in_force_as_of, and searches nothing',
    async (citation, guidance) => {
      const results = [
        await lookup({ citation }),
        await lookup({ citation, state: 'wien' }),
        await lookup({ citation, in_force_as_of: '2020-01-01' }),
      ];
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(searchCaseLaw).not.toHaveBeenCalled();
      expect(searchGazette).not.toHaveBeenCalled();
      for (const result of results) {
        expect(result).toStrictEqual({ found: false, kind: 'norm', guidance });
      }
    },
  );

  it('pins the whole guidance and its content[] rendering for "DSGVO Art32"', async () => {
    const result = await lookup({ citation: 'DSGVO Art32' });
    const guidance = `DSGVO Art 32 is EU law: Regulation (EU) 2016/679, CELEX 32016R0679. ${RIS_DOES_NOT_CONSOLIDATE} Read it on EUR-Lex: ${EUR_LEX}32016R0679. Austrian decisions citing it: ${CASE_LAW_HINT} 'DSGVO Art32'.`;
    expect(result).toEqual({ found: false, kind: 'norm', guidance });

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toBe(`**found**: false\n**kind**: norm\n\n${guidance}`);
  });

  it('stays a result through the production output parse, under a forced kind: "norm" too', async () => {
    const result = await runToolContract(risLookupCitation, {
      citation: 'DSGVO',
      kind: 'norm',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ found: false, kind: 'norm' });
    expect(searchLegislation).not.toHaveBeenCalled();
  });

  // [citation, its guidance] — a CELEX the EU-act set does not hold names no act.
  const CELEX_LED: ReadonlyArray<[string, string]> = [
    ['32016R0679 DSGVO Art6 Abs1', euMiss('DSGVO Art 6', DSGVO, '32016R0679', 'DSGVO Art6')],
    ['32016R0679 DSGVO', euMiss('DSGVO', DSGVO, '32016R0679', null)],
    [
      '31995L0046 Datenschutz-RL Art7 litf',
      euMiss('Datenschutz-RL Art 7', null, '31995L0046', 'Datenschutz-RL Art7'),
    ],
    [
      '12010P/TXT Grundrechte Charta Art47',
      euMiss('Grundrechte Charta Art 47', null, '12010P/TXT', 'Grundrechte Charta Art47'),
    ],
  ];

  it.each(CELEX_LED)(
    'a leading CELEX "%s" makes an EU miss carrying its own CELEX, with no RIS request',
    async (citation, guidance) => {
      const result = await lookup({ citation });
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(searchCaseLaw).not.toHaveBeenCalled();
      expect(result).toStrictEqual({ found: false, kind: 'norm', guidance });
    },
  );

  it.each([
    ['32016R0679 Art6', 'Art 6'],
    ['32016R0679 Art6 Abs1', 'Art 6'],
    ['32016R0679 § 5 lit a', '§ 5'],
  ])(
    'labels "%s", a CELEX and a bare section, by the CELEX it names',
    async (citation, provision) => {
      const result = await lookup({ citation });
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(result).toEqual({
        found: false,
        kind: 'norm',
        guidance: `${provision} of CELEX 32016R0679 is EU law. ${RIS_DOES_NOT_CONSOLIDATE} Read it on EUR-Lex: ${EUR_LEX}32016R0679.`,
      });
    },
  );

  it.each([
    ['12010E267 AEUV Art267', 'AEUV Art267', 'AEUV', '267'],
    ['12010M004 EUV Art4 Abs3', 'EUV Art4', 'EUV', '4'],
    // The whole-treaty CELEX names the same consolidated treaty.
    ['12012E/TXT AEUV Art267', 'AEUV Art267', 'AEUV', '267'],
    ['12016M/TXT EUV Art6', 'EUV Art6', 'EUV', '6'],
  ])(
    'a TFEU/TEU CELEX "%s" is stripped and resolves exactly as "%s"',
    async (led, plain, title, section) => {
      const ledResult = await lookup({ citation: led });
      const plainResult = await lookup({ citation: plain });
      expect(searchLegislation).toHaveBeenCalledTimes(2);
      expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
        application: 'BrKons',
        inForceAsOf: todayInAustria(),
        pageSize: 100,
        title,
        sectionFrom: section,
        sectionTo: section,
        sectionType: 'Artikel',
      });
      expect(searchLegislation.mock.calls[1]?.[0]).toEqual(searchLegislation.mock.calls[0]?.[0]);
      expect(ledResult).toEqual(plainResult);
      expect(ledResult.found).toBe(true);
    },
  );

  // [citation, the provision it names]
  const PROVISION_ONLY: ReadonlyArray<[string, string]> = [
    ['Art6 Abs1', 'Art 6'],
    ['Art 6 Abs 1 Z 3', 'Art 6'],
    ['§ 5 Abs 1', '§ 5'],
    ['§ 1 lit b', '§ 1'],
    ['§ 6 Abs 1 Z 3', '§ 6'],
    ['§ 6 Abs. 1', '§ 6'],
    ['§6 Z3', '§ 6'],
    ['§ 6 lit. b', '§ 6'],
    // No sub-provision at all: "Art 6" used to search the title "Art 6".
    ['§ 6', '§ 6'],
    ['Art 6', 'Art 6'],
    ['Artikel 10a', 'Art 10a'],
    // Abs and Satz read in any case.
    ['Art6 abs1', 'Art 6'],
    ['Art 6 ABS 1', 'Art 6'],
    ['§ 5 satz 2', '§ 5'],
    ['§ 5 Abs 1 satz 2', '§ 5'],
  ];

  it.each(PROVISION_ONLY)(
    'never reads a sub-provision as the abbreviation — "%s" names %s but no law, with no search',
    async (citation, provision) => {
      const result = await lookup({ citation });
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(result).toEqual({
        found: false,
        kind: 'norm',
        guidance: `'${citation}' names a provision, ${provision}, but no law, so nothing was searched. Add the law's abbreviation: '<abbr> ${provision}'. Formats: ris_list_reference topic citation_formats.`,
      });
    },
  );

  it.each([
    ['§ 3 LitG', 'LitG', '3'],
    ['§ 1 ZPO', 'ZPO', '1'],
    ['§ 2 Z-Gesetz', 'Z-Gesetz', '2'],
  ])(
    'keeps Z and lit case-sensitive — "%s" still searches the law %s',
    async (citation, title, section) => {
      await lookup({ citation });
      expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title, sectionFrom: section });
    },
  );

  it.each(['Abs 1', 'DSG §', 'DSG § Abs 1'])(
    '"%s", which names neither a section nor a law it can read, is reported unread — no search, no title retry',
    async (citation) => {
      const result = await lookup({ citation });
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(result).toEqual({ found: false, kind: 'norm', guidance: UNREADABLE_NORM(citation) });
    },
  );

  it('answers a provision without a law offline under a state hint and in_force_as_of too', async () => {
    const result = await runToolContract(risLookupCitation, {
      citation: 'Art6 Abs1',
      state: 'wien',
      in_force_as_of: '2020-01-01',
    });
    const guidance = `'Art6 Abs1' names a provision, Art 6, but no law, so nothing was searched. Add the law's abbreviation: '<abbr> Art 6'. Formats: ris_list_reference topic citation_formats.`;
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect((result.content[0] as { text: string }).text).toBe(
      `**found**: false\n**kind**: norm\n\n${guidance}`,
    );
  });

  it.each([
    ['AEUV Art267', 'AEUV', '267', 'Artikel'],
    ['EUV Art6', 'EUV', '6', 'Artikel'],
    ['EMRK Art8', 'EMRK', '8', 'Artikel'],
    ['DSG §1', 'DSG', '1', 'Paragraph'],
    ['§ 6 DSG', 'DSG', '6', 'Paragraph'],
    ['EU-JZG §1', 'EU-JZG', '1', 'Paragraph'],
    ['§ 22 Abs 1 DSG', 'DSG', '22', 'Paragraph'],
    ['LitG §3', 'LitG', '3', 'Paragraph'],
  ])('"%s" still routes to RIS unchanged', async (citation, title, section, sectionType) => {
    const result = await lookup({ citation });
    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'BrKons',
      inForceAsOf: todayInAustria(),
      pageSize: 100,
      title,
      sectionFrom: section,
      sectionTo: section,
      sectionType,
    });
    expect(result.found).toBe(true);
  });

  it('a bare non-member that only starts with "EU" still routes to RIS', async () => {
    await lookup({ citation: 'EU-JZG' });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title: 'EU-JZG' });
  });

  it('advertises EMRK Art8 rather than DSGVO Art32, and the EUR-Lex miss, on the tool and in citation_formats', () => {
    const norm = RIS_CITATION_FORMATS.find((format) => format.kind === 'norm')!;
    const formats = [norm.description, norm.resolvesVia, ...norm.examples].join(' ');
    for (const surface of [risLookupCitation.description, formats]) {
      expect(surface).toContain('EMRK Art8');
      expect(surface).not.toContain('DSGVO Art32');
      expect(surface).toContain('returns found: false pointing to EUR-Lex');
    }
    expect(norm.examples).toContain('EMRK Art8');
  });
});

describe('risLookupCitation — a comma-joined norms_cited entry resolves its first provision (#72)', () => {
  const NOTE_HEAD = (today: string, title: string, section: string) =>
    `Resolved via ris_search_legislation (BrKons) — title "${title}", § ${section}, in force ${today}.`;

  it('"DSG §1, §24" searches and resolves exactly what "DSG §1" does, naming DSG §24', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const joined = await lookup({ citation: 'DSG §1, §24' });
    const single = await lookup({ citation: 'DSG §1' });
    const today = todayInAustria();

    expect(searchLegislation).toHaveBeenCalledTimes(2);
    expect(searchLegislation.mock.calls[0]?.[0]).toEqual(searchLegislation.mock.calls[1]?.[0]);
    expect(joined.record).toEqual(single.record);
    expect(joined.alternatives_count).toBe(single.alternatives_count);
    expect(joined.resolution_note).toBe(
      `${NOTE_HEAD(today, 'DSG', '1')} The entry also cites DSG §24 — look it up as its own citation. 76 more matched — list them with ris_search_legislation title: "DSG", section_from: "1", section_to: "1", section_type: Paragraph, in_force_as_of: "${today}".`,
    );
    const text = (risLookupCitation.format!(joined)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(`**resolution_note**: ${joined.resolution_note}`);
  });

  it('names every remaining provision, as written, under a multi-token abbreviation', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({ citation: 'Gemeinsamer Meldestandard-G §5, §112, §113' });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      title: 'Gemeinsamer Meldestandard-G',
      sectionFrom: '5',
      sectionTo: '5',
      sectionType: 'Paragraph',
    });
    expect(result.resolution_note).toContain(
      ' The entry also cites Gemeinsamer Meldestandard-G §112 and Gemeinsamer Meldestandard-G §113 — look each up as its own citation. ',
    );
  });

  it.each([
    ['DSG §1 Abs1, §24 Abs2 Z3', 'DSG', '1', 'Paragraph', 'DSG §24 Abs2 Z3'],
    ['B-VG Art7, Art139 Abs1', 'B-VG', '7', 'Artikel', 'B-VG Art139 Abs1'],
    ['DSG §1,§24', 'DSG', '1', 'Paragraph', 'DSG §24'],
  ])(
    '"%s" keeps each provision’s sub-provisions',
    async (citation, title, section, sectionType, named) => {
      searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
      const result = await lookup({ citation });
      expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
        title,
        sectionFrom: section,
        sectionType,
      });
      expect(result.resolution_note).toContain(
        ` The entry also cites ${named} — look it up as its own citation.`,
      );
    },
  );

  it('a first provision that misses returns its own miss, and the guidance names the rest', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: 'DSG §1, §24, §27' });
    const today = todayInAustria();
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for DSG § 1 in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'DSG', section_from/to: '1', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'DSG*'. State law resolves only with an explicit state hint. The entry also cites DSG §24 and DSG §27 — look each up as its own citation.`,
    });
  });

  it('a first provision naming an EU act returns the EU miss, the rest named, with no RIS request', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({ citation: 'EU-Grundrechte-Charta Art7, Art8, Art52' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `EU-Grundrechte-Charta Art 7 is EU law: the Charter of Fundamental Rights of the European Union, CELEX 12016P/TXT. ${RIS_DOES_NOT_CONSOLIDATE} Read it on EUR-Lex: ${EUR_LEX}12016P/TXT. Austrian decisions citing it: ${CASE_LAW_HINT} 'EU-Grundrechte-Charta Art7'. The entry also cites EU-Grundrechte-Charta Art8 and EU-Grundrechte-Charta Art52 — look each up as its own citation.`,
    });
  });

  it.each([
    // A comma inside a title, not followed by a provision token, stays part of the abbreviation.
    ['Bundesgesetz über A, B und C §5', 'Bundesgesetz über A, B und C', '5'],
    ['Foo, Artenschutz §2', 'Foo, Artenschutz', '2'],
  ])(
    '"%s" reads its title comma as part of the abbreviation, as before',
    async (citation, title, section) => {
      searchLegislation.mockResolvedValue(zeroHits());
      await lookup({ citation });
      expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title, sectionFrom: section });
    },
  );

  it('a comma followed by a word, not a provision, still parses as nothing', async () => {
    const result = await lookup({ citation: 'DSG §1, Artenschutz' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: UNREADABLE_NORM('DSG §1, Artenschutz'),
    });
  });

  it('round-trips the comma-joined entries a real VfGH page emits — norms_cited itself unchanged', async () => {
    const vfgh = page('search-ecli-vfgh-g13-2025.json');
    const record = toCaseLawRecord(vfgh.hits[0]!, 'Vfgh') as { norms_cited: string[] };
    expect(record.norms_cited).toContain('DSG §1, §24, §27');
    expect(record.norms_cited).toContain(
      'GesundheitstelematikG 2012 §2, §24b, §24c, §24d, §24e, §24f, §24g, §24h, §28b',
    );

    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({ citation: 'DSG §1, §24, §27' });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title: 'DSG', sectionFrom: '1' });
    expect(result.resolution_note).toContain(' The entry also cites DSG §24 and DSG §27 — ');
  });
});

describe('risLookupCitation — a trailing "allg" (whole-act reference) is dropped (#67)', () => {
  // [cite with "allg", the same cite without it, the title both search (null: an offline EU miss)]
  it.each([
    ['KO allg', 'KO', 'KO'],
    ['AHVB 1986 allg', 'AHVB 1986', 'AHVB 1986'],
    ['DSGVO allg', 'DSGVO', null],
    ['32016R0679 DSGVO allg', '32016R0679 DSGVO', null],
  ])('"%s" resolves exactly as "%s" does', async (withAllg, plain, title) => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({ citation: withAllg });
    const reference = await lookup({ citation: plain });
    expect(result).toEqual(reference);
    if (title === null) {
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(result).toStrictEqual({
        found: false,
        kind: 'norm',
        guidance: euMiss('DSGVO', 'Regulation (EU) 2016/679', '32016R0679', null),
      });
    } else {
      expect(searchLegislation).toHaveBeenCalledTimes(2);
      expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title });
      expect(searchLegislation.mock.calls[0]?.[0]).not.toHaveProperty('sectionFrom');
      expect(searchLegislation.mock.calls[1]?.[0]).toEqual(searchLegislation.mock.calls[0]?.[0]);
    }
  });

  it('drops it under a forced kind: "norm" too', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    await lookup({ citation: 'KO allg', kind: 'norm' });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title: 'KO' });
  });

  it.each([
    // A law's own "Allg" is capitalized and never the cite's trailing word on its own.
    ['Allg GAG', { title: 'Allg GAG' }],
    ['GdO Allg Krnt 1998', { title: 'GdO Allg Krnt 1998' }],
    ['ABGB Allg', { title: 'ABGB Allg' }],
    // Not a standalone token.
    ['VwRallg', { title: 'VwRallg' }],
    ['EURallg', { title: 'EURallg' }],
    // A cite with a section keeps its own parse.
    ['StGB §28 allg', { title: 'StGB', sectionFrom: '28' }],
  ])('leaves "%s" as written', async (citation, params) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await lookup({ citation });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject(params);
  });
});

describe('risLookupCitation — a recital cite is answered offline (#67)', () => {
  // A cite that still reached RIS would come back found: true from this page.
  beforeEach(() => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
  });

  it.each([
    'ErwGr 47 DSGVO',
    'ErwGr47 DSGVO',
    'Erwägungsgrund 141 DSGVO',
    'Erwaegungsgrund 5 DSGVO',
  ])('section-first "%s" gets the same EU miss as "DSGVO ErwGr47"', async (citation) => {
    const result = await lookup({ citation });
    const reference = await lookup({ citation: 'DSGVO ErwGr47' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toEqual(reference);
    expect(result.guidance).toBe(
      `DSGVO is EU law: Regulation (EU) 2016/679, CELEX 32016R0679. ${RIS_DOES_NOT_CONSOLIDATE} Read it on EUR-Lex: ${EUR_LEX}32016R0679.`,
    );
  });

  it('a section-first recital keeps the EU miss under a state hint', async () => {
    const result = await lookup({ citation: 'ErwGr 47 DSGVO', state: 'wien' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      found: false,
      kind: 'norm',
      guidance: euMiss('DSGVO', 'Regulation (EU) 2016/679', '32016R0679', null),
    });
  });

  // [citation, its act (null: none cited), recital number]
  const RECITALS: ReadonlyArray<[string, string | null, string]> = [
    ['DSRL-PJ ErwGr37', 'DSRL-PJ', '37'],
    ['XYZ ErwGr5', 'XYZ', '5'],
    ['ErwGr 37 DSRL-PJ', 'DSRL-PJ', '37'],
    ['Erwägungsgrund 47', null, '47'],
    ['ErwGr 47', null, '47'],
  ];

  it.each(RECITALS)(
    '"%s" — a recital of an act outside the EU-act set, or of none — searches nothing',
    async (citation, act, recital) => {
      const result = await lookup({ citation });
      expect(searchLegislation).not.toHaveBeenCalled();
      const cited = act === null ? `recital ${recital} but no act` : `recital ${recital} of ${act}`;
      expect(result).toEqual({
        found: false,
        kind: 'norm',
        guidance: `'${citation}' cites ${cited}. Only EU acts carry recitals, and RIS does not consolidate EU law, so nothing was searched. Find the act on EUR-Lex: https://eur-lex.europa.eu.`,
      });
    },
  );

  it('labels a CELEX and a bare recital by the CELEX it names', async () => {
    const result = await lookup({ citation: '32016R0679 ErwGr 82' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result.guidance).toBe(
      `ErwGr 82 of CELEX 32016R0679 is EU law. ${RIS_DOES_NOT_CONSOLIDATE} Read it on EUR-Lex: ${EUR_LEX}32016R0679.`,
    );
  });
});

describe('risLookupCitation — a leading CELEX is read only under kind auto or norm (#67)', () => {
  it('a forced kind: "case_number" searches the citation as given, its leading CELEX kept', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    await lookup({ citation: '32016R0679 Ro 2020/01/0001', kind: 'case_number', court: 'vwgh' });
    expect(searchCaseLaw).toHaveBeenCalledTimes(1);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({
      caseNumber: '32016R0679 Ro 2020/01/0001',
    });
  });

  it('a forced kind: "case_number" never turns an EU case-law CELEX into an offline answer', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const result = await lookup({
      citation: '62014CJ0362 Schrems',
      kind: 'case_number',
      court: 'vwgh',
    });
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ caseNumber: '62014CJ0362 Schrems' });
    expect(result.kind).toBe('case_number');
  });
});

const CJEU_GUIDANCE = (cite: string, court: string, celex: string) =>
  `'${cite}' cites EU case law: a decision of ${court}, CELEX ${celex}. RIS holds Austrian law and decisions only, so nothing was searched. Read it on EUR-Lex: ${EUR_LEX}${celex}.`;

describe('risLookupCitation — a leading EU case-law CELEX is named as an EU court decision (#67)', () => {
  // A cite that still reached RIS would come back found: true from these pages.
  beforeEach(() => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    searchCaseLaw.mockResolvedValue(page('search-vfgh-gz-joined.json'));
    searchGazette.mockResolvedValue(page('search-brkons-celex.json'));
  });

  // Real norms_cited strings (vwgh, justiz): [citation, court named, CELEX]
  const CJEU_CITES: ReadonlyArray<[string, string, string]> = [
    ['62014CJ0362 Schrems', 'the Court of Justice of the European Union', '62014CJ0362'],
    [
      '62021CJ0300 Österreichische Post VORAB',
      'the Court of Justice of the European Union',
      '62021CJ0300',
    ],
    [
      '62009TJ0332 Electrabel / Europäische Kommission',
      'the General Court of the European Union',
      '62009TJ0332',
    ],
  ];

  it.each(CJEU_CITES)(
    '"%s" returns kind unknown naming the court decision, with no RIS request',
    async (citation, court, celex) => {
      const result = await lookup({ citation });
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(searchCaseLaw).not.toHaveBeenCalled();
      expect(searchGazette).not.toHaveBeenCalled();
      expect(result).toEqual({
        found: false,
        kind: 'unknown',
        guidance: CJEU_GUIDANCE(citation, court, celex),
      });
      for (const absent of ['is EU law', 'does not consolidate', 'ris_search_legislation']) {
        expect(result.guidance).not.toContain(absent);
      }
    },
  );

  it('keeps kind: "norm" when the route is forced, with the same guidance', async () => {
    const result = await lookup({ citation: '62014CJ0362 Schrems', kind: 'norm' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: CJEU_GUIDANCE(
        '62014CJ0362 Schrems',
        'the Court of Justice of the European Union',
        '62014CJ0362',
      ),
    });
  });

  it('stays a result through the production output parse, guidance on both surfaces', async () => {
    const result = await runToolContract(risLookupCitation, { citation: '62014CJ0362 Schrems' });
    const guidance = CJEU_GUIDANCE(
      '62014CJ0362 Schrems',
      'the Court of Justice of the European Union',
      '62014CJ0362',
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ found: false, kind: 'unknown', guidance });
    expect((result.content[0] as { text: string }).text).toBe(
      `**found**: false\n**kind**: unknown\n\n${guidance}`,
    );
  });
});

describe('risLookupCitation — the EU-act and comma-joined parsing stays linear in the citation length (#67, #72)', () => {
  it.each([
    ['a leading CELEX before a whitespace run', (n: number) => `32016R0679${' '.repeat(n)}x`],
    ['a comma before a whitespace run', (n: number) => `DSG §1,${' '.repeat(n)}x`],
    [
      'repeated commas before section signs',
      (n: number) => `DSG §1${', §'.repeat(Math.floor(n / 3))}`,
    ],
    [
      'repeated commas before Artikel words',
      (n: number) => `DSG §1${', art '.repeat(Math.floor(n / 6))}`,
    ],
    [
      'repeated comma-joined provisions',
      (n: number) => `DSG §1${', §2'.repeat(Math.floor(n / 4))}`,
    ],
    ['a recital marker after a whitespace run', (n: number) => `DSGVO${' '.repeat(n)}ErwGr`],
    ['repeated recital cites', (n: number) => `DSGVO ${'ErwGr1 x '.repeat(Math.floor(n / 9))}`],
    [
      'repeated sub-provisions after a section',
      (n: number) => `Art6 ${'Abs1 '.repeat(Math.floor(n / 5))}`,
    ],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(Math.floor(n / 4))}\ny`],
    ['breaks throughout', (n: number) => `DSG §1,${'  \r\n'.repeat(Math.floor(n / 4))}§2`],
  ] as const)('%s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {}, 1_250);
  });

  it('a leading CELEX-shaped digit run, across the full 5k–320k span', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution((n) => `32016R${'0'.repeat(n)} DSGVO`, {});
  });

  it.each([
    ['a section before a whitespace run', (n: number) => `§1${' '.repeat(n)}x`],
    [
      'repeated sub-provision openers with no number',
      (n: number) => `§1${' Abs'.repeat(Math.floor(n / 4))}`,
    ],
    ['repeated section signs with no number', (n: number) => `${'§'.repeat(n)} x`],
    [
      'repeated sub-provisions ending in a word',
      (n: number) => `Art6${' Z1'.repeat(Math.floor(n / 3))} x`,
    ],
  ] as const)('a provision without a law: %s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {}, 1_250);
  });

  it('a provision without a law: a section digit run, across the full 5k–320k span', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution((n) => `§${'1'.repeat(n)} Abs`, {});
  });

  it.each([
    [
      'repeated lowercase sub-provisions ending in a word',
      (n: number) => `Art6${' abs1'.repeat(Math.floor(n / 5))} x`,
    ],
    ['a section-first recital before a whitespace run', (n: number) => `ErwGr 1${' '.repeat(n)}x`],
    [
      'repeated section-first recital markers',
      (n: number) => `ErwGr 1 ${'ErwGr 1 '.repeat(Math.floor(n / 8))}`,
    ],
    ['a recital marker before a whitespace run', (n: number) => `ErwGr${' '.repeat(n)}1 x`],
    ['an abbreviation before a whitespace run and "allg"', (n: number) => `KO${' '.repeat(n)}allg`],
    [
      'many abbreviation words before "allg"',
      (n: number) => `${'Ab '.repeat(Math.floor(n / 3))}allg`,
    ],
  ] as const)('%s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {}, 1_250);
  });

  it('a recital digit run, across the full 5k–320k span', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution((n) => `ErwGr ${'1'.repeat(n)} XYZ`, {});
  });
});
