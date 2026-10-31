/**
 * @fileoverview Tests for the ris_search_drafts tool — local stage-conditional-filter
 * guards (rejected before any network call), error-contract mapping, zero-hit notices,
 * and record-mapping/format() parity across both pipeline stages (Begut review drafts,
 * RegV government bills). The RIS service module is mocked so the suite is fully
 * offline; success-path fixtures are run through the real normalizer so results stay
 * realistic.
 * @module tests/tools/ris-search-drafts.tool.test
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
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risSearchDrafts } from '@/mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import { buildDraftsRequest, type DraftsSearchParams } from '@/services/ris/request-builder.js';
import type { RisHit } from '@/services/ris/types.js';

import {
  contentText,
  contractError,
  expectArgumentRejection,
  expectReadBack,
  HOSTILE_TEXT,
  readFormatBlock,
} from './_wire.js';

const { searchDrafts } = vi.hoisted(() => ({ searchDrafts: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchDrafts }),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(result: unknown | Promise<unknown>): Promise<McpError> {
  const err = await Promise.resolve(result).catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

beforeEach(() => {
  searchDrafts.mockReset();
});

describe('risSearchDrafts — local guards (no service call)', () => {
  it('rejects in_review_on combined with stage: government_bills', async () => {
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({
      stage: 'government_bills',
      in_review_on: '2026-07-05',
    });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'stage_filter_mismatch' });
    expect(err.message).toContain('in_review_on applies only to stage: review_drafts');
    expect(err.message).toContain("stage: 'government_bills'");
    expect(searchDrafts).not.toHaveBeenCalled();
  });

  it('rejects decided_from combined with stage: review_drafts', async () => {
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({
      stage: 'review_drafts',
      decided_from: '2020-01-01',
    });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'stage_filter_mismatch' });
    expect(err.message).toContain('decided_from applies only to stage: government_bills');
    expect(err.message).toContain("stage: 'review_drafts'");
    expect(searchDrafts).not.toHaveBeenCalled();
  });

  it('rejects decided_to combined with stage: review_drafts (names decided_to, not decided_from)', async () => {
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts', decided_to: '2020-01-01' });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'stage_filter_mismatch' });
    expect(err.message).toContain('decided_to applies only to stage: government_bills');
    expect(err.message).not.toContain('decided_from applies');
    expect(searchDrafts).not.toHaveBeenCalled();
  });

  it('rejects a reversed decided window under stage: review_drafts as stage_filter_mismatch, not as a reversed window (#92)', async () => {
    const result = await runToolContract(risSearchDrafts, {
      stage: 'review_drafts',
      decided_from: '2025-12-31',
      decided_to: '2025-01-01',
    });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as { error: { data?: Record<string, unknown> } };
    expect(error.data).toMatchObject({ reason: 'stage_filter_mismatch' });
    expect(contentText(result)).not.toContain('reversed window');
    expect(searchDrafts).not.toHaveBeenCalled();
  });
});

describe('risSearchDrafts — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchDrafts.mockResolvedValue(zeroHitsResult);
  });

  it('names the stage in the base fragment for review_drafts', async () => {
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts' });
    await risSearchDrafts.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 review_drafts matched.');
  });

  it('names the stage in the base fragment for government_bills', async () => {
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'government_bills' });
    await risSearchDrafts.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 government_bills matched.');
  });

  it('includes the ministry-designation guidance when ministry is set', async () => {
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts', ministry: 'BMF' });
    await risSearchDrafts.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('ministry must match a RIS ministry designation');
  });

  it('includes the in_review_on guidance when set', async () => {
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({
      stage: 'review_drafts',
      in_review_on: '2026-07-05',
    });
    await risSearchDrafts.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No drafts in review on 2026-07-05 matching the filters');
  });
});

describe('risSearchDrafts — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (ValidationError) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service ValidationError rejection to the invalid_query contract error', async () => {
    const upstreamError = validationError("The 'InBegutachtungAm' element is invalid.", {
      risApplication: 'Begut',
    });
    searchDrafts.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts', query: 'Datenschutz' });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'InBegutachtungAm' element is invalid.");
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    searchDrafts.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts', query: 'Datenschutz' });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    searchDrafts.mockRejectedValue(timeout('fetch GET https://data.bka.gv.at timed out.', {}));
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts' });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
  });

  it('maps a builder rejection of an unknown ministry to unresolved_ministry (#44)', async () => {
    // stage + ministry passes the input schema, then expandMinistry refuses the value. The
    // real builder runs on the params the handler produced, so this pins the actual
    // rejection; it reached the wire as a bare -32007 with no reason and no recovery (#12),
    // then under invalid_query, whose recovery leads with page-past-end advice (#44).
    searchDrafts.mockImplementation(async (params: DraftsSearchParams) => {
      buildDraftsRequest(params);
      throw new Error('unreachable — the builder was expected to reject these params');
    });
    const err = await contractError(risSearchDrafts, { stage: 'review_drafts', ministry: 'BMXX' });
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unresolved_ministry' });
    expect(err.message).toContain('Unknown ministry "BMXX"');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('ris_list_reference topic ministries'),
    });
    expect(err.data?.recovery).toMatchObject({ hint: expect.not.stringMatching(/page/iu) });
  });

  it('leads the recovery hint with the page for an out-of-range page (#30)', async () => {
    // RIS answers a page past the end with a German message that names no element, so
    // "correct the parameter named in the message" resolves to nothing and the ministries
    // topic the hint used to end on is a dead end. The page has to come first.
    searchDrafts.mockRejectedValue(
      validationError('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten', {}),
    );
    const err = await contractError(risSearchDrafts, { stage: 'review_drafts', page: 9999 });
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Seitennummer');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringMatching(
        /^For a page past the end, request a lower page, starting from 1\./u,
      ),
    });
  });
});

describe('risSearchDrafts — text filters: blank rejected, non-blank passed through (#39)', () => {
  /** Every optional free-text input: [field, a value, builder key]. */
  const TEXT_FILTERS = [
    ['query', ' Datenschutz ', 'query'],
    ['title', 'Einkommensteuergesetz', 'title'],
    ['ministry', 'BMF', 'ministry'],
  ] as const;

  beforeEach(() => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
  });

  it.each(TEXT_FILTERS)(
    '%s: a non-blank value reaches RIS unchanged',
    async (field, value, key) => {
      const result = await runToolContract(risSearchDrafts, {
        stage: 'review_drafts',
        [field]: value,
      } as never);
      expect(result.isError).not.toBe(true);
      expect(searchDrafts).toHaveBeenCalledTimes(1);
      expect(searchDrafts.mock.calls[0]![0]).toMatchObject({ [key]: value });
    },
  );

  it.each(
    TEXT_FILTERS.flatMap((row) => ['', '   ', '\t\n'].map((blank) => [row[0], blank] as const)),
  )('%s: %j is rejected over the wire before any RIS call', async (field, blank) => {
    const result = await runToolContract(risSearchDrafts, {
      stage: 'review_drafts',
      [field]: blank,
    } as never);
    expectArgumentRejection(result, [`${field}: `, 'omit the field to leave it unfiltered']);
    expect(searchDrafts).not.toHaveBeenCalled();
  });

  it('sends none of the text filters when every one is omitted', async () => {
    const result = await runToolContract(risSearchDrafts, { stage: 'review_drafts' });
    expect(result.isError).not.toBe(true);
    const params = searchDrafts.mock.calls[0]![0] as Record<string, unknown>;
    for (const [, , key] of TEXT_FILTERS) expect(params).not.toHaveProperty(key);
    expect(params).toMatchObject({ stage: 'review_drafts' });
  });
});

describe('risSearchDrafts — record mapping and format() parity', () => {
  it('renders every populated field for a multi-hit Begut result, ministry fallback for a sparse hit', async () => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-begut.json')));
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts' });
    const result = await risSearchDrafts.handler(input, ctx);
    expect(result.results).toHaveLength(2);

    const first = result.results[0]!;
    const second = result.results[1]!;
    expect(first.stage).toBe('review_drafts');
    expect(first.short_title).toBe('Einkommensteuergesetz-Novelle 2026');
    expect(first.ministry).toBe('BMF');
    expect(first.review_deadline).toBe('2026-07-15');
    expect(first.content_urls.html).toContain('BEGUT_COO_2026_0001.html');
    expect(first.content_urls.pdf).toContain('BEGUT_COO_2026_0001.pdf');
    expect(first.document_url).toBe(
      'https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Begut&Dokumentnummer=BEGUT_COO_2026_0001',
    );

    // Second hit has no Begut.EinbringendeStelle — ministry falls back to the technical
    // submitter (Technisch.Einbringer), and it has no Kurztitel or Dokumentliste at all.
    expect(second.short_title).toBeUndefined();
    expect(second.ministry).toBe('BMJ');
    expect(second.review_deadline).toBe('2026-07-22');
    expect(second.content_urls).toEqual({});
    expect(second.materials).toEqual([]);

    const text = (risSearchDrafts.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const record of result.results) {
      expect(text).toContain(record.document_number);
      expect(text).toContain(`(${record.stage})`);
      if (record.ministry !== undefined) expect(text).toContain(record.ministry);
      if (record.review_deadline !== undefined) expect(text).toContain(record.review_deadline);
      if (record.document_url !== undefined) {
        expect(text).toContain(`**RIS view:** [${record.document_url}](<${record.document_url}>)`);
      }
    }
  });

  // normalizeHit has always parsed these; every record mapper dropped them, and
  // ris_get_document rejected their URLs — so a draft's Erläuterungen had no route at all.
  it('surfaces the companion documents and drops the main document and inline images', async () => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-begut.json')));
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts' });
    const result = await risSearchDrafts.handler(input, ctx);
    const { materials } = result.results[0]!;

    expect(materials.map((material) => [material.type, material.name])).toEqual([
      ['Material', 'Erläuterungen'],
      ['Material', 'Textgegenüberstellung'],
      ['Letter', 'Begleitschreiben Begutachtungsentwurf'],
    ]);
    // The bill's own renditions ride content_urls, and the per-record inline formula images
    // (dozens per draft) carry nothing to read.
    for (const material of materials) {
      expect(material.url).not.toBe(
        'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_0001/BEGUT_COO_2026_0001.html',
      );
      expect(material.url).not.toContain('.gif');
    }

    expect(materials[0]!.url).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_0001/Materialien_0001_2716E555_EB43_4642_A87A_3CF88FFCDB08.html',
    );

    const text = (risSearchDrafts.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const { name, type, url } of materials) {
      expect(text).toContain(`- ${name} (${type}) — [${url}](<${url}>)`);
    }
  });

  // ris_get_document validates a companion URL's extension and then discards it, rebuilding
  // the rendition from its own format input — so every spelling of the URL is one handle, and
  // the record carries one of them. The four-URL set it used to carry was 50-60% of the
  // response.
  it('carries one HTML handle per companion when RIS lists an HTML rendition', async () => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-begut.json')));
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts' });
    const result = await risSearchDrafts.handler(input, ctx);
    const { materials } = result.results[0]!;

    // Upstream lists all four renditions for the Erläuterungen, three for the
    // Textgegenüberstellung and two for the covering letter; the record shape doesn't move.
    for (const material of materials) {
      expect(Object.keys(material).toSorted()).toEqual(['name', 'type', 'url']);
      expect(material.url.endsWith('.html')).toBe(true);
    }
  });

  // Not a hypothetical: 2,829 of the 23,483 companions across the full live Begut + RegV
  // corpus (12.0%) carry no HTML rendition, nearly all of them Begut covering letters filed
  // as PDF or PDF/RTF. The record still has to carry a URL for them — RIS 404s a rendition it
  // does not list, so the PDF is the one that resolves, and ris_get_document's markdown format
  // reads its text; dropping the companion would lose the only reference to it the caller ever
  // gets.
  it('falls back to the PDF when a companion carries no HTML URL', async () => {
    const payload = structuredClone(fixture('search-begut.json')) as {
      OgdSearchResult: {
        OgdDocumentResults: {
          OgdDocumentReference: {
            Data: {
              Dokumentliste?: {
                ContentReference: { Urls: { ContentUrl: { DataType: string; Url: string }[] } }[];
              };
            };
          }[];
        };
      };
    };
    const erlaeuterungen =
      payload.OgdSearchResult.OgdDocumentResults.OgdDocumentReference[0]!.Data.Dokumentliste!
        .ContentReference[1]!;
    erlaeuterungen.Urls.ContentUrl = erlaeuterungen.Urls.ContentUrl.filter(
      (entry) => entry.DataType !== 'Html',
    );
    searchDrafts.mockResolvedValue(parseSearchResponse(payload));

    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts' });
    const result = await risSearchDrafts.handler(input, ctx);
    expect(result.results[0]!.materials[0]!.url).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_0001/Materialien_0001_2716E555_EB43_4642_A87A_3CF88FFCDB08.pdf',
    );
  });

  it('maps a RegV (government_bills) hit — decided date surfaced, not review_deadline', async () => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-regv.json')));
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'government_bills' });
    const result = await risSearchDrafts.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.stage).toBe('government_bills');
    expect(record.short_title).toBe('Umsatzsteuergesetz-Novelle 2026');
    expect(record.ministry).toBe('BMF');
    expect(record.decided).toBe('2026-06-24');
    expect(record.review_deadline).toBeUndefined();
    expect(record.document_url).toBe(
      'https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=RegV&Dokumentnummer=REGV_COO_2026_0005',
    );
    // A bill files no covering letter and not always a Textgegenüberstellung; treaty
    // ratifications add Attachment annexes, which the same field carries.
    expect(record.materials.map((material) => material.type)).toEqual(['Material', 'Attachment']);
    expect(record.materials[1]!.name).toBe('Übereinkommen in deutscher Sprache');
    expect(record.materials[1]!.url).toContain('Anlagen_0001_');

    const text = (risSearchDrafts.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(record.document_number);
    expect(text).toContain('**Decided:** 2026-06-24');
    expect(text).not.toContain('**Review deadline:**');
    expect(text).toContain(`**RIS view:** [${record.document_url}](<${record.document_url}>)`);
    expect(text).toContain('WFA (Material)');
    expect(text).toContain('Übereinkommen in deutscher Sprache (Attachment)');
  });
});

// search-begut-review-window.json and search-regv-abkuerzung.json are live captures (review
// drafts in Begutachtung on 2026-10-21; the newest government bills), cut to the records these
// cases need, with each record's inline formula images trimmed to two.
describe('risSearchDrafts — review start, abbreviation, and keywords (#68)', () => {
  const BEGUT_KEYWORDS = 'BEGUT_1174CDB5_3F55_443A_A112_175692DE8744';
  const BEGUT_ABBREVIATION = 'BEGUT_6A7272C6_F603_4C66_A8EE_3A8A4B956566';
  const BEGUT_SEMICOLONS = 'BEGUT_36D925A7_3CDE_452E_ACCF_486628CEDFFB';
  const BEGUT_START_ONLY = 'BEGUT_343BEE2A_632B_4190_AA2C_B6762CD6F563';
  const REGV_ABBREVIATION = 'REGV_1ADD1A33_54AA_4943_99C3_C6C6E7D434C3';
  const REGV_SPARSE = 'REGV_B54220C1_6C61_4BC1_ACE5_4D33FFC44FF3';
  const REGV_KEYWORDS = 'REGV_B9F6BD64_87F1_4603_8824_DAF146D597A4';
  const NEW_KEYS = ['review_start', 'abbreviation', 'keywords'] as const;

  async function search(fixtureName: string, input: Record<string, unknown>) {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture(fixtureName)));
    const result = await runToolContract(risSearchDrafts, input as never);
    expect(result.isError).not.toBe(true);
    const { results } = risSearchDrafts.output.parse(result.structuredContent);
    const text = contentText(result);
    const blockFor = (documentNumber: string) =>
      text.split('\n\n').find((block) => block.includes(`**Document:** ${documentNumber}`)) ?? '';
    return { blockFor, byId: new Map(results.map((r) => [r.document_number, r])), results };
  }

  const reviewDrafts = () =>
    search('search-begut-review-window.json', {
      stage: 'review_drafts',
      in_review_on: '2026-10-21',
    });
  const governmentBills = () =>
    search('search-regv-abkuerzung.json', { stage: 'government_bills' });

  /** Each record's new keys as present on the record — a key set to `undefined` stays visible. */
  const newFields = (record: Record<string, unknown>) =>
    Object.fromEntries(NEW_KEYS.filter((key) => key in record).map((key) => [key, record[key]]));

  /** The block's tail: rendition links, then one line per companion, both pre-#68 lines. */
  const tailLines = (
    record: ReturnType<typeof risSearchDrafts.output.parse>['results'][number],
  ) => {
    const u = record.content_urls;
    return [
      `**Text:** [HTML](<${u.html}>) · [PDF](<${u.pdf}>) · [RTF](<${u.rtf}>) · [XML](<${u.xml}>)`,
      '**Materials:**',
      ...record.materials.map((m) => `- ${m.name ?? m.type} (${m.type}) — [${m.url}](<${m.url}>)`),
    ];
  };

  it('carries review_start, abbreviation, and keywords as RIS sends them, and no key it omits', async () => {
    const drafts = await reviewDrafts();
    expect(drafts.results.map((r) => [r.document_number, newFields(r)])).toStrictEqual([
      [BEGUT_KEYWORDS, { keywords: 'F-Gase, Biozide, Chemikalien', review_start: '2026-10-15' }],
      [BEGUT_ABBREVIATION, { abbreviation: 'BauV-Novelle Flüssiggas', review_start: '2026-10-21' }],
      [BEGUT_START_ONLY, { review_start: '2026-10-21' }],
      [
        BEGUT_SEMICOLONS,
        {
          abbreviation: 'KSp-G',
          keywords: 'Geologische Speicherung; Kohlenstoffdioxid; CO2',
          review_start: '2026-09-22',
        },
      ],
    ]);
    const bills = await governmentBills();
    expect(bills.results.map((r) => [r.document_number, newFields(r)])).toStrictEqual([
      [REGV_ABBREVIATION, { abbreviation: 'BattBegG' }],
      [REGV_SPARSE, {}],
      [
        REGV_KEYWORDS,
        {
          keywords:
            'WiEReG, Wirtschaftliche Eigentümer, Geldwäsche, Geldwäscherei, Terrorismusfinanzierung',
        },
      ],
    ]);
  });

  it('renders a review draft block in field order, start before deadline on one line', async () => {
    const { blockFor, byId } = await reviewDrafts();
    const record = byId.get(BEGUT_SEMICOLONS)!;
    const view = `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Begut&Dokumentnummer=${BEGUT_SEMICOLONS}`;
    expect(blockFor(BEGUT_SEMICOLONS).split('\n')).toStrictEqual([
      `## ${BEGUT_SEMICOLONS}`,
      '**Title:** Bundesgesetz, mit dem das Bundesgesetz über das Verbot der geologischen Speicherung von Kohlenstoffdioxid aufgehoben und das Bundesgesetz über die geologische Speicherung von Kohlenstoffdioxid (KSp-G) erlassen wird',
      `**Document:** ${BEGUT_SEMICOLONS} (review_drafts)`,
      '**Short title:** Kohlenstoffdioxid-Speicherungsgesetz',
      '**Abbreviation:** KSp-G',
      '**Ministry:** BMF (Bundesministerium für Finanzen)',
      '**Review start:** 2026-09-22 | **Review deadline:** 2026-10-30',
      '**Keywords:** Geologische Speicherung; Kohlenstoffdioxid; CO2',
      `**RIS view:** [${view}](<${view}>)`,
      ...tailLines(record),
    ]);
    expect(record.materials).toHaveLength(3);
  });

  it('renders a government bill block in field order, decided alone on the dates line', async () => {
    const { blockFor, byId } = await governmentBills();
    const record = byId.get(REGV_ABBREVIATION)!;
    const view = `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=RegV&Dokumentnummer=${REGV_ABBREVIATION}`;
    expect(blockFor(REGV_ABBREVIATION).split('\n')).toStrictEqual([
      `## ${REGV_ABBREVIATION}`,
      '**Title:** Bundesgesetz, mit dem das Altbatteriengesetz erlassen und das Abfallwirtschaftsgesetz 2002 geändert wird (EU-Batterienverordnung Begleitgesetz – BattBegG)',
      `**Document:** ${REGV_ABBREVIATION} (government_bills)`,
      '**Short title:** EU-Batterienverordnung Begleitgesetz',
      '**Abbreviation:** BattBegG',
      '**Ministry:** BMLUK (Bundesministerium für Land- und Forstwirtschaft, Klima- und Umweltschutz, Regionen und Wasserwirtschaft)',
      '**Decided:** 2026-10-14',
      `**RIS view:** [${view}](<${view}>)`,
      ...tailLines(record),
    ]);
    expect(record.materials).toHaveLength(4);
  });

  it('renders each new field on its own line exactly when structuredContent carries it', async () => {
    const labels = {
      abbreviation: '**Abbreviation:**',
      keywords: '**Keywords:**',
      review_start: '**Review start:**',
    } as const;
    let rendered = 0;
    let omitted = 0;
    for (const { blockFor, results } of [await reviewDrafts(), await governmentBills()]) {
      for (const record of results) {
        const lines = blockFor(record.document_number).split('\n');
        expect(lines[0]).toBe(`## ${record.document_number}`);
        expect(lines[record.title === undefined ? 1 : 2]).toBe(
          `**Document:** ${record.document_number} (${record.stage})`,
        );
        for (const key of NEW_KEYS) {
          const value = record[key];
          const hits = lines.filter((line) => line.includes(labels[key]));
          if (value === undefined) {
            expect(hits).toStrictEqual([]);
            omitted++;
            continue;
          }
          // review_start opens the dates line; the other two fill a line of their own.
          expect(hits).toStrictEqual([
            key === 'review_start'
              ? `${labels[key]} ${value} | **Review deadline:** ${record.review_deadline}`
              : `${labels[key]} ${value}`,
          ]);
          rendered++;
        }
      }
    }
    // 4 review starts, 2 abbreviations and 2 keyword strings on the drafts; 1 and 1 on the bills.
    expect(rendered).toBe(10);
    expect(omitted).toBe(11);
  });
});

describe('risSearchDrafts — content[] reads back the RIS strings (#79)', () => {
  const BASE = 'https://ogd.ris.bka.gv.at/Dokumente/Begut/BEGUT_X';
  const hostile: RisHit = {
    contentReferences: [
      { name: HOSTILE_TEXT.multiLineTitle, type: 'Material', urls: { html: `${BASE}/M_(1).html` } },
      { name: HOSTILE_TEXT.inline, type: 'Letter', urls: { pdf: `${BASE}/L_*a*_1.pdf` } },
    ],
    contentUrls: {
      html: `${BASE}/BEGUT_X.html`,
      pdf: `${BASE}/BEGUT_X.pdf`,
      rtf: `${BASE}/BEGUT_X.rtf`,
      xml: `${BASE}/BEGUT_X.xml`,
    },
    documentNumber: 'BEGUT_~~X~~_',
    documentUrl: 'https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Begut&Dokumentnummer=BEGUT_X',
    metadata: {
      abbreviation: HOSTILE_TEXT.pipeAndBackslash,
      celexReferences: [],
      controller: 'Bundesrecht',
      decided: '`2026`',
      indexes: [],
      keywords: HOSTILE_TEXT.blockMarkers,
      ministry: HOSTILE_TEXT.listOpener,
      reviewDeadline: '_2026_',
      reviewStart: '*2026*',
      shortTitle: HOSTILE_TEXT.inline,
      title: HOSTILE_TEXT.multiLineTitle,
    },
  };
  const sparse: RisHit = {
    contentReferences: [],
    contentUrls: {},
    documentNumber: 'BEGUT_Y',
    metadata: { celexReferences: [], controller: 'Bundesrecht', indexes: [], title: '# Y' },
  };

  async function run() {
    searchDrafts.mockResolvedValue({ hits: [hostile, sparse], page: 1, pageSize: 20, total: 2 });
    const result = await runToolContract(risSearchDrafts, { stage: 'review_drafts' });
    expect(result.isError).not.toBe(true);
    return { result, ...risSearchDrafts.output.parse(result.structuredContent) };
  }

  it('reads back every string verbatim and every URL as a link destination', async () => {
    const { result, results } = await run();
    expectReadBack(result, results, { bulletLists: 1 });
  });

  it('heads each record by its document number alone, the title on a labeled line', async () => {
    const { result } = await run();
    const { headings, text } = readFormatBlock(result);
    expect(headings).toEqual(['BEGUT_~~X~~_', 'BEGUT_Y']);
    expect(text).toContain(`⟨strong⟩Title:⟨/strong⟩ ${HOSTILE_TEXT.multiLineTitle}\n`);
    expect(text).toContain('⟨strong⟩Title:⟨/strong⟩ # Y\n⟨strong⟩Document:⟨/strong⟩ BEGUT_Y ');
  });
});
