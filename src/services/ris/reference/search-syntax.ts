/**
 * @fileoverview RIS search-expression grammar: boolean operators, wildcard rules per field
 * type, phrase quoting, and which parameters belong to which expression type. From the OGD
 * Handbook V2.6 and the request XSD expression types (FulltextSearchExpression,
 * PhraseSearchExpression, ExactMatchSearchExpression, TermSearchExpression).
 * @module services/ris/reference/search-syntax
 */

/** One syntax rule. */
export interface SearchSyntaxRule {
  /** Where it applies. */
  readonly appliesTo: string;
  /** What it does. */
  readonly description: string;
  /** The syntax element. */
  readonly element: string;
  /** Example, when helpful. */
  readonly example: string | null;
}

/** The RIS search grammar. */
export const RIS_SEARCH_SYNTAX = [
  {
    element: 'UND / AND',
    appliesTo: 'Full-text fields (query / Suchworte)',
    description: 'Both terms must match. German and English operator spellings are equivalent.',
    example: 'Datenschutz UND Auskunft',
  },
  {
    element: 'ODER / OR',
    appliesTo: 'Full-text fields (query / Suchworte)',
    description: 'Either term matches.',
    example: 'Datenschutz ODER Datensicherheit',
  },
  {
    element: 'NICHT / NOT',
    appliesTo: 'Full-text fields (query / Suchworte)',
    description: 'Excludes documents matching the term.',
    example: 'Datenschutz NICHT Video',
  },
  {
    element: '( )',
    appliesTo: 'Full-text fields (query / Suchworte)',
    description: 'Groups boolean sub-expressions.',
    example: '(Datenschutz ODER DSGVO) UND Beschwerde',
  },
  {
    element: '"..."',
    appliesTo: 'Full-text fields (query / Suchworte)',
    description: 'Quotes an exact phrase.',
    example: '"personenbezogene Daten"',
  },
  {
    element: '* (full-text)',
    appliesTo: 'Full-text fields (query / Suchworte)',
    description:
      'Wildcard — trailing-only in full-text fields ("Datenschutz*" works, "*schutz" does not). At least two literal characters must adjoin the star.',
    example: 'Datenschutz*',
  },
  {
    element: '* (phrase fields)',
    appliesTo:
      'Phrase fields: title (Titel), number fields (Bgblnummer, Lgblnummer, Avnnummer), issuer (EinbringendeStelle), Kundmachungsorgan, municipality (Gemeinde)',
    description:
      'Wildcard allowed leading or trailing; at least two literal characters must adjoin the star.',
    example: 'DSG* or *gesetz',
  },
  {
    element: 'exact-match fields',
    appliesTo:
      'law_id (Gesetzesnummer), Kundmachungsnummer, Avsv issuer (Urheber), Erlaesse ministry (Bundesministerium), Mrp issuer (Einbringer), session_number (Sitzungsnummer), legislature (Gesetzgebungsperiode), Gliederungszahl, district_authority (Bezirksverwaltungsbehoerde)',
    description:
      'No wildcards, no partial matching — the value must match the stored string completely, including any "(ABBR)"-style suffix.',
    example: 'Urheber: "Österreichische Gesundheitskasse (ÖGK)"',
  },
  {
    element: 'full-text-typed identifiers',
    appliesTo: 'case_number (Geschaeftszahl / GZ), norm (Norm)',
    description:
      'Typed as full-text expressions upstream — an exact Geschäftszahl returns that decision, and norm citations match the format returned in norms_cited ("DSG §1", "DSGVO Art32").',
    example: 'Norm: "DSG §1"',
  },
] as const satisfies readonly SearchSyntaxRule[];
