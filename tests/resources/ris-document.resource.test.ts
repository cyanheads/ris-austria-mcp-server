/**
 * @fileoverview Tests for the ris://document/{application}/{documentNumber} resource — the
 * markdown-only twin of ris_get_document, backed by the shared `renderDocument` helper.
 * Mocked the same way as the get_document tool suite: `buildDocumentContentUrl` delegates
 * to a real `RisService` instance (pure URL construction), `fetchDocumentContent` is a
 * `vi.fn()` resolving canned content.
 * @module tests/resources/ris-document.resource.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { risDocumentResource } from '@/mcp-server/resources/definitions/ris-document.resource.js';
import type { RisContentFormat } from '@/services/ris/ris-service.js';

const { buildDocumentContentUrl, fetchDocumentContent } = vi.hoisted(() => ({
  buildDocumentContentUrl: vi.fn(),
  fetchDocumentContent: vi.fn(),
}));

vi.mock('@/services/ris/ris-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ris/ris-service.js')>();
  // buildDocumentContentUrl is pure (no network) — delegate to a real instance so
  // constructed URLs stay correct without duplicating the per-application segment map.
  const real = new actual.RisService('test-agent/0.0.0');
  buildDocumentContentUrl.mockImplementation(
    (application: string, documentNumber: string, format: RisContentFormat) =>
      real.buildDocumentContentUrl(application, documentNumber, format),
  );
  return {
    ...actual,
    getRisService: () => ({ buildDocumentContentUrl, fetchDocumentContent }),
  };
});

/** Await a handler call expected to reject, and narrow the rejection to an McpError. */
async function captureError(promise: Promise<unknown>): Promise<McpError> {
  const err = await promise.catch((e: unknown) => e);
  if (!(err instanceof McpError)) throw new Error('unreachable — expected an McpError');
  return err;
}

beforeEach(() => {
  buildDocumentContentUrl.mockClear();
  fetchDocumentContent.mockReset();
});

describe('risDocumentResource — resolves via the shared renderDocument helper', () => {
  it('returns markdown-converted document text for a full-text application', async () => {
    fetchDocumentContent.mockResolvedValue({
      text: '<p>Hello <b>World</b></p>',
      byteSize: 25,
      url: 'https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40262691/NOR40262691.html',
    });
    const ctx = createMockContext({ uri: new URL('ris://document/BrKons/NOR40262691') });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const result = await risDocumentResource.handler(params, ctx);
    expect(result).toContain('World');
    expect(result).not.toContain('<b>');
    expect(fetchDocumentContent).toHaveBeenCalledWith(expect.stringContaining('.html'), ctx);
  });

  it('falls back to the unavailable-format notice text for an authentic_pdf_only application', async () => {
    const ctx = createMockContext({ uri: new URL('ris://document/Bvb/BVB_BU_JE_20260703_9') });
    const params = risDocumentResource.params!.parse({
      application: 'Bvb',
      documentNumber: 'BVB_BU_JE_20260703_9',
    });
    const result = await risDocumentResource.handler(params, ctx);
    expect(result).toContain('Bvb publishes only the signed authentic PDF');
    expect(fetchDocumentContent).not.toHaveBeenCalled();
  });
});

describe('risDocumentResource — error mapping', () => {
  // The handler's `.catch()` re-maps errors surfaced while resolving/fetching the document
  // onto this resource's declared contract: NotFound becomes document_not_found and
  // ServiceUnavailable becomes upstream_error.
  it('maps a fetchDocumentContent NotFound rejection to the document_not_found contract error', async () => {
    fetchDocumentContent.mockRejectedValue(notFound('RIS content host returned 404.', {}));
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const err = await captureError(risDocumentResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'document_not_found' });
  });

  it('maps a fetchDocumentContent ServiceUnavailable rejection to the upstream_error contract error', async () => {
    fetchDocumentContent.mockRejectedValue(serviceUnavailable('RIS content host timed out.', {}));
    const ctx = createMockContext({
      errors: risDocumentResource.errors,
      uri: new URL('ris://document/BrKons/NOR40262691'),
    });
    const params = risDocumentResource.params!.parse({
      application: 'BrKons',
      documentNumber: 'NOR40262691',
    });
    const err = await captureError(risDocumentResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
  });
});
