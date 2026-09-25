/**
 * @fileoverview Issuer expansion and change-recency filtering end to end — tool input through
 * the handler, the real `RisService` and request builder, down to the RIS URL — with only the
 * network stubbed by a strict fetch fake. Covers the announcements recency filter on the two
 * collections RIS ignores it on (#37), social-insurance carrier abbreviations (#38), and the
 * ministries in office since 2025 plus the unknown-ministry rejection (#44). Every call runs
 * through `runToolContract`, so `structuredContent` and `content[]` are both asserted.
 * @module tests/tools/issuer-and-recency-filters.test
 */

import { readFileSync } from 'node:fs';

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { risSearchAnnouncements } from '@/mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { risSearchDrafts } from '@/mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { risSearchGazette } from '@/mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { risTrackChanges } from '@/mcp-server/tools/definitions/ris-track-changes.tool.js';
import { RIS_CHANGED_SINCE_INTERVALS } from '@/services/ris/reference/index.js';
import { initRisService } from '@/services/ris/ris-service.js';

import { contentText, type ToolResult } from './_wire.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/ris/${name}`, import.meta.url), 'utf8');
}

const RIS_API = /^https:\/\/data\.bka\.gv\.at\/ris\/api\/v2\.6\//u;

let http: FetchMockHarness;

/** Answer every RIS API request with one fixture body. */
function answerWith(name: string): void {
  const body = fixture(name);
  http.route({
    match: RIS_API,
    respond: () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
  });
}

/** Query params of the one RIS request the call made. */
function sentParams(): Record<string, string> {
  expect(http.calls).toHaveLength(1);
  return Object.fromEntries(
    new URL((http.calls[0] as { request: Request }).request.url).searchParams,
  );
}

interface WireError {
  code: number;
  data?: { reason?: string; recovery?: { hint?: string } };
  message: string;
}

/** The structured error of a failed call, after asserting it is one. */
function wireError(result: ToolResult): WireError {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: WireError }).error;
}

beforeAll(() => {
  initRisService({
    mcpServerName: 'ris-austria-mcp-server',
    mcpServerVersion: 'test',
  } as AppConfig);
});

beforeEach(() => {
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

describe('ris_search_announcements changed_since (#37)', () => {
  const INTERVALS = RIS_CHANGED_SINCE_INTERVALS.map((i) => [i.code, i.risValue] as const);
  const IGNORING = [
    ['social_insurance', 'Avsv'],
    ['veterinary', 'Avn'],
  ] as const;
  const HONORING = [
    'court_rules',
    'trade_exam_rules',
    'health_structure_plans',
    'ministerial_decrees',
    'council_minutes',
  ] as const;

  it.each(
    IGNORING.flatMap(([collection, app]) =>
      INTERVALS.map(([code]) => [collection, app, code] as const),
    ),
  )(
    '%s (%s) + %s fails as collection_filter_mismatch with no RIS request',
    async (collection, application, code) => {
      answerWith('search-avsv.json');
      const result = await runToolContract(risSearchAnnouncements, {
        changed_since: code,
        collection,
      });
      const error = wireError(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('collection_filter_mismatch');
      expect(error.message).toContain(
        `changed_since is not a valid filter for collection '${collection}'`,
      );
      const hint = error.data?.recovery?.hint ?? '';
      for (const phrase of [
        'published_from',
        'ris_track_changes',
        `application: "${application}"`,
      ]) {
        expect(hint).toContain(phrase);
      }
      const text = contentText(result);
      expect(text).toContain(`changed_since is not a valid filter for collection '${collection}'`);
      expect(text).toContain(hint);
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each(
    HONORING.flatMap((collection) =>
      INTERVALS.map(([code, token]) => [collection, code, token] as const),
    ),
  )('%s + %s still forwards ImRisSeit=%s', async (collection, code, token) => {
    answerWith('search-zero-hits.json');
    const result = await runToolContract(risSearchAnnouncements, {
      changed_since: code,
      collection,
    });
    expect(result.isError).not.toBe(true);
    expect(sentParams()['ImRisSeit']).toBe(token);
  });

  it.each(IGNORING)(
    'both named recoveries run as written for %s',
    async (collection, application) => {
      answerWith('search-avsv.json');
      const published = await runToolContract(risSearchAnnouncements, {
        collection,
        published_from: '2026-09-17',
      });
      expect(published.isError).not.toBe(true);
      expect(sentParams()).toMatchObject({
        Applikation: application,
        'Kundmachung.Von': '2026-09-17',
      });

      http.restore();
      http = createFetchMock();
      http.install();
      answerWith('history-with-deleted.json');
      const changes = await runToolContract(risTrackChanges, {
        application,
        changed_from: '2026-09-17',
      });
      expect(changes.isError).not.toBe(true);
      expect(sentParams()).toMatchObject({ AenderungenVon: '2026-09-17', Anwendung: application });
    },
  );
});

describe('ris_search_announcements social-insurance issuer (#38)', () => {
  it.each([
    ['ÖGK', 'Österreichische Gesundheitskasse (ÖGK)'],
    ['ögk', 'Österreichische Gesundheitskasse (ÖGK)'],
    ['DVSV', 'Dachverband der Sozialversicherungsträger (DVSV)'],
    ['hvsv', 'Hauptverband der österreichischen Sozialversicherungsträger (HVSV)'],
    ['PI Linz AG', 'Pensionsinstitut der Linz AG (PI Linz AG)'],
  ])(
    'expands %s to Urheber %s and returns its documents on both surfaces',
    async (issuer, value) => {
      answerWith('search-avsv.json');
      const result = await runToolContract(risSearchAnnouncements, {
        collection: 'social_insurance',
        issuer,
      });
      expect(result.isError).not.toBe(true);
      expect(sentParams()['Urheber']).toBe(value);
      const structured = result.structuredContent as {
        results: { document_number: string }[];
        totalCount: number;
      };
      expect(structured.totalCount).toBe(1204);
      expect(structured.results.length).toBeGreaterThan(0);
      const text = contentText(result);
      for (const record of structured.results) expect(text).toContain(record.document_number);
    },
  );

  it.each([
    'ÖGK Gesamtvertrag',
    'Österreichische Gesundheitskasse (ÖGK)',
    'Wiener Gebietskrankenkasse (WGKK)',
    'Betriebskrankenkasse Kindberg',
  ])('passes %s through unchanged', async (issuer) => {
    answerWith('search-avsv.json');
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'social_insurance',
      issuer,
    });
    expect(result.isError).not.toBe(true);
    expect(sentParams()['Urheber']).toBe(issuer);
  });

  it('passes an unlisted issuer through and answers a zero-hit notice naming the accepted forms', async () => {
    answerWith('search-zero-hits.json');
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'social_insurance',
      issuer: 'Unbekannter Versicherungsträger',
    });
    expect(result.isError).not.toBe(true);
    expect(sentParams()['Urheber']).toBe('Unbekannter Versicherungsträger');
    const structured = result.structuredContent as { notice?: string; results: unknown[] };
    expect(structured.results).toEqual([]);
    const notice = structured.notice ?? '';
    expect(notice).toContain('social-insurance carrier abbreviations');
    expect(notice).toContain('ris_list_reference topic issuing_bodies');
    expect(contentText(result)).toContain(notice);
  });
});

describe('ministries in office since 2025, and unknown ministries (#44)', () => {
  const unknownDesignation = 'Bundesministerium für Zukunftsfragen und Raumfahrt';

  /** One ministry-taking surface: tool, base input, the input field, the RIS param, fixture. */
  const SURFACES = [
    {
      name: 'ris_search_drafts',
      definition: risSearchDrafts,
      base: { stage: 'review_drafts' },
      field: 'ministry',
      param: 'EinbringendeStelle',
      fixture: 'search-begut.json',
      bmwet: 'BMWET',
      bmf: 'BMF',
    },
    {
      name: 'ris_search_gazette',
      definition: risSearchGazette,
      base: { scope: 'federal', published_from: '2025-06-01' },
      field: 'issuer',
      param: 'EinbringendeStelle',
      fixture: 'search-bgblauth-2004-01.json',
      bmwet: 'BMWET',
      bmf: 'BMF',
    },
    {
      name: 'ris_search_announcements council_minutes',
      definition: risSearchAnnouncements,
      base: { collection: 'council_minutes' },
      field: 'issuer',
      param: 'Einbringer',
      fixture: 'search-mrp.json',
      bmwet: 'BMWET (Bundesministerium für Wirtschaft, Energie und Tourismus)',
      bmf: 'BMF (Bundesministerium für Finanzen)',
    },
    {
      name: 'ris_search_announcements ministerial_decrees',
      definition: risSearchAnnouncements,
      base: { collection: 'ministerial_decrees' },
      field: 'issuer',
      param: 'Bundesministerium',
      fixture: 'search-zero-hits.json',
      bmwet: 'Bundesministerium für Wirtschaft, Energie und Tourismus',
      bmf: 'Bundesministerium für Finanzen',
    },
  ] as const;

  /** Run one surface with its ministry field set. */
  function call(surface: (typeof SURFACES)[number], value: string) {
    return runToolContract(
      surface.definition as typeof risSearchAnnouncements,
      {
        ...surface.base,
        [surface.field]: value,
      } as never,
    );
  }

  it.each(SURFACES)('$name resolves BMWET and its full designation', async (surface) => {
    for (const value of ['BMWET', 'Bundesministerium für Wirtschaft, Energie und Tourismus']) {
      http.reset();
      answerWith(surface.fixture);
      const result = await call(surface, value);
      expect(result.isError).not.toBe(true);
      expect(sentParams()[surface.param]).toBe(surface.bmwet);
    }
  });

  it.each(SURFACES)('$name resolves BMF exactly as before', async (surface) => {
    answerWith(surface.fixture);
    const result = await call(surface, 'BMF');
    expect(result.isError).not.toBe(true);
    expect(sentParams()[surface.param]).toBe(surface.bmf);
  });

  it.each(SURFACES)('$name sends an unknown full designation unchanged', async (surface) => {
    answerWith(surface.fixture);
    const result = await call(surface, unknownDesignation);
    expect(result.isError).not.toBe(true);
    expect(sentParams()[surface.param]).toBe(unknownDesignation);
  });

  it.each(SURFACES)(
    '$name rejects an unknown abbreviation as unresolved_ministry, pointing at the ministries table',
    async (surface) => {
      answerWith(surface.fixture);
      const result = await call(surface, 'BMXX');
      const error = wireError(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('unresolved_ministry');
      expect(error.message).toContain('Unknown ministry "BMXX"');
      const hint = error.data?.recovery?.hint ?? '';
      expect(hint).toContain('ris_list_reference topic ministries');
      expect(hint).not.toMatch(/page/iu);
      const text = contentText(result);
      expect(text).toContain('Unknown ministry "BMXX"');
      expect(text).toContain(hint);
      expect(http.calls).toHaveLength(0);
    },
  );

  it('rejects BMEIF on the exact-match families as ambiguous, with the same recovery', async () => {
    answerWith('search-mrp.json');
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'council_minutes',
      issuer: 'BMEIF',
    });
    const error = wireError(result);
    expect(error.data?.reason).toBe('unresolved_ministry');
    expect(error.message).toContain('ambiguous');
    expect(error.message).toContain(
      'BMEIF (Bundesministerium für Europa, Integration und Familie)',
    );
    expect(http.calls).toHaveLength(0);
  });
});

describe('a known ministry the collection does not accept (#45)', () => {
  it.each(['BMEUV', 'BMFFIM'])(
    'ministerial_decrees rejects %s as not accepted by its issuer parameter, on both surfaces',
    async (issuer) => {
      answerWith('search-zero-hits.json');
      const result = await runToolContract(risSearchAnnouncements, {
        collection: 'ministerial_decrees',
        issuer,
      });
      const error = wireError(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('unresolved_ministry');
      expect(error.message).toContain(
        `Ministry "${issuer}" is not accepted by this issuer parameter`,
      );
      expect(error.message).toContain('Erlaesse Bundesministerium');
      expect(error.message).not.toContain('closest matches');
      const text = contentText(result);
      expect(text).toContain(`Ministry "${issuer}" is not accepted by this issuer parameter`);
      expect(text).not.toContain('closest matches');
      expect(http.calls).toHaveLength(0);
    },
  );

  it('council_minutes still resolves BMEUV to its Mrp composite', async () => {
    answerWith('search-mrp.json');
    const result = await runToolContract(risSearchAnnouncements, {
      collection: 'council_minutes',
      issuer: 'BMEUV',
    });
    expect(result.isError).not.toBe(true);
    expect(sentParams()['Einbringer']).toBe(
      'BMEUV (Bundesministerin für EU und Verfassung im Bundeskanzleramt)',
    );
  });
});
