/**
 * @fileoverview Tests for the ris_search_case_law tool — local court-conditional-filter
 * guards (rejected before any network call), error-contract mapping, zero-hit notices,
 * and record-mapping/format() parity. The RIS service module is mocked so the suite is
 * fully offline; success-path fixtures are run through the real normalizer so results
 * stay realistic.
 * @module tests/tools/ris-search-case-law.tool.test
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

import {
  type CaseLawRecord,
  risSearchCaseLaw,
} from '@/mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import { buildCaseLawRequest, type CaseLawSearchParams } from '@/services/ris/request-builder.js';
import type { RisHit } from '@/services/ris/types.js';

import {
  contentText,
  contractError,
  expectArgumentRejection,
  expectReadBack,
  HOSTILE_TEXT,
  readCommonMark,
  readFormatBlock,
  type WireError,
} from './_wire.js';

const { searchCaseLaw } = vi.hoisted(() => ({ searchCaseLaw: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchCaseLaw }),
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
  searchCaseLaw.mockReset();
});

describe('risSearchCaseLaw — local guards (no service call)', () => {
  it('rejects issuing_body sent with a court outside dsk/dok/pvak/verg', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'vfgh',
      issuing_body: 'Datenschutzbehoerde',
    });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('issuing_body');
    expect(err.message).toContain("got 'vfgh'");
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects collection_number sent with a court outside vfgh/vwgh/uvs', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'justiz',
      collection_number: 'VfSlg 19.632/2012',
    });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('collection_number');
    expect(err.message).toContain("got 'justiz'");
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects state sent with a court outside lvwg/uvs', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', state: 'wien' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('state');
    expect(err.message).toContain('lvwg/uvs');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects party sent with a non-upts court', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', party: 'SPÖ' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('party');
    expect(err.message).toContain('upts');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects case_number sent with court normenliste (a norm index, not decisions)', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'normenliste', case_number: 'G 287/2022' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('case_number');
    expect(err.message).toContain('normenliste');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects a non-default decision_type sent with court upts', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'upts', decision_type: 'headnote' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('decision_type');
    expect(err.message).toContain('upts');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects decision_kind for a court with no Entscheidungsart parameter', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'normenliste', decision_kind: 'anything' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'court_filter_mismatch' });
    expect(err.message).toContain('decision_kind');
    expect(err.message).toContain('normenliste');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects an invalid decision_kind value for a court that has the parameter (invalid_query)', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', decision_kind: 'NotARealKind' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("decision_kind 'NotARealKind'");
    expect(err.message).toContain('Erkenntnis');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects a subject_area value outside the Justiz Fachgebiet taxonomy (invalid_query)', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'justiz', subject_area: 'NotARealArea' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("subject_area 'NotARealArea'");
    expect(err.message).toContain('justiz_subject_areas');
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it.each([
    [
      { court: 'vfgh', decision_kind: 'NotARealKind' } as const,
      'Set decision_kind to one of: Beschluss, Erkenntnis, Vergleich, KeineAngabe — or omit decision_kind.',
    ],
    [
      { court: 'justiz', subject_area: 'NotARealArea' } as const,
      'Change or drop subject_area, as the message describes.',
    ],
  ])(
    'recovers from a local value rejection by naming the field, never the page: %j',
    async (input, hint) => {
      const result = await runToolContract(risSearchCaseLaw, input);
      const err = (result.structuredContent as { error: WireError }).error;
      expect(err.data).toMatchObject({ reason: 'invalid_query' });
      expect(err.data?.recovery).toEqual({ hint });
      expect(contentText(result)).toContain(hint);
      expect(contentText(result)).not.toMatch(/page/iu);
    },
  );
});

describe('risSearchCaseLaw — issuing_body against the dsk/pvak enumerations (#61)', () => {
  /** Each court's EntscheidendeBehoerde enumeration (OGD v2.6 WSDL), in reference-table order. */
  const BODIES = {
    dsk: ['Datenschutzbehoerde', 'Datenschutzkommission', 'ParlamentarischesDatenschutzkomitee'],
    pvak: ['Personalvertretungsaufsichtsbehoerde', 'PersonalvertretungsAufsichtskommission'],
  } as const;

  beforeEach(() => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
  });

  it.each(
    (['dsk', 'pvak'] as const).flatMap((court) =>
      BODIES[court].flatMap((value) =>
        // Surrounding whitespace is not part of the value.
        [value, value.toLowerCase(), value.toUpperCase(), ` ${value}`, `${value} \t`].map(
          (sent) => [court, sent, value] as const,
        ),
      ),
    ),
  )('%s: issuing_body %s is sent as %s', async (court, sent, canonical) => {
    const result = await runToolContract(risSearchCaseLaw, { court, issuing_body: sent });
    expect(result.isError).not.toBe(true);
    expect(searchCaseLaw.mock.calls[0]![0]).toMatchObject({ issuingBody: canonical });
  });

  it.each(
    (['dsk', 'pvak'] as const).flatMap((court) =>
      ['Undefined', 'undefined', ' Undefined '].map((value) => [court, value] as const),
    ),
  )(
    '%s: issuing_body %s is RIS’s no-filter member and is sent as no filter',
    async (court, value) => {
      const result = await runToolContract(risSearchCaseLaw, { court, issuing_body: value });
      expect(result.isError).not.toBe(true);
      expect(searchCaseLaw.mock.calls[0]![0]).not.toHaveProperty('issuingBody');
    },
  );

  it.each(
    (['dsk', 'pvak'] as const).flatMap((court) =>
      ['Bogus', 'Datenschutzbehörde', 'Datenschutz'].map((value) => [court, value] as const),
    ),
  )(
    '%s: issuing_body %s is rejected before any RIS call, naming the field to correct',
    async (court, value) => {
      const result = await runToolContract(risSearchCaseLaw, { court, issuing_body: value });
      const err = (result.structuredContent as { error: WireError }).error;
      const values = BODIES[court];
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'invalid_query' });
      expect(err.message).toBe(
        `issuing_body '${value}' is not a valid EntscheidendeBehoerde for court '${court}'. Valid values: ${values.join(' | ')}.`,
      );
      const hint = `Set issuing_body to one of: ${values.join(', ')} — or omit issuing_body.`;
      expect(err.data?.recovery).toEqual({ hint });
      expect(contentText(result)).toContain(hint);
      expect(contentText(result)).not.toMatch(/page/iu);
      expect(searchCaseLaw).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['dok', 'Bogus'],
    ['verg', 'undefined'],
  ] as const)('%s keeps forwarding issuing_body %s as free text', async (court, value) => {
    const result = await runToolContract(risSearchCaseLaw, { court, issuing_body: value });
    expect(result.isError).not.toBe(true);
    expect(searchCaseLaw.mock.calls[0]![0]).toMatchObject({ issuingBody: value });
  });

  it('lists the issuing_body values per court in its description', () => {
    const description = risSearchCaseLaw.input.shape.issuing_body.description ?? '';
    for (const value of [...BODIES.dsk, ...BODIES.pvak]) expect(description).toContain(value);
  });
});

describe('risSearchCaseLaw — description routes a known cite to ris_lookup_citation', () => {
  it('names the ECLI among the cites ris_lookup_citation resolves directly', () => {
    expect(risSearchCaseLaw.description).toContain(
      'For a known Geschäftszahl, ECLI, or VfSlg/VwSlg cite, ris_lookup_citation resolves it directly.',
    );
  });
});

describe('risSearchCaseLaw — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (ValidationError) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service ValidationError rejection to the invalid_query contract error', async () => {
    const upstreamError = validationError("The 'Entscheidungsart' element is invalid.", {
      risApplication: 'Vfgh',
    });
    searchCaseLaw.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', query: 'Datenschutz' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'Entscheidungsart' element is invalid.");
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    searchCaseLaw.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', query: 'Datenschutz' });
    const err = await captureError(risSearchCaseLaw.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    // fetchWithTimeout classifies its own deadline as Timeout, not ServiceUnavailable. A
    // widened upstream_error guard would report -32000 for it, since ctx.fail resolves the
    // code from the contract entry — so the deadline needs its own declared reason.
    searchCaseLaw.mockRejectedValue(timeout('fetch GET https://data.bka.gv.at timed out.', {}));
    const err = await contractError(risSearchCaseLaw, { court: 'vfgh', query: 'Datenschutz' });
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('retry the same search'),
    });
  });

  it('states a request-builder rejection of a schema-valid sort_by in the caller’s vocabulary', async () => {
    // court: normenliste + sort_by: decision_date passes the input schema, then the builder
    // rejects it. The builder speaks its own vocabulary — the service param name `sortBy`
    // and the RIS application code `Normenliste`, neither of which the caller sent — so the
    // handler restates the rejection over the input field and court value it did send (#29).
    searchCaseLaw.mockImplementation(async (params: CaseLawSearchParams) => {
      buildCaseLawRequest(params);
      throw new Error('unreachable — the builder was expected to reject these params');
    });
    const err = await contractError(risSearchCaseLaw, {
      court: 'normenliste',
      sort_by: 'decision_date',
    });
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toBe(
      "sort_by is not available for court 'normenliste' — the VwGH norm index lists laws rather than decisions, so it carries no decision date or case number to sort on. Drop sort_by, or search court: 'vwgh' for the decisions themselves.",
    );
    // Nothing the caller could not have written itself survives into the message.
    expect(err.message).not.toContain('sortBy');
    expect(err.message).not.toContain('Normenliste');
    expect(err.message).not.toContain('silently ignored upstream');
    // A local rejection is never a page past the end: its recovery names the field (#59).
    expect(err.data?.recovery).toEqual({
      hint: 'Change or drop sort_by, as the message describes.',
    });
  });

  it('leads the recovery hint with the page for an out-of-range page (#30)', async () => {
    // RIS answers a page past the end with a German message that names no element, so
    // "correct the parameter named in the message" resolves to nothing and the reference
    // topics are dead ends. The page has to come first in the hint.
    searchCaseLaw.mockRejectedValue(
      validationError('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten', {}),
    );
    const err = await contractError(risSearchCaseLaw, {
      court: 'vfgh',
      query: 'Datenschutz',
      page: 9999,
    });
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain('Seitennummer');
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringMatching(
        /^For a page past the end, request a lower page, starting from 1\./u,
      ),
    });
  });
});

describe('risSearchCaseLaw — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchCaseLaw.mockResolvedValue(zeroHitsResult);
  });

  it('includes the per-court base fragment', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 decisions in vfgh. Other courts are separate calls');
  });

  it('includes the Geschäftszahl-format guidance when case_number is set', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', case_number: 'G 287/2022' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Geschäftszahl formats differ per court');
  });

  it('includes the norm-format guidance when norm is set', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh', norm: 'DSG §1' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain("norm must match RIS's cited-norm format");
  });

  it('includes the coverage-start-year guidance when decided_to predates the court window', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'bvwg', decided_to: '2010-01-01' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('bvwg coverage starts 2014');
  });

  it('includes the historical-court successor guidance', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'uvs' });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('uvs is historical');
    expect(notice).toContain('its successor is lvwg');
  });

  it('flags the unpopulated Fachgebiet/decision_kind tags for justiz', async () => {
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'justiz',
      decision_kind: 'Ordentliche Erledigung (Sachentscheidung)',
    });
    await risSearchCaseLaw.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('not yet populated in the RIS corpus');
  });
});

describe('risSearchCaseLaw — enrichment: truncation disclosure', () => {
  // A declared enrichment field, once set via ctx.enrich, is merged into structuredContent
  // AND auto-appended to content[] as the framework's enrichment trailer; getEnrichment(ctx)
  // reads that merged surface, so it stands in for both what structured- and content-only
  // clients receive (matching how ris-track-changes asserts its own truncated field).
  it('sets truncated=true when the total exceeds the current page', async () => {
    // Mirrors issue #3's live case: page 1 of pageSize 10 with far more matches beyond it.
    const base = parseSearchResponse(fixture('search-vfgh.json'));
    searchCaseLaw.mockResolvedValue({ ...base, total: 625, page: 1, pageSize: 10 });
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'vwgh',
      query: 'Datenschutz',
      page_size: 10,
    });
    await risSearchCaseLaw.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(625);
    expect(enrichment.page).toBe(1);
    expect(enrichment.pageSize).toBe(10);
    expect(enrichment.truncated).toBe(true);
  });

  it('leaves truncated unset when the page holds every match', async () => {
    const base = parseSearchResponse(fixture('search-vfgh.json'));
    // total equals the hits on this single page → nothing exists beyond it.
    searchCaseLaw.mockResolvedValue({ ...base, total: base.hits.length, page: 1, pageSize: 10 });
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'vwgh',
      query: 'Datenschutz',
      page_size: 10,
    });
    await risSearchCaseLaw.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(base.hits.length);
    expect(enrichment.truncated).toBeUndefined();
  });
});

describe('risSearchCaseLaw — text filters: blank rejected, non-blank passed through (#39)', () => {
  /**
   * Every optional free-text input: [field, the court it applies to, a value, builder key].
   * decision_kind, subject_area, and issuing_body carry values the local reference checks
   * accept verbatim, so the value reaching the service is the value sent.
   */
  const TEXT_FILTERS = [
    ['query', { court: 'vfgh' }, ' Datenschutz ', 'query'],
    ['norm', { court: 'vfgh' }, 'DSG §1', 'norm'],
    ['case_number', { court: 'vfgh' }, 'G 287/2022', 'caseNumber'],
    ['decision_kind', { court: 'vfgh' }, 'Erkenntnis', 'decisionKind'],
    ['collection_number', { court: 'vfgh' }, '19.632', 'collectionNumber'],
    ['issuing_body', { court: 'dsk' }, 'Datenschutzbehoerde', 'issuingBody'],
    ['court_name', { court: 'justiz' }, 'OLG Wien', 'courtName'],
    ['subject_area', { court: 'justiz' }, 'Datenschutzrecht', 'subjectArea'],
    ['party', { court: 'upts' }, 'ÖVP', 'party'],
    ['subject_law', { court: 'bks' }, 'ORF-Gesetz', 'subjectLaw'],
  ] as const;

  beforeEach(() => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
  });

  it.each(TEXT_FILTERS)(
    '%s: a non-blank value reaches RIS unchanged',
    async (field, base, value, key) => {
      const result = await runToolContract(risSearchCaseLaw, { ...base, [field]: value } as never);
      expect(result.isError).not.toBe(true);
      expect(searchCaseLaw).toHaveBeenCalledTimes(1);
      expect(searchCaseLaw.mock.calls[0]![0]).toMatchObject({ [key]: value });
    },
  );

  it.each(
    TEXT_FILTERS.flatMap((row) =>
      ['', '   ', '\t\n'].map((blank) => [row[0], blank, row[1]] as const),
    ),
  )('%s: %j is rejected over the wire before any RIS call', async (field, blank, base) => {
    const result = await runToolContract(risSearchCaseLaw, { ...base, [field]: blank } as never);
    expectArgumentRejection(result, [`${field}: `, 'omit the field to leave it unfiltered']);
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('rejects a blank court-conditional filter as blank rather than dropping it under the wrong court', async () => {
    // court_name is justiz-only; a blank one under vfgh used to vanish and search vfgh unfiltered.
    const result = await runToolContract(risSearchCaseLaw, { court: 'vfgh', court_name: '' });
    expectArgumentRejection(result, ['court_name: ', 'omit the field to leave it unfiltered']);
    expect(searchCaseLaw).not.toHaveBeenCalled();
  });

  it('sends none of the text filters when every one is omitted', async () => {
    const result = await runToolContract(risSearchCaseLaw, { court: 'vfgh' });
    expect(result.isError).not.toBe(true);
    const params = searchCaseLaw.mock.calls[0]![0] as Record<string, unknown>;
    for (const [, , , key] of TEXT_FILTERS) expect(params).not.toHaveProperty(key);
    expect(params).toMatchObject({ court: 'vfgh' });
  });
});

describe('risSearchCaseLaw — record mapping and format() parity', () => {
  it('normalizes an array Geschäftszahl into multiple case_numbers, all rendered in format()', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-gz-array.json')));
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.case_numbers.length).toBeGreaterThan(1);
    expect(record.case_numbers[0]).toBe('E33/2026 ua');
    const text = (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text;
    for (const gz of record.case_numbers) expect(text).toContain(gz);
  });

  it('asks RIS for both document types by default, through the real service (#62)', async () => {
    // RIS serves Rechtssätze only on vfgh, vwgh, and justiz unless a Dokumenttyp flag is set,
    // so the default decision_type: all has to reach the wire as both flags.
    const actual = await vi.importActual<typeof import('@/services/ris/ris-service.js')>(
      '@/services/ris/ris-service.js',
    );
    const realService = new actual.RisService('ris-austria-mcp-server/test');
    const fetchMock = vi.fn((_url: unknown) =>
      Promise.resolve(new Response(JSON.stringify(fixture('search-zero-hits.json')))),
    );
    vi.stubGlobal('fetch', fetchMock);
    searchCaseLaw.mockImplementation((params, ctx) => realService.searchCaseLaw(params, ctx));

    const result = await runToolContract(risSearchCaseLaw, {
      court: 'vfgh',
      decided_from: '2026-09-01',
      decided_to: '2026-09-30',
    });
    vi.unstubAllGlobals();

    expect(result.isError).not.toBe(true);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('Applikation')).toBe('Vfgh');
    expect(url.searchParams.get('Dokumenttyp.SucheInRechtssaetzen')).toBe('true');
    expect(url.searchParams.get('Dokumenttyp.SucheInEntscheidungstexten')).toBe('true');
  });

  it('returns a joined Justiz headnote as one case number per element, on both surfaces (#53)', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-justiz-gz-joined.json')));
    const result = await runToolContract(risSearchCaseLaw, {
      court: 'justiz',
      case_number: '6Ob236/23h',
    });
    expect(result.isError).not.toBe(true);
    const [record] = (result.structuredContent as { results: CaseLawRecord[] }).results;
    expect(record!.case_numbers).toHaveLength(52);
    expect(record!.case_numbers[0]).toBe('1Ob948/52');
    expect(record!.case_numbers).toEqual(expect.arrayContaining(['6Ob236/23h', '3Ob761/53']));
    expect(contentText(result)).toContain(
      '## 1Ob948/52, 2Ob398/53, 3Ob760/53, 3Ob761/53, 3Ob15/54,',
    );
  });

  it('renders every populated field for a multi-hit result', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    expect(result.results).toHaveLength(2);
    // Read as CommonMark: a live cited norm ends in a space, which the escaper writes as `&#32;`.
    const text = readCommonMark(
      (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text,
    );
    for (const record of result.results) {
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.court);
      for (const gz of record.case_numbers) expect(text).toContain(gz);
      if (record.decision_date !== undefined) expect(text).toContain(record.decision_date);
      if (record.decision_type !== undefined) expect(text).toContain(record.decision_type);
      if (record.decision_kind !== undefined) expect(text).toContain(record.decision_kind);
      if (record.ecli !== undefined) expect(text).toContain(record.ecli);
      if (record.keywords !== undefined) expect(text).toContain(record.keywords);
      if (record.guiding_principle !== undefined) expect(text).toContain(record.guiding_principle);
      for (const norm of record.norms_cited) expect(text).toContain(norm);
    }
  });

  it('identifies a normenliste hit by the law it indexes, on both surfaces (#19)', async () => {
    // The whole payload of a norm-index record used to fall outside the schema, so a search
    // returned bare NL… numbers with empty case_numbers and empty norms_cited — nothing that
    // says which law was matched without a ris_get_document call per hit.
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-normenliste-dsg.json')));
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({
      court: 'normenliste',
      query: 'DSG',
      page_size: 10,
    });
    const result = await risSearchCaseLaw.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.document_number).toBe('NL00001301');
    expect(record.norm_index).toEqual({
      abbreviation: 'DSG 2000',
      reference: 'BGBl I 165/1999 BGBl. I Nr. 165/1999',
      title: expect.stringContaining('Bundesgesetz über den Schutz personenbezogener Daten'),
      type: 'BG',
    });
    expect(record.indexes).toEqual(['10/10 Datenschutz']);
    expect(record.note).toContain('nunmehr DSG');

    const text = (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**Norm:** DSG 2000');
    expect(text).toContain('**Norm type:** BG');
    expect(text).toContain('**Promulgated:** BGBl I 165/1999');
    expect(text).toContain('**Law:** Bundesgesetz über den Schutz personenbezogener Daten');
    expect(text).toContain('**Index:** 10/10 Datenschutz');
    expect(text).toContain('**Note:** Umbenennungsnorm');
    // The second law of the page is identified too — its VwGH short form, not the long one.
    expect(text).toContain('**Norm:** DSG 1978');
  });

  it('leaves norm_index absent for a deciding court', async () => {
    // Its presence is the marker separating a norm-index record from a decision — the
    // sixteen deciding courts must never carry it.
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    for (const record of result.results) expect(record.norm_index).toBeUndefined();
  });

  it('surfaces indexes and state on a state administrative court, on both surfaces (#22)', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-lvwg-tirol.json')));
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'lvwg', state: 'tirol' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    const text = (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**State:** Tirol');
    for (const record of result.results) {
      expect(record.state).toBe('Tirol');
      expect(record.indexes.length).toBeGreaterThan(0);
      for (const index of record.indexes) expect(text).toContain(index);
    }
    // The three-entry record proves the array shape survives to the rendered line.
    expect(result.results[1]!.indexes).toHaveLength(3);
    expect(text).toContain('**Index:** 10/01 Bundes-Verfassungsgesetz (B-VG); 10/10 Datenschutz;');
  });

  it('surfaces the guiding principle (Leitsatz) from a VfGH Rechtssatz and renders it', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-vfgh.json')));
    const ctx = createMockContext({ errors: risSearchCaseLaw.errors });
    const input = risSearchCaseLaw.input.parse({ court: 'vfgh' });
    const result = await risSearchCaseLaw.handler(input, ctx);
    const withPrinciple = result.results.find((r) => r.guiding_principle !== undefined);
    expect(withPrinciple, 'a VfGH hit should surface guiding_principle (Leitsatz)').toBeDefined();
    const text = (risSearchCaseLaw.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**Guiding principle:**');
    expect(text).toContain(withPrinciple!.guiding_principle!);
  });
});

// The fold itself is swept across every state parameter in _shared.test.ts; this pins that a
// result's own state value works as the next call's state filter on the wire path.
describe('risSearchCaseLaw — state names in state (#58)', () => {
  it('accepts the German state name a result carries as the next call’s state', async () => {
    searchCaseLaw.mockResolvedValue(parseSearchResponse(fixture('search-lvwg-tirol.json')));
    const first = await runToolContract(risSearchCaseLaw, { court: 'lvwg', state: 'tirol' });
    const { results } = first.structuredContent as { results: { state?: string }[] };
    const carried = results[0]?.state;
    expect(carried).toBe('Tirol');

    searchCaseLaw.mockClear();
    const second = await runToolContract(risSearchCaseLaw, { court: 'lvwg', state: carried });
    expect(second.isError).not.toBe(true);
    expect(searchCaseLaw.mock.calls[0]?.[0]).toMatchObject({ state: 'tirol' });
  });
});

describe('risSearchCaseLaw — content[] reads back the RIS strings (#79)', () => {
  const BASE = 'https://ogd.ris.bka.gv.at/Dokumente/Vfgh/JFT_X';
  const decision: RisHit = {
    application: 'Vfgh',
    contentReferences: [],
    contentUrls: {
      html: `${BASE}/JFT_X.html`,
      pdf: `${BASE}/JFT_(X).pdf`,
      rtf: `${BASE}/JFT_*X*.rtf`,
      xml: `${BASE}/JFT_X.xml`,
    },
    documentNumber: 'JFT_~~X~~',
    metadata: {
      abbreviation: '*DSG*',
      caseNumbers: [HOSTILE_TEXT.inline, HOSTILE_TEXT.pipeAndBackslash],
      collectionNumber: '_1_',
      controller: 'Judikatur',
      decisionDate: '2026-01-01',
      decisionDocumentType: '`Text`',
      decisionKind: '~~Erkenntnis~~',
      decisionUrl: 'https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFT_X',
      ecli: 'ECLI:AT:VFGH:2026:<b>X</b>',
      guidingPrinciple: HOSTILE_TEXT.multiLineTitle,
      headnotesUrl: 'https://ogd.ris.bka.gv.at/Ergebnis.wxe?Abfrage=Vfgh&Rechtssatz=JFR_X',
      indexes: [HOSTILE_TEXT.blockMarkers, '10/10 *Datenschutz*'],
      keywords: HOSTILE_TEXT.inline,
      legalAreas: [],
      legalForceNote: HOSTILE_TEXT.listOpener,
      normType: '_BG_',
      normsCited: [HOSTILE_TEXT.listOpener, 'DSG §1 [a](b)'],
      note: HOSTILE_TEXT.blockMarkers,
      reference: '<i>BGBl I 165/1999</i>',
      state: '# Tirol',
      summary: HOSTILE_TEXT.listOpener,
      title: HOSTILE_TEXT.multiLineTitle,
    },
    organ: HOSTILE_TEXT.inline,
  };
  const transparency: RisHit = {
    application: 'Upts',
    contentReferences: [],
    contentUrls: {},
    documentNumber: 'UPTS_~~1~~',
    metadata: {
      caseNumbers: [],
      controller: 'Sonstige',
      decisionDate: '2026-02-02',
      issuers: [],
      keywords: '`k`',
      normsCited: ['1. PartG §6'],
      party: '> Partei',
      summary: HOSTILE_TEXT.blockMarkers,
    },
  };

  async function run() {
    searchCaseLaw.mockResolvedValue({
      hits: [decision, transparency],
      page: 1,
      pageSize: 20,
      total: 2,
    });
    const result = await runToolContract(risSearchCaseLaw, { court: 'vfgh' });
    expect(result.isError).not.toBe(true);
    return { result, ...risSearchCaseLaw.output.parse(result.structuredContent) };
  }

  it('reads back every string verbatim and every URL as a link destination', async () => {
    const { result, results } = await run();
    expectReadBack(result, results);
  });

  it('heads a decision by its escaped case numbers, an uncased record by its document number', async () => {
    const { result } = await run();
    expect(readFormatBlock(result).headings).toEqual([
      `${HOSTILE_TEXT.inline}, ${HOSTILE_TEXT.pipeAndBackslash}`,
      'UPTS_~~1~~',
    ]);
  });
});
