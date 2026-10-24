/**
 * @fileoverview Tests for the ris_track_changes tool — deletion-record surfacing, the
 * cross-class changed-document record shape, enrichment (totals/paging/applied window),
 * the zero-hit notice, error-contract mapping, and format() parity. The RIS service module
 * is mocked so the suite is fully offline; success-path fixtures are run through the real
 * normalizer so results stay realistic.
 * @module tests/tools/ris-track-changes.tool.test
 */

import { readFileSync } from 'node:fs';

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toRecord as toCaseLawRecord } from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';
import { parseHistoryResponse } from '@/services/ris/normalizer.js';

import { contentText, contractError } from './_wire.js';

const { trackChanges } = vi.hoisted(() => ({ trackChanges: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ trackChanges }),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** Read a fixture as the raw body text RIS puts on the wire. */
function rawFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8');
}

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

beforeEach(() => {
  trackChanges.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('risTrackChanges — deletion records', () => {
  it('surfaces deletion records with document_number and deleted_at, alongside changed documents', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);

    expect(result.results).toHaveLength(7);
    const deletions = result.results.filter((r) => r.deleted);
    expect(deletions).toHaveLength(5);
    const first = deletions.find((r) => r.document_number === 'NOR30003318');
    expect(first).toBeDefined();
    expect(first?.deleted_at).toBe('2026-06-17T14:46:31');
    expect(first?.content_urls).toEqual({});
    // Deletion records carry the issuing Organ too (RawDeletedNode.Organ).
    expect(first?.organ).toBe('BKA');

    const changed = result.results.filter((r) => !r.deleted);
    expect(changed).toHaveLength(2);
  });

  it('renders deleted records distinctly (with the deletion timestamp) in format()', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    const text = (risTrackChanges.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('NOR30003318 — deleted');
    expect(text).toContain('**Deleted:** yes (2026-06-17T14:46:31)');
  });

  it('renders an explicit "**Deleted:** no" line for a non-deleted changed record', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    const changed = result.results.find((r) => !r.deleted);
    expect(changed, 'fixture should carry a non-deleted changed record').toBeDefined();
    // Isolate the single deleted:false record so the assertion is unambiguous — content-only
    // clients must see its explicit "no", which the old truthy-gated render dropped entirely.
    const text = (
      risTrackChanges.format!({ results: [changed!] })[0] as { type: 'text'; text: string }
    ).text;
    expect(text).toContain('**Deleted:** no');
    expect(text).not.toContain('**Deleted:** yes');
  });
});

describe('risTrackChanges — changed-document record shape', () => {
  it('maps a changed BrKons document to the cross-class record shape', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    const result = await risTrackChanges.handler(input, ctx);
    const record = result.results.find((r) => r.document_number === 'NOR40278538');
    expect(record).toBeDefined();
    expect(record?.deleted).toBe(false);
    expect(record?.short_title).toBe('Grundausbildungsverordnung BMLV – M BUO 2017');
    expect(record?.title).toBeUndefined();
    expect(record?.changed).toBe('2026-06-17');
    expect(record?.published).toBe('2026-06-17');
    expect(record?.document_url).toBe(
      'https://www.ris.bka.gv.at/eli/bgbl/ii/2016/442/P7/NOR40278538',
    );
    expect(record?.content_urls).toEqual({
      xml: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.xml',
      html: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.html',
      rtf: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.rtf',
      pdf: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40278538/NOR40278538.pdf',
    });
    // The fixture's content list carries no Authentisch DataType — authentic_pdf_url must
    // stay genuinely absent, not defaulted.
    expect(record?.authentic_pdf_url).toBeUndefined();
    expect(record?.binding_status).toBe('consolidated_informational');
    expect(record?.organ).toBe('BKA (Bundeskanzleramt)');
  });

  it('applies the same binding_status (per queried application) to every record, deleted or changed', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    expect(result.results.length).toBeGreaterThan(0);
    for (const record of result.results) {
      expect(record.binding_status).toBe('consolidated_informational');
    }
  });
});

describe('risTrackChanges — enrichment: totals, paging, applied window', () => {
  it('reports total, page, pageSize, application, and the applied changed_from/changed_to window', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({
      application: 'BrKons',
      changed_from: '2026-06-01',
      changed_to: '2026-06-30',
      include_deleted: true,
    });
    await risTrackChanges.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    // Fixture: total 101, page 1, pageSize 100, 7 entries on this page — 101 > 7, so more
    // pages exist beyond this one.
    expect(enrichment.totalCount).toBe(101);
    expect(enrichment.page).toBe(1);
    expect(enrichment.pageSize).toBe(100);
    expect(enrichment.application).toBe('BrKons');
    expect(enrichment.changedFrom).toBe('2026-06-01');
    expect(enrichment.changedTo).toBe('2026-06-30');
    expect(enrichment.truncated).toBe(true);
  });

  it('omits changedFrom/changedTo from enrichment when the window is not provided', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    await risTrackChanges.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.changedFrom).toBeUndefined();
    expect(enrichment.changedTo).toBeUndefined();
  });
});

describe('risTrackChanges — zero-hit notice', () => {
  it('includes the exact-date-window guidance when changed_from/changed_to are set', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('search-zero-hits.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({
      application: 'BrKons',
      changed_from: '2020-01-01',
      changed_to: '2020-01-02',
    });
    await risTrackChanges.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 changes in BrKons between 2020-01-01 and 2020-01-02.');
    expect(notice).toContain("use the search tools' changed_since for coarse recency filtering");
  });

  it('defaults to "the start of the feed" and "now" when the window is omitted', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('search-zero-hits.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    await risTrackChanges.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 changes in BrKons between the start of the feed and now.');
  });
});

describe('risTrackChanges — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (ValidationError) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service ValidationError rejection to the invalid_query contract error', async () => {
    const upstreamError = validationError("The 'Anwendung' element is invalid.", {
      risApplication: 'BrKons',
    });
    trackChanges.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    const err = await captureError(risTrackChanges.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'Anwendung' element is invalid.");
  });

  it('surfaces an out-of-range page as an actionable invalid_query, not an opaque InternalError', async () => {
    // End-to-end across the seam the fix depends on: the REAL service (fetch stubbed with
    // RIS's verbatim HTTP 500 body) must throw the code this tool's unmodified .catch()
    // matches. Mocking the service here instead would assume the very thing under test.
    const actual = await vi.importActual<typeof import('@/services/ris/ris-service.js')>(
      '@/services/ris/ris-service.js',
    );
    const realService = new actual.RisService('ris-austria-mcp-server/test');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(rawFixture('error-500-page-overflow.json'), { status: 500 })),
      ),
    );
    trackChanges.mockImplementation((params, ctx) => realService.trackChanges(params, ctx));

    const err = await contractError(risTrackChanges, {
      application: 'Dsk',
      changed_from: '2026-07-01',
      changed_to: '2026-07-15',
      page: 2,
    });

    // The caller must not be told this server broke — the page number is their input.
    expect(err.code).not.toBe(JsonRpcErrorCode.InternalError);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    // RIS's own explanation reaches the caller…
    expect(err.message).toContain('Seitennummer');
    // …alongside this tool's recovery hint, which a contract-less throw would have lost.
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('Correct the parameter named in the message'),
    });
    // invalid_query declares no retryable flag — an input error is not worth retrying.
    expect(err.data?.retryable).toBeUndefined();
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    trackChanges.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons' });
    const err = await captureError(risTrackChanges.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    trackChanges.mockRejectedValue(timeout('fetch GET https://data.bka.gv.at timed out.', {}));
    const err = await contractError(risTrackChanges, { application: 'BrKons' });
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('narrow the change window'),
    });
  });
});

describe('risTrackChanges — format() parity', () => {
  it('renders every populated field for both changed and deleted records', async () => {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture('history-with-deleted.json')));
    const ctx = createMockContext({ errors: risTrackChanges.errors });
    const input = risTrackChanges.input.parse({ application: 'BrKons', include_deleted: true });
    const result = await risTrackChanges.handler(input, ctx);
    const text = (risTrackChanges.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const record of result.results) {
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.binding_status);
      // deleted renders for BOTH states — true → "yes"/"yes (ts)", false → "no" (was truthy-gated).
      expect(text).toContain(`**Deleted:** ${record.deleted ? 'yes' : 'no'}`);
      if (record.short_title !== undefined) expect(text).toContain(record.short_title);
      if (record.organ !== undefined) expect(text).toContain(record.organ);
      if (record.title !== undefined) expect(text).toContain(record.title);
      if (record.changed !== undefined) expect(text).toContain(record.changed);
      if (record.published !== undefined) expect(text).toContain(record.published);
      if (record.deleted_at !== undefined) expect(text).toContain(record.deleted_at);
      if (record.document_url !== undefined) expect(text).toContain(record.document_url);
      if (record.authentic_pdf_url !== undefined) expect(text).toContain(record.authentic_pdf_url);
      for (const key of ['html', 'pdf', 'rtf', 'xml'] as const) {
        const url = record.content_urls[key];
        if (url !== undefined) expect(text).toContain(url);
      }
    }
  });

  it('renders the empty-page fallback when results is empty', () => {
    const blocks = risTrackChanges.format!({ results: [] });
    expect((blocks[0] as { type: 'text'; text: string }).text).toBe('_No changes on this page._');
  });
});

describe('risTrackChanges — row identity: section label, law id, case numbers (#56)', () => {
  /** Run one call over the wire; return the parsed records by id and the text block per id. */
  async function callWire(fixtureName: string, input: Record<string, unknown>) {
    trackChanges.mockResolvedValue(parseHistoryResponse(fixture(fixtureName)));
    const result = await runToolContract(risTrackChanges, input as never);
    expect(result.isError).not.toBe(true);
    const { results } = risTrackChanges.output.parse(result.structuredContent);
    const text = contentText(result);
    const blockFor = (documentNumber: string) =>
      text.split('\n\n').find((block) => block.includes(`**Document:** ${documentNumber}`)) ?? '';
    return { blockFor, byId: new Map(results.map((r) => [r.document_number, r])) };
  }

  it('keeps deletion rows and other applications’ rows unchanged', async () => {
    const deletions = await callWire('history-with-deleted.json', {
      application: 'BrKons',
      include_deleted: true,
    });
    expect(Object.keys(deletions.byId.get('NOR30003318')!).sort()).toEqual([
      'binding_status',
      'content_urls',
      'deleted',
      'deleted_at',
      'document_number',
      'organ',
    ]);
    // Gr rows carry a Geschaeftszahl, but only court-decision rows gain case_numbers.
    const gr = await callWire('history-gr.json', { application: 'Gr' });
    expect(Object.keys(gr.byId.get('GEMRE_KA_20914_902_2_2_2026')!).sort()).toEqual([
      'binding_status',
      'changed',
      'content_urls',
      'deleted',
      'document_number',
      'document_url',
      'organ',
      'short_title',
      'title',
    ]);
  });

  it('gives a BrKons row its section label and law id, and appends the label to the heading', async () => {
    const { blockFor, byId } = await callWire('history-brkons.json', {
      application: 'BrKons',
      changed_from: '2026-10-16',
      changed_to: '2026-10-17',
    });
    expect(byId.get('NOR40264172')).toMatchObject({
      law_id: '20012655',
      section_label: '§ 16',
      short_title: 'DORA-Vollzugsgesetz',
    });
    expect(blockFor('NOR40264172')).toContain('## DORA-Vollzugsgesetz § 16\n');
    expect(blockFor('NOR40264172')).toContain('**Law ID:** 20012655');
    // RIS's heading-document label is relayed verbatim; that row's multi-line long title moves
    // out of the heading onto its own line.
    const headingDocument = byId.get('NOR40264174')!;
    expect(headingDocument.section_label).toBe('§ 0');
    expect(blockFor('NOR40264174')).toContain('## DORA-Vollzugsgesetz § 0\n');
    expect(blockFor('NOR40264174')).toContain(`**Title:** ${headingDocument.title}`);
    expect(byId.get('NOR40264172')).not.toHaveProperty('case_numbers');
  });

  it('gives an LrKons row its section label and law id, Anlage labels included', async () => {
    const { blockFor, byId } = await callWire('history-lrkons.json', { application: 'LrKons' });
    expect(byId.get('LST40036626')).toMatchObject({ law_id: '20001950', section_label: 'Anl. 1' });
    expect(blockFor('LST40036626')).toContain(
      '## Geschäftsordnung der Steiermärkischen Landesregierung – GeOLR Anl. 1\n',
    );
    expect(byId.get('LOO40027136')).toMatchObject({ law_id: '20001395', section_label: '§ 1' });
  });

  it('gives a court-decision row its case numbers and decision date, and heads it by case number', async () => {
    const { blockFor, byId } = await callWire('history-vwgh.json', {
      application: 'Vwgh',
      changed_from: '2026-10-10',
      changed_to: '2026-10-17',
    });
    const row = byId.get('JWR_1983160049_19850221X07')!;
    expect(row).toMatchObject({ case_numbers: ['83/16/0049'], decision_date: '1985-02-21' });
    expect(row.title).toBeUndefined();
    expect(row).not.toHaveProperty('section_label');
    const block = blockFor('JWR_1983160049_19850221X07');
    expect(block).toContain('## 83/16/0049\n');
    expect(block).toContain('**Decided:** 1985-02-21');
    expect(block).toContain('**Document:** JWR_1983160049_19850221X07');
  });

  it('carries the same identity on Justiz rows', async () => {
    const { blockFor, byId } = await callWire('history-justiz.json', { application: 'Justiz' });
    const id = 'JJT_20260820_OLG0639_0100BS00052_26M0000_000';
    expect(byId.get(id)).toMatchObject({
      case_numbers: ['10Bs52/26m'],
      decision_date: '2026-08-20',
    });
    expect(blockFor(id)).toContain('## 10Bs52/26m\n');
  });

  /*
   * A Justiz headnote names every decision it covers in one `;`-joined item, companions in
   * parentheses. The change feed and ris_search_case_law read it through the same normalizer,
   * so a row's case_numbers are the elements the case-law record carries — one splitting rule.
   */
  it('splits a joined Justiz headnote row exactly as ris_search_case_law does', async () => {
    const page = fixture('history-justiz.json') as {
      OgdSearchResult: { OgdDocumentResults: { OgdDocumentReference: unknown[] } };
    };
    const [text] = page.OgdSearchResult.OgdDocumentResults.OgdDocumentReference as {
      Data: { Metadaten: { Judikatur: Record<string, unknown>; Technisch: { ID: string } } };
    }[];
    const headnote = structuredClone(text!);
    headnote.Data.Metadaten.Technisch.ID = 'JJR_19521210_OGH0002_0010OB00948_5200000_001';
    headnote.Data.Metadaten.Judikatur.Dokumenttyp = 'Rechtssatz';
    headnote.Data.Metadaten.Judikatur.Geschaeftszahl = {
      item: '1Ob948/52; 3Ob760/53 (3Ob761/53); 6Ob236/23h',
    };
    page.OgdSearchResult.OgdDocumentResults.OgdDocumentReference = [headnote];
    const changes = parseHistoryResponse(page);
    trackChanges.mockResolvedValue(changes);

    const result = await runToolContract(risTrackChanges, { application: 'Justiz' });
    const { results } = risTrackChanges.output.parse(result.structuredContent);
    const expected = ['1Ob948/52', '3Ob760/53', '3Ob761/53', '6Ob236/23h'];
    expect(results[0]?.case_numbers).toEqual(expected);

    const [change] = changes.changes;
    if (change?.kind !== 'document') throw new Error('expected a changed document');
    expect(toCaseLawRecord(change.hit, 'Justiz').case_numbers).toEqual(expected);

    // The heading names the leading decision and counts the rest; the text still lists all.
    const block = contentText(result);
    expect(block).toContain('## 1Ob948/52 (+3 more)\n**Document:** ');
    expect(block).toContain(`**Case numbers:** ${expected.join(', ')}`);
  });

  it('keeps a long headnote row’s heading to its leading decision', () => {
    const caseNumbers = Array.from({ length: 52 }, (_, i) => `${i + 1}Ob${i + 1}/52`);
    const text = (
      risTrackChanges.format!({
        results: [
          {
            binding_status: 'decision',
            case_numbers: caseNumbers,
            content_urls: {},
            deleted: false,
            document_number: 'JJR_X',
          },
        ],
      })[0] as { type: 'text'; text: string }
    ).text;
    const [heading] = text.split('\n');
    expect(heading).toBe('## 1Ob1/52 (+51 more)');
    expect(text).toContain(`**Case numbers:** ${caseNumbers.join(', ')}`);
  });

  it('describes case_numbers in the case-law vocabulary — a headnote row lists every decision', () => {
    const field = risTrackChanges.output.shape.results.element.shape.case_numbers;
    expect(field.description).toContain('one per element in upstream order');
    expect(field.description).toContain('a headnote row lists every decision it covers');
  });

  it('states case numbers and labels on their own line when the heading cannot carry them', () => {
    const base = {
      binding_status: 'decision',
      content_urls: {},
      deleted: false,
    } as const;
    const text = (
      risTrackChanges.format!({
        results: [
          { ...base, document_number: 'A', title: 'Normenliste DSG', case_numbers: ['1 Ob 2/26x'] },
          { ...base, document_number: 'B', section_label: '§ 3', law_id: '20000001' },
        ],
      })[0] as { type: 'text'; text: string }
    ).text;
    expect(text).toContain('## Normenliste DSG\n**Document:** A\n**Case numbers:** 1 Ob 2/26x');
    expect(text).toContain('## B\n**Document:** B\n**Section:** § 3\n**Law ID:** 20000001');
  });
});

describe('risTrackChanges — in-force window on consolidated-law rows (#69)', () => {
  /** Run one call over the wire; return the parsed records by id and the text block per id. */
  async function callWire(payload: unknown, input: Record<string, unknown>) {
    trackChanges.mockResolvedValue(parseHistoryResponse(payload));
    const result = await runToolContract(risTrackChanges, input as never);
    expect(result.isError).not.toBe(true);
    const { results } = risTrackChanges.output.parse(result.structuredContent);
    const text = contentText(result);
    const blockFor = (documentNumber: string) =>
      text.split('\n\n').find((block) => block.includes(`**Document:** ${documentNumber}`)) ?? '';
    return { blockFor, byId: new Map(results.map((r) => [r.document_number, r])), text };
  }

  /** history-brkons.json with fields of one record's BrKons node replaced. */
  function brkonsWith(documentNumber: string, fields: Record<string, string>): unknown {
    const page = structuredClone(fixture('history-brkons.json')) as {
      OgdSearchResult: {
        OgdDocumentResults: {
          OgdDocumentReference: {
            Data: {
              Metadaten: {
                Bundesrecht: { BrKons: Record<string, string> };
                Technisch: { ID: string };
              };
            };
          }[];
        };
      };
    };
    const ref = page.OgdSearchResult.OgdDocumentResults.OgdDocumentReference.find(
      (candidate) => candidate.Data.Metadaten.Technisch.ID === documentNumber,
    );
    if (ref === undefined) throw new Error(`No record ${documentNumber}`);
    Object.assign(ref.Data.Metadaten.Bundesrecht.BrKons, fields);
    return page;
  }

  it('carries a BrKons row’s in-force window, rendered from → until right after the law id', async () => {
    const { blockFor, byId } = await callWire(fixture('history-brkons.json'), {
      application: 'BrKons',
    });
    expect(byId.get('NOR40264172')).toMatchObject({
      in_force_from: '2025-01-17',
      in_force_until: '2026-10-16',
      law_id: '20012655',
      section_label: '§ 16',
      short_title: 'DORA-Vollzugsgesetz',
    });
    expect(blockFor('NOR40264172').split('\n')).toEqual([
      '## DORA-Vollzugsgesetz § 16',
      '**Document:** NOR40264172',
      '**Short title:** DORA-Vollzugsgesetz',
      '**Law ID:** 20012655',
      '**In force:** 2025-01-17 → 2026-10-16',
      '**Organ:** BKA (Bundeskanzleramt)',
      '**Binding:** consolidated_informational',
      '**Changed:** 2026-10-16 | **Published:** 2024-07-23',
      '**Deleted:** no',
      `**RIS view:** ${byId.get('NOR40264172')!.document_url}`,
      expect.stringMatching(/^\*\*Text:\*\* \[HTML\]\(/u),
    ]);
  });

  it('renders a row with no end date as "→ no end date", never as still in force', async () => {
    const { blockFor, byId, text } = await callWire(fixture('history-lrkons.json'), {
      application: 'LrKons',
    });
    const future = byId.get('LST40036626')!;
    expect(future.in_force_from).toBe('2027-01-01');
    expect(future).not.toHaveProperty('in_force_until');
    expect(blockFor('LST40036626')).toContain('\n**In force:** 2027-01-01 → no end date\n');
    expect(blockFor('LOO40027136')).toContain('\n**In force:** 2026-10-16 → no end date\n');
    expect(text).not.toMatch(/still in force/iu);
  });

  // NOR40113657 (PAG § 36) starts on 9000-01-01; its predecessor NOR40113654 ends then.
  it.each([
    {
      id: 'NOR40264172',
      fields: { Ausserkrafttretensdatum: '9000-01-01', Inkrafttretensdatum: '2010-01-01' },
      window: { in_force_from: '2010-01-01', in_force_until: '9000-01-01' },
      line: '**In force:** 2010-01-01 → 9000-01-01',
    },
    {
      id: 'NOR40264174',
      fields: { Inkrafttretensdatum: '9000-01-01' },
      window: { in_force_from: '9000-01-01' },
      line: '**In force:** 9000-01-01 → no end date',
    },
    {
      id: 'NOR40264172',
      fields: { Ausserkrafttretensdatum: '2026-12-31', Inkrafttretensdatum: '' },
      window: { in_force_until: '2026-12-31' },
      line: '**In force:** unknown → 2026-12-31',
    },
  ])('relays the RIS window verbatim as "$line"', async ({ id, fields, window, line }) => {
    const { blockFor, byId } = await callWire(brkonsWith(id, fields), { application: 'BrKons' });
    const row = byId.get(id)!;
    expect({
      ...(row.in_force_from !== undefined && { in_force_from: row.in_force_from }),
      ...(row.in_force_until !== undefined && { in_force_until: row.in_force_until }),
    }).toStrictEqual(window);
    expect(blockFor(id).split('\n')).toContain(line);
  });

  it('gives deletion rows and other applications’ rows no in-force keys or line', async () => {
    const deletions = await callWire(fixture('history-with-deleted.json'), {
      application: 'BrKons',
      include_deleted: true,
    });
    expect(deletions.byId.get('NOR40234331')).toMatchObject({
      in_force_from: '2021-05-26',
      in_force_until: '2026-06-16',
    });
    const deletion = deletions.byId.get('NOR30003318')!;
    expect(deletion).not.toHaveProperty('in_force_from');
    expect(deletion).not.toHaveProperty('in_force_until');
    expect(deletions.blockFor('NOR30003318')).not.toContain('**In force:**');

    // Gr metadata carries an Inkrafttretensdatum (2026-10-16); only consolidated-law rows relay it.
    for (const [name, application, id] of [
      ['history-gr.json', 'Gr', 'GEMRE_KA_20914_902_2_2_2026'],
      ['history-vwgh.json', 'Vwgh', 'JWR_1983160049_19850221X07'],
    ] as const) {
      const other = await callWire(fixture(name), { application });
      const row = other.byId.get(id)!;
      expect(row).not.toHaveProperty('in_force_from');
      expect(row).not.toHaveProperty('in_force_until');
      expect(other.blockFor(id)).not.toBe('');
      expect(other.text).not.toContain('**In force:**');
    }
  });

  it('states the in-force rule and the 9000-01-01 placeholder in both field descriptions', () => {
    const { shape } = risTrackChanges.output.shape.results.element;
    for (const field of [shape.in_force_from, shape.in_force_until]) {
      expect(field.description).toContain('9000-01-01');
      expect(field.description).toContain(
        'in force on date D when in_force_from ≤ D and in_force_until is absent or ≥ D',
      );
    }
    expect(shape.in_force_until.description).not.toMatch(/still in force|absent while in force/iu);
  });
});
