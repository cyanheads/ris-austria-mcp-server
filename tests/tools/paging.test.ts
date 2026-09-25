/**
 * @fileoverview Paging across the six paginated tools (#40) — page_size accepts 10 or 20 and
 * rejects anything larger before any RIS call, and `page` / `pageSize` / `totalCount` /
 * `truncated` stay exact at both sizes: a full page, rows beyond it, a last partial page, an
 * empty result, and a page past the end. Every case runs through `runToolContract`, so both
 * `structuredContent` and `content[]` are asserted. The RIS service module is mocked; pages are
 * built from real fixtures run through the real normalizer.
 * @module tests/tools/paging.test
 */

import { readFileSync } from 'node:fs';

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { risSearchCaseLaw } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { risSearchDrafts } from '@/mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { risSearchLegislation } from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';
import { parseHistoryResponse, parseSearchResponse } from '@/services/ris/normalizer.js';
import type { RisChangeSet, RisSearchResult } from '@/services/ris/types.js';

import { contentText, expectArgumentRejection } from './_wire.js';

const service = vi.hoisted(() => ({
  searchAnnouncements: vi.fn(),
  searchCaseLaw: vi.fn(),
  searchDrafts: vi.fn(),
  searchGazette: vi.fn(),
  searchLegislation: vi.fn(),
  trackChanges: vi.fn(),
}));

vi.mock('@/services/ris/ris-service.js', () => ({ getRisService: () => service }));

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

const PAGINATED = [
  {
    base: { query: 'Datenschutz' },
    definition: risSearchLegislation,
    method: service.searchLegislation,
    page: searchPage(parseSearchResponse(fixture('search-brkons-multi.json'))),
  },
  {
    base: { court: 'vfgh' },
    definition: risSearchCaseLaw,
    method: service.searchCaseLaw,
    page: searchPage(parseSearchResponse(fixture('search-vfgh.json'))),
  },
  {
    base: {},
    definition: risSearchGazette,
    method: service.searchGazette,
    page: searchPage(parseSearchResponse(fixture('search-bgblauth-2004-01.json'))),
  },
  {
    base: { stage: 'review_drafts' },
    definition: risSearchDrafts,
    method: service.searchDrafts,
    page: searchPage(parseSearchResponse(fixture('search-begut.json'))),
  },
  {
    base: { collection: 'social_insurance' },
    definition: risSearchAnnouncements,
    method: service.searchAnnouncements,
    page: searchPage(parseSearchResponse(fixture('search-avsv.json'))),
  },
  {
    base: { application: 'BrKons' },
    definition: risTrackChanges,
    method: service.trackChanges,
    page: historyPage(parseHistoryResponse(fixture('history-with-deleted.json'))),
  },
] as const;

/** The paging fields a success result carries in `structuredContent`. */
interface PagedResult {
  readonly page: number;
  readonly pageSize: number;
  readonly results: readonly { readonly document_number: string }[];
  readonly totalCount: number;
  readonly truncated?: boolean;
}

beforeEach(() => {
  for (const method of Object.values(service)) method.mockReset();
});

describe.each(PAGINATED)(
  '$definition.name — page_size bound (#40)',
  ({ base, definition, method, page }) => {
    it.each([50, 100])('rejects page_size %d over the wire before any RIS call', async (size) => {
      const result = await runToolContract(definition, { ...base, page_size: size } as never);
      expectArgumentRejection(result, ['page_size: ', 'Expected 10 or 20', 'raise page']);
      expect(method).not.toHaveBeenCalled();
    });

    it.each([10, 20])('sends page_size %d to RIS as the page size', async (size) => {
      method.mockResolvedValue(page(3, 3, 1, size));
      const result = await runToolContract(definition, { ...base, page_size: size } as never);
      expect(result.isError).not.toBe(true);
      expect(method.mock.calls[0]![0]).toMatchObject({ pageSize: size });
    });

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
      expect((result.structuredContent as unknown as PagedResult).results).toHaveLength(20);
    });
  },
);

describe.each(PAGINATED)(
  '$definition.name — truncated is exact at both page sizes (#40)',
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
