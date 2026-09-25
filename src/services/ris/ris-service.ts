/**
 * @fileoverview RisService — the single gateway to the RIS OGD REST API v2.6
 * (`data.bka.gv.at`) and the document content hosts (`www.ris.bka.gv.at`, which this
 * service constructs rendition URLs on, and `ogd.ris.bka.gv.at`, which search results
 * carry). Tool handlers call the per-class search methods and never touch HTTP or the
 * JSON-XML envelope.
 *
 * Resilience: `withRetry` (base delay 1.5s — rate-limited-API calibration) wraps the full
 * fetch + parse pipeline, under a wall-clock budget shared by every attempt so a slow
 * upstream cannot multiply the deadline by the attempt count; a search deadline itself is
 * not retried. `fetchWithTimeout` maps HTTP statuses; HTML error pages and
 * non-JSON bodies classify as transient `ServiceUnavailable`, never `SerializationError`.
 * RIS Client errors surface as `ValidationError` (non-transient — not retried) whether they
 * arrive in-band on a 200 or as the same envelope on a 500 error response, which
 * `fetchJson` translates rather than letting the status decide. An upstream 5xx carrying no
 * such envelope uses the framework's `ServiceUnavailable` classification; HTTP 501 opts
 * out of retry, and caller cancellation remains `RequestCancelled`.
 * Content fetches are allowlisted to the `/Dokumente/` tree on exactly those two origins, plus
 * a configured content host (SSRF guard).
 * @module services/ris/ris-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  serviceUnavailable,
  timeout,
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

/**
 * Search deadlines, sized against the MCP request budget rather than a single upstream call.
 *
 * Search latency tracks how much of the corpus RIS has to scan, not a fixed cost (measured
 * 2026-07-26 against the live Judikatur controller): a filtered search answers in 0.6–3s,
 * but an unfiltered Bvwg page costs 3.4–3.9s at page_size 10, 6.0–10.5s at 20, 14.6–18.3s at
 * 50, and 27–43s at 100. The previous 15s deadline therefore could not serve the two larger
 * page sizes at all, and four attempts at 15s plus ~13s of jittered backoff spent ~73s
 * reaching a verdict the MCP SDK's 60s default request timeout had already taken from the
 * caller.
 *
 * `SEARCH_TIMEOUT_MS` covers that band up to its long tail. The tools accept page sizes 10
 * and 20 only (#40), which keeps a tool-issued search in the 6–10.5s band; the deadline
 * still sizes for 50 and 100, which `RisPageSize` keeps in the service vocabulary. The tail
 * past it is out of reach at any deadline that still leaves room to deliver the response, so
 * the `upstream_timeout` recovery hints name the lever that shortens the scan (a smaller
 * page_size).
 * `SEARCH_BUDGET_MS` is `withRetry`'s `deadlineMs` — one wall-clock budget across every
 * attempt and every backoff, so a slow *failing* upstream cannot multiply the deadline by
 * the attempt count. Each attempt bounds its own fetch at whatever is left, a backoff that
 * would consume the remainder fails fast instead of sleeping into a certain timeout, and the
 * expiry aborts the in-flight request rather than waiting it out — so the whole call settles
 * within the budget, inside the client's 60s.
 */
const SEARCH_TIMEOUT_MS = 40_000;
const SEARCH_BUDGET_MS = 48_000;
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
 * Opt a search deadline out of retry. RIS answers a search by scanning as much of the corpus
 * as the filters leave — a request it could not finish inside the deadline is expensive, not
 * unlucky, so an identical second request re-runs the same scan and only spends budget the
 * caller's request deadline does not have. Keyed on the `FetchTimeout` source rather than the
 * `Timeout` code, so an upstream 504 (a fault RIS's front door reports quickly, and which a
 * retry can genuinely clear) stays retryable.
 *
 * `withRetry`'s default predicate honors `data.retryable === false`; the flag never reaches
 * the wire, where `ctx.fail('upstream_timeout')` builds the caller's error from the tool's
 * own contract entry — which still advertises the deadline as retryable by the caller.
 */
function failFastOnDeadline(error: unknown): unknown {
  if (!(error instanceof McpError) || error.data?.errorSource !== 'FetchTimeout') return error;
  return timeout(error.message, { ...error.data, retryable: false }, { cause: error });
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
 * The origins RIS serves document renditions from: `www.` is the host this server constructs
 * URLs on, and `ogd.` is the host every `content_urls` and draft `materials[].url` in the OGD
 * API's search output now carries. Both serve the same `/Dokumente/` tree byte for byte.
 * Matched exactly — never by suffix — so another `*.bka.gv.at` host, a lookalike, a port, or
 * `http://` stays unfetchable.
 */
const RIS_CONTENT_ORIGINS = ['https://www.ris.bka.gv.at', 'https://ogd.ris.bka.gv.at'];

/**
 * Every origin a `document_url` may carry: the two RIS content origins, plus the configured
 * content host's own, which is the default `www.` origin unless an operator repoints
 * `RIS_CONTENT_BASE_URL` — whose constructed URLs must then pass the same check.
 */
export function fetchableOrigins(contentBaseUrl: string): string[] {
  return [...new Set([...RIS_CONTENT_ORIGINS, new URL(contentBaseUrl).origin])];
}

/**
 * Assert a caller-supplied document URL is fetchable: on one of {@link fetchableOrigins} and
 * inside its `/Dokumente/` tree. Nothing else is ever fetched.
 */
export function assertFetchableDocumentUrl(url: string, contentBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw validationError(`document_url is not a valid URL: "${url}"`, { url }, { cause });
  }
  const allowedOrigins = fetchableOrigins(contentBaseUrl);
  if (!allowedOrigins.includes(parsed.origin) || !parsed.pathname.startsWith('/Dokumente/')) {
    throw validationError(
      `Only /Dokumente/ URLs on ${allowedOrigins.join(' or ')} are fetchable — pass a URL exactly as returned in content_urls.`,
      { allowedOrigins, url },
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
      parentContext: ctx,
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
    return await this.request(
      buildTrackChangesRequest(params),
      'RisService.trackChanges',
      parseHistoryResponse,
      ctx,
    );
  }

  /**
   * Construct a content URL for a document number from the per-application path-segment
   * map (`/Dokumente/{segment}/{DOKNR}/{DOKNR}.{format}`), harvested live 2026-07-05.
   *
   * `contentName` names a file inside the document's folder other than the main rendition —
   * one of the companion documents a draft ships alongside its bill text
   * (`/Dokumente/{segment}/{DOKNR}/{contentName}.{format}`). RIS names those opaquely and in
   * several shapes, so the caller's URL is the only source for one. It is held to the same
   * safe-character pattern as the document number, so nothing outside the folder is
   * constructible.
   */
  buildDocumentContentUrl(
    application: string,
    documentNumber: string,
    format: RisContentFormat,
    contentName?: string,
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
    if (contentName !== undefined && !DOCUMENT_NUMBER_PATTERN.test(contentName)) {
      throw validationError(`"${contentName}" is not a valid RIS content filename.`, {
        contentName,
      });
    }
    const doknr = encodeURIComponent(documentNumber);
    const file = contentName === undefined ? doknr : encodeURIComponent(contentName);
    return `${this.config.contentBaseUrl}/Dokumente/${segment}/${doknr}/${file}.${format}`;
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
        });
        const text = await response.text();
        const contentType = response.headers.get('content-type');
        const byteSize = new TextEncoder().encode(text).length;
        ctx.log.debug('RIS content fetched', { byteSize, url: target.href });
        return {
          byteSize,
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
    return await this.request(
      request,
      `RisService.search:${request.controller}`,
      parseSearchResponse,
      ctx,
    );
  }

  /**
   * Run one API request with retry wrapping the full fetch + parse pipeline, bounded by
   * {@link SEARCH_BUDGET_MS} as `withRetry`'s total deadline: each attempt caps its own
   * fetch at whatever is left of that budget, never more than {@link SEARCH_TIMEOUT_MS}.
   *
   * The attempt's `signal` composes the deadline clock over the caller's, so an expiry that
   * lands mid-attempt aborts the in-flight request instead of overshooting by one. A caller
   * cancellation keeps precedence and is never relabelled as a budget expiry.
   */
  private async request<T>(
    request: RisRequest,
    operation: string,
    parse: (payload: unknown) => T,
    ctx: Context,
  ): Promise<T> {
    const requestContext = this.requestContext(operation, ctx);
    return await withRetry(
      async ({ remainingMs, signal }) =>
        parse(
          await this.fetchJson(
            request,
            requestContext,
            Math.min(SEARCH_TIMEOUT_MS, remainingMs),
            signal,
          ),
        ),
      {
        baseDelayMs: RETRY_BASE_DELAY_MS,
        context: requestContext,
        deadlineMs: SEARCH_BUDGET_MS,
        operation,
        signal: ctx.signal,
      },
    );
  }

  /** GET one controller endpoint and return the parsed JSON body (single attempt). */
  private async fetchJson(
    request: RisRequest,
    requestContext: RequestContext,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const query = new URLSearchParams(request.params).toString();
    const url = `${this.config.apiBaseUrl}/${request.controller}${query === '' ? '' : `?${query}`}`;
    const response = await fetchWithTimeout(url, timeoutMs, requestContext, {
      headers: { Accept: 'application/json', 'User-Agent': this.userAgent() },
      signal,
    }).catch((error: unknown) => {
      // RIS reports a rejected parameter as HTTP 500 carrying the in-band error envelope,
      // which fetchWithTimeout captures as data.body. Translate that domain error before
      // retrying a generic upstream failure, preserving the rejected parameter detail.
      if (error instanceof McpError) {
        const translated = errorFromResponseBody(error.data?.body, { cause: error });
        if (translated) throw translated;
      }
      throw failFastOnDeadline(error);
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
