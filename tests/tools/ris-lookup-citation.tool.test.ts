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

import {
  contentText,
  HOSTILE_TEXT,
  hostileHit as hostileMetadata,
  linkDestinations,
  readCommonMark,
  type ToolResult,
  WEB_URL,
} from './_wire.js';

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

/** The guidance for a citation no route classifies — nothing was searched. */
const UNCLASSIFIED = (citation: string) =>
  `Could not classify '${citation}'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' or year-first 'BGBl I 2018/24' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ro 2026/03/0016', court-prefixed 'VfGH G 13/2025', or an ECLI 'ECLI:AT:VFGH:2026:G13.2025'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law.`;

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

/**
 * The CommonMark read-back of a resolved record's block as format() lays it out, built from the
 * `structuredContent` values: one `**field**: value` line per populated field in record order —
 * array elements joined by ", ", a nested object's string fields as "key value" joined by " · "
 * (a nested URL as a link labelled by its key), a bare URL as a link whose text is the URL — so
 * every value reads back verbatim, in its own field's line, and nothing else renders live.
 */
function recordRead(record: object): string {
  return Object.entries(record)
    .flatMap(([key, value]): string[] => {
      const line = (rendered: string) => [`⟨strong⟩${key}⟨/strong⟩: ${rendered}`];
      if (value === undefined || value === null) return [];
      if (Array.isArray(value)) return value.length === 0 ? [] : line(value.map(String).join(', '));
      if (typeof value === 'object') {
        const parts = Object.entries(value as Record<string, unknown>).flatMap(([sub, item]) =>
          typeof item !== 'string' ? [] : [WEB_URL.test(item) ? `⟨a⟩${sub}⟨/a⟩` : `${sub} ${item}`],
        );
        return parts.length === 0 ? [] : line(parts.join(' · '));
      }
      return line(
        typeof value === 'string' && WEB_URL.test(value) ? `⟨a⟩${value}⟨/a⟩` : String(value),
      );
    })
    .join('\n');
}

/** Every URL a resolved record links, in render order: a bare URL field, then nested ones. */
function recordUrls(record: object): string[] {
  return Object.values(record).flatMap((value): string[] => {
    if (typeof value === 'string') return WEB_URL.test(value) ? [value] : [];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.values(value as Record<string, unknown>).filter(
      (item): item is string => typeof item === 'string' && WEB_URL.test(item),
    );
  });
}

/** The read-back of format()'s "Resolved document" heading, as it precedes the record block. */
const RECORD_HEADING = '⟨heading_open⟩\n\nResolved document\n\n⟨heading_close⟩\n\n';

/**
 * Assert format()'s record block reads back, through a CommonMark parse, as exactly
 * {@link recordRead} of `record` — every populated field in its own line, verbatim, in record
 * order, with nothing added — and that the text links exactly the record's URLs, in order. The
 * block is what follows the "Resolved document" heading, up to an `alternatives_count` trailer.
 */
function expectRecordRendered(text: string, record: object): void {
  const read = readCommonMark(text);
  expect(read).toContain(RECORD_HEADING);
  const block = read
    .slice(read.indexOf(RECORD_HEADING) + RECORD_HEADING.length)
    .replace(/\n\n⟨strong⟩alternatives_count⟨\/strong⟩: \d+$/u, '');
  expect(block).toBe(recordRead(record));
  expect(linkDestinations(text)).toEqual(recordUrls(record));
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
    // A terminal ";" (every VwGH entry of 1995–96 and 2005–06 ends in one), or a "." or ","
    // right after the section number or a sub-provision, is dropped (#73).
    ['AbgEO §53;', 'AbgEO', '53', 'Paragraph'],
    ['AAV §46 Abs6;', 'AAV', '46', 'Paragraph'],
    ['DSG §1.', 'DSG', '1', 'Paragraph'],
    ['B-VG Art7,', 'B-VG', '7', 'Artikel'],
    // A parenthesized sub-provision attached to the section number (#73).
    ['DSG §6(1)', 'DSG', '6', 'Paragraph'],
    ['DSG §6(1a).', 'DSG', '6', 'Paragraph'],
    ['B-VG Art 6(1)', 'B-VG', '6', 'Artikel'],
    // Any sub-provision attached to the section number, the first four verbatim from norms_cited;
    // an uppercase sub-provision keyword never joins the section as its letter (#76).
    ['VfGG §7Abs2', 'VfGG', '7', 'Paragraph'],
    ['DSG 2000 §27Abs1 Z2;', 'DSG 2000', '27', 'Paragraph'],
    ['IPRG §4Abs.1', 'IPRG', '4', 'Paragraph'],
    ['B-VG Art140Abs1 Z1 litd', 'B-VG', '140', 'Artikel'],
    ['ABGB §1330Abs1', 'ABGB', '1330', 'Paragraph'],
    ['DSG §4Z2', 'DSG', '4', 'Paragraph'],
    ['DSG §4lit.a', 'DSG', '4', 'Paragraph'],
    ['GEG §7Satz3', 'GEG', '7', 'Paragraph'],
    ['DSG §6Abs1(2)Z3.', 'DSG', '6', 'Paragraph'],
    ['BienenseuchenG §3aAbs1', 'BienenseuchenG', '3a', 'Paragraph'],
    // A spaced letter joins the section only in lowercase: "Z 2" and an OGH index letter
    // ("ABGB §1330 A") do not; a compact letter does unless it opens a sub-provision (#73).
    ['DSG §4 Z 2', 'DSG', '4', 'Paragraph'],
    ['B-VG Art 6 Z 2', 'B-VG', '6', 'Artikel'],
    ['ABGB §1330 A', 'ABGB', '1330', 'Paragraph'],
    ['ABGB §1330 A;', 'ABGB', '1330', 'Paragraph'],
    ['ABGB §1330A', 'ABGB', '1330A', 'Paragraph'],
    ['ZPO §448 b', 'ZPO', '448b', 'Paragraph'],
    // An ordinal-led abbreviation, with or without a space after the ordinal (#73).
    ['1. COVID-19-JuBG §1', '1. COVID-19-JuBG', '1', 'Paragraph'],
    ['7.ZPMRK Art4', '7.ZPMRK', '4', 'Artikel'],
    // A month word that runs on into a longer word, or a hyphenated one, is part of a title (#73).
    ['5. Maiverordnung §2', '5. Maiverordnung', '2', 'Paragraph'],
    ['1. Mai-Gesetz §2', '1. Mai-Gesetz', '2', 'Paragraph'],
    ['3. Julius-Raab-G §1', '3. Julius-Raab-G', '1', 'Paragraph'],
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

  /*
   * Under kind auto the terminal ";" a norms_cited entry ends in is dropped before classifying,
   * so it reaches the case-number and ECLI routes too: each cite runs its plain form's search
   * and comes back with its plain form's whole result. A forced kind keeps it (#73 suite).
   */
  it.each([
    ['Ro 2026/03/0016;', 'Ro 2026/03/0016', 'search-zero-hits.json'],
    ['G 287/2022;', 'G 287/2022', 'search-vfgh.json'],
    ['ECLI:AT:VFGH:2026:G13.2025;', 'ECLI:AT:VFGH:2026:G13.2025', 'search-ecli-vfgh-g13-2025.json'],
  ])('"%s" runs the search "%s" runs and returns its result', async (citation, plain, name) => {
    searchCaseLaw.mockResolvedValue(page(name));
    const result = await lookup({ citation });
    const reference = await lookup({ citation: plain });
    expect(searchCaseLaw).toHaveBeenCalledTimes(2);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual(searchCaseLaw.mock.calls[1]?.[0]);
    expect(result).toEqual(reference);
    expect(result.kind).toBe('case_number');
  });

  it('a ";"-terminated Geschäftszahl names the plain number on both surfaces', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const result = await runToolContract(risLookupCitation, { citation: 'Ro 2026/03/0016;' });
    const guidance =
      "No decision for 'Ro 2026/03/0016' in Vwgh. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.";
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: 'Ro 2026/03/0016',
      court: 'vwgh',
      pageSize: 100,
    });
    expect(result.structuredContent).toEqual({ found: false, kind: 'case_number', guidance });
    expect(contentText(result)).toBe(`**found**: false\n**kind**: case_number\n\n${guidance}`);
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

  /*
   * A cite carrying a year RIS's abbreviation omits (#78). The AlVG capture is the first four of
   * 102 hits for title "AlVG 1977" (2026-10-24): a regulation without an abbreviation and the AZV
   * ahead of the Arbeitslosenversicherungsgesetz 1977, which RIS files as "AlVG".
   */
  const ALVG = 'NOR40198908';

  it.each(['AlVG 1977', 'AlVG 1977;', 'alvg 1977', 'AlVG  1977 §0'])(
    '"%s" resolves to the AlVG, hit 3 of 102 — the cited abbreviation without its year',
    async (citation) => {
      const result = await resolveAgainst(searchLegislation, 'search-brkons-alvg-1977.json', {
        citation,
        in_force_as_of: '2026-10-24',
      });
      expect(documentNumberOf(result)).toBe(ALVG);
      expect(result.record).toMatchObject({
        abbreviation: 'AlVG',
        short_title: 'Arbeitslosenversicherungsgesetz 1977',
      });
      expect(result.alternatives_count).toBe(101);
    },
  );

  it('a year-stripped resolution reaches both surfaces, the over-cap total named', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-alvg-1977.json'));
    const result = await runToolContract(risLookupCitation, {
      citation: 'AlVG 1977',
      in_force_as_of: '2026-10-24',
    });
    const structured = result.structuredContent as {
      record: { document_number: string };
      resolution_note: string;
    };
    expect(structured.record.document_number).toBe(ALVG);
    expect(structured.resolution_note).toBe(
      'Resolved via ris_search_legislation (BrKons) — title "AlVG 1977", in force 2026-10-24. 101 more matched — list them with ris_search_legislation title: "AlVG 1977", in_force_as_of: "2026-10-24".',
    );
    expect(contentText(result)).toContain(`**document_number**: ${ALVG}`);
    expect(contentText(result)).toContain(`**resolution_note**: ${structured.resolution_note}`);
  });

  it('within the year-stripped rank, an exact section label beats a prefixed one', async () => {
    // The AlVG capture with its "Art. 1 § 1" hit copied, re-labelled "§ 1", and placed last.
    const base = page('search-brkons-alvg-1977.json');
    const prefixed = base.hits[3]!;
    const exact = {
      ...prefixed,
      documentNumber: 'NOR_EXACT_LABEL',
      metadata: { ...prefixed.metadata, sectionLabel: '§ 1' },
    } as typeof prefixed;
    searchLegislation.mockResolvedValue({ ...base, hits: [...base.hits, exact] });
    const result = await lookup({ citation: 'AlVG 1977 §1' });
    expect(documentNumberOf(result)).toBe('NOR_EXACT_LABEL');
  });

  /*
   * Each derived from a capture: [case, cite, page, the labels of a re-labelled copy of the page's
   * own hit, the expected pick]. The re-labelled hit would win if the year were stripped without
   * its checks.
   */
  const YEAR_BOUNDARIES: ReadonlyArray<
    [string, string, string, { abbreviation: string; shortTitle: string }, string]
  > = [
    [
      'an exact abbreviation still beats the cited one without its year',
      '§ 2 EStG 1988',
      'search-brkons-estg-section-2.json',
      { abbreviation: 'EStG', shortTitle: 'Einkommensteuergesetz 1988' },
      'NOR40246516',
    ],
    [
      'a law without the year in its short title is not pulled to it — an older TKG for "TKG 2021"',
      'TKG 2021 §5',
      'search-brkons-estg-section-2.json',
      { abbreviation: 'TKG', shortTitle: 'Telekommunikationsgesetz 2003' },
      'NOR40069297',
    ],
    [
      'a law with the year in its short title is pulled to it',
      'TKG 2021 §5',
      'search-brkons-estg-section-2.json',
      { abbreviation: 'TKG', shortTitle: 'Telekommunikationsgesetz 2021' },
      'NOR_RELABELLED',
    ],
    [
      'a short title with the non-breaking space RIS writes before the year is pulled to it',
      'TKG 2021 §5',
      'search-brkons-estg-section-2.json',
      { abbreviation: 'TKG', shortTitle: 'Telekommunikationsgesetz 2021' },
      'NOR_RELABELLED',
    ],
  ];

  it.each(YEAR_BOUNDARIES)('%s', async (_case, citation, name, labels, expected) => {
    const base = page(name);
    const template = base.hits.find((hit) => hit.documentNumber === 'NOR40246516')!;
    const relabelled = {
      ...template,
      documentNumber: 'NOR_RELABELLED',
      metadata: { ...template.metadata, ...labels },
    } as typeof template;
    // RIS order: the page's first hit, then the re-labelled one, then the rest.
    const [first, ...rest] = base.hits;
    searchLegislation.mockResolvedValue({ ...base, hits: [first!, relabelled, ...rest] });
    const result = await lookup({ citation });
    expect(documentNumberOf(result)).toBe(expected);
  });

  it.each([
    // No hit carries the base abbreviation: RIS order stands.
    [
      'AlVG 1977 on a page without the AlVG',
      'AlVG 1977',
      (hit: RisHit) => !hit.documentNumber.startsWith('NOR40'),
    ],
    // Not a trailing four-digit year: nothing is stripped.
    ['a five-digit number', 'AlVG 19770', () => true],
    ['a three-digit number', 'AlVG 977', () => true],
  ] as const)('%s keeps RIS order', async (_case, citation, keep) => {
    const base = page('search-brkons-alvg-1977.json');
    const hits = base.hits.filter(keep);
    searchLegislation.mockResolvedValue({ ...base, hits });
    const result = await lookup({ citation });
    expect(documentNumberOf(result)).toBe('NOR11009083');
  });

  it('advertises the year-stripped rank on the tool and in citation_formats', () => {
    const norm = RIS_CITATION_FORMATS.find((format) => format.kind === 'norm')!;
    for (const surface of [risLookupCitation.description, norm.resolvesVia]) {
      expect(surface).toContain('("AlVG 1977" → AlVG)');
    }
  });

  it('a year cite with no hit misses with the plain guidance', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: 'AlVG 1977', in_force_as_of: '2026-10-24' });
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance:
        "No document for AlVG 1977 in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: 'AlVG 1977', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'AlVG 1977*'. State law resolves only with an explicit state hint.",
    });
  });

  it('asks RIS for a 100-hit page, so a bare abbreviation ranks past the first 20 titles', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    await risLookupCitation.handler(risLookupCitation.input.parse({ citation: 'UGB' }), ctx);
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ pageSize: 100 });
  });
});

/*
 * A cite ending in a year RIS's title omits matches nothing (#80), so the lookup searches once
 * more without the year. It takes a hit only when that hit's abbreviation is the cited one without
 * the year and the law's original gazette (StammnormBgblnummer) is no later than the cited year,
 * and only for a year no later than the in-force date's. Each second page is a capture of the
 * yearless search in force 2026-10-25; the first page is the zero-hit search the year cite gets.
 */
describe('risLookupCitation — a year RIS’s title omits is dropped after a zero-hit search (#80)', () => {
  const AS_OF = '2026-10-25';

  /** The norm miss guidance for a § cite, naming the cite as written. */
  const normMiss = (abbreviation: string, section: string, date = AS_OF) =>
    `No document for ${abbreviation} § ${section} in force on ${date}. If the provision existed at another time, retry ris_search_legislation with title: '${abbreviation}', section_from/to: '${section}', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: '${abbreviation}*'. State law resolves only with an explicit state hint.`;

  /** The params of every legislation search sent, in order. */
  const sentParams = () => searchLegislation.mock.calls.map(([params]) => params as object);

  /** [cite, cited abbreviation, yearless title, second page, expected pick]. */
  const RESOLVES: ReadonlyArray<[string, string, string, string, string]> = [
    ['VwGVG 2014 §28', 'VwGVG 2014', 'VwGVG', 'search-brkons-vwgvg-section-28.json', 'NOR40196850'],
    [
      'BFA-VG 2014 §21',
      'BFA-VG 2014',
      'BFA-VG',
      'search-brkons-bfa-vg-section-21.json',
      'NOR40278192',
    ],
    ['GSpG 1989 §2', 'GSpG 1989', 'GSpG', 'search-brkons-gspg-section-2.json', 'NOR40217893'],
    [
      'AußStrG 2005 §43',
      'AußStrG 2005',
      'AußStrG',
      'search-brkons-ausstrg-section-43.json',
      'NOR40046671',
    ],
    ['BWG 1993 §70', 'BWG 1993', 'BWG', 'search-brkons-bwg-section-70.json', 'NOR40263581'],
    ['DSG 2000 §1', 'DSG 2000', 'DSG', 'search-brkons-dsg-section-1.json', 'NOR40139563'],
    ['ORF-G 2001', 'ORF-G 2001', 'ORF-G', 'search-brkons-orf-g.json', 'NOR30001521'],
  ];

  it.each(RESOLVES)(
    '"%s" resolves through a second search without the year',
    async (citation, cited, yearless, name, expected) => {
      searchLegislation.mockResolvedValueOnce(zeroHits()).mockResolvedValueOnce(page(name));
      const result = await lookup({ citation, in_force_as_of: AS_OF });

      expect(searchLegislation).toHaveBeenCalledTimes(2);
      const [first, second] = sentParams();
      expect(first).toMatchObject({ inForceAsOf: AS_OF, title: cited });
      expect(second).toEqual({ ...first, title: yearless });
      expect(documentNumberOf(result)).toBe(expected);
      expect(result.record).toMatchObject({ abbreviation: yearless });
    },
  );

  it('puts the exact § label ahead of the lettered ones on the second page too', async () => {
    const bwg = page('search-brkons-bwg-section-70.json');
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce({ ...bwg, hits: [...bwg.hits].reverse() });
    const result = await lookup({ citation: 'BWG 1993 §70', in_force_as_of: AS_OF });
    expect(documentNumberOf(result)).toBe('NOR40263581');
    expect(result.record).toMatchObject({ section_label: '§ 70' });
  });

  it('names the dropped year in resolution_note on both surfaces', async () => {
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(page('search-brkons-vwgvg-section-28.json'));
    const result = await runToolContract(risLookupCitation, {
      citation: 'VwGVG 2014 §28',
      in_force_as_of: AS_OF,
    });
    const note =
      'Resolved via ris_search_legislation (BrKons) — title "VwGVG", § 28, in force 2026-10-25. Title "VwGVG 2014" matched nothing, so the year was dropped.';
    expect(result.structuredContent).toMatchObject({ found: true, resolution_note: note });
    expect(result.structuredContent).not.toHaveProperty('alternatives_count');
    expect(contentText(result)).toContain(`**resolution_note**: ${note}\n`);
  });

  it('lists the alternatives with the title that matched', async () => {
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(page('search-brkons-bwg-section-70.json'));
    const result = await lookup({ citation: 'BWG 1993 §70', in_force_as_of: AS_OF });
    expect(result.alternatives_count).toBe(4);
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_legislation (BrKons) — title "BWG", § 70, in force 2026-10-25. Title "BWG 1993" matched nothing, so the year was dropped. 4 more matched — list them with ris_search_legislation title: "BWG", section_from: "70", section_to: "70", section_type: Paragraph, in_force_as_of: "2026-10-25".',
    );
  });

  it('still names the other cites of a comma-joined entry', async () => {
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(page('search-brkons-vwgvg-section-28.json'));
    const result = await lookup({ citation: 'VwGVG 2014 §28, §29', in_force_as_of: AS_OF });
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_legislation (BrKons) — title "VwGVG", § 28, in force 2026-10-25. Title "VwGVG 2014" matched nothing, so the year was dropped. The entry also cites VwGVG 2014 §29 — look it up as its own citation.',
    );
  });

  /*
   * The second search runs and returns a different law: re-promulgated after the cited year
   * (AVG and VStG 1991, Stammnorm 51/1991 and 52/1991), or filed under the abbreviation plus
   * another year (TKG 2021 beside the TKG-DSVO; WEG 2002, AsylG 2005, UStG 1994, GewO 1994).
   */
  const OTHER_LAWS: ReadonlyArray<[string, string, string, string]> = [
    ['AVG 1950 §1', 'AVG 1950', '1', 'search-brkons-avg-section-1.json'],
    ['VStG 1950 §1', 'VStG 1950', '1', 'search-brkons-vstg-section-1.json'],
    ['TKG 2003 §5', 'TKG 2003', '5', 'search-brkons-tkg-section-5.json'],
    ['WEG 1975 §1', 'WEG 1975', '1', 'search-brkons-weg-section-1.json'],
    ['AsylG 1997 §1', 'AsylG 1997', '1', 'search-brkons-asylg-section-1.json'],
    ['UStG 1972 §1', 'UStG 1972', '1', 'search-brkons-ustg-section-1.json'],
    ['GewO 1973 §1', 'GewO 1973', '1', 'search-brkons-gewo-section-1.json'],
  ];

  it.each(OTHER_LAWS)(
    '"%s" takes nothing from the second search and misses under the cited form',
    async (citation, cited, section, name) => {
      searchLegislation.mockResolvedValueOnce(zeroHits()).mockResolvedValueOnce(page(name));
      const result = await lookup({ citation, in_force_as_of: AS_OF });
      expect(searchLegislation).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ found: false, kind: 'norm', guidance: normMiss(cited, section) });
    },
  );

  it('takes no hit filed under the abbreviation plus another year, whatever its gazette', async () => {
    // Derived from the "TKG 2003 §5" second page: both hits' original gazettes moved before
    // 2003, so only the abbreviation check keeps the TKG 2021 and the TKG-DSVO out.
    const tkg = page('search-brkons-tkg-section-5.json');
    const predated = tkg.hits.map((hit) =>
      hit.metadata.controller === 'Bundesrecht'
        ? { ...hit, metadata: { ...hit.metadata, originalGazetteNumber: '1/2000' } }
        : hit,
    );
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce({ ...tkg, hits: predated });
    const result = await lookup({ citation: 'TKG 2003 §5', in_force_as_of: AS_OF });
    expect(searchLegislation).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ found: false, kind: 'norm', guidance: normMiss('TKG 2003', '5') });
  });

  it('does not search again for a cited year later than the in-force date', async () => {
    // A second search would return the DSG 1978 — abbreviation exactly "DSG", Stammnorm
    // 565/1978, both no later than 2000 — a different law than the DSG 2000 cited.
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(page('search-brkons-dsg-section-1-as-of-1995.json'));
    const result = await lookup({ citation: 'DSG 2000 §1', in_force_as_of: '1995-01-01' });
    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: normMiss('DSG 2000', '1', '1995-01-01'),
    });
  });

  it('never takes a hit that carries no original gazette number', async () => {
    const vwgvg = page('search-brkons-vwgvg-section-28.json');
    const hit = vwgvg.hits[0]!;
    if (hit.metadata.controller !== 'Bundesrecht')
      throw new Error('unreachable — a BrKons capture');
    const unstamped = { ...hit, metadata: { ...hit.metadata, originalGazetteNumber: undefined } };
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce({ ...vwgvg, hits: [unstamped] });
    const result = await lookup({ citation: 'VwGVG 2014 §28', in_force_as_of: AS_OF });
    expect(searchLegislation).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ found: false, kind: 'norm', guidance: normMiss('VwGVG 2014', '28') });
  });

  it('does not retry a search the request builder rejected', async () => {
    searchLegislation.mockRejectedValueOnce(
      validationError('sortBy has no confirmed RIS mapping.', {}),
    );
    const result = await lookup({ citation: 'VwGVG 2014 §28', in_force_as_of: AS_OF });
    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ found: false, kind: 'norm', guidance: normMiss('VwGVG 2014', '28') });
  });

  it('does not retry a zero-hit cite that ends in no year', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: 'VwGVG §28', in_force_as_of: AS_OF });
    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ found: false, kind: 'norm', guidance: normMiss('VwGVG', '28') });
  });

  it.each([
    ['AlVG 1977', 'search-brkons-alvg-1977.json', 'NOR40198908'],
    ['§ 2 EStG 1988', 'search-brkons-estg-section-2.json', 'NOR40246516'],
    ['TKG 2021 §5', 'search-brkons-tkg-section-5.json', 'NOR40238463'],
    ['VwGVG §28', 'search-brkons-vwgvg-section-28.json', 'NOR40196850'],
  ])(
    '"%s", which matches today, sends the one request it sends today',
    async (citation, name, expected) => {
      searchLegislation.mockResolvedValue(page(name));
      const result = await lookup({ citation, in_force_as_of: AS_OF });
      expect(searchLegislation).toHaveBeenCalledTimes(1);
      expect(documentNumberOf(result)).toBe(expected);
      expect(result.resolution_note).not.toContain('the year was dropped');
    },
  );

  it('advertises the yearless second search and its guard on the tool', () => {
    expect(risLookupCitation.description).toContain(
      'a cite whose year matches nothing ("VwGVG 2014 §28") is searched once more without it, taking only the law filed under the cited abbreviation without that year and first promulgated no later than it ("VwGVG 2014" → VwGVG, not "AVG 1950" → the AVG of 1991), for a year no later than in_force_as_of’s',
    );
  });

  it('surfaces a deadline on the second search as upstream_timeout', async () => {
    searchLegislation.mockResolvedValueOnce(zeroHits()).mockRejectedValueOnce(
      timeout('RisService.search:Bundesrecht exceeded its retry deadline.', {
        reason: 'retry_deadline_exceeded',
      }),
    );
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const err = await captureError(
      risLookupCitation.handler(
        risLookupCitation.input.parse({ citation: 'VwGVG 2014 §28', in_force_as_of: AS_OF }),
        ctx,
      ),
    );
    expect(searchLegislation).toHaveBeenCalledTimes(2);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
  });
});

/*
 * Every search one lookup chains runs under a single search budget measured from its first
 * request (#85): the case-number probe of two courts, the LGBl. → Lgbl fallback (#27), and the
 * norm route's yearless retry (#80).
 */
describe('risLookupCitation — the searches one lookup chains share one budget (#85)', () => {
  type SearchMethod = 'searchCaseLaw' | 'searchGazette' | 'searchLegislation';
  const SEARCHES = { searchCaseLaw, searchGazette, searchLegislation };

  /**
   * Route `method` through the real service under a stubbed fetch. Request i (1-based) answers
   * `answers[i - 1]` — a fixture name — after `delayMs`; a request past the list never answers
   * until its signal aborts. Returns the fetch stub.
   */
  async function realSearch(method: SearchMethod, answers: readonly string[], delayMs: number) {
    const actual = await vi.importActual<typeof import('@/services/ris/ris-service.js')>(
      '@/services/ris/ris-service.js',
    );
    const realService = new actual.RisService('ris-austria-mcp-server/test');
    let requests = 0;
    const fetchMock = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const answer = answers[requests];
          requests += 1;
          const timer =
            answer === undefined
              ? undefined
              : setTimeout(() => {
                  resolve(new Response(JSON.stringify(fixture(answer))));
                }, delayMs);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason as Error);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    SEARCHES[method].mockImplementation((params, ctx, budget) =>
      realService[method](params, ctx, budget),
    );
    return fetchMock;
  }

  /** Run `input` through the contract on fake time; resolve with the result and its settle time. */
  async function settle(input: { citation: string; state?: string }) {
    const t0 = Date.now();
    let settledAfterMs = Number.NaN;
    const pending = runToolContract(risLookupCitation, input).then((result) => {
      settledAfterMs = Date.now() - t0;
      return result;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    return { result: await pending, settledAfterMs };
  }

  /*
   * The first search answers, empty, 39 s in — inside its own 40 s attempt timeout and the 48 s
   * budget — and the second never answers. On the shared budget the second gets the 9 s left, so
   * the call settles at 48 s; a fresh budget would carry it to 87 s.
   */
  it.each([
    [
      'the two-court case-number probe',
      'searchCaseLaw',
      { citation: '2025-0.934.677' },
      'Judikatur',
    ],
    [
      'the LGBl. → Lgbl fallback',
      'searchGazette',
      { citation: 'LGBl. Nr. 158/2013', state: 'tirol' },
      'Landesrecht',
    ],
    ['the yearless norm retry', 'searchLegislation', { citation: 'VwGVG 2014 §28' }, 'Bundesrecht'],
  ] as const)(
    '%s settles inside one budget, as upstream_timeout on both surfaces',
    async (_route, method, input, controller) => {
      try {
        const fetchMock = await realSearch(method, ['search-zero-hits.json'], 39_000);
        vi.useFakeTimers();
        const { result, settledAfterMs } = await settle(input);

        const message = `RisService.search:${controller} exceeded its 9000ms retry deadline after 1 attempt.`;
        const hint =
          'RIS did not answer in time — retry the same citation shortly, or pass kind plus a court or state hint so fewer routes are tried.';
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(settledAfterMs).toBe(48_000);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toStrictEqual({
          error: {
            code: JsonRpcErrorCode.Timeout,
            data: { reason: 'upstream_timeout', recovery: { hint }, retryable: true },
            message,
          },
        });
        expect(contentText(result)).toBe(
          `Error: ${message}\n\nRecovery: ${hint}\n\n(reason upstream_timeout · retryable)`,
        );
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it('gives each lookup a budget of its own: two 30 s lookups in a row both resolve', async () => {
    // On one budget across calls, the second lookup would find it spent and fail unsent.
    try {
      const answer = 'search-brkons-dsg-section-6.json';
      const fetchMock = await realSearch('searchLegislation', [answer, answer], 30_000);
      vi.useFakeTimers();
      const first = await settle({ citation: '§ 6 DSG' });
      const second = await settle({ citation: '§ 6 DSG' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const { result, settledAfterMs } of [first, second]) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ found: true, kind: 'norm' });
        expect(settledAfterMs).toBe(30_000);
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a caller cancellation during the second court a cancellation', async () => {
    try {
      const fetchMock = await realSearch('searchCaseLaw', ['search-zero-hits.json'], 39_000);
      vi.useFakeTimers();
      const controller = new AbortController();
      const ctx = createMockContext({
        errors: risLookupCitation.errors,
        signal: controller.signal,
      });
      const pending = captureError(
        risLookupCitation.handler(
          risLookupCitation.input.parse({ citation: '2025-0.934.677' }),
          ctx,
        ),
      );
      await vi.advanceTimersByTimeAsync(40_000);
      // The first court has answered; the second court's request is the one in flight.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      controller.abort();
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(err.message).toMatch(/^fetch GET https:\/\/data\.bka\.gv\.at\/\S* was aborted\.$/u);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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

describe('risLookupCitation — ranking stays linear in the citation length (#48, #78)', () => {
  it.each([
    ['a whitespace run', (n: number) => `G${' '.repeat(n)}13/2025`],
    ['repeated openers with one closer', (n: number) => `G13/2025${'('.repeat(n)})`],
    ['repeated ua suffixes', (n: number) => `G13/2025${' ua'.repeat(Math.floor(n / 3))}`],
  ])('%s', async (_shape, build) => {
    searchCaseLaw.mockResolvedValue(page('search-vfgh-gz-joined.json'));
    await expectLinearResolution(build, { court: 'vfgh', kind: 'case_number' });
  });

  // A norm cite ranked against the AlVG capture, the year-stripped rank in play (#78).
  it.each([
    ['a whitespace run before a year-like word', (n: number) => `AlVG${' '.repeat(n)}1977x §1`],
    ['repeated years', (n: number) => `AlVG${' 1977'.repeat(Math.floor(n / 5))} §1`],
    [
      'one long line of digits ending in a break before a cited year',
      (n: number) => `AlVG ${'1'.repeat(n)}\n1977 §1`,
    ],
    [
      'breaks throughout before a year-like word',
      (n: number) => `AlVG${'  \r\n'.repeat(Math.floor(n / 4))}1977x §1`,
    ],
  ] as const)('%s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(page('search-brkons-alvg-1977.json'));
    await expectLinearResolution(build, {}, 1_250);
  });

  it('a digit run before a cited year, across the full 5k–320k span', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-alvg-1977.json'));
    await expectLinearResolution((n) => `A${'1'.repeat(n)} 1977 §1`, {});
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
  ] as const)('%s', async (_shape, kind, build) => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, { kind });
  });

  // The spaced-digit shape stays below the input size where Bun's regex engine switches modes.
  it('a court prefix before a run of spaced digits', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution((n) => `VfGH ${'1 '.repeat(Math.floor(n / 2))}`, {}, 1_250);
  });

  it('a court prefix before a digit run, across the full 5k–320k span', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution((n) => `VfGH ${'1'.repeat(n)}`, {});
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

/** The EU-miss guidance for an EC Treaty cite (`EG` / `EGV`), which names no CELEX. */
const ecTreatyMiss = (label: string, norm: string | null) =>
  `${label} is EU law: the Treaty establishing the European Community (EC Treaty). ${RIS_DOES_NOT_CONSOLIDATE} Find the act on EUR-Lex: https://eur-lex.europa.eu.${norm === null ? '' : ` Austrian decisions citing it: ${CASE_LAW_HINT} '${norm}'.`}`;

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
    /*
     * The EC Treaty, renumbered at Amsterdam, so named without a CELEX. Before, "EG" searched
     * the title "EG": bare, it resolved to the EC–Switzerland free-movement agreement; with Art
     * 10, to the EC anti-fraud agreement with Switzerland; with Art 175, to the EC–Chile
     * association agreement (2026-10-24).
     */
    ['EG Art234', ecTreatyMiss('EG Art 234', 'EG Art234')],
    ['EG Art 10', ecTreatyMiss('EG Art 10', 'EG Art10')],
    ['EG', ecTreatyMiss('EG', null)],
    ['EGV Art177', ecTreatyMiss('EGV Art 177', 'EGV Art177')],
    ['Art 234 EG', ecTreatyMiss('EG Art 234', 'EG Art234')],
    // The first norm of a ". "-joined entry, the rest named (#76).
    [
      'DSGVO Art6. ZPO §1',
      `${euMiss('DSGVO Art 6', DSGVO, '32016R0679', 'DSGVO Art6')} The entry also cites ZPO §1 — look it up as its own citation.`,
    ],
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

  it('an EC Treaty entry naming several articles misses on both surfaces, naming the rest', async () => {
    const result = await runToolContract(risLookupCitation, { citation: 'EG Art28, Art234' });
    const guidance = `${ecTreatyMiss('EG Art 28', 'EG Art28')} The entry also cites EG Art234 — look it up as its own citation.`;
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(contentText(result)).toBe(`**found**: false\n**kind**: norm\n\n${guidance}`);
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
    /*
     * A pre-Lisbon treaty CELEX (sector 1, E or M, before 2008) names the EC Treaty or an older
     * TEU, which RIS does not consolidate. VwGH ends these entries in ";" — the drop is what lets
     * the terminated form parse at all.
     */
    ['11997E175 EG Art175;', euMiss('EG Art 175', null, '11997E175', 'EG Art175')],
    ['11997E175 EG Art175', euMiss('EG Art 175', null, '11997E175', 'EG Art175')],
    ['11997E234 EG Art234;', euMiss('EG Art 234', null, '11997E234', 'EG Art234')],
    ['12006E234 EG Art234', euMiss('EG Art 234', null, '12006E234', 'EG Art234')],
    ['11957E177 EWGV Art177', euMiss('EWGV Art 177', null, '11957E177', 'EWGV Art177')],
    ['11992M006 EUV Art6', euMiss('EUV Art 6', null, '11992M006', 'EUV Art6')],
    ['11997M/TXT EUV Art6', euMiss('EUV Art 6', null, '11997M/TXT', 'EUV Art6')],
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
    // 2008 is the first post-Lisbon consolidation (OJ C 115), and VwGH ends these in ";" too.
    ['12008E267 AEUV Art267', 'AEUV Art267', 'AEUV', '267'],
    ['12008M004 EUV Art4', 'EUV Art4', 'EUV', '4'],
    ['12010E267 AEUV Art267;', 'AEUV Art267', 'AEUV', '267'],
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
    // A parenthesized Absatz, spaced or attached, and a terminal "." or "," (#73).
    ['Art6(1)', 'Art 6'],
    ['§ 6 (1a)', '§ 6'],
    ['Art 6 Abs 1.', 'Art 6'],
    ['§ 6 Z 2,', '§ 6'],
    ['§ 6 Z. 2', '§ 6'],
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
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
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
      expect(surface).toContain('the EC Treaty as EG');
    }
    expect(norm.resolvesVia).toContain('("11997E175 EG Art175") names the EC Treaty');
    expect(norm.examples).toContain('EMRK Art8');
  });
});

/**
 * The EU-miss guidance for an act cited by its number (`label`, the cite as parsed), which names
 * no act and no CELEX, and the case-law norm (`null`: no section).
 */
const numberedEuMiss = (label: string, norm: string | null) =>
  `${label} is EU law. ${RIS_DOES_NOT_CONSOLIDATE} Find the act on EUR-Lex: https://eur-lex.europa.eu.${norm === null ? '' : ` Austrian decisions citing it: ${CASE_LAW_HINT} '${norm}'.`}`;

describe('risLookupCitation — an EU act cited as "EG-Vertrag" or by its act number is an EU miss (#83)', () => {
  // As in #67: a cite that still reached RIS would come back found: true from this page.
  beforeEach(() => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    searchCaseLaw.mockResolvedValue(page('search-brkons-celex.json'));
    searchGazette.mockResolvedValue(page('search-brkons-celex.json'));
  });

  const GWRL = '6. Geldwäscherichtlinie 2024/1640/EU';
  // [citation, the guidance every hint gets]
  const NUMBERED_CITES: ReadonlyArray<[string, string]> = [
    ['EG-Vertrag Art5', ecTreatyMiss('EG-Vertrag Art 5', 'EG-Vertrag Art5')],
    ['Art 5 EG-Vertrag', ecTreatyMiss('EG-Vertrag Art 5', 'EG-Vertrag Art5')],
    ['EG-VERTRAG Art189', ecTreatyMiss('EG-VERTRAG Art 189', 'EG-VERTRAG Art189')],
    ['EG-Vertrag', ecTreatyMiss('EG-Vertrag', null)],
    ['Art. 3 VO (EG) 178/2002', numberedEuMiss('VO (EG) 178/2002 Art 3', 'VO (EG) 178/2002 Art3')],
    [
      'E Kommission 2002/16/EG Art1;',
      numberedEuMiss('E Kommission 2002/16/EG Art 1', 'E Kommission 2002/16/EG Art1'),
    ],
    ['RL 95/46/EG Art2', numberedEuMiss('RL 95/46/EG Art 2', 'RL 95/46/EG Art2')],
    ['VO (EU) 2016/679 Art6', numberedEuMiss('VO (EU) 2016/679 Art 6', 'VO (EU) 2016/679 Art6')],
    [
      'Richtlinie 2006/123/EG Art 3',
      numberedEuMiss('Richtlinie 2006/123/EG Art 3', 'Richtlinie 2006/123/EG Art3'),
    ],
    [
      `${GWRL} Art1, Art3, Art30`,
      `${numberedEuMiss(`${GWRL} Art 1`, `${GWRL} Art1`)} The entry also cites ${GWRL} Art3 and ${GWRL} Art30 — look each up as its own citation.`,
    ],
    [
      'Verordnung (EU) Nr. 1215/2012 Art 25',
      numberedEuMiss('Verordnung (EU) Nr. 1215/2012 Art 25', 'Verordnung (EU) Nr. 1215/2012 Art25'),
    ],
    [
      'Beschluss Rat 2002/584/Euratom Art2',
      numberedEuMiss('Beschluss Rat 2002/584/Euratom Art 2', 'Beschluss Rat 2002/584/Euratom Art2'),
    ],
    // Case-insensitive, whitespace collapsed.
    ['rl  95/46/eg art 2', numberedEuMiss('rl  95/46/eg Art 2', 'rl  95/46/eg Art2')],
    // Bare: under kind auto these read as norms, never as a VfGH or VwGH case number.
    ['RL 2006/123/EG', numberedEuMiss('RL 2006/123/EG', null)],
    ['VO (EG) 178/2002', numberedEuMiss('VO (EG) 178/2002', null)],
    ['2002/16/EG', numberedEuMiss('2002/16/EG', null)],
    ['(EU) 2016/679', numberedEuMiss('(EU) 2016/679', null)],
    ['Richtlinie 2006/123/EG;', numberedEuMiss('Richtlinie 2006/123/EG', null)],
  ];

  it.each(NUMBERED_CITES)(
    '"%s" returns the same EU miss with no hint, a state hint, or in_force_as_of, and searches nothing',
    async (citation, guidance) => {
      const results = [
        await lookup({ citation }),
        await lookup({ citation, state: 'burgenland' }),
        await lookup({ citation, in_force_as_of: '2020-01-01' }),
        await lookup({ citation, kind: 'norm' }),
      ];
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(searchCaseLaw).not.toHaveBeenCalled();
      expect(searchGazette).not.toHaveBeenCalled();
      for (const result of results) {
        expect(result).toStrictEqual({ found: false, kind: 'norm', guidance });
      }
    },
  );

  it('decides an act number ending in a year before the yearless retry could run (#80)', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: 'Richtlinie (EU) 2019/1158 Art 5' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      found: false,
      kind: 'norm',
      guidance: numberedEuMiss('Richtlinie (EU) 2019/1158 Art 5', 'Richtlinie (EU) 2019/1158 Art5'),
    });
  });

  it('renders a bare act number’s miss on both surfaces', async () => {
    const result = await runToolContract(risLookupCitation, { citation: 'RL 2006/123/EG' });
    const guidance = numberedEuMiss('RL 2006/123/EG', null);
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
    );
  });

  it('takes a bare act number as given under a forced kind: case_number', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: 'RL 2006/123/EG', kind: 'case_number' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(searchCaseLaw).toHaveBeenCalledTimes(1);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toEqual({
      caseNumber: 'RL 2006/123/EG',
      court: 'vfgh',
      pageSize: 100,
    });
    expect(result).toStrictEqual({
      found: false,
      kind: 'case_number',
      guidance:
        "No decision for 'RL 2006/123/EG' in Vfgh. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.",
    });
  });

  it('takes a bare act number as given under a forced kind: gazette', async () => {
    const result = await lookup({ citation: 'RL 2006/123/EG', kind: 'gazette' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(searchGazette).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      found: false,
      kind: 'gazette',
      guidance:
        "Could not read a gazette number from 'RL 2006/123/EG'. A gazette citation needs a number and a year — 'BGBl. I Nr. 165/1999', 'BGBl. Nr. 194/1961', 'RGBl. Nr. 189/1902', or 'LGBl. Nr. 61/2026' with a state hint. Formats: ris_list_reference topic citation_formats. To search without a number, browse with ris_search_gazette published_from/published_to.",
    });
  });

  /*
   * Austrian law whose name holds an EU act number, with the number at the end (after a
   * compound "-RL", or after other words) or at the start: each keeps the search it sent before.
   * [citation, state, title, section, section type]
   */
  it.each([
    ['UmsetzungsG-RL 2014/54/EU §1', undefined, 'UmsetzungsG-RL 2014/54/EU', '1', 'Paragraph'],
    [
      'Entscheidung der Europäischen Kommission zur Festlegung der Bedingungen für RL 94/62/EG Art 1',
      undefined,
      'Entscheidung der Europäischen Kommission zur Festlegung der Bedingungen für RL 94/62/EG',
      '1',
      'Artikel',
    ],
    [
      'Sammelgesetz - Anpassung Richtlinie (EU) 2024/1233 Art 1',
      'burgenland',
      'Sammelgesetz - Anpassung Richtlinie (EU) 2024/1233',
      '1',
      'Artikel',
    ],
    [
      'Richtlinie 2016/801/EU, erforderliche Anpassung Art 1',
      'burgenland',
      'Richtlinie 2016/801/EU, erforderliche Anpassung',
      '1',
      'Artikel',
    ],
    ['Bgld. EU-BA-G §1', 'burgenland', 'Bgld. EU-BA-G', '1', 'Paragraph'],
    ['EU-AHG §1', undefined, 'EU-AHG', '1', 'Paragraph'],
    ['EU-JZG §1', undefined, 'EU-JZG', '1', 'Paragraph'],
    ['Ärztinnen-/Ärzte-EU-VO 2014 §1', undefined, 'Ärztinnen-/Ärzte-EU-VO 2014', '1', 'Paragraph'],
    ['AEUV Art267', undefined, 'AEUV', '267', 'Artikel'],
    ['EUV Art6', undefined, 'EUV', '6', 'Artikel'],
    ['EMRK Art8', undefined, 'EMRK', '8', 'Artikel'],
  ] as const)(
    '"%s" still searches RIS with the same params',
    async (citation, state, title, section, sectionType) => {
      const result = await lookup({ citation, ...(state !== undefined && { state }) });
      expect(searchLegislation).toHaveBeenCalledTimes(1);
      expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
        application: state === undefined ? 'BrKons' : 'LrKons',
        inForceAsOf: todayInAustria(),
        pageSize: 100,
        title,
        sectionFrom: section,
        sectionTo: section,
        sectionType,
        ...(state !== undefined && { state }),
      });
      expect(result.found).toBe(true);
    },
  );

  it('advertises the EC Treaty as EG-Vertrag and the act-number form on the tool and in citation_formats', () => {
    const norm = RIS_CITATION_FORMATS.find((format) => format.kind === 'norm')!;
    for (const surface of [risLookupCitation.description, norm.resolvesVia]) {
      expect(surface).toContain('the EC Treaty as EG, EGV, or EG-Vertrag');
      expect(surface).toContain(
        'an EU act cited by its number ("RL 2006/123/EG", "VO (EG) 178/2002")',
      );
    }
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
    // The #73 shapes inside a comma-joined entry.
    ['DSG §1(1), §24(2)', 'DSG', '1', 'Paragraph', 'DSG §24(2)'],
    ['B-VG Art7 Z 2, Art139;', 'B-VG', '7', 'Artikel', 'B-VG Art139'],
    ['1. COVID-19-JuBG §1, §2', '1. COVID-19-JuBG', '1', 'Paragraph', '1. COVID-19-JuBG §2'],
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

/**
 * The sentence a resolved norm's note carries after its head when the cite's first norm names the
 * version it is read in ("idF …", "aF", "nF"), which the lookup never applies (#82, #86).
 */
const VERSION_NOT_APPLIED = (date: string) =>
  ` The version the cite names was not applied: this is the text in force ${date}. To read that version, pass in_force_as_of a date it was in force.`;

describe('risLookupCitation — a norms_cited entry joining full norms with ". " resolves its first norm (#76)', () => {
  /** The sentence naming the rest, as the note and the guidance append it. */
  const ALSO = (cites: readonly string[]) =>
    ` The entry also cites ${cites.length > 1 ? `${cites.slice(0, -1).join(', ')} and ${cites.at(-1)}` : cites[0]} — look ${cites.length === 1 ? 'it' : 'each'} up as its own citation.`;

  /*
   * [entry, the plain cite its first norm is, the rest as named]. OGH (Justiz) headnotes join
   * full norms with ". ", each naming its own law; the first three entries are verbatim. Each
   * entry has to send the plain cite's search and come back with its whole result, the note
   * naming the rest after the plain note's head — and each named cite, looked up on its own as
   * the note says, has to read as a norm and be searched. A first norm naming its version
   * ('versioned') carries VERSION_NOT_APPLIED before the rest.
   */
  const CHAINS: ReadonlyArray<[string, string, readonly string[], 'versioned'?]> = [
    ['ZPO §179. ZPO §275 Abs2', 'ZPO §179', ['ZPO §275 Abs2']],
    ['EO §379 Abs2 Z5. EO §382 Abs1 Z6. EO §384', 'EO §379', ['EO §382 Abs1 Z6', 'EO §384']],
    [
      'ZPO §271. ZPO §182a. IPRG §3. IPRG §4Abs.1',
      'ZPO §271',
      ['ZPO §182a', 'IPRG §3', 'IPRG §4Abs.1'],
    ],
    // An attached parenthesis on either side, an Artikel, more than one space, a final ";".
    ['ZPO §179(1). ZPO §275 Abs2', 'ZPO §179', ['ZPO §275 Abs2']],
    ['ZPO §179. ZPO §275(1)', 'ZPO §179', ['ZPO §275(1)']],
    ['B-VG Art7.  EMRK Art8', 'B-VG Art7', ['EMRK Art8']],
    ['ZPO §179. ZPO §275 Abs2;', 'ZPO §179', ['ZPO §275 Abs2']],
    // Comma-joined provisions on either side of a ". ", each named as its own cite (#72).
    ['ZPO §179, §180. IPRG §3', 'ZPO §179', ['ZPO §180', 'IPRG §3']],
    ['ZPO §179. IPRG §3, §4 Abs1', 'ZPO §179', ['IPRG §3', 'IPRG §4 Abs1']],
    ['DSG §1, §24. ZPO §1, §2. IPRG §3', 'DSG §1', ['DSG §24', 'ZPO §1', 'ZPO §2', 'IPRG §3']],
    // A "." after a sub-provision keyword, an ordinal, or an abbreviating word is no separator.
    ['ZPO §179 Abs. 1. ZPO §275', 'ZPO §179', ['ZPO §275']],
    ['DSG §4 lit. a. ZPO §1', 'DSG §4', ['ZPO §1']],
    ['B-VG Art. 7. EMRK Art. 8', 'B-VG Art7', ['EMRK Art. 8']],
    ['ZPO §1. 1. COVID-19-JuBG §2', 'ZPO §1', ['1. COVID-19-JuBG §2']],
    [
      'ZPO §1. Bgld. Kinder- und JugendhilfeG 2013 §5',
      'ZPO §1',
      ['Bgld. Kinder- und JugendhilfeG 2013 §5'],
    ],
    // A "." after a sub-provision's value splits, and a law whose name starts with "Satz" leads.
    ['ZPO §1 Satz 2. ZPO §2', 'ZPO §1', ['ZPO §2']],
    ['StGB §28 Z. 1. StGB §29', 'StGB §28', ['StGB §29']],
    [
      'ZPO §1. Satzung der Sbg Gebietskrankenkasse §30',
      'ZPO §1',
      ['Satzung der Sbg Gebietskrankenkasse §30'],
    ],
    // A Satz ends a norm; its ordinal ("2. Satz") or a "." before it ("Abs2. Satz 2") does not.
    ['EO §85 Abs2 2. Satz. EO §86', 'EO §85', ['EO §86']],
    ['ZPO §1 Abs1 2. Satz. ZPO §2', 'ZPO §1', ['ZPO §2']],
    ['EO §85 Abs2. 2. Satz. EO §86', 'EO §85', ['EO §86']],
    ['ZPO §1 Abs2. Satz 2. ZPO §3', 'ZPO §1', ['ZPO §3']],
    [
      'VfGG §57 Abs1 erster Satz. VfGG §62 Abs1 zweiter Satz',
      'VfGG §57',
      ['VfGG §62 Abs1 zweiter Satz'],
    ],
    // A norm ending in the amending act an "idF" names, by gazette number or by name, ends there.
    ['AVG §39a idF 1982/199. AVG §40', 'AVG §39a', ['AVG §40'], 'versioned'],
    ['MRG §23 idF WRN 2000. MRG §24', 'MRG §23', ['MRG §24'], 'versioned'],
    // An ordinal after "idF" leads the amending act's name, inside one norm, on either side.
    ['MRG §16 Abs1 idF 3. WÄG Art 2. ZPO §1', 'MRG §16', ['ZPO §1'], 'versioned'],
    // The clause belongs to the later norm, named as written: the first norm names no version.
    ['ZPO §1. MRG §16 Abs1 idF 3. WÄG Art 2', 'ZPO §1', ['MRG §16 Abs1 idF 3. WÄG Art 2']],
  ];

  it.each(CHAINS)(
    '"%s" sends the search "%s" sends and names the rest',
    async (entry, plain, rest, versioned) => {
      searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
      const chained = await lookup({ citation: entry });
      const single = await lookup({ citation: plain });
      const today = todayInAustria();
      const head = `, in force ${today}.`;
      const version = versioned === undefined ? '' : VERSION_NOT_APPLIED(today);

      expect(searchLegislation).toHaveBeenCalledTimes(2);
      expect(searchLegislation.mock.calls[0]?.[0]).toEqual(searchLegislation.mock.calls[1]?.[0]);
      expect(chained.record).toEqual(single.record);
      expect(chained.alternatives_count).toBe(single.alternatives_count);
      expect(single.resolution_note).toContain(head);
      expect(chained.resolution_note).toBe(
        single.resolution_note!.replace(head, `${head}${version}${ALSO(rest)}`),
      );

      for (const [i, part] of rest.entries()) {
        const own = await lookup({ citation: part });
        expect(own, part).toMatchObject({ found: true, kind: 'norm' });
        expect(own.resolution_note, part).not.toContain('also cites');
        expect(searchLegislation, part).toHaveBeenCalledTimes(3 + i);
      }
    },
  );

  it('a resolution reaches both surfaces, the note naming the rest', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await runToolContract(risLookupCitation, {
      citation: 'ZPO §179. ZPO §275 Abs2',
      in_force_as_of: '2026-10-24',
    });
    const structured = result.structuredContent as { found: boolean; resolution_note: string };
    expect(result.isError).toBeFalsy();
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      title: 'ZPO',
      sectionFrom: '179',
      sectionTo: '179',
      sectionType: 'Paragraph',
    });
    expect(structured.found).toBe(true);
    expect(structured.resolution_note).toMatch(
      /^Resolved via ris_search_legislation \(BrKons\) — title "ZPO", § 179, in force 2026-10-24\. The entry also cites ZPO §275 Abs2 — look it up as its own citation\. /,
    );
    expect(contentText(result)).toContain(`**resolution_note**: ${structured.resolution_note}`);
  });

  it('a first norm that misses returns its own miss on both surfaces, the guidance naming the rest', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await runToolContract(risLookupCitation, {
      citation: 'ZPO §271. ZPO §182a. IPRG §3',
      in_force_as_of: '2026-10-24',
    });
    const guidance = `No document for ZPO § 271 in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: 'ZPO', section_from/to: '271', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'ZPO*'. State law resolves only with an explicit state hint.${ALSO(['ZPO §182a', 'IPRG §3'])}`;
    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
    );
  });

  it.each([
    // Real entries whose ". " belongs to one law's name, or leads no other norm: read as before.
    ['EMRK 7. ZP Art4', 'EMRK 7. ZP', '4', 'Artikel'],
    // The "idF" clause before the section is the version read, not part of the law (#82).
    ['MRG idF 3. WÄG §16 Abs8', 'MRG', '16', 'Paragraph'],
    ['EO §85 Abs2 2. Satz', 'EO', '85', 'Paragraph'],
    [
      'Bgld. Kinder- und JugendhilfeG 2013 §5',
      'Bgld. Kinder- und JugendhilfeG 2013',
      '5',
      'Paragraph',
    ],
    ['XYZ u. a. G §5', 'XYZ u. a. G', '5', 'Paragraph'],
    // An ordinal after "idF" names the amending act, even with a provision on both sides of it.
    ['MRG §16 Abs1 idF 3. WÄG Art 2', 'MRG', '16', 'Paragraph'],
    ['MRG §16 Abs1 idF des 3. WÄG Art 2', 'MRG', '16', 'Paragraph'],
  ] as const)(
    '"%s" stays one norm and names nothing else',
    async (citation, title, section, sectionType) => {
      searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
      const result = await lookup({ citation });
      expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
        title,
        sectionFrom: section,
        sectionType,
      });
      expect(result.found).toBe(true);
      expect(result.resolution_note).not.toContain('also cites');
    },
  );

  it('advertises the ". "-joined form on the tool and in citation_formats', () => {
    const norm = RIS_CITATION_FORMATS.find((format) => format.kind === 'norm')!;
    for (const surface of [risLookupCitation.description, norm.description]) {
      expect(surface).toContain('"ZPO §179. ZPO §275 Abs2"');
    }
  });
});

/**
 * [entry, the plain cite it reads as, the rest as named]. The entry has to send the plain cite's
 * search and come back with its whole result, the note naming the rest after the plain note's
 * head. Shared by the long-title short form (#81) and the version-clause (#82) suites; a
 * `versioned` entry, one naming the version its law is read in, also carries VERSION_NOT_APPLIED
 * after the head, before the rest.
 */
async function expectReadsAsPlain(
  entry: string,
  plain: string,
  rest: readonly string[],
  kind: 'auto' | 'norm' = 'auto',
  versioned = false,
): Promise<void> {
  searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
  const read = await lookup({ citation: entry, kind });
  const single = await lookup({ citation: plain });
  const head = `, in force ${todayInAustria()}.`;
  const version = versioned ? VERSION_NOT_APPLIED(todayInAustria()) : '';
  const also =
    rest.length === 0
      ? ''
      : ` The entry also cites ${rest.length > 1 ? `${rest.slice(0, -1).join(', ')} and ${rest.at(-1)}` : rest[0]} — look ${rest.length === 1 ? 'it' : 'each'} up as its own citation.`;

  expect(searchGazette).not.toHaveBeenCalled();
  expect(searchLegislation).toHaveBeenCalledTimes(2);
  expect(searchLegislation.mock.calls[0]?.[0]).toEqual(searchLegislation.mock.calls[1]?.[0]);
  expect(read.record).toEqual(single.record);
  expect(read).toMatchObject({ found: true, kind: 'norm' });
  expect(single.resolution_note).toContain(head);
  expect(single.resolution_note).not.toContain(VERSION_NOT_APPLIED(todayInAustria()));
  expect(read.resolution_note).toBe(
    single.resolution_note!.replace(head, `${head}${version}${also}`),
  );
}

describe('risLookupCitation — a long title’s " - <short form> §N" is read as the short form (#81)', () => {
  const VO_HMV =
    'Verfahrensordnung zur Herausgabe des Heilmittelverzeichnisses nach §351g ASVG - VO-HMV §29, §32, §34';

  it.each<[string, string, readonly string[]]>([
    ['StaatsanwaltschaftsG - StAG §35 Abs1', 'StAG §35 Abs1', []],
    [VO_HMV, 'VO-HMV §29', ['VO-HMV §32', 'VO-HMV §34']],
    [
      'Verfahrensordnung für parlamentarische Untersuchungsausschüsse - VO-UA §3, §22',
      'VO-UA §3',
      ['VO-UA §22'],
    ],
    ['Übk über die zivilrechtlichen Aspekte int Kindesentführung - HKÜ Art12', 'HKÜ Art12', []],
    // A four-digit year after the short form, as RIS titles carry one ("Jagdgesetz 2004 - TJG 2004").
    ['Tiroler Jagdgesetz 2004 - TJG 2004 §5', 'TJG 2004 §5', []],
    // An en dash, as one entry writes the same title.
    ['Verfahrensordnung für parlamentarische Untersuchungsausschüsse – VO-UA §27', 'VO-UA §27', []],
    // The first norm of a ". "-joined entry; a later one is named as written.
    ['StaatsanwaltschaftsG - StAG §35. ZPO §1', 'StAG §35', ['ZPO §1']],
  ])('"%s" sends the search "%s" sends and names the rest', async (entry, plain, rest) => {
    await expectReadsAsPlain(entry, plain, rest);
  });

  it('a short form that misses names it in the guidance and the retry, the rest under it, on both surfaces', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await runToolContract(risLookupCitation, {
      citation: VO_HMV,
      in_force_as_of: '2026-10-24',
    });
    const guidance =
      "No document for VO-HMV § 29 in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: 'VO-HMV', section_from/to: '29', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'VO-HMV*'. State law resolves only with an explicit state hint. The entry also cites VO-HMV §32 and VO-HMV §34 — look each up as its own citation.";
    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'BrKons',
      inForceAsOf: '2026-10-24',
      pageSize: 100,
      title: 'VO-HMV',
      sectionFrom: '29',
      sectionTo: '29',
      sectionType: 'Paragraph',
    });
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
    );
  });

  it('a resolved short form’s "list them" recipe carries the short form', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({
      citation: 'StaatsanwaltschaftsG - StAG §35 Abs1',
      in_force_as_of: '2026-10-24',
    });
    expect(result.resolution_note).toBe(
      'Resolved via ris_search_legislation (BrKons) — title "StAG", § 35, in force 2026-10-24. 76 more matched — list them with ris_search_legislation title: "StAG", section_from: "35", section_to: "35", section_type: Paragraph, in_force_as_of: "2026-10-24".',
    );
  });

  /*
   * [citation, title, section, sectionType] — today's reading, kept. A " - " not followed by one
   * word and a §/Artikel number, a dash after a text that already ends in a provision (two whole
   * cites joined by a dash), a section-first cite, and a long title with no short form.
   */
  it.each<[string, string, string, 'Artikel' | 'Paragraph']>([
    [
      'Vollstreckungsvertrag Österreich - Jugoslawien betr Schiedssprüche und Schiedsvergleiche Art2 lite',
      'Vollstreckungsvertrag Österreich - Jugoslawien betr Schiedssprüche und Schiedsvergleiche',
      '2',
      'Artikel',
    ],
    ['B-VG Art7 Abs1 / Gesetz - Verwaltungsakt', 'B-VG', '7', 'Artikel'],
    [
      'EG-RL 97/81/EG - Rahmenvereinbarung über Teilzeitarbeit 31997L0081 §4',
      'EG-RL 97/81/EG - Rahmenvereinbarung über Teilzeitarbeit 31997L0081',
      '4',
      'Paragraph',
    ],
    [
      'Verfahrensordnung für parlamentarische Untersuchungsausschüsse - VO- UA §3 Abs3',
      'Verfahrensordnung für parlamentarische Untersuchungsausschüsse - VO- UA',
      '3',
      'Paragraph',
    ],
    [
      'Verfahrensordnung zur Herausgabe des Erstattungskodex nach §351g ASVG - VO-EKO XII. Abschnitt',
      'Verfahrensordnung zur Herausgabe des Erstattungskodex nach',
      '351g',
      'Paragraph',
    ],
    [
      'Verfahrensordnung zur Herausgabe des Erstattungskodex nach §351g ASVG §23, §24',
      'Verfahrensordnung zur Herausgabe des Erstattungskodex nach',
      '351g',
      'Paragraph',
    ],
    ['ASVG §5 - ABGB §1', 'ASVG', '5', 'Paragraph'],
    ['ASVG §5 Abs1 - ABGB §1', 'ASVG', '5', 'Paragraph'],
    ['B-VG Art7 - ABGB §1', 'B-VG Art7 - ABGB', '1', 'Paragraph'],
    ['§ 5 ASVG - ABGB §1', 'ASVG - ABGB §1', '5', 'Paragraph'],
    ['Art 5 B-VG - ABGB §1', 'Art 5 B-VG - ABGB', '1', 'Paragraph'],
    ['§ 35 StaatsanwaltschaftsG - StAG', 'StaatsanwaltschaftsG - StAG', '35', 'Paragraph'],
    ['Long Title - X 12 §5', 'Long Title - X 12', '5', 'Paragraph'],
    ['Long Title - 2010/28 §5', 'Long Title - 2010/28', '5', 'Paragraph'],
  ])('"%s" keeps today’s reading', async (citation, title, section, sectionType) => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation });
    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'BrKons',
      inForceAsOf: todayInAustria(),
      pageSize: 100,
      title,
      sectionFrom: section,
      sectionTo: section,
      sectionType,
    });
    expect(result).toMatchObject({ found: false, kind: 'norm' });
  });

  it('a dash between two whole cites names neither as the other’s short form', async () => {
    await expectReadsAsPlain('ASVG §5 - ABGB §1', 'ASVG §5', []);
  });

  it('a short form with no §/Artikel number stays unclassified, as before', async () => {
    const result = await lookup({ citation: 'StaatsanwaltschaftsG - StAG' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchGazette).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      found: false,
      kind: 'unknown',
      guidance: UNCLASSIFIED('StaatsanwaltschaftsG - StAG'),
    });
  });

  it('advertises the short form on the tool and in citation_formats', () => {
    const norm = RIS_CITATION_FORMATS.find((format) => format.kind === 'norm')!;
    for (const surface of [risLookupCitation.description, norm.description]) {
      expect(surface).toContain('"StaatsanwaltschaftsG - StAG §35"');
    }
  });
});

describe('risLookupCitation — an "idF" clause, "aF", or "nF" is the version read, not part of the law (#82, #86)', () => {
  /*
   * [entry, the plain cite it reads as, the rest as named]. Under kind auto and kind norm, a
   * version note between the law and its §/Artikel number is dropped, and a gazette number inside
   * an "idF" clause, before or after the section, no longer routes the cite to the amending act.
   */
  const VERSIONED: ReadonlyArray<[string, string, readonly string[]]> = [
    ['ABGB idF 2. ErwSchG §254 Abs1', 'ABGB §254 Abs1', []],
    ['WEG idF 3.WÄG §17 Abs2', 'WEG §17 Abs2', []],
    ['JN idF ZVN 1983 §45', 'JN §45', []],
    ['EO idF EO-Nov 2000 §211 Abs5', 'EO §211 Abs5', []],
    ['MRG idF 3. WÄG §16', 'MRG §16', []],
    ['ABGB idF vor dem ErbRÄG 2015 §1487', 'ABGB §1487', []],
    ['ABGB idF des 2. ErwSchG §254', 'ABGB §254', []],
    ['ABGB idF ArtI Z38 KindRÄG 2001 §189 Abs2', 'ABGB §189 Abs2', []],
    ['ABGB aF §140', 'ABGB §140', []],
    ['ZPO nF §502 Abs1', 'ZPO §502 Abs1', []],
    // A gazette number inside the clause, before the section or after it.
    ['ABGB idF BGBl I 2010/28 §988', 'ABGB §988', []],
    ['ABGB idF BGBl. I Nr. 15/2013 §167', 'ABGB §167', []],
    ['ABGB idF DaKRÄG (BGBl I Nr 28/2010) §988', 'ABGB §988', []],
    ['ABGB §167 Abs3 idF BGBl I 2013/15', 'ABGB §167 Abs3', []],
    [
      'Oö LustbarkeitsabgabeG 1979 §14 Abs1 idF LGBl 40/1983',
      'Oö LustbarkeitsabgabeG 1979 §14',
      [],
    ],
    ['B-VG idF BGBl I 2/2008 Art7', 'B-VG Art7', []],
    // Section-first, the clause after the law.
    ['§ 167 ABGB idF BGBl I 2013/15', '§ 167 ABGB', []],
    ['§ 254 ABGB idF 2. ErwSchG', '§ 254 ABGB', []],
    ['Art 7 B-VG idF BGBl I 2/2008', 'Art 7 B-VG', []],
    // The other provisions of a comma-joined entry are named under the plain law.
    ['ABGB idF 2. ErwSchG §254, §255', 'ABGB §254', ['ABGB §255']],
  ];

  it.each(VERSIONED)('"%s" sends the search "%s" sends', async (entry, plain, rest) => {
    await expectReadsAsPlain(entry, plain, rest, 'auto', true);
  });

  it.each(VERSIONED)(
    '"%s" under kind norm sends the search "%s" sends',
    async (entry, plain, rest) => {
      await expectReadsAsPlain(entry, plain, rest, 'norm', true);
    },
  );

  it('a resolved versioned cite says the version was not applied, on both surfaces', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await runToolContract(risLookupCitation, {
      citation: 'ABGB aF §140',
      in_force_as_of: '2026-10-24',
    });
    const structured = result.structuredContent as { found: boolean; resolution_note: string };
    expect(structured.found).toBe(true);
    expect(structured.resolution_note).toBe(
      `Resolved via ris_search_legislation (BrKons) — title "ABGB", § 140, in force 2026-10-24.${VERSION_NOT_APPLIED('2026-10-24')} 76 more matched — list them with ris_search_legislation title: "ABGB", section_from: "140", section_to: "140", section_type: Paragraph, in_force_as_of: "2026-10-24".`,
    );
    expect(contentText(result)).toContain(`**resolution_note**: ${structured.resolution_note}\n`);
  });

  /*
   * [entry, where its version sits, the plain cite it reads as, the rest as named] — a version
   * named after the section, or in the first norm of a ". "-joined entry, is no more applied than
   * one before it. A later provision of a comma-joined entry is named with the clause after it.
   */
  it.each<[string, string, string, readonly string[]]>([
    ['ABGB §180 Abs1 idF KindNamRÄG 2013', 'after the section', 'ABGB §180', []],
    ['BAO §299 idF 2002/I/097', 'after the section, a VwGH-number tail', 'BAO §299', []],
    ['ABGB §140 aF', 'after the section, "aF"', 'ABGB §140', []],
    [
      'MRG §16 Abs1 idF 3. WÄG Art 2',
      'after the section, an ordinal-led amending act',
      'MRG §16',
      [],
    ],
    ['ABGB aF §140, §141', 'in the law of a comma-joined entry', 'ABGB §140', ['ABGB §141']],
    [
      'ABGB §254, §255 idF 2. ErwSchG',
      'after a later provision of a comma-joined entry',
      'ABGB §254',
      ['ABGB §255 idF 2. ErwSchG'],
    ],
    [
      'ASVG §609 Abs19, §615 Abs1 Z4, jeweils idF Sozialrechts-ÄnderungsG 2004',
      'a comma-joined entry whose clause covers each provision',
      'ASVG §609',
      ['ASVG §615 Abs1 Z4, jeweils idF Sozialrechts-ÄnderungsG 2004'],
    ],
  ])(
    '"%s" (%s) sends the search "%s" sends and says the version was not applied',
    async (entry, _where, plain, rest) => {
      await expectReadsAsPlain(entry, plain, rest, 'auto', true);
    },
  );

  /*
   * [entry] — no version named in the first norm's own text: the note says nothing about one. The
   * later norms of a ". "-joined entry carry their own clause into the cite the note names; a word
   * merely containing "aF", "nF", or "idF" is no version.
   */
  it.each([
    ['ZPO §1. MRG §16 Abs1 idF 3. WÄG Art 2'],
    ['ZPO §1. ABGB aF §140'],
    ['ZPO §1. ABGB §254, §255 idF 2. ErwSchG'],
    ['ABGB §140'],
    ['VwGVG §28'],
    ['ABGB §140 aFx'],
    ['ABGB §140 naF'],
    ['ABGB §140 idFx'],
  ])('"%s" names no version of its first norm: no version sentence', async (citation) => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({ citation, in_force_as_of: '2026-10-24' });
    expect(result.found).toBe(true);
    expect(result.resolution_note).not.toContain('was not applied');
  });

  it('a versioned cite whose year matched nothing names both the dropped year and the version', async () => {
    searchLegislation
      .mockResolvedValueOnce(zeroHits())
      .mockResolvedValueOnce(page('search-brkons-vwgvg-section-28.json'));
    const result = await lookup({
      citation: 'VwGVG 2014 idF BGBl I 2018/57 §28',
      in_force_as_of: '2026-10-25',
    });
    expect(result.resolution_note).toBe(
      `Resolved via ris_search_legislation (BrKons) — title "VwGVG", § 28, in force 2026-10-25. Title "VwGVG 2014" matched nothing, so the year was dropped.${VERSION_NOT_APPLIED('2026-10-25')}`,
    );
  });

  it('a versioned cite that misses returns no version sentence: nothing was returned', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: 'ABGB aF §140', in_force_as_of: '2026-10-24' });
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance:
        "No document for ABGB § 140 in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: 'ABGB', section_from/to: '140', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'ABGB*'. State law resolves only with an explicit state hint.",
    });
  });

  it('a versioned cite that misses names the plain law in the guidance and the retry, on both surfaces', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await runToolContract(risLookupCitation, {
      citation: 'ABGB idF BGBl I 2010/28 §988',
      in_force_as_of: '2026-10-24',
    });
    const guidance =
      "No document for ABGB § 988 in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: 'ABGB', section_from/to: '988', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'ABGB*'. State law resolves only with an explicit state hint.";
    expect(searchGazette).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
    );
  });

  it('a resolved versioned cite’s "list them" recipe carries the plain law and the requested date', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({
      citation: 'ABGB idF 2. ErwSchG §254 Abs1',
      in_force_as_of: '2026-10-24',
    });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ inForceAsOf: '2026-10-24' });
    expect(result.resolution_note).toBe(
      `Resolved via ris_search_legislation (BrKons) — title "ABGB", § 254, in force 2026-10-24.${VERSION_NOT_APPLIED('2026-10-24')} 76 more matched — list them with ris_search_legislation title: "ABGB", section_from: "254", section_to: "254", section_type: Paragraph, in_force_as_of: "2026-10-24".`,
    );
  });

  /*
   * [citation, title, section] — today's reading, kept: a clause after the section with a named or
   * VwGH-number tail, which the section tail already drops.
   */
  it.each([
    ['ABGB §180 Abs1 idF KindNamRÄG 2013', 'ABGB', '180'],
    ['BAO §299 idF 2002/I/097', 'BAO', '299'],
  ])('"%s" keeps today’s reading', async (citation, title, section) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await lookup({ citation });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title, sectionFrom: section });
  });

  it.each([
    [
      '2. COVID-19-MaßnahmenV BGBl II 278/2021 idF BGBl II 394/2021 §11 Abs3',
      { application: 'BgblAuth', number: '278/2021', part: 'part2' },
    ],
    [
      '3. Covid-19-MaßnahmenV BGBl II 441/2021 idF BGBl II 459/2021',
      { application: 'BgblAuth', number: '441/2021', part: 'part2' },
    ],
    // The law's own gazette prefix misspelled ("BGBI"), its number still before the clause.
    [
      '4. COVID-19-SchutzmaßnahmenV BGBI II 58/2021 idF BGBl II 111/2021 §2',
      { application: 'BgblAuth', number: '58/2021', part: 'part2' },
    ],
  ])(
    '"%s" names its law by gazette number before the clause: a gazette cite, as before',
    async (citation, params) => {
      searchGazette.mockResolvedValue(zeroHits());
      const result = await lookup({ citation });
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(searchGazette.mock.calls[0]?.[0]).toEqual(params);
      expect(result).toMatchObject({ found: false, kind: 'gazette' });
    },
  );

  /*
   * [entry, the bare law it reads as] — a cite naming no §/Artikel number reads as its law alone,
   * the way the bare abbreviation does (#86); a gazette number in the clause never makes it a
   * gazette cite.
   */
  const PROVISION_FREE: ReadonlyArray<[string, string]> = [
    ['ABGB idF BGBl 1970/342', 'ABGB'],
    ['ASVG idF BGBl I 2013/3', 'ASVG'],
    ['GSVG idF 19.GSVGNov BGBl 19', 'GSVG'],
    ['ABGB idF KindNamRÄG 2013', 'ABGB'],
    ['AVG idF 1982/199', 'AVG'],
  ];

  it.each(PROVISION_FREE)('"%s" reads as "%s" alone', async (entry, law) => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const read = await lookup({ citation: entry });
    const bare = await lookup({ citation: law });
    expect(searchGazette).not.toHaveBeenCalled();
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchLegislation).toHaveBeenCalledTimes(2);
    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'BrKons',
      inForceAsOf: todayInAustria(),
      pageSize: 100,
      title: law,
    });
    expect(searchLegislation.mock.calls[1]?.[0]).toEqual(searchLegislation.mock.calls[0]?.[0]);
    const head = `, in force ${todayInAustria()}.`;
    expect(bare.resolution_note).toContain(head);
    expect(read).toEqual({
      ...bare,
      resolution_note: bare.resolution_note!.replace(
        head,
        `${head}${VERSION_NOT_APPLIED(todayInAustria())}`,
      ),
    });
  });

  it.each(PROVISION_FREE)('"%s" under kind norm reads as "%s" alone', async (entry, law) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await lookup({ citation: entry, kind: 'norm' });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title: law });
  });

  /*
   * [entry, the gazette search it sends, or null for none] — a clause naming the amending act by
   * gazette number, then a Roman-numbered Artikel, cites a provision of that amending act: read as
   * before, a gazette cite under kind auto and unread under kind norm.
   */
  it.each<[string, Record<string, string> | null]>([
    [
      'AngG idF des BG 3.7.1975 BGBl 1975/418 ArtII Abs1',
      { application: 'BgblPdf', number: '418/1975' },
    ],
    [
      'EVKO. AO und AnfO idF IRÄG BGBl 1982/370 ArtX',
      { application: 'BgblPdf', number: '370/1982' },
    ],
    ['TirPGG idF LGBl 1999/1 ArtII', null],
    ['EGVG idF BGBl 1990/356 ArtIX Abs1 Z1', { application: 'BgblPdf', number: '356/1990' }],
    ['AngG idF BGBl 1975/418 Art. IX', { application: 'BgblPdf', number: '418/1975' }],
    ['AngG idF BGBl 1975/418 Art II', { application: 'BgblPdf', number: '418/1975' }],
  ])('"%s" cites an Artikel of the amending act: read as before', async (citation, params) => {
    searchGazette.mockResolvedValue(zeroHits());
    const auto = await lookup({ citation });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(auto).toMatchObject({ found: false, kind: 'gazette' });
    if (params === null) expect(searchGazette).not.toHaveBeenCalled();
    else expect(searchGazette.mock.calls[0]?.[0]).toEqual(params);

    const norm = await lookup({ citation, kind: 'norm' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(norm).toEqual({ found: false, kind: 'norm', guidance: UNREADABLE_NORM(citation) });
  });

  it('a provision-free versioned cite naming an amending act by gazette is no gazette cite on either surface', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await runToolContract(risLookupCitation, {
      citation: 'ABGB idF BGBl 1970/342',
      in_force_as_of: '2026-10-24',
    });
    const guidance =
      "No document for ABGB in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: 'ABGB', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'ABGB*'. State law resolves only with an explicit state hint.";
    expect(searchGazette).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
    );
  });

  it('a municipal plan read in a council resolution’s version is looked up by its name', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({
      citation: 'Bebauungsplan der Stadtgemeinde Klosterneuburg idF des Beschlusses vom 28.02.03',
      in_force_as_of: '2026-10-24',
    });
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({
      title: 'Bebauungsplan der Stadtgemeinde Klosterneuburg',
    });
    expect(result).toMatchObject({ found: false, kind: 'norm' });
  });

  it('a provision-free versioned cite whose law is no bare name stays unclassified, as before', async () => {
    const result = await lookup({
      citation: 'COVID-19 BH Landeck Verordnung Nr. 119/2020 idF 2020/181',
    });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(searchCaseLaw).not.toHaveBeenCalled();
    expect(searchGazette).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      found: false,
      kind: 'unknown',
      guidance: UNCLASSIFIED('COVID-19 BH Landeck Verordnung Nr. 119/2020 idF 2020/181'),
    });
  });

  it('an Artikel number no shape reads, after a clause, is not dropped with it: unread, as before', async () => {
    const citation = 'Berufshaftpflichtversicherung ABHV 2000 idF 2009 Art2.2.1';
    const result = await lookup({ citation });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toEqual({ found: false, kind: 'norm', guidance: UNREADABLE_NORM(citation) });
  });

  it('a leading CELEX names the act without the clause', async () => {
    const result = await lookup({
      citation: '32006L0022 HarmonisierungDV-RL Strassenverkehr idF 32020R1057',
    });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance: euMiss('HarmonisierungDV-RL Strassenverkehr', null, '32006L0022', null),
    });
  });

  it('a cite opening with "idF" names no law before it: the gazette reading stays', async () => {
    searchGazette.mockResolvedValue(zeroHits());
    await lookup({ citation: 'idF BGBl 1/2000 §1' });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(searchGazette.mock.calls[0]?.[0]).toMatchObject({ number: '1/2000' });
  });

  it('advertises the dropped version note on the tool and in citation_formats', () => {
    const norm = RIS_CITATION_FORMATS.find((format) => format.kind === 'norm')!;
    for (const surface of [risLookupCitation.description, norm.description]) {
      expect(surface).toContain('"ABGB idF 2. ErwSchG §254"');
    }
    expect(norm.description).toContain('(resolution_note says the cited version was not applied)');
  });
});

describe('risLookupCitation — a cite reads as its plain form past sub-provisions, terminal punctuation, ordinals, and suspended hyphens (#73, #77)', () => {
  const NORM_PARAMS = (title: string, section?: string, sectionType?: 'Artikel' | 'Paragraph') => ({
    application: 'BrKons',
    inForceAsOf: todayInAustria(),
    pageSize: 100,
    title,
    ...(section !== undefined && { sectionFrom: section, sectionTo: section, sectionType }),
  });

  const SZK = 'Steuer- und Zollkoordination 2004';
  const MILCH = 'Milchwirtschaftsfonds Ausgleichs- und Zuschußsystem 1990';

  /*
   * [citation, its plain form, the law and section both search]. The abbreviation-first shapes
   * sit in the #5 table; these are the section-first and bare ones. Each also has to come back
   * with the plain form's whole result, record and note included; a bare cite, which has no
   * section, has to name the same law its plain form does.
   */
  const PLAIN: ReadonlyArray<[string, string, string, string?, ('Artikel' | 'Paragraph')?]> = [
    ['AlVG 1977;', 'AlVG 1977', 'AlVG 1977'],
    ['Art. 6 (1) B-VG', 'Art 6 B-VG', 'B-VG', '6', 'Artikel'],
    ['Art 6(1) B-VG', 'Art 6 B-VG', 'B-VG', '6', 'Artikel'],
    ['Art. 6 (1) lit. a B-VG', 'Art 6 B-VG', 'B-VG', '6', 'Artikel'],
    ['Art 6 Z 2 B-VG', 'Art 6 B-VG', 'B-VG', '6', 'Artikel'],
    ['§ 6 (1a) DSG', '§ 6 DSG', 'DSG', '6', 'Paragraph'],
    ['§ 6(1) DSG', '§ 6 DSG', 'DSG', '6', 'Paragraph'],
    ['§ 4 Z 2 DSG', '§ 4 DSG', 'DSG', '4', 'Paragraph'],
    ['§ 6 Z. 2 DSG', '§ 6 DSG', 'DSG', '6', 'Paragraph'],
    ['§ 6 Abs. 1 Z. 2 DSG', '§ 6 DSG', 'DSG', '6', 'Paragraph'],
    ['§ 6 Abs. 1 Z. 2 lit. a DSG;', '§ 6 DSG', 'DSG', '6', 'Paragraph'],
    ['1. COVID-19-JuBG', '§ 1 1. COVID-19-JuBG', '1. COVID-19-JuBG'],
    ['§ 1 1. COVID-19-JuBG', '1. COVID-19-JuBG §1', '1. COVID-19-JuBG', '1', 'Paragraph'],
    // A bare title with a suspended hyphen before "und" (#77).
    ['Steuer- und Zollkoordination 2004', 'Steuer- und Zollkoordination 2004 §1', SZK],
    ['Steuer- und Zollkoordination 2004;', 'Steuer- und Zollkoordination 2004 §1', SZK],
    [MILCH, `${MILCH} §1`, MILCH],
    // Unchanged: a suspended-hyphen title with a section already read.
    [`${SZK} §5`, `§ 5 ${SZK}`, SZK, '5', 'Paragraph'],
    // Unchanged: a lowercase spaced letter joins the section, and a "." ending a law stays.
    ['§ 448 b ZPO', '§ 448b ZPO', 'ZPO', '448b', 'Paragraph'],
    ['Art 15 a B-VG', 'Art 15a B-VG', 'B-VG', '15a', 'Artikel'],
    // Unchanged: section-first, a spaced capital joins the section too and never reaches the
    // law; only a Ziffer ("Z 2") is a sub-provision there. The index-letter drop is
    // abbreviation-first only ("ABGB §1330 A" → § 1330).
    ['Art 15 A B-VG', 'Art 15A B-VG', 'B-VG', '15A', 'Artikel'],
    ['§ 1330 A ABGB', '§ 1330A ABGB', 'ABGB', '1330A', 'Paragraph'],
    ['§ 6 DSG.', '§ 6 DSG.', 'DSG.', '6', 'Paragraph'],
  ];

  it.each(PLAIN)(
    '"%s" sends the search "%s" sends',
    async (citation, plain, title, section, sectionType) => {
      searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
      const result = await lookup({ citation });
      const reference = await lookup({ citation: plain });
      expect(searchLegislation.mock.calls[0]?.[0]).toEqual(
        NORM_PARAMS(title, section, sectionType),
      );
      expect(result).toMatchObject({ found: true, kind: 'norm' });
      if (section !== undefined) {
        expect(searchLegislation.mock.calls[1]?.[0]).toEqual(searchLegislation.mock.calls[0]?.[0]);
        expect(result).toEqual(reference);
      } else {
        expect(searchLegislation.mock.calls[1]?.[0]).toMatchObject({ title });
      }
    },
  );

  it('an ordinal-led state regulation reaches its LrKons search and misses with the plain guidance', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const cite = '2. DurchführungsV zum Tir JagdG 2004 §1';
    const result = await lookup({ citation: cite, state: 'tirol', in_force_as_of: '2026-10-24' });
    expect(searchLegislation.mock.calls[0]?.[0]).toEqual({
      application: 'LrKons',
      inForceAsOf: '2026-10-24',
      pageSize: 100,
      title: '2. DurchführungsV zum Tir JagdG 2004',
      sectionFrom: '1',
      sectionTo: '1',
      sectionType: 'Paragraph',
      state: 'tirol',
    });
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance:
        "No document for 2. DurchführungsV zum Tir JagdG 2004 § 1 in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: '2. DurchführungsV zum Tir JagdG 2004', section_from/to: '1', section_type: 'Paragraph', scope: 'tirol', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: '2. DurchführungsV zum Tir JagdG 2004*', scope: 'tirol'.",
    });
  });

  it.each([
    // A day of the month and a month name is a date, never an ordinal-led law.
    '12. Mai',
    '3. Juli 2020',
    '12.Mai',
    '1. Jänner 2021',
    '28. Feber',
    // A hyphen before a word other than "und" suspends nothing, so the bare title names no law.
    'Steuer- Zollkoordination 2004',
  ])('"%s" names no law: unclassified, nothing searched', async (citation) => {
    const result = await lookup({ citation });
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result).toEqual({ found: false, kind: 'unknown', guidance: expect.any(String) });
  });

  it('a date is unclassified on both surfaces, its guidance the plain unknown one', async () => {
    const result = await runToolContract(risLookupCitation, { citation: '3. Juli 2020' });
    const structured = result.structuredContent as { guidance: string };
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ found: false, kind: 'unknown' });
    expect(structured.guidance).toMatch(/^Could not classify '3\. Juli 2020'\./);
    expect(contentText(result)).toBe(
      `**found**: false\n**kind**: unknown\n\n${structured.guidance}`,
    );
  });

  // [citation, kind, the cite the guidance names (default: the citation)]
  it.each<[string, string, string?]>([
    // A date names no law before it.
    ['12. Mai §1', 'auto'],
    ['3. Juli 2020 Art 5', 'auto'],
    ['12. Mai ErwGr 5', 'auto'],
    ['12. Mai', 'norm'],
    ['3. Juli 2020', 'norm'],
    // A section sign with no number, once its ";" is dropped.
    ['DSG §;', 'auto', 'DSG §'],
    // An attached keyword with no value is no sub-provision, nor is a word that only starts like one.
    ['DSG §4Abs', 'auto'],
    ['DSG §4Absatz1', 'auto'],
    ['DSG §4Zx', 'auto'],
    // The part after a ". " names no law with a provision, so nothing reads as a second norm (#76).
    ['ZPO §179. Siehe auch', 'auto'],
    ['ZPO §179. Abs 2', 'auto'],
    ['ZPO §179(1). ZPO', 'auto'],
  ])(
    '"%s" (kind %s) names no law it can read: unread, nothing searched',
    async (citation, kind, read = citation) => {
      const result = await lookup({ citation, kind });
      expect(searchLegislation).not.toHaveBeenCalled();
      expect(result).toEqual({ found: false, kind: 'norm', guidance: UNREADABLE_NORM(read) });
    },
  );

  it('a date after a ". " still splits off, so the norm before it resolves', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await lookup({ citation: 'ZPO §1. 12. Mai §2' });
    expect(searchLegislation).toHaveBeenCalledTimes(1);
    expect(searchLegislation.mock.calls[0]?.[0]).toMatchObject({ title: 'ZPO', sectionFrom: '1' });
    expect(result.resolution_note).toContain('The entry also cites 12. Mai §2');
  });

  it('a miss names the law and section read, not the sub-provision', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await lookup({ citation: '§ 4 Z 2 DSG', in_force_as_of: '2026-10-24' });
    expect(result).toEqual({
      found: false,
      kind: 'norm',
      guidance:
        "No document for DSG § 4 in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: 'DSG', section_from/to: '4', section_type: 'Paragraph', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: 'DSG*'. State law resolves only with an explicit state hint.",
    });
  });

  it('a resolution reaches both surfaces, its note naming the plain cite', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await runToolContract(risLookupCitation, {
      citation: 'Art. 6 (1) B-VG;',
      in_force_as_of: '2026-10-24',
    });
    const structured = result.structuredContent as { found: boolean; resolution_note: string };
    expect(result.isError).toBeFalsy();
    expect(structured.found).toBe(true);
    expect(structured.resolution_note).toMatch(
      /^Resolved via ris_search_legislation \(BrKons\) — title "B-VG", Art 6, in force 2026-10-24\./,
    );
    expect(contentText(result)).toContain(`**resolution_note**: ${structured.resolution_note}`);
  });

  it('a provision without a law in a new shape is answered offline on both surfaces', async () => {
    const result = await runToolContract(risLookupCitation, { citation: 'Art6(1);' });
    const guidance = `'Art6(1)' names a provision, Art 6, but no law, so nothing was searched. Add the law's abbreviation: '<abbr> Art 6'. Formats: ris_list_reference topic citation_formats.`;
    expect(searchLegislation).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
    );
  });

  it('advertises the ordinal-led form and the dropped sub-provisions and ";" on the tool and in citation_formats', () => {
    const norm = RIS_CITATION_FORMATS.find((format) => format.kind === 'norm')!;
    for (const surface of [risLookupCitation.description, norm.description]) {
      expect(surface).toContain('"1. COVID-19-JuBG');
      expect(surface).toContain('"(1)")');
      expect(surface).toContain('a terminal ";"');
    }
    expect(norm.description).toContain('("12. Mai") is a date, never a law');
  });

  it('a suspended-hyphen title classifies as a norm and misses on both surfaces, as a forced norm too', async () => {
    searchLegislation.mockResolvedValue(zeroHits());
    const auto = await runToolContract(risLookupCitation, {
      citation: SZK,
      in_force_as_of: '2026-10-24',
    });
    const forced = await lookup({ citation: SZK, kind: 'norm', in_force_as_of: '2026-10-24' });
    const guidance = `No document for ${SZK} in force on 2026-10-24. If the provision existed at another time, retry ris_search_legislation with title: '${SZK}', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: '${SZK}*'. State law resolves only with an explicit state hint.`;
    expect(auto.structuredContent).toEqual({ found: false, kind: 'norm', guidance });
    expect(readCommonMark(contentText(auto))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: norm\n\n${guidance}`,
    );
    expect(forced).toEqual(auto.structuredContent);
    // Each run searches the cite, then — its year matching nothing — the cite without it (#80).
    const [autoFirst, autoRetry, forcedFirst, forcedRetry] = searchLegislation.mock.calls.map(
      ([params]) => params as object,
    );
    expect(searchLegislation).toHaveBeenCalledTimes(4);
    expect(forcedFirst).toEqual(autoFirst);
    expect(autoRetry).toEqual({ ...autoFirst, title: 'Steuer- und Zollkoordination' });
    expect(forcedRetry).toEqual(autoRetry);
  });

  it('a forced case-number route keeps a terminal ";" as given', async () => {
    searchCaseLaw.mockResolvedValue(zeroHits());
    await lookup({ citation: 'Ro 2026/03/0016;', kind: 'case_number', court: 'vwgh' });
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ caseNumber: 'Ro 2026/03/0016;' });
  });
});

describe('risLookupCitation — a trailing "allg" (whole-act reference) is dropped (#67)', () => {
  // [cite with "allg", the same cite without it, the title both search (null: an offline EU miss)]
  it.each([
    ['KO allg', 'KO', 'KO'],
    ['AHVB 1986 allg', 'AHVB 1986', 'AHVB 1986'],
    ['DSGVO allg', 'DSGVO', null],
    ['32016R0679 DSGVO allg', '32016R0679 DSGVO', null],
    // A terminal ";" goes first, and an ordinal-led abbreviation is a bare one too (#73).
    ['KO allg;', 'KO', 'KO'],
    ['1. COVID-19-JuBG allg', '1. COVID-19-JuBG', '1. COVID-19-JuBG'],
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

describe('risLookupCitation — the EU-act, comma-joined, ". "-joined, short-form, version-note, and sub-provision parsing stays linear in the citation length (#67, #72, #73, #76, #81, #82, #86)', () => {
  it.each([
    [
      'repeated attached parentheses after a section',
      (n: number) => `DSG §1${'(1)'.repeat(Math.floor(n / 3))}x`,
    ],
    [
      'repeated spaced parentheses after a section-first number',
      (n: number) => `§ 1 ${'(1) '.repeat(Math.floor(n / 4))}DSG`,
    ],
    [
      'repeated parentheses after a section with no law',
      (n: number) => `Art6${'(1)'.repeat(Math.floor(n / 3))}x`,
    ],
    [
      'repeated attached "Abs.1" after a section',
      (n: number) => `IPRG §4${'Abs.1'.repeat(Math.floor(n / 5))}!`,
    ],
    [
      'repeated attached "Abs.1" after an Artikel',
      (n: number) => `B-VG Art4${'Abs.1'.repeat(Math.floor(n / 5))}!`,
    ],
    [
      'one long line of attached "Abs.1" ending in a break',
      (n: number) => `IPRG §4${'Abs.1'.repeat(Math.floor(n / 5))}\ny`,
    ],
    [
      'breaks throughout attached "Abs. 1"',
      (n: number) => `IPRG §4${'Abs.\r\n1'.repeat(Math.floor(n / 7))}!`,
    ],
    [
      'unclosed parentheses after a section-first number',
      (n: number) => `§ 1 ${'(1'.repeat(n / 2)} DSG`,
    ],
    [
      'nested parentheses after a section-first number',
      (n: number) => `§ 1 ${'(1'.repeat(Math.floor(n / 4))}${')'.repeat(Math.floor(n / 4))} DSG`,
    ],
    ['repeated spaced "Z" with no number', (n: number) => `§ 1 ${'Z '.repeat(n / 2)}DSG`],
    ['repeated "Z." sub-provisions', (n: number) => `§ 1 ${'Z. 2 '.repeat(n / 5)}x`],
    ['repeated spaced lowercase letters', (n: number) => `DSG §1${' a'.repeat(n / 2)}`],
    [
      'repeated spaced capitals after a section-first number',
      (n: number) => `§ 1 ${'A '.repeat(n / 2)}x`,
    ],
    [
      'repeated section-first numbers before a spaced "Z"',
      (n: number) => '§ 1 Z '.repeat(Math.floor(n / 6)),
    ],
    [
      'repeated Artikel numbers before a spaced capital',
      (n: number) => 'Art 1 A '.repeat(Math.floor(n / 8)),
    ],
    ['a whitespace run after a section-first spaced "Z"', (n: number) => `§ 1 Z${' '.repeat(n)}x`],
    ['repeated ordinals before a law', (n: number) => `${'1. '.repeat(Math.floor(n / 3))}x §1`],
    ['repeated ordinals and nothing else', (n: number) => '1.'.repeat(n / 2)],
    ['a run of semicolons after a section', (n: number) => `AbgEO §53${';'.repeat(n)}x`],
    ['a run of semicolons at the end', (n: number) => `AbgEO §53${';'.repeat(n)}`],
    ['repeated terminal commas', (n: number) => `B-VG Art7${','.repeat(n)}`],
    ['repeated hyphen-space pairs before "und"', (n: number) => `A${'- '.repeat(n / 2)}und`],
    ['repeated suspended-hyphen words', (n: number) => `${'Ab- und '.repeat(Math.floor(n / 8))}Cd`],
    [
      'repeated suspended-hyphen words before a hyphen',
      (n: number) => `${'Ab- und '.repeat(Math.floor(n / 8))}-`,
    ],
    ['repeated dates', (n: number) => '12. Mai '.repeat(Math.floor(n / 8))],
    ['repeated dates before a section', (n: number) => `${'12. Mai '.repeat(Math.floor(n / 8))}§1`],
    [
      'one long line of dates ending in a break',
      (n: number) => `${'12. Mai '.repeat(Math.floor(n / 8))}\n§1`,
    ],
    ['breaks throughout dates', (n: number) => `${'12.\r\nMai \r\n'.repeat(Math.floor(n / 11))}§1`],
    ['repeated ". "-joined norms', (n: number) => 'ZPO §1. '.repeat(Math.floor(n / 8))],
    [
      'repeated words after a ". ", none naming a provision',
      (n: number) => `ZPO §1. ${'a. '.repeat(Math.floor(n / 3))}x`,
    ],
    [
      'repeated sub-provision keywords before a "."',
      (n: number) => `ZPO §1 ${'Abs. '.repeat(Math.floor(n / 5))}x`,
    ],
    ['repeated ". " with no law after', (n: number) => `ZPO §1${'. '.repeat(n / 2)}x`],
    ['repeated "§1. "', (n: number) => '§1. '.repeat(n / 4)],
    [
      'repeated ordinals after a ". "',
      (n: number) => `ZPO §1. ${'1. '.repeat(Math.floor(n / 3))}x §2`,
    ],
    [
      'repeated section signs with no number after a ". "',
      (n: number) => `ZPO §1. x${' §'.repeat(n / 2)}`,
    ],
    [
      'a whitespace run before a section sign with no number, after a ". "',
      (n: number) => `ZPO §1. x${' '.repeat(n)}§`,
    ],
    [
      'one long line of ". "-joined norms ending in a break',
      (n: number) => `${'ZPO §1. '.repeat(Math.floor(n / 8))}\ny`,
    ],
    [
      'breaks throughout a ". "-joined entry',
      (n: number) => `${'ZPO §1.  \r\n'.repeat(Math.floor(n / 10))}ZPO §2`,
    ],
    [
      'repeated norms ending in "2. Satz"',
      (n: number) => 'EO §85 Abs2 2. Satz. '.repeat(Math.floor(n / 21)),
    ],
    [
      'one long line of norms ending in "2. Satz", ending in a break',
      (n: number) => `${'EO §85 Abs2 2. Satz. '.repeat(Math.floor(n / 21))}\ny`,
    ],
    [
      'breaks throughout norms ending in "2. Satz"',
      (n: number) => 'EO §85 Abs2 2.\r\nSatz.  \r\n'.repeat(Math.floor(n / 23)),
    ],
    [
      'repeated "idF 3. "',
      (n: number) => `MRG §16 ${'idF 3. '.repeat(Math.floor(n / 7))}WÄG Art 2`,
    ],
    [
      'repeated "idF des 3. "',
      (n: number) => `MRG §16 ${'idF des 3. '.repeat(Math.floor(n / 11))}WÄG Art 2`,
    ],
    [
      'one long line of "idF 3. " ending in a break',
      (n: number) => `MRG §16 ${'idF 3. '.repeat(Math.floor(n / 7))}\nWÄG Art 2`,
    ],
    [
      'breaks throughout "idF 3. "',
      (n: number) => `MRG §16 ${'idF\r\n3.\r\n'.repeat(Math.floor(n / 9))}WÄG Art 2`,
    ],
  ] as const)('%s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {}, 1_250);
  });

  it.each([
    ['an ordinal digit run', (n: number) => `${'1'.repeat(n)}. COVID-19-JuBG §1`],
    ['a day-of-month digit run before a month', (n: number) => `${'1'.repeat(n)}. Mai §1`],
    ['a section-first digit run before a parenthesis', (n: number) => `§ ${'1'.repeat(n)}(1) DSG`],
    [
      'a section-first digit run before a spaced capital',
      (n: number) => `§ ${'1'.repeat(n)} A ABGB`,
    ],
    ['an Artikel digit run before a Ziffer', (n: number) => `Art ${'1'.repeat(n)} Z 2 B-VG`],
    ['an attached sub-provision digit run', (n: number) => `IPRG §4Abs.${'1'.repeat(n)}!`],
    ['a ". "-joined entry ending in a digit run', (n: number) => `ZPO §1. ZPO §${'1'.repeat(n)}`],
    ['a digit run before a ". "', (n: number) => `ZPO §${'1'.repeat(n)}. ZPO §2`],
    ['an ordinal digit run after a ". "', (n: number) => `EO §85 Abs2. ${'2'.repeat(n)}. EO §86`],
    [
      'an ordinal digit run after "idF"',
      (n: number) => `MRG §16 Abs1 idF ${'3'.repeat(n)}. WÄG Art 2`,
    ],
  ])('%s, across the full 5k–320k span', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {});
  });

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

  // An EU act cited by its number (#83): designator words, digit runs, and whitespace runs.
  it.each([
    [
      'a long designator word',
      (n: number) => `${'Geldwäsche'.repeat(Math.floor(n / 10))}richtlinie 2024/1640/EU Art1`,
    ],
    [
      'a long word that never ends in a designator',
      (n: number) => `${'richtlinie'.repeat(Math.floor(n / 10))}x 2024/1640/EU Art1`,
    ],
    ['a whitespace run after the designator', (n: number) => `RL${' '.repeat(n)}2006/123/EG Art1`],
    ['a whitespace run in a bare act number', (n: number) => `VO (EG)${' '.repeat(n)}178/2002`],
    ['repeated designators', (n: number) => `${'RL '.repeat(Math.floor(n / 3))}2006/123/EG Art1`],
    [
      'one long line of designators ending in a break',
      (n: number) => `${'RL '.repeat(Math.floor(n / 3))}\n2006/123/EG`,
    ],
    [
      'breaks throughout a bare act number',
      (n: number) => `RL${'  \r\n'.repeat(Math.floor(n / 4))}2006/123/EG`,
    ],
  ] as const)('%s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    searchCaseLaw.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {}, 1_250);
  });

  it.each([
    ['a long digit run in an act number', (n: number) => `RL ${'1'.repeat(n)}/123/EG Art1`],
    ['a long digit run in a bare act number', (n: number) => `VO (EG) ${'1'.repeat(n)}/2002`],
    ['a long digit run with no closing type', (n: number) => `RL 2006/${'1'.repeat(n)}`],
  ])('%s, across the full 5k–320k span', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    searchCaseLaw.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {});
  });

  // A long title's " - <short form>" (#81), and a version note before or after the section (#82, #86).
  it.each([
    [
      'a long run of " - " before a short form',
      (n: number) => `A${' - '.repeat(Math.floor(n / 3))}B §1`,
    ],
    [
      'repeated " - <word>" with no provision after any',
      (n: number) => `A${' - B'.repeat(Math.floor(n / 4))} x §1`,
    ],
    [
      'repeated short forms after a whole cite',
      (n: number) => `ASVG §1${' - B §1'.repeat(Math.floor(n / 7))}`,
    ],
    [
      'a whitespace run between a short form and its provision',
      (n: number) => `A - B${' '.repeat(n)}§1`,
    ],
    ['a whitespace run after a short form’s year', (n: number) => `A - B 2004${' '.repeat(n)}x`],
    [
      'repeated sub-provisions before a dash',
      (n: number) => `ASVG §1${' Abs1'.repeat(Math.floor(n / 5))} - ABGB §1`,
    ],
    [
      'repeated sub-provisions and a word before a dash',
      (n: number) => `ASVG §1${' Abs1'.repeat(Math.floor(n / 5))} x - ABGB §1`,
    ],
    ['repeated section signs before a dash', (n: number) => `A ${'§'.repeat(n)} - B §1`],
    [
      'repeated Artikel numbers before a dash',
      (n: number) => `A${' Art 1'.repeat(Math.floor(n / 6))} - B §1`,
    ],
    [
      'one long line of " - <word>" ending in a break',
      (n: number) => `${'A - B '.repeat(Math.floor(n / 6))}\n§1`,
    ],
    ['breaks throughout " - "', (n: number) => `A${' -\r\n'.repeat(Math.floor(n / 4))}B §1`],
    [
      'a long clause before the section',
      (n: number) => `ABGB idF ${'X '.repeat(Math.floor(n / 2))}§1`,
    ],
    [
      'a repeated "idF " run before the section',
      (n: number) => `ABGB ${'idF '.repeat(Math.floor(n / 4))}§1`,
    ],
    [
      'a repeated "idF " run with no section',
      (n: number) => `ABGB ${'idF '.repeat(Math.floor(n / 4))}`,
    ],
    [
      'a repeated "idF " run before a gazette number',
      (n: number) => `ABGB ${'idF '.repeat(Math.floor(n / 4))}BGBl 1/2000`,
    ],
    [
      'repeated " aF" before the section',
      (n: number) => `ABGB${' aF'.repeat(Math.floor(n / 3))} §1`,
    ],
    ['a whitespace run before "idF"', (n: number) => `ABGB${' '.repeat(n)}idF BGBl 1/2000`],
    [
      'repeated gazette prefixes in a clause with no section',
      (n: number) => `ABGB idF ${'BGBl '.repeat(Math.floor(n / 5))}1970/342`,
    ],
    [
      'one long line of a clause ending in a break',
      (n: number) => `ABGB idF ${'X '.repeat(Math.floor(n / 2))}\n§1`,
    ],
    [
      'breaks throughout an "idF" run',
      (n: number) => `ABGB${' idF\r\n'.repeat(Math.floor(n / 6))}§1`,
    ],
    [
      'repeated Artikel words after a gazette number in a clause',
      (n: number) => `ABGB idF BGBl 1/2000${' Art'.repeat(Math.floor(n / 4))}`,
    ],
    [
      'a whitespace run after an Artikel word in a clause',
      (n: number) => `ABGB idF BGBl 1/2000 Art${' '.repeat(n)}x`,
    ],
    [
      'repeated gazette prefixes before a Roman-numbered Artikel',
      (n: number) => `ABGB idF ${'BGBl '.repeat(Math.floor(n / 5))}1/2000 ArtII`,
    ],
  ] as const)('%s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    searchGazette.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {}, 1_250);
  });

  it.each([
    [
      'a long gazette number in a clause after the section',
      (n: number) => `ABGB §167 idF BGBl I ${'1'.repeat(n)}/2013`,
    ],
    [
      'a long gazette number in a clause before the section',
      (n: number) => `ABGB idF BGBl I ${'1'.repeat(n)}/2010 §988`,
    ],
    ['a long word after a dash', (n: number) => `A - ${'B'.repeat(n)} §1`],
    ['a long digit run in the word after a dash', (n: number) => `A - B${'1'.repeat(n)} §1`],
    [
      'a long Roman numeral after an Artikel in a clause',
      (n: number) => `ABGB idF BGBl 1/2000 Art${'I'.repeat(n)}x`,
    ],
  ])('%s, across the full 5k–320k span', async (_shape, build) => {
    searchLegislation.mockResolvedValue(zeroHits());
    searchGazette.mockResolvedValue(zeroHits());
    await expectLinearResolution(build, {});
  });

  // A resolved cite, its own text read for the version it names (#82, #86).
  it.each([
    ['repeated " a" words before the section', (n: number) => `ABGB${' a'.repeat(n / 2)} §1`],
    ['repeated " id" words before the section', (n: number) => `ABGB${' id'.repeat(n / 5)} §1`],
    ['repeated " aFx" words after the section', (n: number) => `ABGB §1${' aFx'.repeat(n / 5)}`],
    [
      'one long line of " idFx" words ending in a break',
      (n: number) => `ABGB §1${' idFx'.repeat(n / 5)}\ny`,
    ],
    ['breaks throughout before "aF"', (n: number) => `ABGB${'  \r\n'.repeat(n / 5)}aF §1`],
  ] as const)('%s', async (_shape, build) => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    await expectLinearResolution(build, {}, 1_250);
  });

  it('repeated " i" words after the section, across the full 5k–320k span', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    await expectLinearResolution((n) => `ABGB §1${' i'.repeat(n / 2)}`, {});
  });
});

describe('risLookupCitation — content[] reads back RIS and caller text verbatim (#79)', () => {
  /**
   * The shared hostile metadata (every non-URL string and array element swapped for a
   * HOSTILE_TEXT shape, `overrides` laid on top — fields that set the nested values
   * (`norm_index`, `translation`) the fixture lacks), plus the document number struck through
   * and the organ inline-marked.
   */
  function hostileHit(
    hit: RisHit,
    offset: number,
    overrides: Record<string, unknown> = {},
  ): RisHit {
    return {
      ...hostileMetadata(hit, offset, overrides),
      documentNumber: `~~${hit.documentNumber}~~`,
      organ: HOSTILE_TEXT.inline,
    };
  }

  /**
   * Assert the format() text of a resolved lookup reads back, through a CommonMark parse, as
   * exactly the result's `structuredContent`: the found, kind, and resolution_note lines, the
   * authored "Resolved document" heading, the record block ({@link recordRead}), and the
   * alternatives_count trailer when there is one — every string verbatim in its own field's line,
   * no markup but the authored heading, bold labels, and links — and that the text links exactly
   * the record's URLs, in order. Returns the parsed text.
   */
  function expectReadBack(result: ToolResult): string {
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      alternatives_count?: number;
      kind: string;
      record: object;
      resolution_note: string;
    };
    const text = contentText(result);
    const read = readCommonMark(text);
    expect(read).toBe(
      `⟨strong⟩found⟨/strong⟩: true\n⟨strong⟩kind⟨/strong⟩: ${structured.kind}\n⟨strong⟩resolution_note⟨/strong⟩: ${structured.resolution_note}\n\n${RECORD_HEADING}${recordRead(structured.record)}${structured.alternatives_count === undefined ? '' : `\n\n⟨strong⟩alternatives_count⟨/strong⟩: ${structured.alternatives_count}`}`,
    );
    expect(linkDestinations(text)).toEqual(recordUrls(structured.record));
    return read;
  }

  it('reads back a resolved norm record: a multi-line title, every scalar, array element, and translation field', async () => {
    const base = page('search-brkons-celex.json');
    const hit = hostileHit(base.hits[0]!, 0, {
      source: HOSTILE_TEXT.blockMarkers,
      title: HOSTILE_TEXT.multiLineTitle,
    });
    searchLegislation.mockResolvedValue({ ...base, hits: [hit] });
    const result = await runToolContract(risLookupCitation, { citation: '§ 6 DSG' });
    const { record } = result.structuredContent as { record: Record<string, unknown> };
    // structuredContent relays the RIS strings as written.
    expect(record).toMatchObject({
      document_number: `~~${base.hits[0]!.documentNumber}~~`,
      title: HOSTILE_TEXT.multiLineTitle,
      translation: { source: HOSTILE_TEXT.blockMarkers },
    });
    const read = expectReadBack(result);
    expect(read).toContain(
      `⟨strong⟩document_number⟨/strong⟩: ~~${base.hits[0]!.documentNumber}~~\n`,
    );
    const urls = record.content_urls as Record<string, string>;
    expect(Object.keys(urls).length).toBeGreaterThan(0);
    for (const key of Object.keys(urls)) expect(read).toContain(`⟨a⟩${key}⟨/a⟩`);
    expect(linkDestinations(contentText(result))).toEqual(
      expect.arrayContaining(Object.values(urls)),
    );
  });

  it('reads back a resolved gazette record, its bare URL fields as links whose text is the URL', async () => {
    const base = page('search-bgblauth-celex.json');
    searchGazette.mockResolvedValue({ ...base, hits: [hostileHit(base.hits[0]!, 1)] });
    const result = await runToolContract(risLookupCitation, { citation: 'BGBl. I Nr. 8/2026' });
    const { record } = result.structuredContent as { record: Record<string, unknown> };
    expect(record.authentic_pdf_url).toMatch(WEB_URL);
    const read = expectReadBack(result);
    expect(read).toContain(
      `⟨strong⟩authentic_pdf_url⟨/strong⟩: ⟨a⟩${String(record.authentic_pdf_url)}⟨/a⟩`,
    );
    expect((record.celex_references as string[]).length).toBeGreaterThan(1);
  });

  it('reads back a resolved case-number record, its nested norm index and organ included', async () => {
    const base = page('search-vfgh.json');
    const hit = hostileHit(base.hits[0]!, 2, {
      abbreviation: HOSTILE_TEXT.pipeAndBackslash,
      title: HOSTILE_TEXT.multiLineTitle,
    });
    searchCaseLaw.mockResolvedValue({ ...base, hits: [hit] });
    const result = await runToolContract(risLookupCitation, { citation: 'G 287/2022' });
    const { record } = result.structuredContent as { record: Record<string, unknown> };
    expect(record).toMatchObject({
      organ: HOSTILE_TEXT.inline,
      norm_index: {
        abbreviation: HOSTILE_TEXT.pipeAndBackslash,
        title: HOSTILE_TEXT.multiLineTitle,
      },
    });
    const read = expectReadBack(result);
    expect(read).toContain(
      `⟨strong⟩norm_index⟨/strong⟩: title ${HOSTILE_TEXT.multiLineTitle} · abbreviation ${HOSTILE_TEXT.pipeAndBackslash}`,
    );
    expect(read).toContain(`⟨strong⟩organ⟨/strong⟩: ${HOSTILE_TEXT.inline}\n`);
  });

  const MARKED = 'X *y* _z_ `c` ~~s~~ [a](b) <b>w</b> | \\';

  it('reads back a resolution note quoting the cited title', async () => {
    searchLegislation.mockResolvedValue(page('search-brkons-celex.json'));
    const result = await runToolContract(risLookupCitation, { citation: `${MARKED} §1` });
    const { resolution_note } = result.structuredContent as { resolution_note: string };
    expect(resolution_note).toContain(`title "${MARKED}"`);
    const read = expectReadBack(result);
    expect(read).toContain(`⟨strong⟩resolution_note⟨/strong⟩: ${resolution_note}\n`);
  });

  it.each([
    [`${MARKED} §1`, 'norm'],
    ['6. Geldwäscherichtlinie 2024/1640/EU Art1', 'norm'],
    ['<b>x</b> *42*/2020', 'unknown'],
    ['Art6 Abs1', 'norm'],
  ])('reads back the whole found: false text for "%s"', async (citation, kind) => {
    searchLegislation.mockResolvedValue(zeroHits());
    const result = await runToolContract(risLookupCitation, { citation });
    const { guidance } = result.structuredContent as { guidance: string };
    expect(readCommonMark(contentText(result))).toBe(
      `⟨strong⟩found⟨/strong⟩: false\n⟨strong⟩kind⟨/strong⟩: ${kind}\n\n${guidance}`,
    );
  });
});
