/**
 * @fileoverview Shared Zod schemas and error-contract plumbing reused across multiple tool
 * definitions.
 * @module mcp-server/tools/definitions/_shared
 */

import type { TypedFail, TypedRecoveryFor } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** An ISO calendar date (YYYY-MM-DD), validated client-side before any upstream call. */
export const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected an ISO date in YYYY-MM-DD form.');

/**
 * The three reasons every search-family tool declares for a failure raised below the
 * handler — in the request builder or in `RisService`. Each tool still declares its own
 * full `errors[]` inline (the contract is part of its public surface); this union is only
 * the subset {@link failSearchError} resolves against.
 */
type SearchFailureReason = 'invalid_query' | 'upstream_error' | 'upstream_timeout';

/** The slice of a handler `ctx` {@link failSearchError} needs. */
interface SearchFailureContext {
  readonly fail: TypedFail<SearchFailureReason>;
  readonly recoveryFor: TypedRecoveryFor<SearchFailureReason>;
}

/**
 * Framework codes raised below the handler, mapped to the contract reason describing them.
 *
 * - `ValidationError` — a schema-valid but unsupported parameter combination the request
 *   builder rejected locally, before any upstream call.
 * - `InvalidParams` — RIS rejected a parameter value in its in-band error envelope.
 * - `ServiceUnavailable` — RIS unreachable, degraded, or serving an HTML error page.
 * - `Timeout` — the request deadline elapsed. Its own reason rather than a widened
 *   `upstream_error` guard: `ctx.fail` resolves the code from the contract entry, so folding
 *   the two would put -32000 back on the wire for every deadline.
 */
const REASON_BY_CODE = new Map<JsonRpcErrorCode, SearchFailureReason>([
  [JsonRpcErrorCode.ValidationError, 'invalid_query'],
  [JsonRpcErrorCode.InvalidParams, 'invalid_query'],
  [JsonRpcErrorCode.ServiceUnavailable, 'upstream_error'],
  [JsonRpcErrorCode.Timeout, 'upstream_timeout'],
]);

/**
 * Map a request-builder or service failure onto the declared contract, so `reason` and
 * `recovery` reach the wire — neither the builder's `validationError` nor the service's
 * framework errors carry either on their own. An unmapped code is returned untouched for
 * the framework to classify.
 *
 * Returns the error for the caller to `throw`, keeping the throw visible at the call site.
 */
export function failSearchError(error: unknown, ctx: SearchFailureContext): unknown {
  if (!(error instanceof McpError)) return error;
  const reason = REASON_BY_CODE.get(error.code);
  return reason === undefined
    ? error
    : ctx.fail(reason, error.message, { ...ctx.recoveryFor(reason) });
}
