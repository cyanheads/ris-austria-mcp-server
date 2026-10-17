/**
 * @fileoverview Tests for the shared input schemas in `_shared.ts` and their reach across the
 * surface. `isoDateString` backs every date-taking parameter on every tool, so an impossible
 * calendar date must be an input error at each of them rather than a shape-valid string sent
 * upstream — where RIS's rejection is either an opaque error or, in ris_lookup_citation,
 * silently reinterpreted as a citation miss (#14). Every free-text filter on the filter tools
 * rejects a blank or whitespace-only value (#39), and every paginated tool takes page_size 10
 * or 20 only (#40) — both swept from the advertised schemas, so a parameter added later cannot
 * skip the rule. Every state-valued parameter folds a German, capitalized, umlauted, or English
 * state name to its code while advertising the same JSON Schema as before (#58). The
 * search-failure mapper gives a local rejection a recovery naming the field to correct, never
 * the page-first advice RIS's own errors need (#59). Fully offline: only input schemas,
 * schema-level rejections, and the error mapper are exercised, no handler and no service.
 * @module tests/tools/_shared.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';

import {
  failMinistrySearchError,
  failSearchError,
  isoDateString,
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
import { foldStateName, RIS_STATES } from '@/services/ris/reference/index.js';

import { expectArgumentRejection } from './_wire.js';

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

describe('page_size — 10 or 20 on every paginated tool (#40)', () => {
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
    it('advertises exactly 10 and 20', () => {
      const node = advertisedInput(definition).properties?.page_size as SchemaNode;
      const values = node.enum ?? node.anyOf?.map((branch) => branch.const);
      expect(values).toEqual([10, 20]);
    });

    it.each([10, 20])('accepts %d', (size) => {
      expect(definition.input.safeParse({ ...base, page_size: size }).success).toBe(true);
    });

    it('accepts an omitted page_size (RIS serves 20)', () => {
      const outcome = definition.input.safeParse(base);
      expect(outcome.success).toBe(true);
      expect((outcome.data as Record<string, unknown>).page_size).toBeUndefined();
    });

    it.each([50, 100, 30, '20'])('rejects %j, naming 10, 20, and page', (size) => {
      const outcome = definition.input.safeParse({ ...base, page_size: size });
      expect(outcome.success).toBe(false);
      const [issue] = outcome.error?.issues ?? [];
      expect(issue?.path).toEqual(['page_size']);
      expect(issue?.message).toContain('Expected 10 or 20');
      expect(issue?.message).toContain('raise page');
    });
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

// The fold runs over a caller-sized string before the enum sees it.
describe('foldStateName — time on adversarial input', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  /** Bound on one call at 320,000 characters; linear work there takes about a millisecond. */
  const BOUND_MS = 50;
  const SCOPE = new Set(['federal', ...STATE_CODES]);

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
