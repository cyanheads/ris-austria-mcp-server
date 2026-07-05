/**
 * @fileoverview Shared Zod schemas reused across multiple tool definitions.
 * @module mcp-server/tools/definitions/_shared
 */

import { z } from '@cyanheads/mcp-ts-core';

/** An ISO calendar date (YYYY-MM-DD), validated client-side before any upstream call. */
export const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected an ISO date in YYYY-MM-DD form.');
