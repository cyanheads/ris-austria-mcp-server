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
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risSearchDrafts } from '@/mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import { buildDraftsRequest, type DraftsSearchParams } from '@/services/ris/request-builder.js';

const { searchDrafts } = vi.hoisted(() => ({ searchDrafts: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchDrafts }),
}));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(promise: Promise<unknown>): Promise<McpError> {
  const err = await promise.catch((e: unknown) => e);
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
});

describe('risSearchDrafts — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchDrafts.mockResolvedValue(zeroHitsResult);
  });

  it('names the stage in the base fragment for review_drafts', async () => {
    const ctx = createMockContext();
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts' });
    await risSearchDrafts.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 review_drafts matched.');
  });

  it('names the stage in the base fragment for government_bills', async () => {
    const ctx = createMockContext();
    const input = risSearchDrafts.input.parse({ stage: 'government_bills' });
    await risSearchDrafts.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 government_bills matched.');
  });

  it('includes the ministry-designation guidance when ministry is set', async () => {
    const ctx = createMockContext();
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts', ministry: 'BMF' });
    await risSearchDrafts.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('ministry must match a RIS ministry designation');
  });

  it('includes the in_review_on guidance when set', async () => {
    const ctx = createMockContext();
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
  // tool's declared contract: a Client error (InvalidParams) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service InvalidParams rejection to the invalid_query contract error', async () => {
    const upstreamError = invalidParams("The 'InBegutachtungAm' element is invalid.", {
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

  it('maps a builder rejection of an unknown ministry to invalid_query', async () => {
    // stage + ministry passes the input schema, then expandMinistry refuses the value. The
    // real builder runs on the params the handler produced, so this pins the actual
    // rejection; it reached the wire as a bare -32007 with no reason and no recovery (#12).
    searchDrafts.mockImplementation(async (params: DraftsSearchParams) => {
      buildDraftsRequest(params);
      throw new Error('unreachable — the builder was expected to reject these params');
    });
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts', ministry: 'BMXX' });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Unknown ministry "BMXX"');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('correct the parameter named in the message'),
    });
  });

  it('leads the recovery hint with the page for an out-of-range page (#30)', async () => {
    // RIS answers a page past the end with a German message that names no element, so
    // "correct the parameter named in the message" resolves to nothing and the ministries
    // topic the hint used to end on is a dead end. The page has to come first.
    searchDrafts.mockRejectedValue(
      invalidParams('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten', {}),
    );
    const ctx = createMockContext({ errors: risSearchDrafts.errors });
    const input = risSearchDrafts.input.parse({ stage: 'review_drafts', page: 9999 });
    const err = await captureError(risSearchDrafts.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Seitennummer');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringMatching(
        /^For a page past the end, request a lower page, starting from 1\./u,
      ),
    });
  });
});

describe('risSearchDrafts — record mapping and format() parity', () => {
  it('renders every populated field for a multi-hit Begut result, ministry fallback for a sparse hit', async () => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-begut.json')));
    const ctx = createMockContext();
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
        expect(text).toContain(`**RIS view:** ${record.document_url}`);
      }
    }
  });

  // normalizeHit has always parsed these; every record mapper dropped them, and
  // ris_get_document rejected their URLs — so a draft's Erläuterungen had no route at all.
  it('surfaces the companion documents and drops the main document and inline images', async () => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-begut.json')));
    const ctx = createMockContext();
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
      expect(Object.values(material.urls)).not.toContain(
        'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_0001/BEGUT_COO_2026_0001.html',
      );
      expect(JSON.stringify(material.urls)).not.toContain('.gif');
    }

    const erlaeuterungen = materials[0]!;
    expect(erlaeuterungen.urls.html).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Begut/BEGUT_COO_2026_0001/Materialien_0001_2716E555_EB43_4642_A87A_3CF88FFCDB08.html',
    );
    expect(erlaeuterungen.urls.rtf).toContain('Materialien_0001_');
    // RIS publishes RTF for well under half of them — absent, not fabricated.
    expect(materials[1]!.urls.rtf).toBeUndefined();

    const text = (risSearchDrafts.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const material of materials) {
      expect(text).toContain(`${material.name} (${material.type})`);
      for (const url of Object.values(material.urls)) expect(text).toContain(url);
    }
  });

  it('maps a RegV (government_bills) hit — decided date surfaced, not review_deadline', async () => {
    searchDrafts.mockResolvedValue(parseSearchResponse(fixture('search-regv.json')));
    const ctx = createMockContext();
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
    expect(record.materials[1]!.urls.pdf).toContain('Anlagen_0001_');

    const text = (risSearchDrafts.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(record.document_number);
    expect(text).toContain('**Decided:** 2026-06-24');
    expect(text).not.toContain('**Review deadline:**');
    expect(text).toContain(`**RIS view:** ${record.document_url}`);
    expect(text).toContain('WFA (Material)');
    expect(text).toContain('Übereinkommen in deutscher Sprache (Attachment)');
  });
});
