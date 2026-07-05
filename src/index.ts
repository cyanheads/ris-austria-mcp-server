#!/usr/bin/env node
/**
 * @fileoverview ris-austria-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { risDocumentResource } from './mcp-server/resources/definitions/ris-document.resource.js';
import { risGetDocument } from './mcp-server/tools/definitions/ris-get-document.tool.js';
import { risListReference } from './mcp-server/tools/definitions/ris-list-reference.tool.js';
import { risLookupCitation } from './mcp-server/tools/definitions/ris-lookup-citation.tool.js';
import { risSearchAnnouncements } from './mcp-server/tools/definitions/ris-search-announcements.tool.js';
import { risSearchCaseLaw } from './mcp-server/tools/definitions/ris-search-case-law.tool.js';
import { risSearchDrafts } from './mcp-server/tools/definitions/ris-search-drafts.tool.js';
import { risSearchGazette } from './mcp-server/tools/definitions/ris-search-gazette.tool.js';
import { risSearchLegislation } from './mcp-server/tools/definitions/ris-search-legislation.tool.js';
import { risTrackChanges } from './mcp-server/tools/definitions/ris-track-changes.tool.js';
import { initRisService } from './services/ris/ris-service.js';

await createApp({
  name: 'ris-austria-mcp-server',
  title: 'ris-austria-mcp-server',
  tools: [
    risSearchLegislation,
    risSearchCaseLaw,
    risSearchGazette,
    risSearchDrafts,
    risSearchAnnouncements,
    risLookupCitation,
    risGetDocument,
    risTrackChanges,
    risListReference,
  ],
  resources: [risDocumentResource],
  setup(core) {
    initRisService(core.config);
  },
});
