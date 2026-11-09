/**
 * @fileoverview The switch, log line, and counter every pre-validation fold in `_shared.ts`
 * carries (#107). A fold that changes a value writes one log line and adds one to
 * `ris.input.folded`, keyed by the tool or resource and the field; a value already its code does
 * neither; `RIS_FOLD_INPUT_SPELLINGS=false` restores strict validation for every fold, the #58
 * state-name fold included. `createCounter` is wrapped so the suite reads what each fold
 * records while the framework's instrument still receives it. Fully offline: input schemas and
 * one framework argument parse with the handler replaced, no service.
 * @module tests/tools/_shared-input-folds.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { risDocumentResource } from '@/mcp-server/resources/definitions/ris-document.resource.js';
import { risGetDocument } from '@/mcp-server/tools/definitions/ris-get-document.tool.js';
import { risLookupCitation } from '@/mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { risSearchCaseLaw } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { risSearchLegislation } from '@/mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';

import { expectArgumentRejection } from './_wire.js';

/** Every value a counter created through `@cyanheads/mcp-ts-core/utils` recorded, in order. */
const { recorded } = vi.hoisted(() => ({
  recorded: [] as { attributes: unknown; name: string; value: number }[],
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: (...args: Parameters<typeof actual.createCounter>) => {
      const counter = actual.createCounter(...args);
      return {
        add: (...record: Parameters<typeof counter.add>) => {
          recorded.push({ name: args[0], value: record[0], attributes: record[1] });
          counter.add(...record);
        },
      };
    },
  };
});

let info: MockInstance<typeof logger.info>;

beforeEach(() => {
  recorded.length = 0;
  info = vi.spyOn(logger, 'info');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The one count a fold at `definition`/`field` records. */
function countAt(definition: string, field: string) {
  return {
    name: 'ris.input.folded',
    value: 1,
    attributes: { 'ris.input.definition': definition, 'ris.input.field': field },
  };
}

/** The one log line a fold at `definition`/`field` writes, folding the value to `folded`. */
function expectFoldLog(definition: string, field: string, folded: string): void {
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith(
    `Folded ${definition} ${field} to "${folded}" before validation.`,
    expect.objectContaining({
      operation: 'FoldInputSpelling',
      extra: expect.objectContaining({ definition, field, folded }),
    }),
  );
}

describe('a fold that changes a value logs once and counts once, by definition and field', () => {
  it.each<[string, string, { readonly input: { parse: (v: unknown) => unknown } }, object, string]>(
    [
      ['ris_search_case_law', 'court', risSearchCaseLaw, { court: 'Vfgh', query: 'x' }, 'vfgh'],
      [
        'ris_lookup_citation',
        'court',
        risLookupCitation,
        { citation: 'G 1/26', court: 'VWGH' },
        'vwgh',
      ],
      [
        'ris_get_document',
        'application',
        risGetDocument,
        { application: 'vfgh', document_number: 'JFT_1' },
        'Vfgh',
      ],
      ['ris_track_changes', 'application', risTrackChanges, { application: ' brkons ' }, 'BrKons'],
      [
        'ris_document',
        'application',
        { input: risDocumentResource.params as { parse: (v: unknown) => unknown } },
        { application: 'lrkons', documentNumber: 'NOR1' },
        'LrKons',
      ],
      [
        'ris_search_case_law',
        'state',
        risSearchCaseLaw,
        { court: 'lvwg', state: 'Tirol' },
        'tirol',
      ],
      [
        'ris_lookup_citation',
        'state',
        risLookupCitation,
        { citation: '§ 1 DSG', state: 'Vienna' },
        'wien',
      ],
      ['ris_search_legislation', 'scope', risSearchLegislation, { scope: 'Kärnten' }, 'kaernten'],
      ['ris_search_gazette', 'scope', risSearchGazette, { scope: 'FEDERAL' }, 'federal'],
      [
        'ris_search_announcements',
        'plan_state',
        risSearchAnnouncements,
        { collection: 'health_structure_plans', plan_state: 'Styria' },
        'steiermark',
      ],
    ],
  )('%s %s', (definition, field, schema, input, folded) => {
    schema.input.parse(input);
    expectFoldLog(definition, field, folded);
    expect(recorded).toEqual([countAt(definition, field)]);
  });

  it.each<[{ readonly input: { parse: (v: unknown) => unknown } }, object]>([
    [risSearchCaseLaw, { court: 'vfgh', query: 'x' }],
    [risGetDocument, { application: 'Vfgh', document_number: 'JFT_1' }],
    [risSearchCaseLaw, { court: 'lvwg', state: 'tirol' }],
    [risSearchLegislation, {}],
  ])(
    'a value already its code, or an omitted field, neither logs nor counts: %#',
    (schema, input) => {
      schema.input.parse(input);
      expect(info).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    },
  );

  it('a value the fold cannot place neither logs nor counts, and is rejected', () => {
    expect(risSearchCaseLaw.input.safeParse({ court: 'OGH', query: 'x' }).success).toBe(false);
    expect(info).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('a tool call through the framework argument parse logs once and counts once', async () => {
    const received: unknown[] = [];
    const result = await runToolContract(
      {
        ...risTrackChanges,
        handler: (input, ctx) => {
          received.push(input.application);
          ctx.enrich({ application: input.application, page: 1, pageSize: 20, totalCount: 0 });
          return { results: [] };
        },
      },
      { application: 'VFGH' } as never,
    );
    expect(result.isError).not.toBe(true);
    expect(received).toEqual(['Vfgh']);
    expectFoldLog('ris_track_changes', 'application', 'Vfgh');
    expect(recorded).toEqual([countAt('ris_track_changes', 'application')]);
  });
});

describe('RIS_FOLD_INPUT_SPELLINGS=false — strict validation for every fold', () => {
  /** The tool and resource definitions, imported fresh so they read the stubbed environment. */
  async function importDefinitions(value: string) {
    vi.stubEnv('RIS_FOLD_INPUT_SPELLINGS', value);
    vi.resetModules();
    const utils = await import('@cyanheads/mcp-ts-core/utils');
    info = vi.spyOn(utils.logger, 'info');
    return {
      caseLaw: (await import('@/mcp-server/tools/definitions/ris-search-case-law.tool.js'))
        .risSearchCaseLaw,
      getDocument: (await import('@/mcp-server/tools/definitions/ris-get-document.tool.js'))
        .risGetDocument,
      resource: (await import('@/mcp-server/resources/definitions/ris-document.resource.js'))
        .risDocumentResource,
      trackChanges: (await import('@/mcp-server/tools/definitions/ris-track-changes.tool.js'))
        .risTrackChanges,
    };
  }

  it.each([
    ['court "Vfgh"', 'caseLaw', { court: 'Vfgh', query: 'x' }, 'court: Invalid option'],
    ['state "Tirol"', 'caseLaw', { court: 'lvwg', state: 'Tirol' }, 'state: Invalid option'],
    [
      'application "vfgh"',
      'getDocument',
      { application: 'vfgh', document_number: 'JFT_1' },
      'application: Invalid option',
    ],
    ['application "vfgh"', 'trackChanges', { application: 'vfgh' }, 'application: Invalid option'],
  ] as const)('rejects %s on %s as an unfolded enum does', async (_label, tool, input, phrase) => {
    const definitions = await importDefinitions('false');
    const result = await runToolContract(definitions[tool] as never, input as never);
    expectArgumentRejection(result, [phrase]);
    expect(info).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('rejects application "vfgh" on the ris://document resource', async () => {
    const { resource } = await importDefinitions('false');
    const params = resource.params as { safeParse: (v: unknown) => { success: boolean } };
    expect(params.safeParse({ application: 'vfgh', documentNumber: 'NOR1' }).success).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('folds as the default does when set to true', async () => {
    const { caseLaw } = await importDefinitions('true');
    expect(caseLaw.input.parse({ court: 'Vfgh', query: 'x' }).court).toBe('vfgh');
    expect(recorded).toEqual([countAt('ris_search_case_law', 'court')]);
  });
});
