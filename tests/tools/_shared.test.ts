/**
 * @fileoverview Tests for the shared date schema in `_shared.ts` and its reach across the
 * surface. `isoDateString` backs every date-taking parameter on every tool, so an impossible
 * calendar date must be an input error at each of them rather than a shape-valid string sent
 * upstream — where RIS's rejection is either an opaque error or, in ris_lookup_citation,
 * silently reinterpreted as a citation miss (#14). Fully offline: only input schemas are
 * exercised, no handler and no service.
 * @module tests/tools/_shared.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';

import { isoDateString } from '@/mcp-server/tools/definitions/_shared.js';
import { risGetDocument } from '@/mcp-server/tools/definitions/ris-get-document.tool.js';
import { risListReference } from '@/mcp-server/tools/definitions/ris-list-reference.tool.js';
import { risLookupCitation } from '@/mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { risSearchCaseLaw } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { risSearchDrafts } from '@/mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { risSearchLegislation } from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';

/** A real date, an impossible one, and the base input each tool needs to reach its date field. */
const VALID = '2026-07-26';
const IMPOSSIBLE = '2026-99-99';

/** Every tool on the surface, so the coverage check below can see a date parameter added anywhere. */
const ALL_TOOLS = [
  risLookupCitation,
  risSearchLegislation,
  risSearchCaseLaw,
  risSearchGazette,
  risSearchDrafts,
  risSearchAnnouncements,
  risTrackChanges,
  risGetDocument,
  risListReference,
];

/** The advertised `pattern` `isoDateString` emits — the marker the coverage check matches on. */
const ISO_DATE_PATTERN = (
  z.toJSONSchema(z.object({ when: isoDateString }), { io: 'input' }) as unknown as {
    properties: { when: { pattern: string } };
  }
).properties.when.pattern;

/**
 * Every parameter on the surface that resolves to `isoDateString`, paired with the minimal
 * sibling input its tool requires. The last test in this file derives the same set from the
 * advertised schemas, so a new date parameter that skips this table fails rather than passing
 * silently.
 */
const DATE_PARAMS: ReadonlyArray<{
  readonly base: Readonly<Record<string, unknown>>;
  readonly params: readonly string[];
  readonly schema: { readonly parse: (value: unknown) => unknown };
  readonly tool: string;
}> = [
  {
    tool: 'ris_lookup_citation',
    schema: risLookupCitation.input,
    base: { citation: '§ 1 DSG' },
    params: ['in_force_as_of'],
  },
  {
    tool: 'ris_search_legislation',
    schema: risSearchLegislation.input,
    base: { title: 'DSG' },
    params: [
      'in_force_as_of',
      'entered_force_from',
      'entered_force_to',
      'left_force_from',
      'left_force_to',
    ],
  },
  {
    tool: 'ris_search_case_law',
    schema: risSearchCaseLaw.input,
    base: { court: 'vfgh' },
    params: ['decided_from', 'decided_to'],
  },
  {
    tool: 'ris_search_gazette',
    schema: risSearchGazette.input,
    base: {},
    params: ['published_from', 'published_to'],
  },
  {
    tool: 'ris_search_drafts',
    schema: risSearchDrafts.input,
    base: { stage: 'review_drafts' },
    params: ['in_review_on', 'decided_from', 'decided_to'],
  },
  {
    tool: 'ris_search_announcements',
    schema: risSearchAnnouncements.input,
    base: { collection: 'ministerial_decrees' },
    params: [
      'published_from',
      'published_to',
      'in_force_as_of',
      'entered_force_from',
      'entered_force_to',
    ],
  },
  {
    tool: 'ris_track_changes',
    schema: risTrackChanges.input,
    base: { application: 'BrKons' },
    params: ['changed_from', 'changed_to'],
  },
];

describe('isoDateString', () => {
  it.each([
    ['2026-07-26', 'an ordinary date'],
    ['2024-02-29', 'a leap day in a leap year'],
    ['2000-02-29', 'a leap day in a turn-of-century leap year (divisible by 400)'],
    ['2026-01-31', 'the last day of a 31-day month'],
    ['2026-04-30', 'the last day of a 30-day month'],
    ['2023-02-28', 'the last day of February outside a leap year'],
    ['1848-03-15', 'a 19th-century date (the imperial gazette era RIS carries)'],
    ['0001-01-01', 'a year below 100 — a valid ISO date, however far outside the corpus'],
  ])('accepts %s (%s)', (value) => {
    expect(isoDateString.parse(value)).toBe(value);
  });

  it.each([
    ['2026-99-99', 'month and day both out of range — the reported case'],
    ['2026-13-01', 'month 13'],
    ['2026-00-10', 'month 00'],
    ['2026-01-00', 'day 00'],
    ['2026-01-32', 'day 32'],
    ['2023-02-29', 'a leap day outside a leap year'],
    ['1900-02-29', 'a leap day in a turn-of-century non-leap year (divisible by 100, not 400)'],
    ['2026-02-30', 'February 30'],
    ['2026-04-31', 'April 31 — a 30-day month'],
    ['2026-06-31', 'June 31 — a 30-day month'],
    ['2026-09-31', 'September 31 — a 30-day month'],
    ['2026-11-31', 'November 31 — a 30-day month'],
    ['2026-1-1', 'unpadded month and day'],
    ['26-07-26', 'a two-digit year'],
    ['2026/07/26', 'slash separators'],
    ['2026-07-26T00:00:00Z', 'a full ISO timestamp'],
    ['today', 'a natural-language date'],
    ['', 'an empty string'],
  ])('rejects %s (%s)', (value) => {
    expect(isoDateString.safeParse(value).success).toBe(false);
  });

  it('advertises the month/day bounds as a JSON Schema pattern so a schema-validating client rejects before the call', () => {
    // The refinement cannot serialize into JSON Schema, so the pattern has to carry everything
    // expressible in one — a client that only sees the advertised inputSchema still rejects
    // "2026-99-99" without a round trip.
    const pattern = new RegExp(ISO_DATE_PATTERN);
    expect(pattern.test(IMPOSSIBLE)).toBe(false);
    expect(pattern.test(VALID)).toBe(true);
  });
});

describe('isoDateString — reach across the tool surface (#14)', () => {
  for (const { base, params, schema, tool } of DATE_PARAMS) {
    for (const param of params) {
      it(`${tool}.${param} accepts a real date and rejects an impossible one`, () => {
        expect(() => schema.parse({ ...base, [param]: VALID })).not.toThrow();
        expect(() => schema.parse({ ...base, [param]: IMPOSSIBLE })).toThrow();
      });

      it(`${tool}.${param} still accepts a leap day`, () => {
        expect(() => schema.parse({ ...base, [param]: '2024-02-29' })).not.toThrow();
      });
    }
  }

  it('sweeps every parameter that resolves to isoDateString, on every tool', () => {
    // Derived from the advertised schemas rather than counted off the table above, so a date
    // parameter added to any tool — including the two this table has no rows for — lands here
    // as a failure instead of slipping past an unswept parameter.
    const advertised = ALL_TOOLS.flatMap((definition) => {
      const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
        properties?: Record<string, { pattern?: string }>;
      };
      return Object.entries(schema.properties ?? {})
        .filter(([, node]) => node.pattern === ISO_DATE_PATTERN)
        .map(([param]) => `${definition.name}.${param}`);
    });
    const swept = DATE_PARAMS.flatMap(({ params, tool }) =>
      params.map((param) => `${tool}.${param}`),
    );

    expect(advertised.toSorted()).toEqual(swept.toSorted());
    expect(swept).toHaveLength(20);
  });
});
