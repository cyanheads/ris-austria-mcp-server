/**
 * @fileoverview RisService — the single gateway to the RIS OGD REST API v2.6
 * (`data.bka.gv.at`) and the document content host (`www.ris.bka.gv.at`). Tool handlers
 * call the per-class search methods and never touch HTTP or the JSON-XML envelope.
 *
 * Resilience: `withRetry` (base delay 1.5s — rate-limited-API calibration) wraps the full
 * fetch + parse pipeline; `fetchWithTimeout` maps HTTP statuses; HTML error pages and
 * non-JSON bodies classify as transient `ServiceUnavailable`, never `SerializationError`.
 * In-band RIS Client errors surface as `InvalidParams` (non-transient — not retried).
 * Content fetches are allowlisted to the content host's `/Dokumente/` tree (SSRF guard).
 * @module services/ris/ris-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  type RequestContext,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';

import { isHtmlErrorPage, parseHistoryResponse, parseSearchResponse } from './normalizer.js';
import { RIS_APPLICATIONS } from './reference/index.js';
import {
  type AnnouncementsSearchParams,
  buildAnnouncementsRequest,
  buildCaseLawRequest,
  buildDraftsRequest,
  buildGazetteRequest,
  buildLegislationRequest,
  buildTrackChangesRequest,
  type CaseLawSearchParams,
  type DraftsSearchParams,
  type GazetteSearchParams,
  type LegislationSearchParams,
  type RisRequest,
  type TrackChangesParams,
} from './request-builder.js';
import type { RisChangeSet, RisDocumentContent, RisSearchResult } from './types.js';

const SEARCH_TIMEOUT_MS = 15_000;
const CONTENT_TIMEOUT_MS = 20_000;
const RETRY_BASE_DELAY_MS = 1_500;

/** Rendition formats a content URL can be constructed for. */
export type RisContentFormat = 'html' | 'pdf' | 'rtf' | 'xml';

/** Document numbers observed live use letters (incl. umlauts), digits, `_`, `.`, `~`, `-`. */
const DOCUMENT_NUMBER_PATTERN = /^[\p{L}\p{N}_.~-]+$/u;

const CONTENT_PATH_SEGMENTS = new Map<string, string | null>(
  RIS_APPLICATIONS.map((app) => [app.code, app.contentPathSegment]),
);

/**
 * Assert a caller-supplied document URL is fetchable: same origin as the configured
 * content host and inside its `/Dokumente/` tree. Nothing else is ever fetched.
 */
export function assertFetchableDocumentUrl(url: string, contentBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw validationError(`document_url is not a valid URL: "${url}"`, { url }, { cause });
  }
  const allowedOrigin = new URL(contentBaseUrl).origin;
  if (parsed.origin !== allowedOrigin || !parsed.pathname.startsWith('/Dokumente/')) {
    throw validationError(
      `Only ${allowedOrigin}/Dokumente/ URLs are fetchable — pass a URL exactly as returned in content_urls.`,
      { allowedOrigin, url },
    );
  }
  return parsed;
}

/**
 * Gateway service for RIS search controllers, the History change feed, and document
 * content fetches.
 */
export class RisService {
  /** `name/version` identity used to build the descriptive User-Agent. */
  constructor(private readonly identity: string) {}

  private get config() {
    return getServerConfig();
  }

  private userAgent(): string {
    const contact = this.config.contact ?? 'https://github.com/cyanheads/ris-austria-mcp-server';
    return `${this.identity} (${contact})`;
  }

  /** Derive a correlated `RequestContext` for the network utilities from the handler ctx. */
  private requestContext(operation: string, ctx: Context): RequestContext {
    return requestContextService.createRequestContext({
      operation,
      parentContext: {
        requestId: ctx.requestId,
        spanId: ctx.spanId,
        tenantId: ctx.tenantId,
        timestamp: ctx.timestamp,
        traceId: ctx.traceId,
      },
    });
  }

  /** Search consolidated federal/state/municipal law and English translations. */
  async searchLegislation(params: LegislationSearchParams, ctx: Context): Promise<RisSearchResult> {
    return await this.search(buildLegislationRequest(params), ctx);
  }

  /** Search one court/tribunal application of the Judikatur surface (incl. Upts). */
  async searchCaseLaw(params: CaseLawSearchParams, ctx: Context): Promise<RisSearchResult> {
    return await this.search(buildCaseLawRequest(params), ctx);
  }

  /** Browse the promulgation record — federal era tiers, state series, district, municipal. */
  async searchGazette(params: GazetteSearchParams, ctx: Context): Promise<RisSearchResult> {
    return await this.search(buildGazetteRequest(params), ctx);
  }

  /** Search the federal lawmaking pipeline (review drafts, government bills). */
  async searchDrafts(params: DraftsSearchParams, ctx: Context): Promise<RisSearchResult> {
    return await this.search(buildDraftsRequest(params), ctx);
  }

  /** Search the sectoral official gazettes and executive documents. */
  async searchAnnouncements(
    params: AnnouncementsSearchParams,
    ctx: Context,
  ): Promise<RisSearchResult> {
    return await this.search(buildAnnouncementsRequest(params), ctx);
  }

  /** Exact-dated change feed per application; deletions included on request. */
  async trackChanges(params: TrackChangesParams, ctx: Context): Promise<RisChangeSet> {
    const request = buildTrackChangesRequest(params);
    const requestContext = this.requestContext('RisService.trackChanges', ctx);
    return await withRetry(
      async () => parseHistoryResponse(await this.fetchJson(request, requestContext, ctx)),
      {
        baseDelayMs: RETRY_BASE_DELAY_MS,
        context: requestContext,
        operation: 'RisService.trackChanges',
        signal: ctx.signal,
      },
    );
  }

  /**
   * Construct a content URL for a document number from the per-application path-segment
   * map (`/Dokumente/{segment}/{DOKNR}/{DOKNR}.{format}`), harvested live 2026-07-05.
   */
  buildDocumentContentUrl(
    application: string,
    documentNumber: string,
    format: RisContentFormat,
  ): string {
    const segment = CONTENT_PATH_SEGMENTS.get(application);
    if (segment === undefined) {
      throw validationError(`Unknown RIS application "${application}".`, {
        application,
        valid: [...CONTENT_PATH_SEGMENTS.keys()],
      });
    }
    if (segment === null) {
      throw validationError(
        `${application} documents carry no content URLs (metadata only — scans are hosted by the Austrian National Library).`,
        { application },
      );
    }
    if (!DOCUMENT_NUMBER_PATTERN.test(documentNumber)) {
      throw validationError(
        `document_number "${documentNumber}" is not a valid RIS document number.`,
        {
          documentNumber,
        },
      );
    }
    const doknr = encodeURIComponent(documentNumber);
    return `${this.config.contentBaseUrl}/Dokumente/${segment}/${doknr}/${doknr}.${format}`;
  }

  /** Fetch one document rendition from the content host (allowlist-guarded). */
  async fetchDocumentContent(url: string, ctx: Context): Promise<RisDocumentContent> {
    const target = assertFetchableDocumentUrl(url, this.config.contentBaseUrl);
    const requestContext = this.requestContext('RisService.fetchDocumentContent', ctx);
    return await withRetry(
      async () => {
        const response = await fetchWithTimeout(target, CONTENT_TIMEOUT_MS, requestContext, {
          headers: { 'User-Agent': this.userAgent() },
          signal: ctx.signal,
        });
        const text = await response.text();
        const contentType = response.headers.get('content-type');
        ctx.log.debug('RIS content fetched', { byteSize: text.length, url: target.href });
        return {
          byteSize: new TextEncoder().encode(text).length,
          ...(contentType !== null && { contentType }),
          text,
          url: target.href,
        };
      },
      {
        baseDelayMs: RETRY_BASE_DELAY_MS,
        context: requestContext,
        operation: 'RisService.fetchDocumentContent',
        signal: ctx.signal,
      },
    );
  }

  /** Run one search request with retry wrapping the full fetch + parse pipeline. */
  private async search(request: RisRequest, ctx: Context): Promise<RisSearchResult> {
    const operation = `RisService.search:${request.controller}`;
    const requestContext = this.requestContext(operation, ctx);
    return await withRetry(
      async () => parseSearchResponse(await this.fetchJson(request, requestContext, ctx)),
      {
        baseDelayMs: RETRY_BASE_DELAY_MS,
        context: requestContext,
        operation,
        signal: ctx.signal,
      },
    );
  }

  /** GET one controller endpoint and return the parsed JSON body (single attempt). */
  private async fetchJson(
    request: RisRequest,
    requestContext: RequestContext,
    ctx: Context,
  ): Promise<unknown> {
    const query = new URLSearchParams(request.params).toString();
    const url = `${this.config.apiBaseUrl}/${request.controller}${query === '' ? '' : `?${query}`}`;
    const response = await fetchWithTimeout(url, SEARCH_TIMEOUT_MS, requestContext, {
      headers: { Accept: 'application/json', 'User-Agent': this.userAgent() },
      signal: ctx.signal,
    });
    const text = await response.text();
    if (isHtmlErrorPage(text)) {
      throw serviceUnavailable(
        'RIS returned an HTML error page instead of JSON — likely throttled or degraded.',
        {
          controller: request.controller,
        },
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw serviceUnavailable(
        'RIS returned a non-JSON response — likely a transient upstream failure.',
        { controller: request.controller },
        { cause },
      );
    }
  }
}

/* --- Init/accessor pattern --- */

let _service: RisService | undefined;

/** Initialize the singleton from `setup()` in the server entry point. */
export function initRisService(config: AppConfig): void {
  _service = new RisService(`${config.mcpServerName}/${config.mcpServerVersion}`);
}

/** Access the initialized service; throws when `initRisService()` was never called. */
export function getRisService(): RisService {
  if (!_service) {
    throw new Error('RisService not initialized — call initRisService() in setup()');
  }
  return _service;
}
