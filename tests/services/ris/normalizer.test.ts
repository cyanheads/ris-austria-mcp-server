/**
 * @fileoverview Normalizer tests over REAL captured RIS payloads (tests/fixtures/ris/,
 * harvested from the production API 2026-07-05). Fully offline — no network.
 * @module tests/services/ris/normalizer
 */

import { readFileSync } from 'node:fs';

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  assertNoInBandError,
  coerceWrappedList,
  isHtmlErrorPage,
  parseCelexReferences,
  parseHistoryResponse,
  parseSearchResponse,
  stripHtmlRemnants,
} from '@/services/ris/normalizer.js';
import type {
  RisBundesrechtMetadata,
  RisJudikaturMetadata,
  RisSonstigeMetadata,
} from '@/services/ris/types.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

describe('parseSearchResponse', () => {
  it('parses a multi-hit array page and strips <br/> markup (BrKons)', () => {
    const result = parseSearchResponse(fixture('search-brkons-multi.json'));
    expect(result.total).toBe(439471);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.hits).toHaveLength(3);

    const hit = result.hits[0]!;
    expect(hit.documentNumber).toBe('NOR11013238');
    expect(hit.application).toBe('BrKons');
    expect(hit.changed).toBe('2025-10-28');
    const metadata = hit.metadata as RisBundesrechtMetadata;
    expect(metadata.controller).toBe('Bundesrecht');
    // <br/> markers become newlines; no HTML remnants survive.
    expect(metadata.title).not.toContain('<br');
    expect(metadata.title).toContain('StF: BGBl. II Nr. 130/1998');
    expect(metadata.sectionLabel).toBe('§ 0');
    expect(metadata.lawId).toBe('10012838');
    expect(metadata.lawUrl).toContain('GeltendeFassung.wxe');
    expect(metadata.inForceFrom).toBe('1998-04-24');
    expect(metadata.inForceUntil).toBe('2018-12-31');
    expect(metadata.normType).toBe('V');
    expect(metadata.indexes).toEqual(['96/01 Bundesstraßengesetz 1971']);
    // Content URLs keyed by DataType.
    expect(hit.contentUrls.xml).toContain('/Dokumente/Bundesnormen/NOR11013238/NOR11013238.xml');
    expect(hit.contentUrls.html).toContain('.html');
    expect(hit.contentUrls.rtf).toContain('.rtf');
    expect(hit.contentUrls.pdf).toContain('.pdf');
  });

  it('collapses a single-hit object response to one hit (Upts via Sonstige)', () => {
    const result = parseSearchResponse(fixture('search-upts-single.json'));
    expect(result.total).toBe(1);
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.documentNumber).toBe('UPTS_20260427_2026_0_074_605_UPTS_Grüne');
    const metadata = hit.metadata as RisSonstigeMetadata;
    expect(metadata.controller).toBe('Sonstige');
    expect(metadata.caseNumbers).toEqual(['2026-0.074.605/UPTS/Grüne']);
    expect(metadata.party).toBe('GRUENE (Die Grünen - Die Grüne Alternative)');
    // Upts renders multiple cited norms as one newline-separated scalar — split.
    expect(metadata.normsCited.length).toBeGreaterThan(1);
    expect(metadata.normsCited[0]).toBe('PartG §2 Z1');
  });

  it('returns an empty page on zero hits', () => {
    const result = parseSearchResponse(fixture('search-zero-hits.json'));
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('maps an empty-string Dokumentliste to empty content references (BgblAlt)', () => {
    const result = parseSearchResponse(fixture('search-bgblalt.json'));
    const hit = result.hits[0]!;
    expect(hit.contentReferences).toEqual([]);
    expect(hit.contentUrls).toEqual({});
    const metadata = hit.metadata as RisBundesrechtMetadata;
    expect(metadata.alexUrl).toContain('alex.onb.ac.at');
    expect(metadata.gazetteNumber).toBe('49/1940');
    expect(metadata.issue).toBe('25');
  });

  it('coerces a scalar Geschaeftszahl and an array Normen (Vfgh)', () => {
    const result = parseSearchResponse(fixture('search-vfgh.json'));
    const metadata = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(metadata.controller).toBe('Judikatur');
    expect(metadata.caseNumbers).toEqual(['V23/2026 (V23/2026-12)']);
    expect(metadata.normsCited.length).toBeGreaterThan(3);
    expect(metadata.ecli).toBe('ECLI:AT:VFGH:2026:V23.2026');
    expect(metadata.decisionKind).toBe('Erkenntnis');
    expect(metadata.decisionDocumentType).toBe('Rechtssatz');
    expect(metadata.decisionDate).toBe('2026-06-16');
  });

  it('coerces an array Geschaeftszahl to multiple case numbers', () => {
    const result = parseSearchResponse(fixture('search-gz-array.json'));
    const metadata = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(metadata.caseNumbers.length).toBeGreaterThan(1);
    expect(metadata.caseNumbers[0]).toBe('E33/2026 ua');
  });

  it('parses CELEX markers from Titel and Aenderung, multi-value brackets included', () => {
    const result = parseSearchResponse(fixture('search-brkons-celex.json'));
    const metadata = result.hits[0]!.metadata as RisBundesrechtMetadata;
    expect(metadata.celexReferences).toContain('395L0046');
    expect(metadata.celexReferences).toContain('32009L0133');
    expect(metadata.celexReferences).toContain('32010L0024');
    expect(metadata.celexReferences).toContain('32016L0680');
  });

  it('normalizes object-or-array content references and keys DataTypes (Mrp, GrA)', () => {
    const mrp = parseSearchResponse(fixture('search-mrp.json')).hits[0]!;
    // ContentReference array with a single-object ContentUrl inside.
    expect(mrp.contentReferences.length).toBeGreaterThan(1);
    expect(mrp.contentReferences[0]!.type).toBe('MainDocument');
    expect(mrp.contentUrls.pdf).toContain('/Dokumente/Mrp/MRP_20260701_59/');
    const mrpMeta = mrp.metadata as RisSonstigeMetadata;
    expect(mrpMeta.issuers.length).toBeGreaterThan(2);
    expect(mrpMeta.sessionNumber).toBe('59');

    const gra = parseSearchResponse(fixture('search-gra.json')).hits[0]!;
    // Single-object ContentReference; the signed PDF arrives as DataType Authentisch.
    expect(gra.contentUrls.authentic).toContain('/Dokumente/GemeinderechtAuth/');
    expect(gra.metadata.controller).toBe('Gemeinden');
  });

  it('normalizes the Landesrecht and Bezirke classes', () => {
    const lgbl = parseSearchResponse(fixture('search-lgblauth.json')).hits[0]!;
    expect(lgbl.metadata.controller).toBe('Landesrecht');
    const bvb = parseSearchResponse(fixture('search-bvb.json')).hits[0]!;
    expect(bvb.metadata.controller).toBe('Bezirke');
  });

  it('throws InvalidParams with the RIS message on an in-band Client error', () => {
    let caught: McpError | undefined;
    try {
      parseSearchResponse(fixture('error-client.json'));
    } catch (error) {
      caught = error as McpError;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect(caught!.code).toBe(JsonRpcErrorCode.InvalidParams);
    // RIS's schema-validation message passes through and names the element…
    expect(caught!.message).toContain('FassungVom');
    // …but the transport prefix is trimmed.
    expect(caught!.message.startsWith('soap:Client')).toBe(false);
  });

  it('classifies an unrecognized in-band error body as ServiceUnavailable (real 500 body)', () => {
    expect(() => parseSearchResponse(fixture('error-server-500.json'))).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }),
    );
  });

  it('rejects unrecognized envelopes as transient', () => {
    expect(() => parseSearchResponse({})).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }),
    );
    expect(() => parseSearchResponse({ OgdSearchResult: {} })).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }),
    );
  });
});

describe('assertNoInBandError', () => {
  it('honors the handbook @type attribute when present', () => {
    expect(() =>
      assertNoInBandError({ Error: { '@type': 'Client', Message: 'bad element' } }),
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.InvalidParams }));
    expect(() =>
      assertNoInBandError({ Error: { '@type': 'Server', Message: 'backend down' } }),
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }));
  });

  it('classifies by the soap: message prefix when @type is absent', () => {
    expect(() =>
      assertNoInBandError({ Error: { Message: 'soap:Server. backend degraded' } }),
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }));
  });

  it('passes error-free envelopes through', () => {
    expect(() => assertNoInBandError({})).not.toThrow();
  });
});

describe('parseHistoryResponse', () => {
  it('separates changed documents from deletion records', () => {
    const result = parseHistoryResponse(fixture('history-with-deleted.json'));
    expect(result.total).toBe(101);
    const documents = result.changes.filter((change) => change.kind === 'document');
    const deleted = result.changes.filter((change) => change.kind === 'deleted');
    expect(documents).toHaveLength(2);
    expect(deleted).toHaveLength(5);
    const record = deleted[0]!;
    if (record.kind !== 'deleted') throw new Error('unreachable');
    expect(record.record.documentNumber).toBe('NOR30003318');
    // Deletion records carry the History application name, not the search code.
    expect(record.record.application).toBe('Bundesnormen');
    expect(record.record.deletedAt).toBe('2026-06-17T14:46:31');
    // Changed documents keep the standard normalized record shape.
    const doc = documents[0]!;
    if (doc.kind !== 'document') throw new Error('unreachable');
    expect(doc.hit.metadata.controller).toBe('Bundesrecht');
  });
});

describe('text helpers', () => {
  it('coerceWrappedList handles every upstream list shape', () => {
    expect(coerceWrappedList(undefined)).toEqual([]);
    expect(coerceWrappedList('')).toEqual([]);
    expect(coerceWrappedList('one')).toEqual(['one']);
    expect(coerceWrappedList({ item: 'one' })).toEqual(['one']);
    expect(coerceWrappedList({ item: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(coerceWrappedList({})).toEqual([]);
  });

  it('stripHtmlRemnants converts <br/> to newlines, drops tags, decodes entities', () => {
    expect(stripHtmlRemnants('a<br/>b<br />c<br>d')).toBe('a\nb\nc\nd');
    expect(stripHtmlRemnants('x &amp; y &lt;z&gt;')).toBe('x & y <z>');
    expect(stripHtmlRemnants('trailing<br/><br/><br/>')).toBe('trailing');
    expect(stripHtmlRemnants('<i>styled</i> text')).toBe('styled text');
  });

  it('parseCelexReferences splits multi-value brackets and deduplicates', () => {
    expect(
      parseCelexReferences('x [CELEX-Nr.: 32009L0133, 32010L0024] y', '[CELEX-Nr.: 32009L0133]'),
    ).toEqual(['32009L0133', '32010L0024']);
    expect(parseCelexReferences(undefined, 'no markers here')).toEqual([]);
  });

  it('isHtmlErrorPage detects HTML bodies', () => {
    expect(isHtmlErrorPage('<!DOCTYPE html><html>…')).toBe(true);
    expect(isHtmlErrorPage('  <html lang="de">')).toBe(true);
    expect(isHtmlErrorPage('{"OgdSearchResult":{}}')).toBe(false);
  });
});
