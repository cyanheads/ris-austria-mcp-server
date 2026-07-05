/**
 * @fileoverview Offline RisService tests: the content-URL SSRF guard, per-application
 * content-URL construction from the path-segment map, and the init/accessor contract.
 * Network-bound methods are exercised at build time against the live API, not here.
 * @module tests/services/ris/ris-service
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  assertFetchableDocumentUrl,
  getRisService,
  RisService,
} from '@/services/ris/ris-service.js';

const CONTENT_BASE = 'https://www.ris.bka.gv.at';

function expectValidationError(fn: () => unknown, messagePart?: string): void {
  let caught: McpError | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as McpError;
  }
  expect(caught).toBeInstanceOf(McpError);
  expect(caught!.code).toBe(JsonRpcErrorCode.ValidationError);
  if (messagePart !== undefined) expect(caught!.message).toContain(messagePart);
}

describe('assertFetchableDocumentUrl', () => {
  it('accepts content-host URLs under /Dokumente/', () => {
    const url = `${CONTENT_BASE}/Dokumente/Bundesnormen/NOR11013238/NOR11013238.html`;
    expect(assertFetchableDocumentUrl(url, CONTENT_BASE).href).toBe(url);
  });

  it('rejects other hosts, other paths, and malformed URLs', () => {
    expectValidationError(() =>
      assertFetchableDocumentUrl(
        'https://evil.example.com/Dokumente/Bundesnormen/x/x.html',
        CONTENT_BASE,
      ),
    );
    expectValidationError(() =>
      assertFetchableDocumentUrl(`${CONTENT_BASE}/GeltendeFassung.wxe?x=1`, CONTENT_BASE),
    );
    expectValidationError(() =>
      // Same hostname, different scheme/origin.
      assertFetchableDocumentUrl(
        'http://www.ris.bka.gv.at/Dokumente/Bundesnormen/x/x.html',
        CONTENT_BASE,
      ),
    );
    expectValidationError(() => assertFetchableDocumentUrl('not a url', CONTENT_BASE));
  });
});

describe('RisService.buildDocumentContentUrl', () => {
  const service = new RisService('ris-austria-mcp-server/test');

  it('builds content URLs from the per-application path-segment map', () => {
    expect(service.buildDocumentContentUrl('BrKons', 'NOR11013238', 'html')).toBe(
      `${CONTENT_BASE}/Dokumente/Bundesnormen/NOR11013238/NOR11013238.html`,
    );
    expect(service.buildDocumentContentUrl('GrA', 'GEMREA_OB_41203_20260703_3', 'pdf')).toBe(
      `${CONTENT_BASE}/Dokumente/GemeinderechtAuth/GEMREA_OB_41203_20260703_3/GEMREA_OB_41203_20260703_3.pdf`,
    );
    expect(service.buildDocumentContentUrl('Vfgh', 'JFR_20260616_26V00023_01', 'xml')).toBe(
      `${CONTENT_BASE}/Dokumente/Vfgh/JFR_20260616_26V00023_01/JFR_20260616_26V00023_01.xml`,
    );
  });

  it('percent-encodes document numbers with non-ASCII letters', () => {
    const url = service.buildDocumentContentUrl(
      'Upts',
      'UPTS_20260427_2026_0_074_605_UPTS_Grüne',
      'pdf',
    );
    expect(url).toContain('/Dokumente/Upts/UPTS_20260427_2026_0_074_605_UPTS_Gr%C3%BCne/');
    expect(assertFetchableDocumentUrl(url, CONTENT_BASE)).toBeInstanceOf(URL);
  });

  it('rejects BgblAlt (no content URLs), unknown applications, and unsafe document numbers', () => {
    expectValidationError(
      () => service.buildDocumentContentUrl('BgblAlt', 'glo1940_0049_00357', 'html'),
      'BgblAlt',
    );
    expectValidationError(
      () => service.buildDocumentContentUrl('Bogus', 'NOR1', 'html'),
      'Unknown',
    );
    expectValidationError(() =>
      service.buildDocumentContentUrl('BrKons', '../../etc/passwd', 'html'),
    );
    expectValidationError(() => service.buildDocumentContentUrl('BrKons', 'NOR1?x=1', 'html'));
    expectValidationError(() => service.buildDocumentContentUrl('BrKons', '', 'html'));
  });
});

describe('init/accessor', () => {
  it('getRisService throws before initialization', () => {
    expect(() => getRisService()).toThrowError(/not initialized/);
  });
});
