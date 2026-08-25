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
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risLookupCitation } from '@/mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import { toRecord as toCaseLawRecord } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { toRecord as toGazetteRecord } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import {
  risSearchLegislation,
  toRecord as toLegislationRecord,
} from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import { RIS_COURTS } from '@/services/ris/reference/index.js';

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
        "Could not classify '42/2020'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ro 2026/03/0016'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law.",
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
    expect(result.alternatives_count).toBe(76); // total 77 - the one returned hit
    expect(result.resolution_note).toBe(
      `Resolved via ris_search_legislation (BrKons) — title "DSG", § 6, in force ${today}. 76 more matched — list them with ris_search_legislation.`,
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
      title: 'ABGB',
      sectionFrom: '16',
      sectionTo: '16',
      sectionType: 'Paragraph',
      state: 'wien',
    });
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
  // lifted from the two search fixtures (asserted real below).
  const CASES: ReadonlyArray<[string, string, string, 'Paragraph' | 'Artikel']> = [
    // The four shapes from the issue.
    ['DSG §1', 'DSG', '1', 'Paragraph'],
    ['DSG § 1', 'DSG', '1', 'Paragraph'],
    ['DSG §24', 'DSG', '24', 'Paragraph'],
    ['DSGVO Art32', 'DSGVO', '32', 'Artikel'],
    // The dominant real shape — a trailing sub-provision stripped back to the core norm.
    ['DSG §22 Abs1', 'DSG', '22', 'Paragraph'],
    ['DSGVO Art6 Abs1 litc', 'DSGVO', '6', 'Artikel'],
    ['DSGVO Art4 Z2', 'DSGVO', '4', 'Artikel'],
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
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblalt.json')));
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'RGBl. Nr. 189/1902' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchGazette.mock.calls[0]?.[0]).toEqual({
      application: 'BgblAlt',
      number: '189/1902',
    });

    const hit = parseSearchResponse(fixture('search-bgblalt.json')).hits[0]!;
    const expectedRecord = toGazetteRecord(hit, 'BgblAlt');
    expect(result.found).toBe(true);
    expect(result.kind).toBe('gazette');
    expect(result.record).toEqual(expectedRecord);
    expect(result.alternatives_count).toBe(28546); // total 28547 - the one returned hit
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_gazette (BgblAlt) — number "189/1902". 28546 more matched — list them with ris_search_gazette.',
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
      'Resolved via ris_search_gazette (LgblAuth) — number "62/2026", scope: salzburg. 11838 more matched — list them with ris_search_gazette.',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, expectedRecord);
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
      'Resolved via ris_search_gazette (Lgbl) — number "158/2013", scope: tirol, state_era: legacy. 11838 more matched — list them with ris_search_gazette.',
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
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({ caseNumber: 'G 287/2022', court: 'vfgh' });

    const hit = parseSearchResponse(fixture('search-vfgh.json')).hits[0]!;
    const expectedRecord = toCaseLawRecord(hit, 'Vfgh');
    expect(result.found).toBe(true);
    expect(result.kind).toBe('case_number');
    expect(result.record).toEqual(expectedRecord);
    expect(result.alternatives_count).toBe(24056); // total 24057 - the one returned hit
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_case_law (Vfgh) — Geschäftszahl "G 287/2022". 24056 more matched — list them with ris_search_case_law court: vfgh.',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, expectedRecord);
  });

  it('matches a VwGH-shaped Geschäftszahl ("Ra …") and routes to court vwgh', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'Ro 2026/03/0016' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: 'Ro 2026/03/0016',
      court: 'vwgh',
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

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({ caseNumber: '14Os49/26a', court: 'justiz' });
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
    });
    expect(searchCaseLaw.mock.calls[1]?.[0]).toEqual({
      caseNumber: '2025-0.934.677',
      court: 'dok',
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
    });
  });

  it('returns "no matching court" guidance when a forced case_number kind has no recognizable shape and no court hint', async () => {
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
        "No decision for 'not a case number' in no matching court. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.",
    });
    expect(searchCaseLaw).not.toHaveBeenCalled();
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
      'Resolved via ris_search_case_law (Vfgh) — Sammlungsnummer "19.632". 24056 more matched — list them with ris_search_case_law court: vfgh.',
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

describe('risLookupCitation — kind override', () => {
  it('honors an explicit kind: forcing norm on a case-number-shaped citation takes the norm branch instead of auto-classifying it as case_number', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const input = risLookupCitation.input.parse({ citation: 'Ro 2026/03/0016', kind: 'norm' });
    const result = await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for Ro 2026/03/0016 in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'Ro 2026/03/0016', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'Ro 2026/03/0016*'. State law resolves only with an explicit state hint.`,
    });
    // Auto-classification would have routed "Ro 2026/03/0016" to case_number (court vwgh) —
    // the forced kind: 'norm' must bypass that entirely, calling neither search method.
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchLegislation).not.toHaveBeenCalled();
  });
});
