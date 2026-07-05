/**
 * @fileoverview The two federal lawmaking-pipeline stages served by `ris_search_drafts`:
 * ministerial review drafts (Begut) and government bills (RegV).
 * @module services/ris/reference/stages
 */

/** One pipeline stage. */
export interface PipelineStage {
  /** RIS `Applikation` value it routes to. */
  readonly application: string;
  /** Value used by the tool's `stage` parameter. */
  readonly code: string;
  /** Coverage window, when documented. */
  readonly coverage: string | null;
  /** What the stage holds. */
  readonly description: string;
  /** Official German designation. */
  readonly germanName: string;
  /** English name. */
  readonly name: string;
  /** Stage-specific tool parameters. */
  readonly stageParams: readonly string[];
}

/** Both pipeline stages. */
export const RIS_STAGES = [
  {
    code: 'review_drafts',
    application: 'Begut',
    name: 'Ministerial review drafts',
    germanName: 'Begutachtungsentwürfe',
    description:
      'Draft laws a ministry has put into public review (Begutachtung) — before any government bill exists.',
    stageParams: ['in_review_on'],
    coverage: 'As made available by the ministries',
  },
  {
    code: 'government_bills',
    application: 'RegV',
    name: 'Government bills',
    germanName: 'Regierungsvorlagen',
    description: 'Bills adopted by the council of ministers and submitted to parliament.',
    stageParams: ['decided_from', 'decided_to'],
    coverage: '2004 and later',
  },
] as const satisfies readonly PipelineStage[];
