/**
 * @fileoverview Paging across the six paginated tools. page_size takes any whole number 1–100
 * and is served at one of the two page sizes this server sends RIS — 10 for a request up to 10, 20
 * above it — with a notice when the served size differs from the request (#70); 0, negatives,
 * fractions, and anything above 100 are rejected before any RIS call. `page` / `pageSize` /
 * `totalCount` / `truncated` stay exact at both served sizes (#40): a full page, rows beyond it,
 * a last partial page, an empty result, and a page past the end. The requested → served mapping
 * itself is tabled once at `servePageSize` (`_shared.test.ts`); here each tool is checked for
 * the wiring, at one remapped size per side of the split. Every case runs through
 * `runToolContract`, so both `structuredContent` and `content[]` are asserted. The RIS service
 * module is mocked with pages built from real fixtures run through the real normalizer; the wire
 * cases route the mock to a real `RisService` behind a strict fetch fake, so they assert the RIS
 * URL each request actually builds. A reversed date window on any of the six — every
 * `_from`/`_to` pair, swept from the advertised schemas — is answered without a RIS request:
 * an empty page whose enrichment still echoes the requested page and served size (#92).
 * @module tests/tools/paging.test
 */

import { readFileSync } from 'node:fs';

import { z } from '@cyanheads/mcp-ts-core';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isoDateString } from '@/mcp-server/tools/definitions/_shared.js';
import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { risSearchCaseLaw } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { risSearchDrafts } from '@/mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { risSearchLegislation } from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';
import { parseHistoryResponse, parseSearchResponse } from '@/services/ris/normalizer.js';
import { RisService } from '@/services/ris/ris-service.js';
import type { RisChangeSet, RisSearchResult } from '@/services/ris/types.js';

import { contentText, expectArgumentRejection, type ToolResult } from './_wire.js';

const service = vi.hoisted(() => ({
  searchAnnouncements: vi.fn(),
  searchCaseLaw: vi.fn(),
  searchDrafts: vi.fn(),
  searchGazette: vi.fn(),
  searchLegislation: vi.fn(),
  trackChanges: vi.fn(),
}));

/** The tools resolve the service through `getRisService`; the real class stays importable. */
vi.mock('@/services/ris/ris-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ris/ris-service.js')>()),
  getRisService: () => service,
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** A unique document number per synthesized row, so each row is findable on both surfaces. */
function rowNumber(index: number): string {
  return `PAGEROW_${String(index + 1).padStart(3, '0')}`;
}

/** One RIS search page of `rows` records, cycling a real fixture's hits. */
function searchPage(source: RisSearchResult) {
  return (rows: number, total: number, page: number, pageSize: number): RisSearchResult => ({
    hits: Array.from({ length: rows }, (_, index) => ({
      ...(source.hits[index % source.hits.length] as RisSearchResult['hits'][number]),
      documentNumber: rowNumber(index),
    })),
    page,
    pageSize,
    total,
  });
}

/** One History page of `rows` entries, cycling a real fixture's changed and deleted records. */
function historyPage(source: RisChangeSet) {
  return (rows: number, total: number, page: number, pageSize: number): RisChangeSet => ({
    changes: Array.from({ length: rows }, (_, index) => {
      const change = source.changes[
        index % source.changes.length
      ] as RisChangeSet['changes'][number];
      return change.kind === 'document'
        ? { ...change, hit: { ...change.hit, documentNumber: rowNumber(index) } }
        : { ...change, record: { ...change.record, documentNumber: rowNumber(index) } };
    }),
    page,
    pageSize,
    total,
  });
}

/**
 * The six paginated tools: the service method each calls, a page builder, the RIS URL its base
 * input builds with no page size, and the zero-hit notice that base input earns.
 */
const PAGINATED = [
  {
    base: { query: 'Datenschutz', in_force_as_of: '2026-10-01' },
    call: 'searchLegislation',
    definition: risSearchLegislation,
    method: service.searchLegislation,
    page: searchPage(parseSearchResponse(fixture('search-brkons-multi.json'))),
    url: 'https://data.bka.gv.at/ris/api/v2.6/Bundesrecht?Applikation=BrKons&Suchworte=Datenschutz&FassungVom=2026-10-01',
    zeroHit:
      "0 documents matched. Only versions in force on 2026-10-01 were searched — a repealed or not-yet-enacted provision returns nothing. Set include_all_versions: true to search all historical versions. query wildcards are trailing-only ('Datenschutz*', never '*schutz'); boolean operators UND/ODER/NICHT or AND/OR/NOT. Syntax reference: ris_list_reference topic search_syntax.",
  },
  {
    base: { court: 'vfgh' },
    call: 'searchCaseLaw',
    definition: risSearchCaseLaw,
    method: service.searchCaseLaw,
    page: searchPage(parseSearchResponse(fixture('search-vfgh.json'))),
    url: 'https://data.bka.gv.at/ris/api/v2.6/Judikatur?Applikation=Vfgh&Dokumenttyp.SucheInRechtssaetzen=true&Dokumenttyp.SucheInEntscheidungstexten=true',
    zeroHit: '0 decisions in vfgh. Other courts are separate calls — repeat per court.',
  },
  {
    base: {},
    call: 'searchGazette',
    definition: risSearchGazette,
    method: service.searchGazette,
    page: searchPage(parseSearchResponse(fixture('search-bgblauth-2004-01.json'))),
    url: 'https://data.bka.gv.at/ris/api/v2.6/Bundesrecht?Applikation=BgblAuth',
    zeroHit: '0 gazette entries matched.',
  },
  {
    base: { stage: 'review_drafts' },
    call: 'searchDrafts',
    definition: risSearchDrafts,
    method: service.searchDrafts,
    page: searchPage(parseSearchResponse(fixture('search-begut.json'))),
    url: 'https://data.bka.gv.at/ris/api/v2.6/Bundesrecht?Applikation=Begut',
    zeroHit: '0 review_drafts matched.',
  },
  {
    base: { collection: 'social_insurance' },
    call: 'searchAnnouncements',
    definition: risSearchAnnouncements,
    method: service.searchAnnouncements,
    page: searchPage(parseSearchResponse(fixture('search-avsv.json'))),
    url: 'https://data.bka.gv.at/ris/api/v2.6/Sonstige?Applikation=Avsv',
    zeroHit: '0 documents in social_insurance.',
  },
  {
    base: { application: 'BrKons' },
    call: 'trackChanges',
    definition: risTrackChanges,
    method: service.trackChanges,
    page: historyPage(parseHistoryResponse(fixture('history-with-deleted.json'))),
    url: 'https://data.bka.gv.at/ris/api/v2.6/History?Anwendung=Bundesnormen',
    zeroHit:
      "0 changes in BrKons between the start of the feed and now. Windows are exact dates — widen the range, or use the search tools' changed_since for coarse recency filtering.",
  },
] as const;

/** The paging fields a success result carries in `structuredContent`. */
interface PagedResult {
  readonly notice?: string;
  readonly page: number;
  readonly pageSize: number;
  readonly results: readonly { readonly document_number: string }[];
  readonly totalCount: number;
  readonly truncated?: boolean;
}

/** The notice a request served at another size carries, written out in full. */
function servedNotice(requested: number, served: number): string {
  return `page_size ${requested} served as ${served} — this server serves pages of 10 or 20 documents, so page steps through pages of ${served}.`;
}

/**
 * One requested size on each side of the 10/20 split — [requested, served, total] — read at
 * page 2 as a full last page. `truncated` is false at the served size, and would be true if a
 * tool did the paging arithmetic with the requested size instead.
 */
const REMAPPED_PAGES = [
  [9, 10, 20],
  [11, 20, 40],
] as const;

/** The two ends of the 1–100 range, paired with the size each is served at. */
const REMAPPED_WIRE = [
  [1, 10],
  [100, 20],
] as const;

/** Values page_size rejects at the schema, before the handler runs. */
const REJECTED = [0, -1, 1.5, 101, 1e9] as const;

/** Assert `notice` on both surfaces: `structuredContent.notice` and one trailer line in `content[]`. */
function expectNotice(result: ToolResult, notice: string): void {
  expect((result.structuredContent as unknown as PagedResult).notice).toBe(notice);
  const lines = contentText(result).split('\n');
  expect(lines.filter((line) => line === `> ${notice}`)).toHaveLength(1);
}

beforeEach(() => {
  for (const method of Object.values(service)) method.mockReset();
});

describe.each(PAGINATED)(
  '$definition.name — page_size served as 10 or 20 (#70)',
  ({ base, definition, method, page }) => {
    it.each([10, 20])(
      'sends page_size %d to RIS as the page size, with no notice',
      async (size) => {
        method.mockResolvedValue(page(3, 3, 1, size));
        const result = await runToolContract(definition, { ...base, page_size: size } as never);
        expect(result.isError).not.toBe(true);
        expect(method.mock.calls[0]![0]).toMatchObject({ pageSize: size });
        expect(result.structuredContent).not.toHaveProperty('notice');
        expect(contentText(result)).not.toContain('served as');
      },
    );

    it('leaves the page size to RIS when page_size is omitted, echoing the 20 it serves', async () => {
      method.mockResolvedValue(page(20, 45, 1, 20));
      const result = await runToolContract(definition, base as never);
      expect(result.isError).not.toBe(true);
      expect(method.mock.calls[0]![0]).not.toHaveProperty('pageSize');
      expect(result.structuredContent).toMatchObject({
        page: 1,
        pageSize: 20,
        totalCount: 45,
        truncated: true,
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect((result.structuredContent as unknown as PagedResult).results).toHaveLength(20);
    });

    it.each(REMAPPED_PAGES)(
      'serves page_size %d as %d, pages at the served size, and discloses it on both surfaces',
      async (requested, served, total) => {
        method.mockResolvedValue(page(served, total, 2, served));
        const result = await runToolContract(definition, {
          ...base,
          page: 2,
          page_size: requested,
        } as never);
        expect(result.isError).not.toBe(true);
        expect(method).toHaveBeenCalledTimes(1);
        expect(method.mock.calls[0]![0]).toMatchObject({ page: 2, pageSize: served });
        const structured = result.structuredContent as unknown as PagedResult;
        expect(structured).toMatchObject({ page: 2, pageSize: served, totalCount: total });
        expect(structured.truncated).toBeUndefined();
        expectNotice(result, servedNotice(requested, served));
      },
    );

    it.each(REJECTED)('rejects page_size %d over the wire before any RIS call', async (size) => {
      const result = await runToolContract(definition, { ...base, page_size: size } as never);
      expectArgumentRejection(result, ['page_size: ', '1–100', 'raise page']);
      expect(method).not.toHaveBeenCalled();
    });

    it('leads the zero-hit guidance with the page-size sentence, in one notice', async () => {
      method.mockResolvedValue(page(0, 0, 1, 20));
      const result = await runToolContract(definition, { ...base, page_size: 50 } as never);
      expect(result.isError).not.toBe(true);
      expectNotice(result, `${servedNotice(50, 20)} ${zeroHitOf(definition.name)}`);
      expect(contentText(result).split('served as').length - 1).toBe(1);
    });

    it('keeps the zero-hit guidance alone when page_size is omitted', async () => {
      method.mockResolvedValue(page(0, 0, 1, 20));
      const result = await runToolContract(definition, base as never);
      expectNotice(result, zeroHitOf(definition.name));
    });
  },
);

describe('page_size as a numeric string — repaired on the wire, not rejected (#70)', () => {
  it.each([
    ['20', 20, undefined],
    ['5', 10, servedNotice(5, 10)],
  ] as const)('accepts %j and serves it as %d', async (size, served, notice) => {
    service.searchLegislation.mockResolvedValue(
      searchPage(parseSearchResponse(fixture('search-brkons-multi.json')))(3, 3, 1, served),
    );
    const result = await runToolContract(risSearchLegislation, {
      query: 'Datenschutz',
      page_size: size,
    } as never);
    expect(result.isError).not.toBe(true);
    expect(service.searchLegislation.mock.calls[0]![0]).toMatchObject({ pageSize: served });
    expect((result.structuredContent as unknown as PagedResult).notice).toBe(notice);
  });
});

/** The pinned zero-hit notice of one tool's base input. */
function zeroHitOf(name: string): string {
  return (PAGINATED.find((entry) => entry.definition.name === name) as (typeof PAGINATED)[number])
    .zeroHit;
}

describe.each(PAGINATED)(
  '$definition.name — truncated is exact at both served page sizes (#40)',
  ({ base, definition, method, page }) => {
    describe.each([10, 20])('page_size %d', (size) => {
      it.each([
        // [label, rows on the page, total, page number, truncated]
        ['a full first page with nothing beyond', size, size, 1, false],
        ['a full first page with one row beyond', size, size + 1, 1, true],
        ['a full middle page with rows beyond', size, 2 * size + 1, 2, true],
        ['a last partial page', 3, size + 3, 2, false],
        ['an empty result', 0, 0, 1, false],
        ['a page past the end', 0, size + 3, 4, false],
      ] as const)('%s', async (_label, rows, total, pageNumber, truncated) => {
        method.mockResolvedValue(page(rows, total, pageNumber, size));
        const result = await runToolContract(definition, {
          ...base,
          page: pageNumber,
          page_size: size,
        } as never);

        expect(result.isError).not.toBe(true);
        expect(method.mock.calls[0]![0]).toMatchObject({ page: pageNumber, pageSize: size });
        const structured = result.structuredContent as unknown as PagedResult;
        expect(structured).toMatchObject({ page: pageNumber, pageSize: size, totalCount: total });
        expect(structured.truncated).toBe(truncated ? true : undefined);
        expect(structured.results.map((record) => record.document_number)).toEqual(
          Array.from({ length: rows }, (_, index) => rowNumber(index)),
        );

        const text = contentText(result);
        for (const record of structured.results) expect(text).toContain(record.document_number);
        expect(text).toContain(String(total));
        if (truncated) expect(text).toMatch(/truncated/iu);
        else expect(text).not.toMatch(/truncated/iu);
      });
    });
  },
);

describe.each(PAGINATED)(
  '$definition.name — the RIS request each page_size builds (#70)',
  ({ base, call, definition, method, url }) => {
    let http: FetchMockHarness;

    beforeEach(() => {
      const real = new RisService('ris-austria-mcp-server/test');
      method.mockImplementation((params, ctx) => real[call](params as never, ctx));
      http = createFetchMock();
      http.install();
      // A catch-all, so every request is recorded — none rejected unseen.
      http.route({
        match: () => true,
        respond: () =>
          new Response(JSON.stringify(fixture('search-zero-hits.json')), {
            headers: { 'Content-Type': 'application/json' },
          }),
      });
    });

    afterEach(() => {
      http.restore();
    });

    /** The URLs of the RIS requests one call sent. */
    async function sentUrls(pageSize: number | undefined): Promise<string[]> {
      const result = await runToolContract(definition, {
        ...base,
        ...(pageSize !== undefined && { page_size: pageSize }),
      } as never);
      expect(result.isError).not.toBe(true);
      return http.calls.map((entry) => entry.request.url);
    }

    it.each([
      [undefined, ''],
      [10, '&DokumenteProSeite=Ten'],
      [20, '&DokumenteProSeite=Twenty'],
    ])('page_size %s sends the same single request as before', async (size, suffix) => {
      expect(await sentUrls(size)).toEqual([`${url}${suffix}`]);
    });

    it.each(REMAPPED_WIRE)(
      'page_size %d sends the request page_size %d sends',
      async (requested, served) => {
        expect(await sentUrls(requested)).toEqual([
          `${url}&DokumenteProSeite=${served === 10 ? 'Ten' : 'Twenty'}`,
        ]);
      },
    );
  },
);

describe('ris_search_gazette — Vbl short-circuit echoes the served page size (#70)', () => {
  const VBL =
    "0 gazette entries matched. Verordnungsblätter in RIS currently cover Tirol (2022+) — other states' ordinance gazettes are not yet published here.";
  const input = { scope: 'wien', series: 'ordinance_gazette' } as const;

  it.each([
    [undefined, 20, VBL],
    [10, 10, VBL],
    [20, 20, VBL],
    [50, 20, `${servedNotice(50, 20)} ${VBL}`],
    [5, 10, `${servedNotice(5, 10)} ${VBL}`],
  ] as const)('page_size %s echoes pageSize %d', async (size, served, notice) => {
    const result = await runToolContract(risSearchGazette, {
      ...input,
      ...(size !== undefined && { page_size: size }),
    });
    expect(result.isError).not.toBe(true);
    expect(service.searchGazette).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      page: 1,
      pageSize: served,
      servedApplication: 'Vbl',
      totalCount: 0,
    });
    expect(contentText(result).split('\n')).toContain(`**pageSize:** ${served}`);
    expectNotice(result, notice);
  });
});

/** The `pattern` every `isoDateString` parameter advertises — what the window sweep matches on. */
const ISO_DATE_PATTERN = (
  z.toJSONSchema(z.object({ when: isoDateString }), { io: 'input' }) as unknown as {
    properties: { when: { pattern: string } };
  }
).properties.when.pattern;

/**
 * Every date window on the six paginated tools: an input that reaches it, the `_from`/`_to`
 * fields, a later and an earlier date to reverse them with, and the enrichment beyond
 * page/pageSize/totalCount the tool still owes. The gazette, ministerial_decrees, and
 * track_changes rows are the reported reproductions. The first test below derives the same
 * pairs from the advertised schemas, so a window added later has to land here.
 */
const WINDOWS = [
  {
    base: { title: 'DSG' },
    definition: risSearchLegislation,
    earlier: '2026-01-01',
    enrichment: {},
    from: 'entered_force_from',
    later: '2026-06-30',
    to: 'entered_force_to',
  },
  {
    base: { title: 'DSG' },
    definition: risSearchLegislation,
    earlier: '2026-01-01',
    enrichment: {},
    from: 'left_force_from',
    later: '2026-06-30',
    to: 'left_force_to',
  },
  {
    base: { court: 'vfgh' },
    definition: risSearchCaseLaw,
    earlier: '2025-01-01',
    enrichment: {},
    from: 'decided_from',
    later: '2025-06-30',
    to: 'decided_to',
  },
  {
    base: { scope: 'federal' },
    definition: risSearchGazette,
    earlier: '1990-01-01',
    enrichment: { servedApplication: 'BgblPdf' },
    from: 'published_from',
    later: '1990-06-01',
    to: 'published_to',
  },
  {
    base: { stage: 'government_bills' },
    definition: risSearchDrafts,
    earlier: '2025-01-01',
    enrichment: {},
    from: 'decided_from',
    later: '2025-12-31',
    to: 'decided_to',
  },
  {
    base: { collection: 'social_insurance' },
    definition: risSearchAnnouncements,
    earlier: '2026-01-01',
    enrichment: {},
    from: 'published_from',
    later: '2026-06-30',
    to: 'published_to',
  },
  {
    base: { collection: 'ministerial_decrees' },
    definition: risSearchAnnouncements,
    earlier: '2026-01-01',
    enrichment: {},
    from: 'entered_force_from',
    later: '2026-06-30',
    to: 'entered_force_to',
  },
  {
    base: { application: 'BrKons' },
    definition: risTrackChanges,
    earlier: '2026-10-27',
    enrichment: { application: 'BrKons' },
    from: 'changed_from',
    later: '2026-10-28',
    to: 'changed_to',
  },
] as const;

/** The reversed-window notice for one pair, written out in full. */
function reversedNotice(from: string, later: string, to: string, earlier: string): string {
  return `${from} ${later} is after ${to} ${earlier} — a reversed window holds no dates, so nothing matches and RIS was not queried. Retry with the bounds swapped: ${from} ${earlier}, ${to} ${later}.`;
}

/** The service-param name a snake_case input field is sent as. */
function builderParam(field: string): string {
  return field.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

describe('date windows — a reversed _from/_to pair is answered without RIS (#92)', () => {
  it('covers every _from/_to date pair on the six paginated tools, derived from the advertised schemas', () => {
    const advertised = PAGINATED.flatMap(({ definition }) => {
      const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
        properties?: Record<string, { pattern?: string }>;
      };
      const dates = new Set(
        Object.entries(schema.properties ?? {})
          .filter(([, node]) => node.pattern === ISO_DATE_PATTERN)
          .map(([name]) => name),
      );
      return [...dates]
        .filter((name) => name.endsWith('_from') && dates.has(name.replace(/_from$/u, '_to')))
        .map((name) => `${definition.name}.${name}`);
    });
    const swept = WINDOWS.map(({ definition, from }) => `${definition.name}.${from}`);

    expect(advertised.toSorted()).toEqual(swept.toSorted());
    expect(swept).toHaveLength(8);
  });

  describe.each(WINDOWS)(
    '$definition.name $from > $to',
    ({ base, definition, earlier, enrichment, from, later, to }) => {
      const paged = PAGINATED.find(
        (entry) => entry.definition.name === definition.name,
      ) as (typeof PAGINATED)[number];
      const reversed = reversedNotice(from, later, to, earlier);

      it.each([
        ['no paging input', {}, 1, 20, reversed],
        [
          'page 3, page_size 50',
          { page: 3, page_size: 50 },
          3,
          20,
          `${servedNotice(50, 20)} ${reversed}`,
        ],
        ['page_size 5', { page_size: 5 }, 1, 10, `${servedNotice(5, 10)} ${reversed}`],
      ] as const)(
        '%s: an empty page on both surfaces, enrichment echoed, no RIS request',
        async (_label, paging, page, pageSize, notice) => {
          const result = await runToolContract(definition, {
            ...base,
            ...paging,
            [from]: later,
            [to]: earlier,
          } as never);

          expect(result.isError).not.toBe(true);
          expect(paged.method).not.toHaveBeenCalled();
          expect(result.structuredContent).toMatchObject({
            ...enrichment,
            page,
            pageSize,
            results: [],
            totalCount: 0,
          });
          expect(result.structuredContent).not.toHaveProperty('truncated');
          const lines = contentText(result).split('\n');
          expect(lines).toContain('**0 total**');
          expect(lines).toContain(`**page:** ${page}`);
          expect(lines).toContain(`**pageSize:** ${pageSize}`);
          for (const [key, value] of Object.entries(enrichment)) {
            expect(lines).toContain(`**${key}:** \`${value}\``);
          }
          expectNotice(result, notice);
        },
      );

      it('equal bounds — a one-day window — still reach RIS', async () => {
        paged.method.mockResolvedValue(paged.page(1, 1, 1, 20));
        const result = await runToolContract(definition, {
          ...base,
          [from]: later,
          [to]: later,
        } as never);

        expect(result.isError).not.toBe(true);
        expect(paged.method).toHaveBeenCalledTimes(1);
        expect(paged.method.mock.calls[0]![0]).toMatchObject({
          [builderParam(from)]: later,
          [builderParam(to)]: later,
        });
        expect(result.structuredContent).toMatchObject({ totalCount: 1 });
        expect((result.structuredContent as unknown as PagedResult).notice ?? '').not.toContain(
          'reversed window',
        );
      });
    },
  );
});
