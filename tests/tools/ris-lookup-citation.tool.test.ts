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
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risLookupCitation } from '@/mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import { toRecord as toCaseLawRecord } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { toRecord as toGazetteRecord } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { toRecord as toLegislationRecord } from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';

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
async function captureError(promise: Promise<unknown>): Promise<McpError> {
  const err = await promise.catch((e: unknown) => e);
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
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: '42/2020' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'unknown',
      guidance:
        "Could not classify '42/2020'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ra 2019/22/0184'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law.",
    });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchGazette).not.toHaveBeenCalled();
  });
});

describe('risLookupCitation — norm route', () => {
  it('classifies "§ 6 DSG", routes to searchLegislation with the parsed section, and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext();
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

  it('classifies "Art 10 B-VG" as an Artikel citation and returns found:false with normGuidance on a zero-hit resolution', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext();
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
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for B-VG § 10 in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'B-VG', section_from/to: '10', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'B-VG*'. State law resolves only with an explicit state hint.`,
    });
  });

  it('classifies a bare abbreviation "ABGB" with no section — the zero-hit guidance omits the section clause', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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

  it('resolves to found:false (never throws) when the routed search rejects with InvalidParams', async () => {
    searchLegislation.mockRejectedValue(invalidParams("The 'FassungVom' element is invalid.", {}));
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: '§ 6 DSG' });
    const result = await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for DSG § 6 in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'DSG', section_from/to: '6', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'DSG*'. State law resolves only with an explicit state hint.`,
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

  it.each(
    CASES,
  )('parses "%s" to a norm and routes to searchLegislation with { title: "%s", section: "%s" }', async (citation, title, section, sectionType) => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext();
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
  });

  it('resolves an abbreviation-first citation under an explicit kind: "norm" (the case the live review reported as found:false)', async () => {
    searchLegislation.mockResolvedValue(parseSearchResponse(fixture('search-brkons-celex.json')));
    const ctx = createMockContext();
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
    const ctx = createMockContext();

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
    const ctx = createMockContext();
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
        'No gazette entry for 171/2026 in BgblAuth. Verify part (I/II/III — none before 1997) and year; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number. State gazettes need the state hint.',
    });
  });

  it('routes a pre-2004 federal citation to BgblPdf', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    const ctx = createMockContext();
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
        'No gazette entry for 165/1999 in BgblPdf. Verify part (I/II/III — none before 1997) and year; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number. State gazettes need the state hint.',
    });
  });

  it('routes an imperial citation to BgblAlt regardless of year, and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-bgblalt.json')));
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: 'LGBl. Nr. 61/2026' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'No gazette entry for 61/2026 in a state Landesgesetzblatt. Verify part (I/II/III — none before 1997) and year; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number. State gazettes need the state hint.',
    });
    expect(searchGazette).not.toHaveBeenCalled();
  });

  it('routes an LGBl citation with a state hint to LgblAuth, passing state through, and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchGazette.mockResolvedValue(parseSearchResponse(fixture('search-lgblauth.json')));
    const ctx = createMockContext();
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
      'Resolved via ris_search_gazette (LgblAuth) — number "62/2026". 11838 more matched — list them with ris_search_gazette.',
    );

    const text = (risLookupCitation.format!(result)[0] as { type: 'text'; text: string }).text;
    expectRecordRendered(text, expectedRecord);
  });

  it('classifies as gazette by keyword but returns found:false when the citation has no extractable number', async () => {
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: 'BGBl. ohne Nummer' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      kind: 'gazette',
      guidance:
        'No gazette entry for BGBl. ohne Nummer in the requested gazette tier. Verify part (I/II/III — none before 1997) and year; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number. State gazettes need the state hint.',
    });
    expect(searchGazette).not.toHaveBeenCalled();
  });
});

describe('risLookupCitation — case_number route', () => {
  it('matches a VfGH-shaped Geschäftszahl and resolves (record + resolution_note + alternatives_count + format() parity)', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: 'Ra 2019/22/0184' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: 'Ra 2019/22/0184',
      court: 'vwgh',
    });
    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "No decision for 'Ra 2019/22/0184' in Vwgh. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.",
    });
  });

  it('matches a Justiz-shaped Geschäftszahl ("6Ob56/25k") and routes to court justiz', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: '6Ob56/25k' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({ caseNumber: '6Ob56/25k', court: 'justiz' });
    expect(result).toEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "No decision for '6Ob56/25k' in Justiz. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.",
    });
  });

  it('probes dsk then dok in order for the shared DSB/Dok Geschäftszahl shape, resolving on the second candidate', async () => {
    // The second resolved value is reused generically for its non-empty shape only — the
    // fixture's own embedded court identity is irrelevant to what this test verifies (the
    // probe order and which candidate the resolution settles on).
    searchCaseLaw
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: 'VwSlg 18.000 A/2010' });
    const result = await risLookupCitation.handler(input, ctx);

    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({ collectionNumber: '18.000', court: 'vwgh' });
    expect(result).toEqual({
      found: false,
      kind: 'collection_number',
      guidance:
        'No decision for VwSlg 18.000. Verify the number against the cite; fallback: ris_search_case_law court: vwgh with query.',
    });
  });
});

describe('risLookupCitation — kind override', () => {
  it('honors an explicit kind: forcing norm on a case-number-shaped citation takes the norm branch instead of auto-classifying it as case_number', async () => {
    const ctx = createMockContext();
    const input = risLookupCitation.input.parse({ citation: 'Ra 2019/22/0184', kind: 'norm' });
    const result = await risLookupCitation.handler(input, ctx);
    const today = todayInAustria();

    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: `No document for Ra 2019/22/0184 in force on ${today}. If the provision existed at another time, retry ris_search_legislation with title: 'Ra 2019/22/0184', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'Ra 2019/22/0184*'. State law resolves only with an explicit state hint.`,
    });
    // Auto-classification would have routed "Ra 2019/22/0184" to case_number (court vwgh) —
    // the forced kind: 'norm' must bypass that entirely, calling neither search method.
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchLegislation).not.toHaveBeenCalled();
  });
});
