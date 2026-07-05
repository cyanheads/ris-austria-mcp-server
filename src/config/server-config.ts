/**
 * @fileoverview Server-specific environment configuration for ris-austria-mcp-server.
 * All three variables are optional — the RIS OGD API is keyless.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .url()
    .default('https://data.bka.gv.at/ris/api/v2.6')
    .describe('RIS OGD REST API base URL.'),
  contentBaseUrl: z
    .url()
    .default('https://www.ris.bka.gv.at')
    .describe('RIS document content host — also the allowlist host for document_url fetches.'),
  contact: z
    .string()
    .optional()
    .describe(
      'Contact string appended to the User-Agent (RIS netiquette asks integrators to be identifiable).',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config from the environment.
 * Lazy so Workers-style runtimes can inject env vars before first use.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'RIS_API_BASE_URL',
    contentBaseUrl: 'RIS_CONTENT_BASE_URL',
    contact: 'RIS_CONTACT',
  });
  return _config;
}
