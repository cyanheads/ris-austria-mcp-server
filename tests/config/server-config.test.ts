/**
 * @fileoverview Environment boundary coverage for optional RIS configuration.
 * @module tests/config/server-config
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('RIS environment configuration', () => {
  it.each(['', `\${user_config.ris_api_base_url}`])(
    'uses defaults for unset value %j',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('RIS_API_BASE_URL', value);
      vi.stubEnv('RIS_CONTENT_BASE_URL', value);
      vi.stubEnv('RIS_CONTACT', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(getServerConfig()).toEqual({
        apiBaseUrl: 'https://data.bka.gv.at/ris/api/v2.6',
        contentBaseUrl: 'https://www.ris.bka.gv.at',
        contact: undefined,
      });
    },
  );

  it('preserves supplied URLs and embedded placeholder text', async () => {
    vi.resetModules();
    vi.stubEnv('RIS_API_BASE_URL', 'https://api.example.test/v2.6');
    vi.stubEnv('RIS_CONTENT_BASE_URL', 'https://content.example.test');
    vi.stubEnv('RIS_CONTACT', `research-\${team}@example.test`);
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      apiBaseUrl: 'https://api.example.test/v2.6',
      contentBaseUrl: 'https://content.example.test',
      contact: `research-\${team}@example.test`,
    });
  });
});
