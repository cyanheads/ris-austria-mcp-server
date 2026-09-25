/**
 * @fileoverview Assertions over the dual-surface envelope `runToolContract` returns — the
 * shape a client receives on the wire, `structuredContent` and `content[]` alike.
 * @module tests/tools/_wire
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

/** The result of one `runToolContract` call. */
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

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
