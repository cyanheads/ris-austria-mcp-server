/**
 * @fileoverview ris_get_document — read one RIS document's full text (markdown/html/xml)
 * or its rendition URLs, with explicit binding status and the amtssigniert Authentisch PDF
 * surfaced wherever it exists. Two addressing modes route to the same fetch path:
 * `document_number` + `application`, or a `document_url` from a result's content_urls.
 * Format availability varies by application (full text · authentic-PDF-only · PDF-only ·
 * metadata-only) — a text-format request against a non-text application degrades to a
 * `format_unavailable` notice on a success result, never an error. The shared
 * {@link renderDocument} helper backs both this tool and the `ris://document/…` resource.
 * @module mcp-server/tools/definitions/ris-get-document
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { NodeHtmlMarkdown } from 'node-html-markdown';

import { getServerConfig } from '@/config/server-config.js';
import type { RisApplication, RisBindingStatus } from '@/services/ris/reference/index.js';
import { RIS_APPLICATIONS } from '@/services/ris/reference/index.js';
import { getRisService, type RisContentFormat } from '@/services/ris/ris-service.js';

/** The seven canonical binding labels (Design Decisions › Binding status). */
const BINDING_STATUSES = [
  'authentic',
  'consolidated_informational',
  'historical_record',
  'decision',
  'preparatory',
  'administrative_directive',
  'translation',
] as const satisfies readonly RisBindingStatus[];

/** Requested output format. `markdown` and `html` both read the HTML rendition. */
type DocumentFormat = 'markdown' | 'html' | 'xml' | 'urls_only';

/**
 * Byte cap on returned text. Legal texts are read in full, so the cap is generous —
 * it fires only on pathological documents, where the untruncated artifact is still
 * reachable through the returned content URLs.
 */
const MAX_TEXT_BYTES = 500_000;

const APPLICATION_CODES = RIS_APPLICATIONS.map((app) => app.code) as [string, ...string[]];

const APPLICATION_BY_CODE = new Map<string, RisApplication>(
  RIS_APPLICATIONS.map((app) => [app.code, app]),
);

/** Content-path segment → application, for reverse-mapping a passed document_url. */
const APPLICATION_BY_SEGMENT = new Map<string, RisApplication>(
  RIS_APPLICATIONS.flatMap((app) =>
    app.contentPathSegment !== null ? [[app.contentPathSegment, app] as const] : [],
  ),
);

/** Map an empty string from a form-based client to `undefined`. */
function meaningful(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/** Constructed rendition URLs for a document, keyed by DataType. */
interface RenditionContentUrls {
  html?: string;
  pdf?: string;
  rtf?: string;
  xml?: string;
}

/** A resolved document rendition — the shared unit behind the tool and the resource. */
export interface DocumentRendition {
  /** Application code the document belongs to (echoed). */
  readonly application: string;
  /** The amtssigniert authentic PDF (.pdfsig), where the application publishes one. */
  readonly authenticPdfUrl?: string;
  /** Legal binding status of the application's documents. */
  readonly bindingStatus: RisBindingStatus;
  /** Full byte size (UTF-8) of the text; present when text was fetched. */
  readonly byteSize?: number;
  /** Constructed rendition URLs (empty for authentic-PDF-only and metadata-only apps). */
  readonly contentUrls: RenditionContentUrls;
  /** Technical document number (echoed). */
  readonly documentNumber: string;
  /** The format served (echoes the request). */
  readonly format: DocumentFormat;
  /** Document text in the requested format; absent for urls_only and unavailable formats. */
  readonly text?: string;
  /** True when the text was truncated at the byte cap. */
  readonly truncated?: boolean;
  /** Present when the requested text format is unavailable for this application. */
  readonly unavailableNotice?: string;
}

/** Result of parsing a caller-supplied document_url into an application + document number. */
type ParsedDocumentUrl =
  | { readonly application: string; readonly documentNumber: string }
  | { readonly error: string };

/**
 * Parse a caller-supplied `document_url` into `(application, documentNumber)` — errors as
 * values (no throw). Enforces the same host + `/Dokumente/` allowlist as the service's
 * fetch guard, then reverse-maps the content-path segment to its application.
 */
export function parseDocumentUrl(url: string, contentBaseUrl: string): ParsedDocumentUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `"${url}" is not a valid URL` };
  }
  if (parsed.origin !== new URL(contentBaseUrl).origin) {
    return { error: `only ${new URL(contentBaseUrl).origin} URLs are fetchable` };
  }
  if (!parsed.pathname.startsWith('/Dokumente/')) {
    return { error: 'the path is outside the /Dokumente/ tree' };
  }
  const [, segment, documentNumber] = parsed.pathname.split('/').filter((part) => part !== '');
  if (segment === undefined || documentNumber === undefined) {
    return { error: 'the path is not /Dokumente/{segment}/{documentNumber}/…' };
  }
  const app = APPLICATION_BY_SEGMENT.get(segment);
  if (!app) {
    return { error: `path segment "${segment}" is not a recognized RIS application` };
  }
  return { application: app.code, documentNumber: decodeURIComponent(documentNumber) };
}

/** Derive the `.pdfsig` (Authentisch) URL from a constructed `.pdf` rendition URL. */
function authenticPdfFrom(pdfUrl: string): string {
  return pdfUrl.replace(/\.pdf$/u, '.pdfsig');
}

/**
 * Construct the rendition URLs for a document from its application's format availability.
 * `buildDocumentContentUrl` throws `ValidationError` for an unsafe document number.
 */
function buildRenditionUrls(
  service: ReturnType<typeof getRisService>,
  app: RisApplication,
  documentNumber: string,
): { contentUrls: RenditionContentUrls; authenticPdfUrl?: string } {
  if (app.formats === 'none') return { contentUrls: {} }; // BgblAlt — no content URLs to build
  const pdf = service.buildDocumentContentUrl(app.code, documentNumber, 'pdf');
  const authenticPdfUrl = app.binding === 'authentic' ? authenticPdfFrom(pdf) : undefined;
  if (app.formats === 'authentic_pdf_only') {
    // The signed PDF is the only rendition; the plain .pdf is not published separately.
    return { contentUrls: {}, ...(authenticPdfUrl !== undefined && { authenticPdfUrl }) };
  }
  if (app.formats === 'pdf_only') return { contentUrls: { pdf } };
  return {
    contentUrls: {
      xml: service.buildDocumentContentUrl(app.code, documentNumber, 'xml'),
      html: service.buildDocumentContentUrl(app.code, documentNumber, 'html'),
      pdf,
      rtf: service.buildDocumentContentUrl(app.code, documentNumber, 'rtf'),
    },
    ...(authenticPdfUrl !== undefined && { authenticPdfUrl }),
  };
}

/** Compose the `format_unavailable` notice for an application with no text rendition. */
function formatUnavailableNotice(
  app: RisApplication,
  format: DocumentFormat,
  urls: { contentUrls: RenditionContentUrls; authenticPdfUrl?: string },
): string {
  if (app.formats === 'authentic_pdf_only') {
    return `${app.code} publishes only the signed authentic PDF (amtssigniert, .pdfsig) — no ${format} rendition exists. Fetch the authentic PDF from authentic_pdf_url${urls.authenticPdfUrl !== undefined ? ` (${urls.authenticPdfUrl})` : ''}.`;
  }
  if (app.formats === 'pdf_only') {
    return `${app.code} publishes a PDF only — no ${format} rendition exists. Fetch the PDF from content_urls.pdf${urls.contentUrls.pdf !== undefined ? ` (${urls.contentUrls.pdf})` : ''}.`;
  }
  return `${app.code} carries no content URLs in RIS — it is metadata-only, with document scans hosted by the Austrian National Library (ÖNB). Retrieve the record and its ÖNB scan link via ris_search_gazette or ris_lookup_citation; RIS serves no fetchable rendition here.`;
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a codepoint. */
function truncateToBytes(encoded: Uint8Array, maxBytes: number): string {
  return new TextDecoder('utf-8', { fatal: false })
    .decode(encoded.slice(0, maxBytes))
    .replace(/�+$/u, '');
}

/**
 * Resolve, construct URLs for, and (for text formats on text-bearing applications) fetch
 * and convert one RIS document. Throws framework errors (`validationError` for an unknown
 * application or unsafe document number; `notFound`/`serviceUnavailable`/`timeout` from the
 * content fetch) — callers map these onto their own typed contract.
 */
export async function renderDocument(
  applicationCode: string,
  documentNumber: string,
  format: DocumentFormat,
  ctx: Context,
): Promise<DocumentRendition> {
  const app = APPLICATION_BY_CODE.get(applicationCode);
  if (!app) {
    throw validationError(`Unknown RIS application "${applicationCode}".`, {
      application: applicationCode,
      valid: [...APPLICATION_BY_CODE.keys()],
    });
  }
  const service = getRisService();
  const urls = buildRenditionUrls(service, app, documentNumber);
  const base = {
    application: app.code,
    bindingStatus: app.binding,
    contentUrls: urls.contentUrls,
    documentNumber,
    format,
    ...(urls.authenticPdfUrl !== undefined && { authenticPdfUrl: urls.authenticPdfUrl }),
  } satisfies DocumentRendition;

  // No usable payload for the request: a metadata-only application (no URLs at all, any
  // format), or a text format against an application with no text rendition.
  if (app.formats === 'none' || (format !== 'urls_only' && app.formats !== 'full')) {
    return { ...base, unavailableNotice: formatUnavailableNotice(app, format, urls) };
  }
  // urls_only on a full / authentic-PDF-only / PDF-only application — URLs already in base.
  if (format === 'urls_only') return base;

  const fetchFormat: RisContentFormat = format === 'xml' ? 'xml' : 'html';
  const url = service.buildDocumentContentUrl(app.code, documentNumber, fetchFormat);
  const fetched = await service.fetchDocumentContent(url, ctx);
  const rendered = format === 'markdown' ? NodeHtmlMarkdown.translate(fetched.text) : fetched.text;
  const encoded = new TextEncoder().encode(rendered);
  ctx.log.info('Document rendered', {
    application: app.code,
    byteSize: encoded.length,
    format,
  });
  if (encoded.length > MAX_TEXT_BYTES) {
    return {
      ...base,
      byteSize: encoded.length,
      text: truncateToBytes(encoded, MAX_TEXT_BYTES),
      truncated: true,
    };
  }
  return { ...base, byteSize: encoded.length, text: rendered };
}

const ContentUrlsSchema = z
  .object({
    xml: z.string().optional().describe('XML rendition URL (RIS Nutzdaten schema).'),
    html: z.string().optional().describe('HTML rendition URL.'),
    pdf: z.string().optional().describe('PDF rendition URL.'),
    rtf: z.string().optional().describe('RTF rendition URL.'),
  })
  .describe(
    'Constructed rendition URLs. Empty for authentic-PDF-only (Bvb/GrA/KmGer) and metadata-only (BgblAlt) applications — see authentic_pdf_url and the notice.',
  );

export const risGetDocument = tool('ris_get_document', {
  title: 'Get RIS Document',
  description:
    'Fetch one RIS document’s full text or its rendition URLs, with explicit binding status and the amtssigniert authentic PDF surfaced wherever it exists. Address the document exactly one of two ways: document_number plus application (both copied verbatim from a ris_search_* or ris_lookup_citation result), or a document_url from a result’s content_urls. format: markdown (default — the HTML rendition converted to markdown), html (raw HTML rendition), xml (the RIS Nutzdaten XML), or urls_only (no fetch — every rendition URL, including the Authentisch PDF). Format availability varies by application and the tool degrades explicitly, never silently: consolidated law, gazettes, case law, drafts, and most sectoral collections carry full text; district and municipal promulgations and court rules (Bvb, GrA, KmGer) publish only the signed authentic PDF; party-transparency decisions and council minutes (Upts, Mrp) are PDF-only; the 1848–1940 imperial gazettes (BgblAlt) are metadata-only — for these a text-format request returns a format_unavailable notice with the usable URL, not an error. Every result carries binding_status; only authentic (amtssigniert) publications are legally binding. This tool returns content, not fresh metadata — the metadata rides the search/lookup step that produced the document number. Oversized text is truncated at a byte cap (truncated: true) with the content URLs for the full artifact.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    document_number: z
      .string()
      .optional()
      .describe(
        'Technical RIS document number (Technisch.ID), e.g. NOR40262691, JJT_…, BGBLA_2026_II_171 — copy verbatim from a ris_search_* or ris_lookup_citation result. Requires application; mutually exclusive with document_url.',
      ),
    application: z
      .enum(APPLICATION_CODES)
      .optional()
      .describe(
        'RIS application the document belongs to (e.g. BrKons, Dsk, BgblAuth) — copy verbatim from the same result. Required with document_number. Codes and coverage: ris_list_reference topic applications.',
      ),
    document_url: z
      .string()
      .optional()
      .describe(
        'A https://www.ris.bka.gv.at/Dokumente/… rendition URL from a result’s content_urls — the alternative to document_number + application. Only this host’s /Dokumente/ tree is fetchable.',
      ),
    format: z
      .enum(['markdown', 'html', 'xml', 'urls_only'])
      .default('markdown')
      .describe(
        'markdown (default — the HTML rendition converted to markdown), html (raw HTML rendition), xml (RIS Nutzdaten schema), or urls_only (no fetch — all rendition URLs incl. the authentic PDF).',
      ),
  }),
  output: z.object({
    text: z
      .string()
      .optional()
      .describe(
        'The document text in the requested format. Absent for urls_only and when the application carries no text rendition (see the notice).',
      ),
    format: z
      .enum(['markdown', 'html', 'xml', 'urls_only'])
      .describe('The format served — echoes the requested format.'),
    byte_size: z
      .number()
      .optional()
      .describe(
        'Full UTF-8 byte size of the document text. Present when text was fetched; when it exceeds the cap, text is truncated but byte_size still reports the full size.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'Present and true when text was truncated at the byte cap — fetch content_urls for the complete artifact.',
      ),
    binding_status: z
      .enum(BINDING_STATUSES)
      .describe(
        'Legal binding status: authentic (amtssigniert, legally binding), consolidated_informational (consolidated view — not binding), historical_record (superseded/pre-e-Recht promulgation), decision (court/tribunal ruling), preparatory (draft/bill/minutes), administrative_directive (binds the administration, not citizens), or translation (unofficial English).',
      ),
    content_urls: ContentUrlsSchema,
    authentic_pdf_url: z
      .string()
      .optional()
      .describe(
        'The amtssigniert authentic PDF (.pdfsig, Authentisch DataType) — the legally binding artifact — where the application publishes one.',
      ),
    document_number: z.string().describe('Technical RIS document number (echoed).'),
    application: z.string().describe('RIS application the document belongs to (echoed).'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the requested text format is unavailable for this application — names why and the usable URL to fetch instead.',
      ),
  },
  errors: [
    {
      reason: 'invalid_addressing',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both addressing modes were provided, document_number was given without application, or the document_number/application pairing is not a valid RIS document — thrown locally before any fetch.',
      recovery:
        'Provide exactly one addressing mode: document_number plus application (both from one search result), or a document_url from a result’s content_urls.',
    },
    {
      reason: 'unsupported_url',
      code: JsonRpcErrorCode.ValidationError,
      when: 'document_url fails the host + /Dokumente/ path-prefix allowlist, or its path segment is not a recognized RIS application — thrown locally, nothing fetched.',
      recovery:
        'Only ris.bka.gv.at /Dokumente/ URLs are fetchable — pass a URL exactly as returned in content_urls, or switch to document_number + application.',
    },
    {
      reason: 'document_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The constructed or passed content URL returned 404.',
      recovery:
        'The document_number/application pairing didn’t resolve — copy both verbatim from a fresh search result, or resolve the citation with ris_lookup_citation. Document numbers are application-specific.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The RIS content host was unreachable or returned a server error.',
      retryable: true,
      recovery:
        'The RIS content host is temporarily unavailable — retry the fetch after a short delay.',
    },
  ],

  async handler(input, ctx) {
    const documentNumber = meaningful(input.document_number);
    const application = meaningful(input.application);
    const documentUrl = meaningful(input.document_url);
    const { format } = input;

    const failAddressing = (message: string) =>
      ctx.fail('invalid_addressing', message, { ...ctx.recoveryFor('invalid_addressing') });

    let resolvedApplication: string;
    let resolvedDocumentNumber: string;
    if (documentUrl !== undefined) {
      if (documentNumber !== undefined || application !== undefined) {
        throw failAddressing(
          'Provide document_url OR document_number + application, not both addressing modes.',
        );
      }
      const parsed = parseDocumentUrl(documentUrl, getServerConfig().contentBaseUrl);
      if ('error' in parsed) {
        throw ctx.fail('unsupported_url', `document_url is not fetchable — ${parsed.error}.`, {
          ...ctx.recoveryFor('unsupported_url'),
        });
      }
      resolvedApplication = parsed.application;
      resolvedDocumentNumber = parsed.documentNumber;
    } else {
      if (documentNumber === undefined || application === undefined) {
        throw failAddressing(
          'Provide document_number together with application, or a document_url instead.',
        );
      }
      resolvedApplication = application;
      resolvedDocumentNumber = documentNumber;
    }

    // Map framework errors from resolution/fetch onto this tool's declared contract.
    const rendition = await renderDocument(
      resolvedApplication,
      resolvedDocumentNumber,
      format,
      ctx,
    ).catch((err: unknown) => {
      if (err instanceof McpError) {
        if (err.code === JsonRpcErrorCode.ValidationError) {
          throw ctx.fail('invalid_addressing', err.message, {
            ...ctx.recoveryFor('invalid_addressing'),
          });
        }
        if (err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail('document_not_found', err.message, {
            ...ctx.recoveryFor('document_not_found'),
          });
        }
        if (err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, { ...ctx.recoveryFor('upstream_error') });
        }
      }
      throw err;
    });

    if (rendition.unavailableNotice !== undefined) {
      ctx.enrich.notice(rendition.unavailableNotice);
    }

    return {
      application: rendition.application,
      binding_status: rendition.bindingStatus,
      content_urls: rendition.contentUrls,
      document_number: rendition.documentNumber,
      format: rendition.format,
      ...(rendition.authenticPdfUrl !== undefined && {
        authentic_pdf_url: rendition.authenticPdfUrl,
      }),
      ...(rendition.text !== undefined && { text: rendition.text }),
      ...(rendition.byteSize !== undefined && { byte_size: rendition.byteSize }),
      ...(rendition.truncated === true && { truncated: true }),
    };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; the format-unavailable notice rides the enrichment trailer.
  format: (result) => {
    const lines = [`## ${result.document_number} (${result.application})`];
    lines.push(`**Binding:** ${result.binding_status} | **Format:** ${result.format}`);
    if (result.byte_size !== undefined) {
      lines.push(
        `**Size:** ${result.byte_size} bytes${result.truncated === true ? ' (truncated — fetch content_urls for the full text)' : ''}`,
      );
    }
    if (result.authentic_pdf_url !== undefined) {
      lines.push(`**Authentic PDF:** ${result.authentic_pdf_url}`);
    }
    const urls = (['html', 'pdf', 'rtf', 'xml'] as const)
      .filter((key) => result.content_urls[key] !== undefined)
      .map((key) => `[${key.toUpperCase()}](${result.content_urls[key]})`);
    if (urls.length > 0) lines.push(`**Renditions:** ${urls.join(' · ')}`);
    if (result.text !== undefined) lines.push('', result.text);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
