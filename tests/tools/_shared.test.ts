/**
 * @fileoverview Tests for the shared input schemas in `_shared.ts` and their reach across the
 * surface. `isoDateString` backs every date-taking parameter on every tool, so an impossible
 * calendar date must be an input error at each of them rather than a shape-valid string sent
 * upstream — where RIS's rejection is either an opaque error or, in ris_lookup_citation,
 * silently reinterpreted as a citation miss (#14). Every free-text filter on the filter tools
 * rejects a blank or whitespace-only value (#39), and every paginated tool takes a whole-number
 * page_size 1–100 (#40, #70) — both swept from the advertised schemas, so a parameter added
 * later cannot skip the rule; one shared mapping serves that request at 10 or 20 with a notice
 * when the size differs. Every state-valued parameter folds a German, capitalized, umlauted, or English
 * state name to its code while advertising the same JSON Schema as before (#58). The
 * search-failure mapper gives a local rejection a recovery naming the field to correct, never
 * the page-first advice RIS's own errors need (#59). A date window whose `_from` is later than
 * its `_to` gets one notice naming every reversed pair and its swap (#92). A `norm` naming an
 * article spaced or as Artikel is searched under all three spellings RIS indexes, and a notice
 * quoting it reads back verbatim in `content[]` (#108). Fully offline: only
 * input schemas, schema-level rejections, the error mapper, and the page-size and notice helpers
 * are exercised, no handler and no service.
 * @module tests/tools/_shared.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';

import { risDocumentResource } from '@/mcp-server/resources/definitions/ris-document.resource.js';
import {
  delimitedArticleAdvice,
  escapedNoticeTrailer,
  failMinistrySearchError,
  failSearchError,
  foldCodeCase,
  isoDateString,
  joinNotices,
  reversedWindowNotice,
  rewriteNormArticles,
  servePageSize,
} from '@/mcp-server/tools/definitions/_shared.js';
import { risGetDocument } from '@/mcp-server/tools/definitions/ris-get-document.tool.js';
import { risListReference } from '@/mcp-server/tools/definitions/ris-list-reference.tool.js';
import { risLookupCitation } from '@/mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { risSearchCaseLaw } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { risSearchDrafts } from '@/mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { risSearchLegislation } from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';
import {
  foldStateName,
  RIS_APPLICATIONS,
  RIS_COURTS,
  RIS_STATES,
} from '@/services/ris/reference/index.js';

import { expectArgumentRejection, readCommonMark } from './_wire.js';

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

      it(`${tool}.${param} rejects an empty string rather than reading it as omitted`, () => {
        expect(() => schema.parse({ ...base, [param]: '' })).toThrow();
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

/** The slice of an advertised JSON Schema node the sweeps below read. */
interface SchemaNode {
  readonly anyOf?: readonly SchemaNode[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly items?: SchemaNode;
  readonly pattern?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly type?: unknown;
}

/** A definition's input schema as `tools/list` advertises it. */
function advertisedInput(definition: { readonly input: z.ZodType }): SchemaNode {
  return z.toJSONSchema(definition.input, { io: 'input' }) as SchemaNode;
}

/**
 * Every free-text leaf under `node` — a string that is neither an enum/const nor an ISO date —
 * reached through nested objects, array items (segment `[]`), and union branches, so a text
 * filter nested below the top level is found as surely as a flat one.
 */
function freeTextPaths(node: SchemaNode, path: readonly string[] = []): string[][] {
  const found: string[][] = [];
  // A union of primitives serializes as a type list (["string", "number"]), not anyOf.
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (
    types.includes('string') &&
    node.enum === undefined &&
    node.const === undefined &&
    node.pattern !== ISO_DATE_PATTERN
  ) {
    found.push([...path]);
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push(...freeTextPaths(child, [...path, key]));
  }
  if (node.items !== undefined) found.push(...freeTextPaths(node.items, [...path, '[]']));
  for (const branch of node.anyOf ?? []) found.push(...freeTextPaths(branch, path));
  return [...new Map(found.map((segments) => [segments.join('.'), segments])).values()];
}

/** The argument object that puts `value` at `path` (the inverse of the walk above). */
function argumentAt(path: readonly string[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  const inner = argumentAt(rest, value);
  return head === '[]' ? [inner] : { [head]: inner };
}

/**
 * The six tools that filter and page a result set, each with the minimal sibling input its
 * schema requires. Their free-text filters are what #39 guards: RIS reads a blank one as "no
 * filter" or ignores it, widening the query the caller meant to narrow.
 */
const FILTER_TOOLS = [
  { definition: risSearchLegislation, base: {} },
  { definition: risSearchCaseLaw, base: { court: 'vfgh' } },
  { definition: risSearchGazette, base: {} },
  { definition: risSearchDrafts, base: { stage: 'review_drafts' } },
  { definition: risSearchAnnouncements, base: { collection: 'social_insurance' } },
  { definition: risTrackChanges, base: { application: 'BrKons' } },
] as const;

/** The free-text filters the walk must find — pinned, so a new or lost filter is a visible diff. */
const FREE_TEXT_FILTERS: Readonly<Record<string, readonly string[]>> = {
  ris_search_legislation: [
    'query',
    'title',
    'municipality',
    'section_from',
    'section_to',
    'law_id',
    'index',
  ],
  ris_search_case_law: [
    'query',
    'norm',
    'case_number',
    'decision_kind',
    'collection_number',
    'issuing_body',
    'court_name',
    'subject_area',
    'party',
    'subject_law',
  ],
  ris_search_gazette: ['query', 'title', 'number', 'issuer', 'district_authority', 'municipality'],
  ris_search_drafts: ['query', 'title', 'ministry'],
  ris_search_announcements: [
    'query',
    'title',
    'number',
    'issuer',
    'norm',
    'case_number',
    'type',
    'department',
    'session_number',
    'legislature',
  ],
  ris_track_changes: [],
};

const DERIVED_FILTERS = FILTER_TOOLS.flatMap(({ base, definition }) =>
  freeTextPaths(advertisedInput(definition)).map((path) => ({
    base,
    definition,
    label: `${definition.name}.${path.join('.')}`,
    path,
  })),
);

describe('free-text filters — blank and whitespace-only rejected at the schema (#39)', () => {
  it('walks nested objects, array items, and union branches, not just top-level fields', () => {
    const nested = z.object({
      outer: z.object({ inner: z.string().describe('Nested text.') }).describe('Nested object.'),
      list: z.array(z.string().describe('Item.')).describe('Text list.'),
      either: z.union([z.string(), z.number()]).describe('Text or number.'),
      kind: z.enum(['a', 'b']).describe('Enum — not free text.'),
      when: isoDateString.describe('Date — not free text.'),
    });
    expect(freeTextPaths(advertisedInput({ input: nested }))).toEqual([
      ['outer', 'inner'],
      ['list', '[]'],
      ['either'],
    ]);
  });

  it('finds exactly the pinned free-text filters on the six filter tools — 36 in all', () => {
    const derived = Object.fromEntries(
      FILTER_TOOLS.map(({ definition }) => [
        definition.name,
        DERIVED_FILTERS.filter((entry) => entry.definition === definition).map((entry) =>
          entry.path.join('.'),
        ),
      ]),
    );
    expect(derived).toEqual(FREE_TEXT_FILTERS);
    expect(DERIVED_FILTERS).toHaveLength(36);
  });

  describe.each(DERIVED_FILTERS)('$label', ({ base, definition, path }) => {
    it.each([
      ['', 'an empty string'],
      ['   ', 'spaces only'],
      ['\t\n', 'a tab and a newline'],
      [' 　', 'non-breaking and ideographic spaces'],
    ])('rejects %j (%s), naming the field and telling the caller to omit it', (blank) => {
      const outcome = definition.input.safeParse({
        ...base,
        ...(argumentAt(path, blank) as object),
      });
      expect(outcome.success).toBe(false);
      expect(outcome.error?.issues).toEqual([
        expect.objectContaining({
          path,
          message: expect.stringContaining('omit the field to leave it unfiltered'),
        }),
      ]);
    });

    it('accepts a value with a non-whitespace character, unchanged — surrounding spaces kept', () => {
      const outcome = definition.input.safeParse({
        ...base,
        ...(argumentAt(path, ' x ') as object),
      });
      expect(outcome.success).toBe(true);
      const parsed = path.reduce<unknown>(
        (current, segment) =>
          segment === '[]'
            ? (current as unknown[])[0]
            : (current as Record<string, unknown>)[segment],
        outcome.data,
      );
      expect(parsed).toBe(' x ');
    });

    it('advertises a pattern that rejects whitespace-only, so a schema-validating client rejects before the call', () => {
      const node = path.reduce<SchemaNode>(
        (current, segment) =>
          (segment === '[]' ? current.items : current.properties?.[segment]) as SchemaNode,
        advertisedInput(definition),
      );
      expect(node.pattern).toBeDefined();
      const pattern = new RegExp(node.pattern as string, 'u');
      expect(pattern.test('   ')).toBe(false);
      expect(pattern.test('x')).toBe(true);
    });
  });
});

describe('page_size — 1–100 on every paginated tool (#40, #70)', () => {
  const PAGINATED = FILTER_TOOLS.filter(
    ({ definition }) => advertisedInput(definition).properties?.page_size !== undefined,
  );

  it('is carried by exactly the six paginated tools, derived from the advertised schemas', () => {
    const everyTool = ALL_TOOLS.filter(
      (definition) => advertisedInput(definition).properties?.page_size !== undefined,
    ).map((definition) => definition.name);
    expect(everyTool.toSorted()).toEqual(
      FILTER_TOOLS.map(({ definition }) => definition.name).toSorted(),
    );
    expect(PAGINATED).toHaveLength(6);
  });

  describe.each(PAGINATED)('$definition.name', ({ base, definition }) => {
    it('advertises a whole number from 1 to 100', () => {
      expect(advertisedInput(definition).properties?.page_size).toStrictEqual({
        description:
          'Documents per page, 1–100 (default 20). Served as a page of 10 (1–10) or 20 (11–100), with a notice when that differs. For more results, keep the size and raise page.',
        maximum: 100,
        minimum: 1,
        type: 'integer',
      });
    });

    it('accepts every whole number from 1 to 100', () => {
      const rejected = Array.from({ length: 100 }, (_, index) => index + 1).filter(
        (size) => !definition.input.safeParse({ ...base, page_size: size }).success,
      );
      expect(rejected).toEqual([]);
    });

    it('accepts an omitted page_size (RIS serves 20)', () => {
      const outcome = definition.input.safeParse(base);
      expect(outcome.success).toBe(true);
      expect((outcome.data as Record<string, unknown>).page_size).toBeUndefined();
    });

    /**
     * Each of these also fails over the wire. A numeric string such as "20" is left out: the
     * framework repairs it to a number before the schema runs, so clients get it served
     * (paging.test.ts); a non-numeric string reaches the schema's type check and fails here.
     */
    it.each([0, -1, 1.5, 101, 1e9, 'twenty'])('rejects %j, naming 1–100 and page', (size) => {
      const outcome = definition.input.safeParse({ ...base, page_size: size });
      expect(outcome.success).toBe(false);
      const [issue] = outcome.error?.issues ?? [];
      expect(issue?.path).toEqual(['page_size']);
      expect(issue?.message).toBe(
        'Expected a whole number 1–100 (default 20) — it is served as a page of 10 or 20; raise page to read further results.',
      );
    });
  });
});

describe('servePageSize — the one requested → served mapping (#70)', () => {
  it('leaves an omitted page_size to RIS: no size sent, no notice', () => {
    expect(servePageSize(undefined)).toStrictEqual({});
  });

  it.each([10, 20])('sends %d as requested, with no notice', (size) => {
    expect(servePageSize(size)).toStrictEqual({ pageSize: size });
  });

  it.each([
    [1, 10],
    [2, 10],
    [9, 10],
    [11, 20],
    [12, 20],
    [19, 20],
    [21, 20],
    [99, 20],
    [100, 20],
  ])('serves %d as %d, with the notice naming both', (requested, served) => {
    expect(servePageSize(requested)).toStrictEqual({
      notice: `page_size ${requested} served as ${served} — this server serves pages of 10 or 20 documents, so page steps through pages of ${served}.`,
      pageSize: served,
    });
  });
});

describe('joinNotices — one notice string, in order (#70)', () => {
  it.each([
    [[undefined, undefined], undefined],
    [[undefined, 'Zero hits.'], 'Zero hits.'],
    [['Served as 20.', undefined], 'Served as 20.'],
    [['Served as 20.', 'Zero hits.'], 'Served as 20. Zero hits.'],
  ] as const)('%j → %j', (notices, joined) => {
    expect(joinNotices(...notices)).toBe(joined);
  });
});

describe('reversedWindowNotice — a window whose _from is later than its _to (#92)', () => {
  it.each([
    [undefined, undefined, 'no bound'],
    ['2026-10-28', undefined, 'only changed_from — open-ended'],
    [undefined, '2026-10-27', 'only changed_to — open-ended'],
    ['2026-10-28', '2026-10-28', 'equal bounds — a one-day window'],
    ['2026-10-27', '2026-10-28', 'ordered bounds'],
    ['1999-12-31', '2000-01-01', 'ordered across a year boundary'],
  ] as const)('%s → %s (%s) is not reversed', (from, to, _label) => {
    expect(reversedWindowNotice([['changed_from', from, 'changed_to', to]])).toBeUndefined();
  });

  it('names both fields and their values, says the window is reversed, and gives the swap', () => {
    expect(reversedWindowNotice([['changed_from', '2026-10-28', 'changed_to', '2026-10-27']])).toBe(
      'changed_from 2026-10-28 is after changed_to 2026-10-27 — a reversed window holds no dates, so nothing matches and RIS was not queried. Retry with the bounds swapped: changed_from 2026-10-27, changed_to 2026-10-28.',
    );
  });

  it.each([
    ['2000-01-01', '1999-12-31', 'across a year boundary'],
    ['2026-02-01', '2026-01-31', 'across a month boundary'],
    ['2026-10-10', '2026-10-09', 'across a day-digit carry'],
  ])('%s → %s (%s) is reversed', (from, to) => {
    expect(reversedWindowNotice([['decided_from', from, 'decided_to', to]])).toBe(
      `decided_from ${from} is after decided_to ${to} — a reversed window holds no dates, so nothing matches and RIS was not queried. Retry with the bounds swapped: decided_from ${to}, decided_to ${from}.`,
    );
  });

  it('names every reversed pair in one notice, in the order given', () => {
    expect(
      reversedWindowNotice([
        ['entered_force_from', '2026-06-30', 'entered_force_to', '2026-01-01'],
        ['left_force_from', '2025-12-31', 'left_force_to', '2025-07-01'],
      ]),
    ).toBe(
      'entered_force_from 2026-06-30 is after entered_force_to 2026-01-01; left_force_from 2025-12-31 is after left_force_to 2025-07-01 — a reversed window holds no dates, so nothing matches and RIS was not queried. Retry with the bounds swapped: entered_force_from 2026-01-01, entered_force_to 2026-06-30; left_force_from 2025-07-01, left_force_to 2025-12-31.',
    );
  });

  it('names only the reversed pair when the other one is ordered or one-sided', () => {
    const notice =
      'published_from 2026-03-01 is after published_to 2026-02-01 — a reversed window holds no dates, so nothing matches and RIS was not queried. Retry with the bounds swapped: published_from 2026-02-01, published_to 2026-03-01.';
    expect(
      reversedWindowNotice([
        ['published_from', '2026-03-01', 'published_to', '2026-02-01'],
        ['entered_force_from', '2026-01-01', 'entered_force_to', '2026-06-30'],
      ]),
    ).toBe(notice);
    expect(
      reversedWindowNotice([
        ['entered_force_from', '2026-07-01', 'entered_force_to', undefined],
        ['published_from', '2026-03-01', 'published_to', '2026-02-01'],
      ]),
    ).toBe(notice);
  });
});

// RIS indexes an article three ways that never match one another — joined Art6, spaced Art. 6,
// and Artikel 6 — while reading a period as nothing, so an article token in any of them is sent
// as an ODER of all three. Both norm filters route through this helper; their tests prove the
// wiring.
describe('rewriteNormArticles — an article searched under every spelling RIS indexes (#108)', () => {
  const ART_6_DSGVO = '(Art6 DSGVO) ODER (Art 6 DSGVO) ODER (Artikel 6 DSGVO)';
  const ART_6_MRK = '(Art6 MRK) ODER (Art 6 MRK) ODER (Artikel 6 MRK)';

  it.each([
    ['Art. 6 DSGVO', ART_6_DSGVO, 'the citation form'],
    ['Art.6 DSGVO', ART_6_DSGVO, 'no space after the period'],
    ['Art 6 DSGVO', ART_6_DSGVO, 'no period'],
    ['Art6 DSGVO', ART_6_DSGVO, 'joined'],
    [
      'DSGVO Art32',
      '(DSGVO Art32) ODER (DSGVO Art 32) ODER (DSGVO Artikel 32)',
      'joined, the law first',
    ],
    [
      'ArtIX EGJN',
      '(ArtIX EGJN) ODER (Art IX EGJN) ODER (Artikel IX EGJN)',
      'a joined Roman numeral',
    ],
    ['art 6 dsgvo', '(Art6 dsgvo) ODER (Art 6 dsgvo) ODER (Artikel 6 dsgvo)', 'lower case'],
    ['Artikel 6 MRK', ART_6_MRK, 'Artikel'],
    ['ARTIKEL 6 MRK', ART_6_MRK, 'Artikel in capitals'],
    ['Art. IX EGJN', '(ArtIX EGJN) ODER (Art IX EGJN) ODER (Artikel IX EGJN)', 'a Roman numeral'],
    [
      'Art. 15a B-VG',
      '(Art15a B-VG) ODER (Art 15a B-VG) ODER (Artikel 15a B-VG)',
      'an attached letter',
    ],
    ['DSGVO Art. 6', '(DSGVO Art6) ODER (DSGVO Art 6) ODER (DSGVO Artikel 6)', 'the law first'],
    [
      'Art. 6 Abs. 1 lit. f DSGVO',
      '(Art6 Abs. 1 lit. f DSGVO) ODER (Art 6 Abs. 1 lit. f DSGVO) ODER (Artikel 6 Abs. 1 lit. f DSGVO)',
      'Abs. and lit. left as written',
    ],
    [
      'Art. 6 DSGVO ODER Art. 140 B-VG',
      '(Art6 DSGVO ODER Art140 B-VG) ODER (Art 6 DSGVO ODER Art 140 B-VG) ODER (Artikel 6 DSGVO ODER Artikel 140 B-VG)',
      'every token respelled, the caller’s ODER inside each arm',
    ],
    [
      'Art. 6 DSGVO NICHT Abs1',
      '(Art6 DSGVO NICHT Abs1) ODER (Art 6 DSGVO NICHT Abs1) ODER (Artikel 6 DSGVO NICHT Abs1)',
      'the caller’s NICHT inside each arm',
    ],
    [
      'Art. 6 DSGVO UND B-VG Art140',
      '(Art6 DSGVO UND B-VG Art140) ODER (Art 6 DSGVO UND B-VG Art 140) ODER (Artikel 6 DSGVO UND B-VG Artikel 140) ODER (Art. 6 DSGVO UND B-VG Art140)',
      'spaced beside joined — both respelled per arm, plus the value as written',
    ],
    [
      'Art6 DSGVO UND Art. 7 DSGVO',
      '(Art6 DSGVO UND Art7 DSGVO) ODER (Art 6 DSGVO UND Art 7 DSGVO) ODER (Artikel 6 DSGVO UND Artikel 7 DSGVO) ODER (Art6 DSGVO UND Art. 7 DSGVO)',
      'joined beside spaced — plus the value as written',
    ],
    [
      'Art. 6 DSGVO UND Artikel 7 DSGVO',
      '(Art6 DSGVO UND Art7 DSGVO) ODER (Art 6 DSGVO UND Art 7 DSGVO) ODER (Artikel 6 DSGVO UND Artikel 7 DSGVO) ODER (Art. 6 DSGVO UND Artikel 7 DSGVO)',
      'spaced beside Artikel — plus the value as written',
    ],
    [
      'Art.6 DSGVO UND Art 7 DSGVO',
      '(Art6 DSGVO UND Art7 DSGVO) ODER (Art 6 DSGVO UND Art 7 DSGVO) ODER (Artikel 6 DSGVO UND Artikel 7 DSGVO)',
      'Art.6 beside Art 7 — one spelling, since RIS reads the period as a space',
    ],
    ['Art.\t \n6 DSGVO', ART_6_DSGVO, 'a whitespace run'],
    ['  Art. 6 DSGVO\t', ART_6_DSGVO, 'edge whitespace'],
    [
      'Art 57, 58, 96 B-VG',
      '(Art57, 58, 96 B-VG) ODER (Art 57, 58, 96 B-VG) ODER (Artikel 57, 58, 96 B-VG)',
      'a comma list — only the number after Art is a token',
    ],
    [
      'B-VG Art 14 b',
      '(B-VG Art14 b) ODER (B-VG Art 14 b) ODER (B-VG Artikel 14 b)',
      'a letter set apart — the number alone is the token',
    ],
  ])('%j → %s (%s)', (norm, expression) => {
    expect(rewriteNormArticles(norm)?.expression).toBe(expression);
  });

  it.each([
    ['DSG §1', 'no article'],
    ['Artikel6 MRK', 'Artikel with no space'],
    ['ARTIKEL6 MRK', 'Artikel in capitals with no space'],
    ['Art. ix EGJN', 'a lower-case Roman numeral'],
    ['Art. 6ab DSGVO', 'two letters after the number'],
    ['Art. 6b2 DSGVO', 'a number running into a letter and a digit'],
    ['Grundart 6', 'Art ending a longer word'],
    ['ArtSchG 6', 'Art opening a longer word'],
    ['Art. Abs1', 'no number'],
    ['(Art. 6 DSGVO)', 'parentheses'],
    ['Art. 6 DSGVO)', 'a lone closing parenthesis'],
    ['"Art. 6 DSGVO"', 'a quoted phrase'],
    ['Art. 6 DSGVO"', 'a lone quote'],
  ])('%j is sent as written (%s)', (norm) => {
    expect(rewriteNormArticles(norm)).toBeUndefined();
  });

  it('names the expression it searched in the notice', () => {
    expect(rewriteNormArticles('Art. 6 DSGVO')?.notice).toBe(
      'norm searched as (Art6 DSGVO) ODER (Art 6 DSGVO) ODER (Artikel 6 DSGVO) — RIS indexes an article as Art6, Art 6, or Artikel 6, and each spelling matches only entries indexed that way.',
    );
  });

  // The notice spells out the first article's three spellings, whatever its number.
  it.each([
    ['Art. 57 B-VG', 'Art57, Art 57, or Artikel 57'],
    ['DSGVO Art32', 'Art32, Art 32, or Artikel 32'],
    ['Art. IX EGJN', 'ArtIX, Art IX, or Artikel IX'],
    ['Art. 15a B-VG', 'Art15a, Art 15a, or Artikel 15a'],
    ['B-VG Art140 UND Art. 6 DSGVO', 'Art140, Art 140, or Artikel 140'],
  ])('names the spellings of the first article in %j: %s', (norm, spellings) => {
    const rewrite = rewriteNormArticles(norm);
    expect(rewrite?.notice).toBe(
      `norm searched as ${rewrite?.expression} — RIS indexes an article as ${spellings}, and each spelling matches only entries indexed that way.`,
    );
  });
});

// A norm sent as written because it carries ( ) or " still names an article; its zero-hit advice
// says the article matched only as spelled, never to copy a norms_cited string in one spelling.
describe('delimitedArticleAdvice — an article in a norm sent as written (#108)', () => {
  const advice = (spellings: string) =>
    `norm carries ( ) or ", so it was sent as written and each article matched only as spelled — RIS indexes an article as ${spellings}, and each spelling matches only entries indexed that way. Drop the ( ) and " to search every spelling, or copy the exact string from a result's norms_cited.`;

  it.each([
    ['(Art 6 DSGVO)', 'Art6, Art 6, or Artikel 6'],
    ['"Art. 57 B-VG"', 'Art57, Art 57, or Artikel 57'],
    ['Art. 6 DSGVO)', 'Art6, Art 6, or Artikel 6'],
    ['(DSG §1) UND (Artikel 8 MRK)', 'Art8, Art 8, or Artikel 8'],
  ])('advises on %j with %s', (norm, spellings) => {
    expect(rewriteNormArticles(norm)).toBeUndefined();
    expect(delimitedArticleAdvice(norm)).toBe(advice(spellings));
  });

  it.each([
    ['Art. 6 DSGVO', 'no delimiter — the value is rewritten instead'],
    ['(DSG §1)', 'a delimiter but no article'],
    ['DSG §1', 'neither'],
    ['(Artikel6 MRK)', 'a delimiter and an Artikel run into its number, which is no token'],
  ])('gives none for %j (%s)', (norm) => {
    expect(delimitedArticleAdvice(norm)).toBeUndefined();
  });
});

// The search tools' notices now quote a caller's norm, which can hold the * wildcard, _, <, or
// backticks — so the trailer escapes the notice before quoting it, as ris_get_document's does.
describe('escapedNoticeTrailer — a notice quoting caller text reads back verbatim (#108)', () => {
  const blockquote = (notice: string) =>
    ['⟨blockquote_open⟩', notice, '⟨blockquote_close⟩'].join('\n\n');

  it('renders a notice with nothing to escape as the framework’s own block quote', () => {
    const notice = '0 decisions in vwgh. Other courts are separate calls — repeat per court.';
    expect(escapedNoticeTrailer.render(notice)).toBe(`> ${notice}`);
  });

  it.each([
    'norm searched as (Art6 *DSGVO* <b>) ODER (Art 6 *DSGVO* <b>)',
    'a `code` _em_ [link](x) ~~strike~~ | pipe \\ backslash',
    'two lines\n- the second opens a list',
  ])('reads back %j as one block quote holding it as written', (notice) => {
    expect(readCommonMark(escapedNoticeTrailer.render(notice))).toBe(blockquote(notice));
  });

  // Escaping turns every line break into a hard break before the notice is quoted, so a blank
  // line stays inside the one paragraph and no line of the quote is bare — unlike the
  // framework's own trailer, which quotes the notice unescaped and a blank line as `>`.
  it('quotes a blank line as a hard break inside the one paragraph', () => {
    expect(escapedNoticeTrailer.render('a\n\nb')).toBe('> a\\\n> \\\n> b');
  });
});

const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];

/** Thread-CPU milliseconds of one call, the fastest of three samples of ≥ 10 ms each. */
function cpuMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    let runs = 0;
    let ms = 0;
    do {
      run();
      runs++;
      const { user, system } = process.threadCpuUsage(start);
      ms = (user + system) / 1_000;
    } while (ms < 10);
    best = Math.min(best, ms / runs);
  }
  return best;
}

// The rewrite runs over the caller's norm before any request: one delimiter test, one search,
// and three replacements, each of which must stay linear in the value's length. The zero-hit
// advice for a delimited value runs the same token search, so it is timed on the same shapes
// behind an opening parenthesis.
describe('rewriteNormArticles — time on adversarial input', () => {
  /** Bound on one call at 320,000 characters; the slowest shape, every word a token, takes ~15 ms. */
  const BOUND_MS = 100;

  const SHAPES: [string, (size: number) => string][] = [
    ['a long digit run ending in two letters', (size) => `Art ${'1'.repeat(size)}xy`],
    ['a long Roman-numeral run ending in a letter', (size) => `Art ${'I'.repeat(size)}x`],
    ['a whitespace run after Art. with no number', (size) => `Art.${' '.repeat(size)}x`],
    ['repeated Art. with no number', (size) => 'Art.'.repeat(size / 4)],
    ['repeated Artikel with no number', (size) => 'Artikel '.repeat(size / 8)],
    ['joined Roman prefixes running into the next Art', (size) => 'ArtI'.repeat(size / 4)],
    ['overlapping token prefixes', (size) => `${'Art 1x'.repeat(size / 6)}y`],
    ['every word a token', (size) => 'Art. 6 '.repeat(size / 7)],
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['line breaks throughout', (size) => '  \r\n'.repeat(size / 4)],
    ['Art. before every line break', (size) => 'Art.  \r\n'.repeat(size / 8)],
  ];

  /** Time `run` on `make` at every size, the bound checked before the next size runs. */
  function expectLinear(make: (size: number) => string, run: (input: string) => unknown): void {
    const times: number[] = [];
    for (const size of SIZES) {
      const input = make(size);
      const ms = cpuMs(() => run(input));
      expect(ms, `${size} characters`).toBeLessThan(BOUND_MS);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
  }

  it.each(SHAPES)('stays linear on %s', (_shape, make) => {
    expectLinear(make, rewriteNormArticles);
  });

  it.each(SHAPES)('delimitedArticleAdvice stays linear on %s', (_shape, make) => {
    expectLinear((size) => `(${make(size)}`, delimitedArticleAdvice);
  });
});

/** The nine state codes, in the order every state enum lists them. */
const STATE_CODES = RIS_STATES.map((state) => state.code);

/**
 * Every state-valued parameter on the surface, as it was declared before the fold: its enum
 * values, its default, and the minimal sibling input its tool requires. The sweep below derives
 * the same set from the advertised schemas, so a state parameter added later must land here.
 */
const STATE_FIELDS: ReadonlyArray<{
  readonly base: Readonly<Record<string, unknown>>;
  readonly default?: string;
  readonly definition: { readonly input: z.ZodObject; readonly name: string };
  readonly field: string;
  readonly values: readonly [string, ...string[]];
}> = [
  {
    definition: risSearchLegislation,
    field: 'scope',
    base: {},
    values: ['federal', ...STATE_CODES],
    default: 'federal',
  },
  {
    definition: risSearchGazette,
    field: 'scope',
    base: {},
    values: ['federal', ...STATE_CODES, 'district', 'municipal'],
    default: 'federal',
  },
  {
    definition: risSearchCaseLaw,
    field: 'state',
    base: { court: 'lvwg' },
    values: STATE_CODES as [string, ...string[]],
  },
  {
    definition: risLookupCitation,
    field: 'state',
    base: { citation: '§ 1 DSG' },
    values: STATE_CODES as [string, ...string[]],
  },
  {
    definition: risSearchAnnouncements,
    field: 'plan_state',
    base: { collection: 'health_structure_plans' },
    values: STATE_CODES as [string, ...string[]],
  },
];

/** Spellings every state field folds to a code: the cases #58 pins, then the edges around them. */
const FOLDED: ReadonlyArray<readonly [string, string, string]> = [
  ['Wien', 'wien', 'the German name'],
  ['Niederösterreich', 'niederoesterreich', 'a composed (NFC) umlaut'],
  ['Niederösterreich'.normalize('NFD'), 'niederoesterreich', 'a decomposed (NFD) umlaut'],
  ['niederösterreich', 'niederoesterreich', 'a lowercase umlauted name'],
  ['OBERÖSTERREICH', 'oberoesterreich', 'an all-caps name with an umlaut'],
  ['Kärnten', 'kaernten', 'ä'],
  ['Kaernten', 'kaernten', 'the capitalized transliteration'],
  [' Steiermark ', 'steiermark', 'surrounding spaces'],
  ['\tTirol\n', 'tirol', 'a tab and a newline'],
  ['Vienna', 'wien', 'an English name'],
  ['Lower Austria', 'niederoesterreich', 'a two-word English name'],
  ['upper   AUSTRIA', 'oberoesterreich', 'a doubled inner space and mixed case'],
  ['Tyrol', 'tirol', 'Tyrol'],
  ['Carinthia', 'kaernten', 'Carinthia'],
  ['Styria', 'steiermark', 'Styria'],
  ['Vorarlberg', 'vorarlberg', 'a name English shares'],
];

describe('foldStateName', () => {
  const SCOPE = new Set(['federal', ...STATE_CODES]);

  it.each(FOLDED)('folds %j to %s (%s)', (sent, code) => {
    expect(foldStateName(sent, SCOPE)).toBe(code);
  });

  it('folds every German name, both RIS spellings, and the code itself, in any case, to that code', () => {
    for (const state of RIS_STATES) {
      const spellings = [state.code, state.name, state.flatAscii, state.flatUmlaut];
      for (const spelling of spellings) {
        for (const variant of [
          spelling,
          spelling.toUpperCase(),
          spelling.normalize('NFD'),
          ` ${spelling} `,
        ]) {
          expect(foldStateName(variant, SCOPE), JSON.stringify(variant)).toBe(state.code);
        }
      }
    }
  });

  it('folds a non-state value of the field (federal) only where the field accepts it', () => {
    expect(foldStateName('FEDERAL', SCOPE)).toBe('federal');
    expect(foldStateName('Federal', new Set(STATE_CODES))).toBe('Federal');
  });

  it('returns an English name unchanged when the field does not accept its state', () => {
    expect(foldStateName('Vienna', new Set(['federal']))).toBe('Vienna');
  });

  it.each([
    ['Bayern', 'a German state outside Austria'],
    ['  Bayern ', 'an unknown name with padding — returned untrimmed'],
    ['', 'an empty string'],
    ['Nieder-Österreich', 'a hyphenated spelling RIS never uses'],
    ['Vienna, Austria', 'a qualified English name'],
  ])('returns %j exactly as sent (%s)', (sent) => {
    expect(foldStateName(sent, SCOPE)).toBe(sent);
  });

  it.each([3, null, undefined, true, ['wien'], { state: 'wien' }])(
    'returns the non-string %j untouched',
    (sent) => {
      expect(foldStateName(sent, SCOPE)).toBe(sent);
    },
  );
});

// Each fold runs over a caller-sized string before the enum sees it.
describe('foldStateName and foldCodeCase — time on adversarial input', () => {
  /** Bound on one call at 320,000 characters; linear work there takes about a millisecond. */
  const BOUND_MS = 50;
  const SCOPE = new Set(['federal', ...STATE_CODES]);
  const COURT = foldCodeCase(
    z.enum(RIS_COURTS.map((court) => court.code) as [string, ...string[]]),
    { definition: 'test', field: 'court' },
  );

  it.each<[string, (size: number) => string]>([
    ['a long digit run', (size) => '1'.repeat(size)],
    [
      'a whitespace run around a name',
      (size) => `${' '.repeat(size / 2)}Wien${' '.repeat(size / 2)}`,
    ],
    ['alternating letters and spaces', (size) => 'a '.repeat(size / 2)],
    ['decomposed umlauts (o + U+0308)', (size) => 'ö'.repeat(size / 2)],
  ])('stays linear on %s', (_shape, make) => {
    const times: number[] = [];
    for (const size of SIZES) {
      const input = make(size);
      const ms = cpuMs(() => foldStateName(input, SCOPE));
      expect(ms, `${size} characters`).toBeLessThan(BOUND_MS);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
  });

  it.each<[string, (size: number) => string]>([
    ['a long digit run', (size) => '1'.repeat(size)],
    [
      'a whitespace run around a code',
      (size) => `${' '.repeat(size / 2)}Vfgh${' '.repeat(size / 2)}`,
    ],
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['line breaks throughout', (size) => '  \r\n'.repeat(size / 4)],
  ])('foldCodeCase stays linear on %s', (_shape, make) => {
    const times: number[] = [];
    for (const size of SIZES) {
      const input = make(size);
      const ms = cpuMs(() => COURT.safeParse(input));
      expect(ms, `${size} characters`).toBeLessThan(BOUND_MS);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
  });
});

/** The advertised node of each property whose enum lists all nine state codes. */
function stateEnumParams(definition: { readonly input: z.ZodType; readonly name: string }) {
  return Object.entries(advertisedInput(definition).properties ?? {})
    .filter(([, node]) => STATE_CODES.every((code) => node.enum?.includes(code)))
    .map(([param]) => `${definition.name}.${param}`);
}

/** The JSON Schema `tools/list` advertises for an input — the call the MCP SDK makes. */
function wireSchema(input: z.ZodType): unknown {
  return (
    input as unknown as {
      '~standard': { jsonSchema: { input: (options: { target: string }) => unknown } };
    }
  )['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
}

describe('state parameters — German and English names fold to the code (#58)', () => {
  it('covers every parameter whose enum lists the nine state codes, on every tool', () => {
    expect(ALL_TOOLS.flatMap(stateEnumParams).toSorted()).toEqual(
      STATE_FIELDS.map(({ definition, field }) => `${definition.name}.${field}`).toSorted(),
    );
  });

  describe.each(STATE_FIELDS)('$definition.name.$field', (entry) => {
    const { base, definition, field, values } = entry;
    const parse = (value: unknown) => definition.input.safeParse({ ...base, [field]: value });

    it.each(FOLDED)('accepts %j as %s (%s)', (sent, code) => {
      const outcome = parse(sent);
      expect(outcome.success).toBe(true);
      expect((outcome.data as Record<string, unknown>)[field]).toBe(code);
    });

    it.each(values)('accepts the code %s unchanged', (code) => {
      const outcome = parse(code);
      expect((outcome.data as Record<string, unknown>)[field]).toBe(code);
    });

    it(`reads an omitted ${field} as ${entry.default ?? 'unset'}`, () => {
      const outcome = definition.input.safeParse(base);
      expect(outcome.success).toBe(true);
      expect((outcome.data as Record<string, unknown>)[field]).toBe(entry.default);
    });

    it('treats "Federal" as federal only where federal is one of the values', () => {
      const outcome = parse('Federal');
      expect(outcome.success).toBe(values.includes('federal'));
      if (outcome.success) expect((outcome.data as Record<string, unknown>)[field]).toBe('federal');
    });

    it.each<[unknown, string]>([
      ['Bayern', 'a state outside Austria'],
      ['', 'an empty string'],
      [3, 'a number'],
    ])('rejects %j as invalid_arguments, naming the field and its codes', async (sent) => {
      const result = await runToolContract(
        definition as never,
        { ...base, [field]: sent } as never,
      );
      expectArgumentRejection(result, [
        `${field}: Invalid option`,
        values.map((value) => `"${value}"`).join('|'),
      ]);
    });

    it('advertises the same JSON Schema as the plain enum it wraps — only the key order moves', () => {
      const plain = z.enum(values);
      const before = (
        entry.default === undefined ? plain.optional() : plain.default(entry.default)
      ).describe(String(definition.input.shape[field]?.description));
      expect(wireSchema(definition.input)).toStrictEqual(
        wireSchema(definition.input.extend({ [field]: before })),
      );
    });
  });
});

/** Every court code, in the order the case-law enum lists them. */
const COURT_CODES = RIS_COURTS.map((court) => court.code) as [string, ...string[]];
/** The court hint's codes: every court but normenliste, a norm index that carries no case numbers. */
const CASE_NUMBER_COURTS = COURT_CODES.filter((code) => code !== 'normenliste') as [
  string,
  ...string[],
];
/** Every application code, in the order the application enums list them. */
const APPLICATION_CODES = RIS_APPLICATIONS.map((app) => app.code) as [string, ...string[]];

/**
 * Every court- or application-valued parameter, with its codes, one spelling that folds to a
 * code, whether it may be omitted, and the minimal sibling input it needs. The fold itself is
 * tabled once, on its helper; these rows prove only that each field is wired to it. The sweep
 * below derives the tool rows from the advertised schemas, so a parameter added later must
 * land here.
 */
const CODE_FIELDS: ReadonlyArray<{
  readonly base: Readonly<Record<string, unknown>>;
  readonly definition: { readonly input: z.ZodObject; readonly name: string };
  readonly field: string;
  readonly folds: readonly [sent: string, code: string];
  readonly optional: boolean;
  readonly values: readonly [string, ...string[]];
}> = [
  {
    definition: risSearchCaseLaw,
    field: 'court',
    base: { query: 'Datenschutz' },
    folds: ['Vfgh', 'vfgh'],
    optional: false,
    values: COURT_CODES,
  },
  {
    definition: risLookupCitation,
    field: 'court',
    base: { citation: 'G 287/2022' },
    folds: [' VfGH ', 'vfgh'],
    optional: true,
    values: CASE_NUMBER_COURTS,
  },
  {
    definition: risGetDocument,
    field: 'application',
    base: { document_number: 'NOR40262691' },
    folds: ['vfgh', 'Vfgh'],
    optional: true,
    values: APPLICATION_CODES,
  },
  {
    definition: risTrackChanges,
    field: 'application',
    base: {},
    folds: ['BRKONS', 'BrKons'],
    optional: false,
    values: APPLICATION_CODES,
  },
  {
    definition: { name: 'ris_document', input: risDocumentResource.params as z.ZodObject },
    field: 'application',
    base: { documentNumber: 'NOR40262691' },
    folds: ['brkons', 'BrKons'],
    optional: false,
    values: APPLICATION_CODES,
  },
];

describe('foldCodeCase — a code in any letter case, padded or not, folds to the code (#107)', () => {
  const SITE = { definition: 'test', field: 'code' } as const;
  const COURT = foldCodeCase(z.enum(COURT_CODES), SITE);
  const APPLICATION = foldCodeCase(z.enum(APPLICATION_CODES).optional(), SITE);

  it.each<[z.ZodType, string, string, string]>([
    [COURT, 'Vfgh', 'vfgh', 'the spelling a case-law record carries'],
    [COURT, 'VfGH', 'vfgh', 'the spelling the court uses itself'],
    [COURT, 'JUSTIZ', 'justiz', 'all caps'],
    [COURT, ' vwgh ', 'vwgh', 'surrounding spaces'],
    [COURT, '\tAsylGH\n', 'asylgh', 'a tab, a newline, and an inner capital'],
    [APPLICATION, 'vfgh', 'Vfgh', 'the lowercase court code a caller searched with'],
    [APPLICATION, 'VFGH', 'Vfgh', 'all caps'],
    [APPLICATION, 'brkons', 'BrKons', 'a lowercase code with an inner capital'],
    [APPLICATION, ' LGBLAUTH ', 'LgblAuth', 'all caps with surrounding spaces'],
  ])('folds %#: %j to %s (%s)', (schema, sent, code) => {
    expect(schema.parse(sent)).toBe(code);
  });

  it('folds every court and application code, lowercased or uppercased, to itself', () => {
    for (const [schema, codes] of [
      [COURT, COURT_CODES],
      [APPLICATION, APPLICATION_CODES],
    ] as const) {
      for (const code of codes) {
        expect(schema.parse(code.toLowerCase()), code).toBe(code);
        expect(schema.parse(code.toUpperCase()), code).toBe(code);
      }
    }
  });

  it.each(['OGH', 'DSB', '', ' ', 'v fgh', 'vfgh.', 'vfghx', 'Vfgh Vwgh'])(
    'passes %j to the enum as sent, which rejects it',
    (sent) => {
      const outcome = COURT.safeParse(sent, { reportInput: true });
      expect(outcome.success).toBe(false);
      expect(outcome.error?.issues[0]?.input).toBe(sent);
    },
  );

  it.each([7, null, true, ['vfgh'], { court: 'vfgh' }])(
    'passes the non-string %j to the enum untouched',
    (sent) => {
      const outcome = COURT.safeParse(sent, { reportInput: true });
      expect(outcome.success).toBe(false);
      expect(outcome.error?.issues[0]?.input).toBe(sent);
    },
  );

  it('keeps an optional field optional and a default as the default', () => {
    expect(APPLICATION.parse(undefined)).toBeUndefined();
    expect(foldCodeCase(z.enum(['Abc', 'Xyz']).default('Xyz'), SITE).parse(undefined)).toBe('Xyz');
  });

  it('refuses an enum whose codes differ only in letter case, where a fold could name either', () => {
    expect(() => foldCodeCase(z.enum(['Abc', 'abc']), SITE)).toThrow(
      'test code: two codes differ only in letter case.',
    );
  });
});

/** The advertised node of each property whose enum lists every case-number court or every application. */
function codeEnumParams(definition: { readonly input: z.ZodType; readonly name: string }) {
  return Object.entries(advertisedInput(definition).properties ?? {})
    .filter(([, node]) =>
      [CASE_NUMBER_COURTS, APPLICATION_CODES].some((codes) =>
        codes.every((code) => node.enum?.includes(code)),
      ),
    )
    .map(([param]) => `${definition.name}.${param}`);
}

describe('court and application codes — any letter case folds to the code (#107)', () => {
  it('covers every parameter whose enum lists the court or application codes, on every tool', () => {
    expect(ALL_TOOLS.flatMap(codeEnumParams).toSorted()).toEqual(
      CODE_FIELDS.filter(({ definition }) => definition.name !== 'ris_document')
        .map(({ definition, field }) => `${definition.name}.${field}`)
        .toSorted(),
    );
  });

  it('folds the court value every case-law record carries to its code on ris_search_case_law', () => {
    for (const court of RIS_COURTS) {
      const outcome = risSearchCaseLaw.input.safeParse({ court: court.application, query: 'x' });
      expect(outcome.data?.court, court.application).toBe(court.code);
    }
  });

  it('rejects Normenliste on the ris_lookup_citation court hint, whose codes omit the norm index', async () => {
    const result = await runToolContract(risLookupCitation, {
      citation: 'G 287/2022',
      court: 'Normenliste' as never,
    });
    expectArgumentRejection(result, [
      'court: Invalid option',
      CASE_NUMBER_COURTS.map((code) => `"${code}"`).join('|'),
    ]);
  });

  describe.each(
    CODE_FIELDS.map((entry) => [`${entry.definition.name}.${entry.field}`, entry] as const),
  )('%s', (_param, entry) => {
    const { base, definition, field, values } = entry;
    const [sent, code] = entry.folds;
    const parse = (value: unknown) => definition.input.safeParse({ ...base, [field]: value });

    it(`folds ${JSON.stringify(sent)} to ${code}`, () => {
      const outcome = parse(sent);
      expect(outcome.success).toBe(true);
      expect((outcome.data as Record<string, unknown>)[field]).toBe(code);
    });

    it('accepts every code unchanged', () => {
      for (const value of values) {
        expect((parse(value).data as Record<string, unknown>)[field], value).toBe(value);
      }
    });

    it.each<[unknown, string]>([
      ['OGH', 'a court name that is not a code'],
      ['DSB', 'an authority abbreviation that is not a code'],
      ['', 'an empty string'],
      [7, 'a number'],
    ])('rejects %j (%s) with the enum message naming the field and its codes', async (bad) => {
      const options = values.map((value) => `"${value}"`).join('|');
      if (definition.name === 'ris_document') {
        const outcome = parse(bad);
        expect(outcome.success).toBe(false);
        expect(outcome.error?.issues.map((issue) => issue.message)).toEqual([
          `Invalid option: expected one of ${options}`,
        ]);
        return;
      }
      const result = await runToolContract(definition as never, { ...base, [field]: bad } as never);
      expectArgumentRejection(result, [`${field}: Invalid option`, options]);
    });

    it('advertises the same JSON Schema as the plain enum it wraps — only the key order moves', () => {
      const plain = z.enum(values);
      const before = (entry.optional ? plain.optional() : plain).describe(
        String(definition.input.shape[field]?.description),
      );
      expect(wireSchema(definition.input)).toStrictEqual(
        wireSchema(definition.input.extend({ [field]: before })),
      );
    });
  });
});

describe('failSearchError — local rejections recover by naming the field (#59)', () => {
  /** The search tools' shared reasons, declared the way each tool declares them. */
  const ERRORS = [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A page past the end, or a rejected parameter value.',
      recovery: 'For a page past the end, request a lower page, starting from 1.',
    },
    {
      reason: 'unresolved_ministry',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A ministry did not resolve.',
      recovery: 'Pass a ministry from ris_list_reference topic ministries.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'RIS is unreachable.',
      recovery: 'RIS is temporarily unavailable — retry after a short delay.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'RIS did not answer in time.',
      recovery: 'RIS did not answer in time — retry the same search shortly.',
    },
  ] as const;

  function mapped(error: McpError, fields?: Readonly<Record<string, string>>): McpError {
    const ctx = createMockContext({ errors: ERRORS });
    const result = failSearchError(error, ctx as never, fields);
    if (!(result instanceof McpError)) throw new Error('expected an McpError');
    return result;
  }

  it.each([
    [
      'an invalid value, naming the values it accepts',
      validationError('Invalid type value "Bogus".', {
        param: 'type',
        valid: ['Geschaeftsordnung', 'Geschaeftsverteilung'],
        value: 'Bogus',
      }),
      'Set type to one of: Geschaeftsordnung, Geschaeftsverteilung — or omit type.',
    ],
    [
      'an unsupported value, naming the alternatives',
      validationError('sort_by: published is not available.', {
        alternatives: ['number'],
        application: 'Spg',
        param: 'sortBy',
        value: 'published',
      }),
      'Set sort_by to one of: number — or omit sort_by.',
    ],
    [
      'an unsupported value with no alternative',
      validationError('sort_by: number is not available.', {
        alternatives: [],
        application: 'KmGer',
        param: 'sortBy',
        value: 'number',
      }),
      'Change or drop sort_by, as the message describes.',
    ],
    [
      'an unsupported field pair, in snake_case',
      validationError('decidedFrom/decidedTo is not mapped.', {
        application: 'Begut',
        param: 'decidedFrom/decidedTo',
      }),
      'Change or drop decided_from/decided_to, as the message describes.',
    ],
  ])('%s', (_label, error, hint) => {
    const err = mapped(error);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.message).toBe(error.message);
    expect(err.data).toEqual({ reason: 'invalid_query', recovery: { hint } });
    expect(hint).not.toMatch(/page/iu);
  });

  it('names the caller’s field where the tool routes it to a differently named builder param', () => {
    const err = mapped(
      validationError('The historical Lgbl gazette has no Wien.', {
        application: 'Lgbl',
        param: 'state',
        state: 'wien',
      }),
      { state: 'state_era' },
    );
    expect(err.data?.recovery).toEqual({
      hint: 'Change or drop state_era, as the message describes.',
    });
  });

  it('leaves a RIS-originated rejection to the declared recovery', () => {
    const err = mapped(
      validationError("The 'Typ' element is invalid.", { risApplication: 'PruefGewO' }),
    );
    expect(err.data).toEqual({ reason: 'invalid_query' });
  });

  it.each([
    [JsonRpcErrorCode.ServiceUnavailable, 'upstream_error'],
    [JsonRpcErrorCode.Timeout, 'upstream_timeout'],
  ] as const)('maps %s to %s without a hint, whatever its data', (code, reason) => {
    const err = mapped(new McpError(code, 'down', { param: 'type' }));
    expect(err.data).toEqual({ reason });
  });

  it('failMinistrySearchError keeps the ministry reason and passes the field map through', () => {
    const ctx = createMockContext({ errors: ERRORS });
    const ministry = failMinistrySearchError(
      validationError('Unknown ministry "BMXX".', { input: 'BMXX', reason: 'unresolved_ministry' }),
      ctx as never,
    ) as McpError;
    expect(ministry.data).toEqual({ reason: 'unresolved_ministry' });
    const local = failMinistrySearchError(
      validationError('No Wien.', { param: 'state' }),
      ctx as never,
      { state: 'state_era' },
    ) as McpError;
    expect(local.data?.recovery).toEqual({
      hint: 'Change or drop state_era, as the message describes.',
    });
  });
});
