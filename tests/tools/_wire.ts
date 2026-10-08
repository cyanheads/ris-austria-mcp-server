/**
 * @fileoverview Assertions over the dual-surface envelope `runToolContract` returns — the
 * shape a client receives on the wire, `structuredContent` and `content[]` alike.
 * @module tests/tools/_wire
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

/** The result of one `runToolContract` call. */
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** A tool error as the client receives it in `structuredContent.error`. */
export interface WireError {
  readonly code: number;
  readonly data?: Record<string, unknown>;
  readonly message: string;
}

/**
 * Run one call through `runToolContract` and return the error the client receives. Assert a
 * declared reason's recovery hint here, not on a direct `definition.handler(...)` throw: the
 * framework fills `data.recovery` from the `errors[]` entry on the factory path, so a throw
 * site that names only the reason carries no hint until then.
 */
export async function contractError(
  ...args: Parameters<typeof runToolContract>
): Promise<WireError> {
  const result = await runToolContract(...args);
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: WireError }).error;
}

/** Every text block of `content[]`, joined — what a content-only client reads. */
export function contentText(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/**
 * Assert a schema-level argument rejection as it reaches the client: `isError`, InvalidParams
 * (-32602) with the framework's `invalid_arguments` reason, and every phrase present on both
 * surfaces — the structured error message and the `content[]` text.
 */
export function expectArgumentRejection(result: ToolResult, phrases: readonly string[]): void {
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as {
    error: { code: number; data?: { reason?: string }; message: string };
  };
  expect(error).toMatchObject({
    code: JsonRpcErrorCode.InvalidParams,
    data: { reason: 'invalid_arguments' },
  });
  const text = contentText(result);
  for (const phrase of phrases) {
    expect(error.message).toContain(phrase);
    expect(text).toContain(phrase);
  }
}
