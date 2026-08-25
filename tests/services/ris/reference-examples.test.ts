/**
 * @fileoverview Drift guards for the Geschäftszahl examples in `RIS_COURTS`. The examples are
 * quoted back to callers as working starting points, and two of them (vwgh, justiz) had fallen
 * out of the RIS corpus while three prose copies of each still named them (#18). Whether an
 * example is still in the corpus is a live question these offline tests cannot answer — that
 * stays a manual re-harvest. What they pin is the part that made the staleness expensive: a
 * prose copy drifting from `RIS_COURTS`, and a replacement whose format its own court detector
 * does not recognize. Every expectation reads the example out of `RIS_COURTS`, so a future
 * replacement flows through instead of needing the assertions rewritten.
 * @module tests/services/ris/reference-examples.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risLookupCitation } from '@/mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import { risSearchCaseLaw } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { RIS_CITATION_FORMATS, RIS_COURTS } from '@/services/ris/reference/index.js';
import type { RisSearchResult } from '@/services/ris/types.js';

const { searchCaseLaw } = vi.hoisted(() => ({ searchCaseLaw: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchCaseLaw }),
}));

const ZERO_HITS: RisSearchResult = { hits: [], page: 1, pageSize: 10, total: 0 };

/** Look an example up by court code, so a replacement flows into every assertion below. */
function gzExample(code: string): string {
  const court = RIS_COURTS.find((entry) => entry.code === code);
  if (court?.gzExample == null) throw new Error(`No gzExample for court "${code}"`);
  return court.gzExample;
}

/**
 * The courts whose example must round-trip through `ris_lookup_citation`'s format detection —
 * each owns a distinct Geschäftszahl pattern, so its example is expected to resolve back to it.
 * Excluded by design: `dok` (shares the "YYYY-0.NNN.NNN" shape with `dsk` and is probed second),
 * `normenliste` (no case numbers at all), and the historical bodies whose numbering has no
 * pattern of its own.
 */
const SELF_ROUTING_COURTS = [
  'vfgh',
  'vwgh',
  'justiz',
  'bvwg',
  'lvwg',
  'dsk',
  'pvak',
  'gbk',
  'verg',
  'upts',
];

beforeEach(() => {
  searchCaseLaw.mockReset();
  searchCaseLaw.mockResolvedValue(ZERO_HITS);
});

describe('RIS_COURTS gzExamples — format self-routing', () => {
  it.each(SELF_ROUTING_COURTS)(
    'the %s example is detected as that court by ris_lookup_citation',
    async (code) => {
      const citation = gzExample(code);
      const ctx = createMockContext({ errors: risLookupCitation.errors });
      await risLookupCitation.handler(risLookupCitation.input.parse({ citation }), ctx);

      expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ caseNumber: citation, court: code });
    },
  );

  it('every case-number example in the citation_formats table classifies as a case number', async () => {
    const caseNumbers = RIS_CITATION_FORMATS.find((format) => format.kind === 'case_number');
    expect(caseNumbers?.examples.length).toBeGreaterThan(0);

    for (const citation of caseNumbers?.examples ?? []) {
      const ctx = createMockContext({ errors: risLookupCitation.errors });
      const result = await risLookupCitation.handler(
        risLookupCitation.input.parse({ citation }),
        ctx,
      );
      expect(result.kind, `"${citation}" should classify as case_number`).toBe('case_number');
    }
  });
});

describe('RIS_COURTS gzExamples — prose copies stay in sync', () => {
  it('the ris_lookup_citation description quotes the current vwgh and justiz examples', () => {
    expect(risLookupCitation.description).toContain(gzExample('vwgh'));
    expect(risLookupCitation.description).toContain(gzExample('justiz'));
  });

  it('the citation input description quotes the current vwgh example', () => {
    const shape = risLookupCitation.input.shape as { citation: { description?: string } };
    expect(shape.citation.description).toContain(gzExample('vwgh'));
  });

  it('the unclassified-citation guidance quotes the current vwgh example', async () => {
    const ctx = createMockContext({ errors: risLookupCitation.errors });
    const result = await risLookupCitation.handler(
      risLookupCitation.input.parse({ citation: '42/2020' }),
      ctx,
    );
    expect(result.kind).toBe('unknown');
    expect(result.guidance).toContain(gzExample('vwgh'));
  });

  it('the case-law zero-hit notice quotes the current vfgh, vwgh, and justiz examples', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    await risSearchCaseLaw.handler(
      risSearchCaseLaw.input.parse({ court: 'vwgh', case_number: gzExample('vwgh') }),
      ctx,
    );
    const notice = getEnrichment(ctx).notice as string;

    for (const code of ['vfgh', 'vwgh', 'justiz']) {
      expect(notice, `zero-hit notice should quote the ${code} example`).toContain(gzExample(code));
    }
  });
});
