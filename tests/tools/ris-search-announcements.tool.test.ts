/**
 * @fileoverview Tests for the ris_search_announcements tool — local per-collection
 * filter-matrix guards (rejected before any network call), the binding label assigned
 * per collection, error-contract mapping, zero-hit notices, and record-mapping/
 * format() parity across the Sonstige controller's collections. The RIS service
 * module is mocked so the suite is fully offline; success-path fixtures are run
 * through the real normalizer so results stay realistic.
 * @module tests/tools/ris-search-announcements.tool.test
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

import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { parseSearchResponse } from '@/services/ris/normalizer.js';
import {
  type AnnouncementsSearchParams,
  buildAnnouncementsRequest,
} from '@/services/ris/request-builder.js';

import {
  contentText,
  contractError,
  expectArgumentRejection,
  expectReadBack,
  HOSTILE_TEXT,
  hostileHit,
  linkDestinations,
  readCommonMark,
  stringLeaves,
  WEB_URL,
  type WireError,
} from './_wire.js';

const { searchAnnouncements } = vi.hoisted(() => ({ searchAnnouncements: vi.fn() }));

vi.mock('@/services/ris/ris-service.js', () => ({
  getRisService: () => ({ searchAnnouncements }),
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
  searchAnnouncements.mockReset();
});

describe('risSearchAnnouncements — local guards (no service call)', () => {
  it('rejects number sent to court_rules (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'court_rules', number: '12' });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("number is not a valid filter for collection 'court_rules'");
    expect(err.message).toContain(
      'it accepts: query, title, published_from, published_to, in_force_as_of, type',
    );
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects title sent to council_minutes (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'council_minutes',
      title: 'Ministerrat',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("title is not a valid filter for collection 'council_minutes'");
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects norm sent to social_insurance (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      norm: 'DSG §1',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("norm is not a valid filter for collection 'social_insurance'");
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects published_from sent to ministerial_decrees (decrees date by force, not publication)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'ministerial_decrees',
      published_from: '2020-01-01',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain(
      "published_from is not a valid filter for collection 'ministerial_decrees'",
    );
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects case_number sent to health_structure_plans (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'health_structure_plans',
      case_number: 'G 1/2020',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain(
      "case_number is not a valid filter for collection 'health_structure_plans'",
    );
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects issuer sent to trade_exam_rules (not in its param matrix)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'trade_exam_rules',
      issuer: 'BMF',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain("issuer is not a valid filter for collection 'trade_exam_rules'");
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it('rejects a reversed published window on ministerial_decrees as collection_filter_mismatch, not as a reversed window (#92)', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'ministerial_decrees',
      published_from: '2026-06-30',
      published_to: '2026-01-01',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'collection_filter_mismatch' });
    expect(err.message).toContain(
      "published_from is not a valid filter for collection 'ministerial_decrees'",
    );
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });
});

describe('risSearchAnnouncements — binding label per collection', () => {
  // `binding` is looked up purely from the requested `collection` — independent of the
  // mocked hit's actual shape — so a single realistic fixture is enough to sweep every
  // collection's designated label.
  const collectionBindings: [collection: string, binding: string][] = [
    ['social_insurance', 'authentic'],
    ['veterinary', 'authentic'],
    ['court_rules', 'authentic'],
    ['trade_exam_rules', 'authentic'],
    ['health_structure_plans', 'authentic'],
    ['ministerial_decrees', 'administrative_directive'],
    ['council_minutes', 'preparatory'],
  ];

  it('labels each collection with its designated binding value', async () => {
    for (const [collection, binding] of collectionBindings) {
      searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-mrp.json')));
      const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
      const input = risSearchAnnouncements.input.parse({ collection });
      const result = await risSearchAnnouncements.handler(input, ctx);
      expect(result.results[0]!.binding).toBe(binding);
      expect(result.results[0]!.collection).toBe(collection);
    }
  });
});

describe('risSearchAnnouncements — zero-hit notices', () => {
  const zeroHitsResult = parseSearchResponse(fixture('search-zero-hits.json'));

  beforeEach(() => {
    searchAnnouncements.mockResolvedValue(zeroHitsResult);
  });

  it('names the collection in the base fragment', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'social_insurance' });
    await risSearchAnnouncements.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe('0 documents in social_insurance.');
  });

  it('includes the norm-format guidance when norm is set', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'veterinary', norm: 'DSG §1' });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain("norm must match RIS's cited-norm format");
  });

  it('includes the issuer-designation guidance when issuer is set', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      issuer: 'Unbekannter Versicherungsträger',
    });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('issuer must match the RIS designation');
    expect(notice).toContain('ministry and social-insurance carrier abbreviations are expanded');
  });

  it('includes the KmGer coverage caveat for collection: court_rules', async () => {
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'court_rules' });
    await risSearchAnnouncements.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('0 documents in court_rules.');
    expect(notice).toContain('KmGer currently carries LVwG Tirol and Vorarlberg rules only.');
  });
});

// RIS keeps every document with no recorded Inkrafttretensdatum under FassungVom and under
// either Inkrafttretensdatum bound, whatever the date; the page is served as RIS sends it
// and the notice discloses the rule with the page's count of such rows.
describe('risSearchAnnouncements — undated documents under an in-force filter (#96)', () => {
  /** search-erlaesse.json holds five decrees, three of them with no Inkrafttretensdatum. */
  const DECREES_UNDATED =
    '3 of 5 on this page have no in_force_from — RIS returns all documents with no recorded entry-into-force date under in_force_as_of, entered_force_from, or entered_force_to, whatever the date, so totalCount counts them too.';

  /** Run one call over the wire; return the records and the enrichment fields. */
  async function callWire(input: Record<string, unknown>) {
    const result = await runToolContract(risSearchAnnouncements, input as never);
    expect(result.isError).not.toBe(true);
    const { results } = risSearchAnnouncements.output.parse(result.structuredContent);
    return { result, results, structured: result.structuredContent as Record<string, unknown> };
  }

  /** The notice reaches content[] as one block-quoted trailer line a client reads as plain text. */
  function expectNoticeLine(
    result: Awaited<ReturnType<typeof runToolContract>>,
    notice: string,
  ): void {
    const lines = contentText(result).split('\n');
    expect(lines.filter((line) => line === `> ${notice}`)).toHaveLength(1);
    expect(readCommonMark(`> ${notice}`)).toBe(
      `⟨blockquote_open⟩\n\n${notice}\n\n⟨blockquote_close⟩`,
    );
  }

  /** The three-notice veterinary page with the first `undated` notices' Inkrafttretensdatum removed. */
  function undatedVeterinaryPage(undated: number) {
    const raw = fixture('search-avn.json') as {
      OgdSearchResult: {
        OgdDocumentResults: {
          OgdDocumentReference: {
            Data: { Metadaten: { Sonstige: { Avn: { Inkrafttretensdatum?: string } } } };
          }[];
        };
      };
    };
    for (const doc of raw.OgdSearchResult.OgdDocumentResults.OgdDocumentReference.slice(
      0,
      undated,
    )) {
      delete doc.Data.Metadaten.Sonstige.Avn.Inkrafttretensdatum;
    }
    return parseSearchResponse(raw);
  }

  it('counts the decrees with no in_force_from under an entered-force window, on both surfaces', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-erlaesse.json')));
    const { result, results, structured } = await callWire({
      collection: 'ministerial_decrees',
      entered_force_from: '2026-07-01',
      entered_force_to: '2026-07-01',
    });
    expect(structured.notice).toBe(DECREES_UNDATED);
    expectNoticeLine(result, DECREES_UNDATED);
    // Served as RIS sent it: every row, the request, and the paging untouched.
    expect(results).toHaveLength(5);
    expect(results.filter((r) => r.in_force_from === undefined)).toHaveLength(3);
    expect(searchAnnouncements.mock.calls[0]![0]).toEqual({
      collection: 'ministerial_decrees',
      enteredForceFrom: '2026-07-01',
      enteredForceTo: '2026-07-01',
    });
    expect(structured).toMatchObject({ page: 1, pageSize: 100, totalCount: 1628, truncated: true });
  });

  it('counts undated veterinary notices under in_force_as_of — the rule follows the rows, not the collection', async () => {
    searchAnnouncements.mockResolvedValue(undatedVeterinaryPage(3));
    const { result, results, structured } = await callWire({
      collection: 'veterinary',
      in_force_as_of: '1900-01-01',
    });
    const notice =
      '3 of 3 on this page have no in_force_from — RIS returns all documents with no recorded entry-into-force date under in_force_as_of, entered_force_from, or entered_force_to, whatever the date, so totalCount counts them too.';
    expect(structured.notice).toBe(notice);
    expectNoticeLine(result, notice);
    expect(results.map((r) => r.document_number)).toEqual([
      'AVN_20261009_AVN_2026_23',
      'AVN_20260807_AVN_2026_19',
      'AVN_20260805_AVN_2026_17',
    ]);
    expect(searchAnnouncements.mock.calls[0]![0]).toEqual({
      collection: 'veterinary',
      inForceAsOf: '1900-01-01',
    });
    expect(structured).toMatchObject({ page: 1, pageSize: 100, totalCount: 710 });
  });

  it('counts a single undated notice among dated ones', async () => {
    searchAnnouncements.mockResolvedValue(undatedVeterinaryPage(1));
    const { structured } = await callWire({
      collection: 'veterinary',
      in_force_as_of: '2026-10-30',
    });
    expect(structured.notice).toBe(
      '1 of 3 on this page has no in_force_from — RIS returns all documents with no recorded entry-into-force date under in_force_as_of, entered_force_from, or entered_force_to, whatever the date, so totalCount counts them too.',
    );
  });

  it('adds no notice to a decree page without an in-force filter, though it holds undated rows', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-erlaesse.json')));
    const { results, structured } = await callWire({ collection: 'ministerial_decrees' });
    expect(results.filter((r) => r.in_force_from === undefined)).toHaveLength(3);
    expect(structured).not.toHaveProperty('notice');
  });

  it('adds no notice when every row under an in-force filter carries in_force_from', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-pruefgewo.json')));
    const { results, structured } = await callWire({
      collection: 'trade_exam_rules',
      in_force_as_of: '2026-10-30',
    });
    expect(results.every((r) => r.in_force_from !== undefined)).toBe(true);
    expect(structured).not.toHaveProperty('notice');
  });

  it('leads with the page-size sentence, in one notice', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-erlaesse.json')));
    const { result, structured } = await callWire({
      collection: 'ministerial_decrees',
      in_force_as_of: '2026-07-01',
      page_size: 50,
    });
    const notice = structured.notice as string;
    expect(notice.startsWith('page_size 50 served as 20 — ')).toBe(true);
    expect(notice.endsWith(` ${DECREES_UNDATED}`)).toBe(true);
    expectNoticeLine(result, notice);
    expect(searchAnnouncements.mock.calls[0]![0]).toEqual({
      collection: 'ministerial_decrees',
      inForceAsOf: '2026-07-01',
      pageSize: 20,
    });
  });
});

describe('risSearchAnnouncements — error mapping', () => {
  // The handler's `.catch()` re-maps in-band RIS errors surfaced by the service onto this
  // tool's declared contract: a Client error (ValidationError) becomes invalid_query
  // (ValidationError) and a transport/Server error (ServiceUnavailable) becomes
  // upstream_error — each carrying the original RIS message plus reason + recovery on the wire.
  it('maps a service ValidationError rejection to the invalid_query contract error', async () => {
    const upstreamError = validationError("The 'Kundmachung.Von' element is invalid.", {
      risApplication: 'Avsv',
    });
    searchAnnouncements.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      query: 'Beitragsgrundlage',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_query' });
    expect(err.message).toContain("'Kundmachung.Von' element is invalid.");
  });

  it('maps a service ServiceUnavailable rejection to the upstream_error contract error', async () => {
    const upstreamError = serviceUnavailable('RIS returned a non-JSON response.', {});
    searchAnnouncements.mockRejectedValue(upstreamError);
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({
      collection: 'social_insurance',
      query: 'Beitragsgrundlage',
    });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });

  it('maps a fetch deadline to upstream_timeout, keeping -32004 on the wire', async () => {
    searchAnnouncements.mockRejectedValue(
      timeout('fetch GET https://data.bka.gv.at timed out.', {}),
    );
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'social_insurance' });
    const err = await captureError(risSearchAnnouncements.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
  });

  // Each case below passes the input schema and is then refused by the request builder. The
  // real builder runs on the params the handler produced, so the asserted message is the one
  // a caller actually receives. The builder names the service param and the RIS application
  // code the caller never sent; the handler restates both over the collection value and the
  // tool's own field name, and names the sort columns the collection does have where it has
  // any (#12, #29).
  it.each([
    [
      'a collection that sorts by number only',
      { collection: 'health_structure_plans', sort_by: 'published' },
      "sort_by: 'published' is not available for collection 'health_structure_plans'. Use sort_by: 'number', or drop sort_by.",
      'Set sort_by to one of: number — or omit sort_by.',
    ],
    [
      'a collection with no sortable column at all',
      { collection: 'court_rules', sort_by: 'number' },
      "sort_by: 'number' is not available for collection 'court_rules'. Drop sort_by — this collection carries no sortable column.",
      'Change or drop sort_by, as the message describes.',
    ],
    [
      'a decrees collection with no sortable column',
      { collection: 'ministerial_decrees', sort_by: 'published' },
      "sort_by: 'published' is not available for collection 'ministerial_decrees'. Drop sort_by — this collection carries no sortable column.",
      'Change or drop sort_by, as the message describes.',
    ],
  ])(
    'states a builder sort_by rejection for %s in the caller’s vocabulary',
    async (_label, raw, message, hint) => {
      searchAnnouncements.mockImplementation(async (params: AnnouncementsSearchParams) => {
        buildAnnouncementsRequest(params);
        throw new Error('unreachable — the builder was expected to reject these params');
      });
      const err = await contractError(risSearchAnnouncements, raw);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'invalid_query' });
      expect(err.message).toBe(message);
      // Nothing the caller could not have written itself survives into the message.
      expect(err.message).not.toMatch(/Spg|KmGer|Erlaesse|sortBy/u);
      expect(err.message).not.toContain('silently ignored upstream');
      // A local rejection is never a page past the end: its recovery names the field (#59).
      expect(err.data?.recovery).toEqual({ hint });
    },
  );

  describe('type outside the collection’s RIS enumeration (#59)', () => {
    const TYPES = {
      court_rules: ['Geschaeftsordnung', 'Geschaeftsverteilung'],
      trade_exam_rules: [
        'Befaehigungspruefungsordnung',
        'Meisterpruefungsordnung',
        'HoehereBerufsqualifikation',
        'Fachdiplom',
        'HoeheresFachdiplom',
      ],
      veterinary: [
        'Kundmachungen',
        'SonstigeVeroeffentlichungen',
        'VeroeffentlichungenAufGrundVEVO',
      ],
    } as const;
    const COLLECTIONS = Object.keys(TYPES) as (keyof typeof TYPES)[];

    beforeEach(() => {
      searchAnnouncements.mockImplementation(async (params: AnnouncementsSearchParams) => {
        buildAnnouncementsRequest(params);
        return parseSearchResponse(fixture('search-zero-hits.json'));
      });
    });

    it.each(COLLECTIONS.map((collection) => [collection, TYPES[collection]] as const))(
      '%s: rejects Bogus naming type, the collection, and its values, with a field-naming recovery',
      async (collection, values) => {
        const result = await runToolContract(risSearchAnnouncements, { collection, type: 'Bogus' });
        expect(result.isError).toBe(true);
        const err = (result.structuredContent as { error: WireError }).error;
        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toMatchObject({ reason: 'invalid_query' });
        expect(err.message).toBe(
          `Invalid type value "Bogus" for collection ${collection}. Valid values: ${values.join(', ')}.`,
        );
        const hint = `Set type to one of: ${values.join(', ')} — or omit type.`;
        expect(err.data?.recovery).toEqual({ hint });
        expect(contentText(result)).toContain(hint);
        expect(contentText(result)).not.toMatch(/page/iu);
      },
    );

    it.each(COLLECTIONS)('%s: type Undefined searches unfiltered', async (collection) => {
      const result = await runToolContract(risSearchAnnouncements, {
        collection,
        type: 'Undefined',
      });
      expect(result.isError).not.toBe(true);
    });

    it('accepts a type padded with whitespace, sending the canonical value', async () => {
      const result = await runToolContract(risSearchAnnouncements, {
        collection: 'trade_exam_rules',
        type: ' Fachdiplom',
      });
      expect(result.isError).not.toBe(true);
      expect(buildAnnouncementsRequest(searchAnnouncements.mock.calls[0]![0]).params).toMatchObject(
        {
          Typ: 'Fachdiplom',
        },
      );
    });

    it('lists every collection’s type values in the type description', () => {
      const description = risSearchAnnouncements.input.shape.type.description ?? '';
      for (const value of Object.values(TYPES).flat()) expect(description).toContain(value);
    });
  });

  it('leads the recovery hint with the page for an out-of-range page (#30)', async () => {
    // RIS answers a page past the end with a German message that names no element, so
    // "correct the parameter named in the message" resolves to nothing and the reference
    // topics are dead ends. The page has to come first in the hint.
    searchAnnouncements.mockRejectedValue(
      validationError('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten', {}),
    );
    const err = await contractError(risSearchAnnouncements, {
      collection: 'social_insurance',
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

  it('maps a builder rejection of an unknown issuer to unresolved_ministry (#44)', async () => {
    searchAnnouncements.mockImplementation(async (params: AnnouncementsSearchParams) => {
      buildAnnouncementsRequest(params);
      throw new Error('unreachable — the builder was expected to reject these params');
    });
    const err = await contractError(risSearchAnnouncements, {
      collection: 'ministerial_decrees',
      issuer: 'BMXX',
    });
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unresolved_ministry' });
    expect(err.message).toContain('Unknown ministry "BMXX"');
    // The page-past-end advice that leads invalid_query does not apply to a ministry value.
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('ris_list_reference topic ministries'),
    });
    expect(err.data?.recovery).toMatchObject({ hint: expect.not.stringMatching(/page/iu) });
  });
});

describe('risSearchAnnouncements — text filters: blank rejected, non-blank passed through (#39)', () => {
  /** Every optional free-text input: [field, a collection that accepts it, a value, builder key]. */
  const TEXT_FILTERS = [
    ['query', { collection: 'social_insurance' }, ' Beitragsgrundlage ', 'query'],
    ['title', { collection: 'social_insurance' }, 'Satzung', 'title'],
    ['number', { collection: 'social_insurance' }, '40/2026', 'number'],
    ['issuer', { collection: 'social_insurance' }, 'ÖGK', 'issuer'],
    ['norm', { collection: 'veterinary' }, 'TSG §1', 'norm'],
    ['case_number', { collection: 'veterinary' }, '2026-0.123.456', 'caseNumber'],
    ['type', { collection: 'trade_exam_rules' }, 'Meisterpruefungsordnung', 'type'],
    ['department', { collection: 'ministerial_decrees' }, 'IV/2', 'department'],
    ['session_number', { collection: 'council_minutes' }, '59', 'sessionNumber'],
    ['legislature', { collection: 'council_minutes' }, 'XXVII', 'legislature'],
  ] as const;

  beforeEach(() => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
  });

  it.each(TEXT_FILTERS)(
    '%s: a non-blank value reaches RIS unchanged',
    async (field, base, value, key) => {
      const result = await runToolContract(risSearchAnnouncements, {
        ...base,
        [field]: value,
      } as never);
      expect(result.isError).not.toBe(true);
      expect(searchAnnouncements).toHaveBeenCalledTimes(1);
      expect(searchAnnouncements.mock.calls[0]![0]).toMatchObject({ [key]: value });
    },
  );

  it.each(
    TEXT_FILTERS.flatMap((row) =>
      ['', '   ', '\t\n'].map((blank) => [row[0], blank, row[1]] as const),
    ),
  )('%s: %j is rejected over the wire before any RIS call', async (field, blank, base) => {
    const result = await runToolContract(risSearchAnnouncements, {
      ...base,
      [field]: blank,
    } as never);
    expectArgumentRejection(result, [`${field}: `, 'omit the field to leave it unfiltered']);
    expect(searchAnnouncements).not.toHaveBeenCalled();
  });

  it.each([
    // RIS ignores a whitespace-only Urheber, so this one widened upstream, not locally.
    ['issuer', '   '],
    // norm is not a social_insurance filter; a blank one used to pass the collection guard.
    ['norm', ''],
  ])(
    'rejects a blank %s under social_insurance instead of answering the whole collection',
    async (field, blank) => {
      const result = await runToolContract(risSearchAnnouncements, {
        collection: 'social_insurance',
        [field]: blank,
      } as never);
      expectArgumentRejection(result, [`${field}: `, 'omit the field to leave it unfiltered']);
      expect(searchAnnouncements).not.toHaveBeenCalled();
    },
  );

  it('sends none of the text filters when every one is omitted', async () => {
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'social_insurance',
    });
    expect(result.isError).not.toBe(true);
    const params = searchAnnouncements.mock.calls[0]![0] as Record<string, unknown>;
    for (const [, , , key] of TEXT_FILTERS) expect(params).not.toHaveProperty(key);
    expect(params).toMatchObject({ collection: 'social_insurance' });
  });
});

describe('risSearchAnnouncements — record mapping and format() parity', () => {
  it('renders every populated field for a multi-hit council_minutes result under a document-number heading', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-mrp.json')));
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'council_minutes' });
    const result = await risSearchAnnouncements.handler(input, ctx);
    expect(result.results).toHaveLength(2);

    const first = result.results[0]!;
    const second = result.results[1]!;
    // Neither hit carries a title or summary; the heading is the document number either way.
    expect(first.title).toBeUndefined();
    expect(first.summary).toBeUndefined();
    expect(first.issuers).toHaveLength(5);
    expect(second.issuers).toHaveLength(1);
    expect(first.session_date).toBe('2026-07-01');
    expect(first.authentic_pdf_url).toBeUndefined();
    // Council minutes are PDF-only, so the RIS web view is the only surface a person can
    // open — and it was the field this record dropped.
    expect(first.document_url).toBe(
      'https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Mrp&Dokumentnummer=MRP_20260701_59',
    );

    const text = (risSearchAnnouncements.format!(result)[0] as { type: 'text'; text: string }).text;
    const read = readCommonMark(text);
    const parts = read.split('\n\n');
    expect(parts.flatMap((part, i) => (part === '⟨heading_open⟩' ? [parts[i + 1]] : []))).toEqual([
      'MRP_20260701_59',
      second.document_number,
    ]);
    for (const record of result.results) {
      expect(record.binding).toBe('preparatory');
      expect(text).toContain(record.document_number);
      expect(text).toContain(record.collection);
      if (record.session_date !== undefined) expect(text).toContain(record.session_date);
      for (const issuer of record.issuers) expect(text).toContain(issuer);
      expect(read).toContain(`⟨strong⟩RIS view:⟨/strong⟩ ⟨a⟩${record.document_url}⟨/a⟩`);
    }
    expect(linkDestinations(text).toSorted()).toEqual(
      stringLeaves(result.results)
        .filter((s) => WEB_URL.test(s))
        .toSorted(),
    );
  });

  it('maps an Avsv (social_insurance) hit — number, summary, and the authentic PDF surface', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-avsv.json')));
    const ctx = createMockContext({ errors: risSearchAnnouncements.errors });
    const input = risSearchAnnouncements.input.parse({ collection: 'social_insurance' });
    const result = await risSearchAnnouncements.handler(input, ctx);
    const record = result.results[0]!;
    expect(record.binding).toBe('authentic');
    expect(record.number).toBe('40');
    expect(record.published).toBe('2026-07-02');
    expect(record.summary).toContain('Höchstbeitragsgrundlage');
    expect(record.issuers).toEqual(['ÖGK']);
    expect(record.authentic_pdf_url).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Avsv/AVSV_2026_0040/AVSV_2026_0040.pdfsig',
    );
    expect(record.content_urls.pdf).toBe(
      'https://www.ris.bka.gv.at/Dokumente/Avsv/AVSV_2026_0040/AVSV_2026_0040.pdf',
    );
    expect(record.document_url).toBe(
      'https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Avsv&Dokumentnummer=AVSV_2026_0040',
    );

    const text = (risSearchAnnouncements.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(record.document_number);
    expect(text).toContain('**Number:** 40');
    expect(text).toContain(record.summary!);
    expect(text).toContain('ÖGK');
    expect(text).toContain(record.authentic_pdf_url!);
    expect(readCommonMark(text)).toContain(
      `⟨strong⟩RIS view:⟨/strong⟩ ⟨a⟩${record.document_url}⟨/a⟩`,
    );
    expect(linkDestinations(text).toSorted()).toEqual(
      stringLeaves(result.results)
        .filter((s) => WEB_URL.test(s))
        .toSorted(),
    );
  });
});

// The fold itself is swept across every state parameter in _shared.test.ts; this pins that the
// folded code is the plan state the request carries on the wire path.
describe('risSearchAnnouncements — state names in plan_state (#58)', () => {
  it.each([
    ['Kärnten', 'kaernten'],
    ['Styria', 'steiermark'],
  ])(
    'searches the regional health-structure plan of the state named %j (%s)',
    async (planState, code) => {
      searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
      const result = await runToolContract(risSearchAnnouncements, {
        collection: 'health_structure_plans',
        plan_state: planState,
      });
      expect(result.isError).not.toBe(true);
      expect(searchAnnouncements.mock.calls[0]?.[0]).toMatchObject({ planState: code });
    },
  );
});

describe('risSearchAnnouncements — collection metadata on records (#54)', () => {
  /** Run one call over the wire; return the parsed records by id and the text block per id. */
  async function callWire(fixtureName: string, input: Record<string, unknown>) {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture(fixtureName)));
    const result = await runToolContract(risSearchAnnouncements, input as never);
    expect(result.isError).not.toBe(true);
    const { results } = risSearchAnnouncements.output.parse(result.structuredContent);
    const text = contentText(result);
    // Matched on the parse: a document number ending in `_` is written escaped (`\_`).
    const blockFor = (documentNumber: string) =>
      text
        .split('\n\n')
        .find((block) =>
          readCommonMark(block).includes(`⟨strong⟩Document:⟨/strong⟩ ${documentNumber} (`),
        ) ?? '';
    return { blockFor, byId: new Map(results.map((r) => [r.document_number, r])), results };
  }

  it('adds no collection-specific keys to a social_insurance record', async () => {
    const { results } = await callWire('search-avsv.json', { collection: 'social_insurance' });
    expect(Object.keys(results[0]!).sort()).toEqual([
      'authentic_pdf_url',
      'binding',
      'collection',
      'content_urls',
      'document_number',
      'document_url',
      'issuers',
      'norms_cited',
      'number',
      'published',
      'summary',
      'title',
    ]);
  });

  it('gives a decree its case number, type, approval date, department, gazette citation, and norms', async () => {
    const { blockFor, byId } = await callWire('search-erlaesse.json', {
      collection: 'ministerial_decrees',
      issuer: 'BMJ',
    });
    const id = 'ERL_BMJ_20260924_2026_0_710_595';
    expect(byId.get(id)).toMatchObject({
      approved: '2026-09-24',
      case_numbers: ['2026-0.710.595'],
      department: 'I 7',
      in_force_from: '2026-10-01',
      norms_cited: ['TP1 GGG, TP2 GGG, TP3 GGG, TP12 GGG'],
      promulgation: 'eJABl Nr. 13/2026',
      type: 'Erlass',
    });
    expect(byId.get(id)).not.toHaveProperty('published');
    const block = blockFor(id);
    for (const line of [
      '**Approved:** 2026-09-24',
      '**Case numbers:** 2026-0.710.595',
      '**Type:** Erlass',
      '**Department:** I 7',
      '**In force from:** 2026-10-01',
      '**Promulgation:** eJABl Nr. 13/2026',
      '**Norms:** TP1 GGG, TP2 GGG, TP3 GGG, TP12 GGG',
    ]) {
      expect(block).toContain(line);
    }
  });

  it('keeps a multi-item decree Normen as separate entries and leaves absent fields absent', async () => {
    const { blockFor, byId } = await callWire('search-erlaesse.json', {
      collection: 'ministerial_decrees',
    });
    const rundschreiben = byId.get('ERL_BKA_20250110_2025_0_015_115')!;
    expect(rundschreiben.norms_cited).toEqual(['B-VG Art 22a', 'IFG']);
    for (const key of ['department', 'promulgation', 'in_force_from', 'in_force_until', 'note']) {
      expect(rundschreiben).not.toHaveProperty(key);
    }
    expect(blockFor('ERL_BKA_20250110_2025_0_015_115')).not.toContain('**Department:**');
    expect(byId.get('ERL_BKA_20250813_2025_0_615_241')!.in_force_until).toBe('2026-08-31');
    expect(blockFor('ERL_BKA_20250813_2025_0_615_241')).toContain('**In force until:** 2026-08-31');
    expect(byId.get('ERL_BKA_20260914_2026_0_722_315')!.keywords).toBe(
      'Bildungskarenz, Bildungsteilzeit, Weiterbildungsbeihilfe',
    );
    expect(blockFor('ERL_BKA_20260914_2026_0_722_315')).toContain(
      '**Keywords:** Bildungskarenz, Bildungsteilzeit, Weiterbildungsbeihilfe',
    );
    expect(byId.get('ERL_BMJ_20250930_2025_0_575_430')!.note).toBe(
      'Außerkrafttreten des Erlasses vom 20. April 2018',
    );
    expect(blockFor('ERL_BMJ_20250930_2025_0_575_430')).toContain(
      '**Note:** Außerkrafttreten des Erlasses vom 20. April 2018',
    );
  });

  it('gives a veterinary notice trimmed case numbers, its repeal date, note, and keywords', async () => {
    const { blockFor, byId } = await callWire('search-avn.json', { collection: 'veterinary' });
    expect(byId.get('AVN_20261009_AVN_2026_23')!.case_numbers).toEqual(['2026-0.847.254']);
    expect(byId.get('AVN_20260805_AVN_2026_17')!.case_numbers).toEqual(['2026-0.613.534']);
    const tbc = byId.get('AVN_20260807_AVN_2026_19')!;
    expect(tbc).toMatchObject({
      in_force_from: '2026-08-08',
      in_force_until: '2026-10-06',
      keywords: 'TBC',
      type: 'Kundmachung',
    });
    expect(tbc.note).toContain('AVN Nr. 2025/30');
    expect(blockFor('AVN_20260807_AVN_2026_19')).toContain(`**Note:** ${tbc.note}`);
    expect(byId.get('AVN_20260805_AVN_2026_17')).not.toHaveProperty('in_force_until');
  });

  it('gives a court rule its court, case number, type, and in-force window', async () => {
    const { blockFor, byId } = await callWire('search-kmger.json', { collection: 'court_rules' });
    const id = 'KMGER_LVWGTI_20260522_LVwG_102_120_2026';
    expect(byId.get(id)).toMatchObject({
      case_numbers: ['LVwG-102/120-2026'],
      court_name: 'LVwG Tirol',
      in_force_from: '2026-05-22',
      in_force_until: '2026-08-09',
      type: 'Geschaeftsverteilung',
    });
    expect(blockFor(id)).toContain('**Court:** LVwG Tirol');
  });

  it('gives a trade-exam rule its repeal date', async () => {
    const { blockFor, byId } = await callWire('search-pruefgewo.json', {
      collection: 'trade_exam_rules',
    });
    const id = 'PRUEF_20210412_2021_0_253_954_BMDW_Gewerberecht_';
    expect(byId.get(id)).toMatchObject({
      case_numbers: ['2021-0.253.954 (BMDW/Gewerberecht)'],
      in_force_until: '2022-11-15',
      type: 'Meisterpruefungsordnung',
    });
    expect(blockFor(id)).toContain('**In force until:** 2022-11-15');
  });

  it('gives a health-structure plan its state, type, and repeal date, and no case_numbers', async () => {
    const { blockFor, byId } = await callWire('search-spg.json', {
      collection: 'health_structure_plans',
      plan_state: 'salzburg',
    });
    const id = 'SPG_SA_RSG_V_20250507_3_2025';
    expect(byId.get(id)).toMatchObject({
      in_force_until: '2026-02-16',
      keywords: 'RSG-Planungsmatrix',
      plan_state: 'Salzburg',
      type: 'RsgVerordnung',
    });
    expect(byId.get(id)).not.toHaveProperty('case_numbers');
    expect(blockFor(id)).toContain('**Plan state:** Salzburg');
  });

  it('gives council minutes their session number and legislature, and no case_numbers', async () => {
    const { blockFor, byId } = await callWire('search-mrp.json', {
      collection: 'council_minutes',
    });
    expect(byId.get('MRP_20260701_59')).toMatchObject({
      legislature: 'XXVIII',
      session_number: '59',
    });
    expect(byId.get('MRP_20260630_58b')!.session_number).toBe('58b');
    expect(byId.get('MRP_20260701_59')).not.toHaveProperty('case_numbers');
    expect(byId.get('MRP_20260701_59')).not.toHaveProperty('in_force_from');
    const block = blockFor('MRP_20260701_59');
    expect(block).toContain('**Session number:** 59');
    expect(block).toContain('**Legislature:** XXVIII');
  });

  it('round-trips a decree norms_cited entry into the norm filter unchanged', async () => {
    searchAnnouncements.mockResolvedValue(parseSearchResponse(fixture('search-zero-hits.json')));
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'ministerial_decrees',
      norm: 'TP1 GGG, TP2 GGG, TP3 GGG, TP12 GGG',
    });
    expect(result.isError).not.toBe(true);
    expect(searchAnnouncements.mock.calls[0]![0]).toMatchObject({
      norm: 'TP1 GGG, TP2 GGG, TP3 GGG, TP12 GGG',
    });
  });
});

describe('risSearchAnnouncements — multi-line notes keep their breaks under their label (#54, #79)', () => {
  it('renders a note RIS breaks with <br/> in its **Note:** paragraph, line breaks and numbering read back', async () => {
    const page = parseSearchResponse(fixture('search-erlaesse.json'));
    const id = 'ERL_BMJ_20250930_2025_0_575_430';
    const hits = page.hits.map((hit) =>
      hit.documentNumber === id
        ? {
            ...hit,
            metadata: {
              ...hit.metadata,
              note: '1. Außerkrafttreten des Erlasses vom 20. April 2018\n2. Ersetzt durch den Erlass vom 30. September 2025',
            },
          }
        : hit,
    );
    searchAnnouncements.mockResolvedValue({ ...page, hits });
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'ministerial_decrees',
    });
    expect(result.isError).not.toBe(true);
    const { results } = risSearchAnnouncements.output.parse(result.structuredContent);
    expect(results.find((r) => r.document_number === id)!.note).toBe(
      '1. Außerkrafttreten des Erlasses vom 20. April 2018\n2. Ersetzt durch den Erlass vom 30. September 2025',
    );
    // The second line opens with "2. " — read back as text, never as an ordered list.
    const read = readCommonMark(contentText(result));
    expect(read).toContain(
      '⟨strong⟩Note:⟨/strong⟩ 1. Außerkrafttreten des Erlasses vom 20. April 2018\n2. Ersetzt durch den Erlass vom 30. September 2025\n',
    );
    expect(read).not.toContain('⟨ordered_list_open⟩');
  });
});

describe('risSearchAnnouncements — content[] reads back RIS text verbatim (#79)', () => {
  it('reads back every hostile-shaped field under a document-number heading', async () => {
    const page = parseSearchResponse(fixture('search-erlaesse.json'));
    const [first, second, third] = page.hits;
    const hits = [
      {
        ...hostileHit(first!, 0, {
          note: HOSTILE_TEXT.blockMarkers,
          summary: HOSTILE_TEXT.listOpener,
          title: HOSTILE_TEXT.multiLineTitle,
        }),
        documentNumber: `~~${first!.documentNumber}~~`,
      },
      hostileHit(second!, 1, { summary: HOSTILE_TEXT.multiLineTitle, title: undefined }),
      hostileHit(third!, 2, {}),
    ];
    searchAnnouncements.mockResolvedValue({ ...page, hits });
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'ministerial_decrees',
    });
    expect(result.isError).not.toBe(true);
    const { results } = risSearchAnnouncements.output.parse(result.structuredContent);
    // structuredContent relays the RIS strings as written.
    expect(results[0]).toMatchObject({
      document_number: `~~${first!.documentNumber}~~`,
      note: HOSTILE_TEXT.blockMarkers,
      summary: HOSTILE_TEXT.listOpener,
      title: HOSTILE_TEXT.multiLineTitle,
    });
    expect(results[1]).not.toHaveProperty('title');

    const blocks = expectReadBack(result, results);
    results.forEach((record, i) => {
      const read = readCommonMark(blocks[i]!);
      expect(
        read.startsWith(`⟨heading_open⟩\n\n${record.document_number}\n\n⟨heading_close⟩`),
      ).toBe(true);
      if (record.title !== undefined) {
        expect(read).toContain(`⟨strong⟩Title:⟨/strong⟩ ${record.title}\n`);
      }
      expect(read).toContain(`\n${record.summary}\n`);
    });
    expect(readCommonMark(blocks[0]!)).toContain(
      `⟨strong⟩Note:⟨/strong⟩ ${HOSTILE_TEXT.blockMarkers}\n`,
    );
    expect(readCommonMark(blocks[1]!)).not.toContain('Title:');
  });

  it('reads back all six titles of a decree search, three of them multi-line, under six headings', async () => {
    searchAnnouncements.mockResolvedValue(
      parseSearchResponse(fixture('search-erlaesse-befoerderungszuschuss.json')),
    );
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'ministerial_decrees',
      query: 'Beförderungszuschusses',
    });
    expect(result.isError).not.toBe(true);
    const { results } = risSearchAnnouncements.output.parse(result.structuredContent);
    expect(results).toHaveLength(6);
    expect(results[1]!.title).toBe(
      'Informationsschreiben zur steuerlichen Behandlung des\nBeförderungszuschusses für sämtliche Mitarbeiterinnen und Mitarbeiter ab\n1. Jänner 2026',
    );
    expect(results.filter((record) => record.title?.includes('\n'))).toHaveLength(3);
    const blocks = expectReadBack(result, results);
    results.forEach((record, i) => {
      expect(readCommonMark(blocks[i]!)).toContain(`⟨strong⟩Title:⟨/strong⟩ ${record.title}\n`);
    });
  });
});
