/**
 * @fileoverview RisService — the single gateway to the RIS OGD REST API v2.6
 * (`data.bka.gv.at`) and the document content host (`www.ris.bka.gv.at`). Tool handlers
 * call the per-class search methods and never touch HTTP or the JSON-XML envelope.
 *
 * Resilience: `withRetry` (base delay 1.5s — rate-limited-API calibration) wraps the full
 * fetch + parse pipeline; `fetchWithTimeout` maps HTTP statuses; HTML error pages and
 * non-JSON bodies classify as transient `ServiceUnavailable`, never `SerializationError`.
 * RIS Client errors surface as `InvalidParams` (non-transient — not retried) whether they
 * arrive in-band on a 200 or as the same envelope on a 500 error response, which
 * `fetchJson` translates rather than letting the status decide. An upstream 5xx carrying no
 * such envelope is reclassified to `ServiceUnavailable` on both the search and content paths
 * — 500/501 map to `InternalError`, a code no caller contract covers and `withRetry` never
 * retries.
 * Content fetches are allowlisted to the content host's `/Dokumente/` tree (SSRF guard).
 * @module services/ris/ris-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  type RequestContext,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';

import {
  errorFromResponseBody,
  isHtmlErrorPage,
  parseHistoryResponse,
  parseSearchResponse,
} from './normalizer.js';
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
const RETRY_BASE_DELAY_MS = 1_500;

/**
 * Content-fetch deadline and attempt budget, sized against the MCP request budget rather
 * than the content host's cold-render tail.
 *
 * The host renders a document on first request and caches it (measured 2026-07-26: warm
 * ≈0.6s, cold 7.8–91s across twelve renditions; the CDN itself returns 503 somewhere in the
 * 44–91s band, so the slowest renders are unreachable at any client deadline). Waiting out
 * the tail is therefore not an option: two attempts at 25s plus the jittered backoff caps a
 * call at ~52s, inside the MCP SDK's 60s default request timeout. The previous 20s × 4
 * attempts spent ~93s — past that deadline, so the caller saw a transport hang rather than
 * this service's contract.
 *
 * Retrying is still worth an attempt rather than a wasted one — a render that finishes
 * between the two attempts is served from cache on the second — but an aborted attempt does
 * not reliably leave the rendition cached, so a repeated call can time out again. The
 * `upstream_timeout` recovery hints say exactly that, and point at `format: urls_only` for a
 * document this deadline cannot reach.
 */
const CONTENT_TIMEOUT_MS = 25_000;
const CONTENT_MAX_RETRIES = 1;

/**
 * Reclassify an unclassified upstream 5xx as transient. `fetchWithTimeout` maps 500/501 to
 * `InternalError` — a code no tool or resource contract declares and `withRetry` does not
 * treat as transient — so a degraded RIS reached the wire as a bare -32603 with no reason,
 * no retryable flag, and no recovery. Reads the canonical `status` field (0.10.15+), which
 * also keeps an abort-sourced `InternalError` (no status) out of the reclassification.
 *
 * Runs only after the RIS error-envelope translation has had its chance: a 500 carrying an
 * `OgdSearchResult.Error` is a rejected parameter, not a server fault.
 */
function reclassifyUpstreamServerError(error: unknown): unknown {
  if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.InternalError) return error;
  const status = error.data?.status;
  if (typeof status !== 'number' || status < 500) return error;
  return serviceUnavailable(
    `RIS returned HTTP ${status} with no error envelope — the upstream is degraded.`,
    { status },
    { cause: error },
  );
}

/** Rendition formats a content URL can be constructed for. */
export const RIS_CONTENT_FORMATS = ['html', 'pdf', 'rtf', 'xml'] as const;
export type RisContentFormat = (typeof RIS_CONTENT_FORMATS)[number];

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
          // A mistyped document number is the most common caller error and renders as a
          // plain 404 — an expected outcome mapped to `document_not_found`, not an
          // operational fault worth an error-level line.
          expectedStatuses: [404],
          headers: { 'User-Agent': this.userAgent() },
          signal: ctx.signal,
        }).catch((error: unknown) => {
          throw reclassifyUpstreamServerError(error);
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
        maxRetries: CONTENT_MAX_RETRIES,
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
    }).catch((error: unknown) => {
      // RIS reports a rejected parameter as HTTP 500 carrying the in-band error envelope,
      // which fetchWithTimeout captures as data.body before the status maps to a generic
      // InternalError. Translating it tells the caller which input RIS rejected. A 500
      // without one is a genuine server fault — reclassify so it lands on the callers'
      // declared upstream_error rather than an undeclared InternalError.
      if (error instanceof McpError) {
        const translated = errorFromResponseBody(error.data?.body, { cause: error });
        if (translated) throw translated;
      }
      throw reclassifyUpstreamServerError(error);
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
