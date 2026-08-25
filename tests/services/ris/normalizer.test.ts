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
  errorFromResponseBody,
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

/** Read a fixture as the raw body text, the shape an error-response body arrives in. */
function rawFixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/ris/${name}`, import.meta.url), 'utf8');
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

  it('maps every Normenliste identifying field, preferring the VwGH short form (#19)', () => {
    const result = parseSearchResponse(fixture('search-normenliste-dsg.json'));
    const first = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(first.controller).toBe('Judikatur');
    expect(first.title).toContain('Bundesgesetz über den Schutz personenbezogener Daten');
    expect(first.abbreviation).toBe('DSG 2000');
    expect(first.normType).toBe('BG');
    expect(first.reference).toBe('BGBl I 165/1999 BGBl. I Nr. 165/1999');
    expect(first.indexes).toEqual(['10/10 Datenschutz']);
    expect(first.note).toContain('Umbenennung ab 2018-05-25, nunmehr DSG');
    // A norm-index record identifies a law, so it carries none of the decision fields.
    expect(first.caseNumbers).toEqual([]);
    expect(first.normsCited).toEqual([]);

    // AbkuerzungDesVerwaltungsgerichtshofes is on every record and is the citable form;
    // Abkuerzung is sparse and here repeats the full name.
    const second = result.hits[1]!.metadata as RisJudikaturMetadata;
    expect(second.abbreviation).toBe('DSG 1978');
    expect(second.abbreviation).not.toBe('Datenschutzgesetz - DSG');
    expect(second.note).toBeUndefined();
    // CRLF-delimited upstream — no carriage returns survive into the normalized text.
    expect(second.reference).toBe('BGBl 565/1978\nBGBl. Nr. 565/1978');
    expect(second.title).not.toContain('\r');
  });

  // The normalizer already mapped these two; #22's loss was at the record mapper, so the
  // regression test lives in the ris_search_case_law suite. This pins the fixture shapes.
  it('maps Lvwg Indizes and Bundesland, in both upstream list shapes', () => {
    const result = parseSearchResponse(fixture('search-lvwg-tirol.json'));
    const single = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(single.state).toBe('Tirol');
    expect(single.indexes).toEqual(['10/10 Grundrechte, Datenschutz, Auskunftspflicht']);
    const multi = result.hits[1]!.metadata as RisJudikaturMetadata;
    expect(multi.state).toBe('Tirol');
    expect(multi.indexes).toEqual([
      '10/01 Bundes-Verfassungsgesetz (B-VG)',
      '10/10 Datenschutz',
      '10/10 Grundrechte, Datenschutz, Auskunftspflicht',
    ]);
  });

  it('maps Erv translation provenance, stripping the <br/> RIS separates it with (#22)', () => {
    const result = parseSearchResponse(fixture('search-erv-translations.json'));
    const first = result.hits[0]!.metadata as RisBundesrechtMetadata;
    expect(first.source).toBe(
      'Original version: Federal Law Gazette No. 52/1991\nas amended by: Federal Law Gazette I No. 50/2025\ndate of the version: 1 November 2025',
    );
    expect(first.author).toBe('Federal Chancellery');
    // An Erv record states its version only here — it has no consolidated-law fields.
    expect(first.inForceFrom).toBeUndefined();
    expect(first.promulgation).toBeUndefined();
    expect(first.eli).toBeUndefined();

    // Author is <br/>-separated prose too when an amendment was translated by another body.
    const second = result.hits[1]!.metadata as RisBundesrechtMetadata;
    expect(second.author).toBe(
      'Federal Ministry for Labour, Social Affairs and Consumer\namendment: Federal Chancellery',
    );
    expect(second.author).not.toContain('<br');
    expect(second.source).not.toContain('<br');
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

  it('throws ValidationError with the RIS message on an in-band Client error', () => {
    let caught: McpError | undefined;
    try {
      parseSearchResponse(fixture('error-client.json'));
    } catch (error) {
      caught = error as McpError;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect(caught!.code).toBe(JsonRpcErrorCode.ValidationError);
    // RIS's schema-validation message passes through and names the element…
    expect(caught!.message).toContain('FassungVom');
    // …but the transport prefix is trimmed.
    expect(caught!.message.startsWith('soap:Client')).toBe(false);
  });

  it('classifies a fault whose soap: prefix sits behind .NET scaffolding (real 500 body)', () => {
    // Landesrecht wraps its faults in `Bka.Ris.…OgdException: soap:Client:…`, which hid the
    // prefix from classification and made this deterministic input error look transient.
    let caught: McpError | undefined;
    try {
      parseSearchResponse(fixture('error-500-vbl-invalid-state.json'));
    } catch (error) {
      caught = error as McpError;
    }
    expect(caught!.code).toBe(JsonRpcErrorCode.ValidationError);
    // The rejected value survives; only the .NET type names and stack marker are dropped.
    expect(caught!.message).toContain("'Kaernten' is not a valid value for RemotionVblBundesland");
    expect(caught!.message).not.toContain('Exception');
    expect(caught!.message).not.toContain('<STACKTRACE>');
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
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }));
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

describe('errorFromResponseBody', () => {
  // RIS answers a rejected parameter with HTTP 500 carrying the same OgdSearchResult.Error
  // envelope it uses in-band on a 200 — so the status alone would call a caller input error
  // a server fault. Both bodies below are verbatim captures from the live API (2026-07-15).
  it('translates an out-of-range page 500 body to ValidationError with RIS’s own message', () => {
    const error = errorFromResponseBody(rawFixture('error-500-page-overflow.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    // RIS names the cause; the transport prefix is trimmed, the explanation survives.
    expect(error?.message).toBe('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten');
    expect(error?.data).toMatchObject({ risApplication: 'History' });
  });

  it('translates a non-paging 500 body the same way — the envelope drives it, not the message', () => {
    const error = errorFromResponseBody(rawFixture('error-500-unknown-application.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.message).toBe('Application NotARealApp not found');
  });

  // RIS wraps its fulltext-validation faults in .NET exception scaffolding. The German
  // sentence is the actionable part and must survive whole; the scaffolding must not.
  const FULLTEXT_GUIDANCE =
    'Eine \'FulltextSearchExpression\' enthält eine ungültige Abfrage: Die Eingabe "*" enthält zu wenige Zeichen vor oder nach dem Platzhalter (*). Es müssen mindestens 2 Zeichen vor oder nach dem Platzhalter sein. Bitte korrigieren Sie Ihre Eingabe.';

  it('strips the SoapException scaffolding and stack marker, keeping RIS’s guidance whole', () => {
    const error = errorFromResponseBody(rawFixture('error-500-fulltext-wildcard.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.message).toBe(FULLTEXT_GUIDANCE);
  });

  it('classifies a Landesrecht fault, whose soap: prefix hides behind an outer .NET wrapper', () => {
    // Landesrecht alone prefixes `Bka.Ris.…OgdException: ` — which pushed the soap: prefix
    // off the front, so the fault fell through to the transient ServiceUnavailable bucket
    // and got retried. Same rejected input as the wildcard body above, same verdict.
    const error = errorFromResponseBody(rawFixture('error-500-fulltext-landesrecht.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.code).not.toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error?.message).toBe(FULLTEXT_GUIDANCE);
  });

  it('leaves a fault that carries no scaffolding byte-identical', () => {
    // The paging and schema-validation faults are already clean — RIS's prose names no .NET
    // type, so the strip must be a no-op on them rather than eating a real word.
    expect(errorFromResponseBody(rawFixture('error-500-page-overflow.json'))?.message).toBe(
      'Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten',
    );
    const schema = errorFromResponseBody(rawFixture('error-client.json'));
    expect(schema?.message).toBe(
      "Schema Validation Error: The 'http://ris.bka.gv.at/ogd/V2_6:FassungVom' element is invalid - The value 'notadate' is invalid according to its datatype 'http://www.w3.org/2001/XMLSchema:date' - The string 'notadate' is not a valid Date value.",
    );
  });

  it('classifies a Server-prefixed error body as transient ServiceUnavailable', () => {
    const body = JSON.stringify({
      OgdSearchResult: { Error: { Applikation: 'History', Message: 'soap:Server. backend down' } },
    });
    expect(errorFromResponseBody(body)?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('keeps the original error as the cause when one is supplied', () => {
    const cause = new McpError(JsonRpcErrorCode.InternalError, 'Fetch failed. Status: 500');
    const error = errorFromResponseBody(rawFixture('error-500-page-overflow.json'), { cause });
    expect(error?.cause).toBe(cause);
  });

  it('gives up on a body truncated mid-JSON rather than fabricating an error', () => {
    // fetchWithTimeout captures at most ERROR_BODY_LIMIT (500) bytes of an error body and
    // appends an ellipsis — a longer envelope than RIS's known ones arrives unparseable.
    const longBody = JSON.stringify({
      OgdSearchResult: {
        Error: { Applikation: 'History', Message: `soap:Client. ${'detail '.repeat(100)}` },
      },
    });
    expect(longBody.length).toBeGreaterThan(500);
    expect(errorFromResponseBody(`${longBody.slice(0, 500)}…`)).toBeUndefined();
  });

  it('gives up on bodies that carry no RIS error envelope', () => {
    expect(errorFromResponseBody(undefined)).toBeUndefined();
    expect(errorFromResponseBody('<!DOCTYPE html><html>Gateway Timeout</html>')).toBeUndefined();
    expect(errorFromResponseBody('{"OgdSearchResult":{}}')).toBeUndefined();
    // A successful envelope carries no Error node — nothing to translate.
    expect(errorFromResponseBody(JSON.stringify(fixture('search-zero-hits.json')))).toBeUndefined();
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

  it('stripHtmlRemnants normalizes the CRLF line endings RIS emits in text fields', () => {
    // Normenliste titles and Fundstellen are CRLF-delimited upstream; a literal \r reaches
    // the caller as escape noise around every line break.
    expect(stripHtmlRemnants('line one\r\nline two\rline three')).toBe(
      'line one\nline two\nline three',
    );
    expect(stripHtmlRemnants('one break<br/>\r\nnot two')).toBe('one break\nnot two');
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
