/**
 * @fileoverview Justiz `Fachgebiet` subject-area taxonomy (OGD Handbook V2.6; identical to the
 * official RIS example-page list). Note: the filter is documented but the corpus carries no
 * tagged documents yet — every probed value returned 0 hits on 2026-07-05.
 * @module services/ris/reference/justiz-subject-areas
 */

/** One Justiz subject-area (Fachgebiet) value. */
export interface JustizSubjectArea {
  /** English gloss of the subject area. */
  readonly english: string;
  /** Exact German value for the Justiz `Fachgebiet` parameter. */
  readonly value: string;
}

/** The documented Justiz Fachgebiet taxonomy. */
export const RIS_JUSTIZ_SUBJECT_AREAS = [
  { value: 'Amtsdelikte/Korruption', english: 'Official misconduct and corruption' },
  { value: 'Amtshaftung inkl. StEG', english: 'State liability (incl. StEG compensation)' },
  { value: 'Anfechtungsrecht', english: 'Avoidance and contestation law' },
  { value: 'Arbeitsrecht', english: 'Labour law' },
  { value: 'Bestandrecht', english: 'Tenancy and lease law' },
  { value: 'Datenschutzrecht', english: 'Data protection law' },
  {
    value: 'Erbrecht und Verlassenschaftsverfahren',
    english: 'Inheritance law and probate proceedings',
  },
  { value: 'Erwachsenenschutzrecht', english: 'Adult guardianship law' },
  { value: 'Exekutionsrecht', english: 'Enforcement of judgments' },
  { value: 'Familienrecht (ohne Unterhalt)', english: 'Family law (excluding maintenance)' },
  { value: 'Finanzstrafsachen', english: 'Fiscal criminal matters' },
  { value: 'Gewerblicher Rechtsschutz', english: 'Industrial property protection' },
  { value: 'Grundbuchsrecht', english: 'Land register law' },
  { value: 'Grundrechte', english: 'Fundamental rights' },
  { value: 'Insolvenzrecht', english: 'Insolvency law' },
  {
    value: 'Internationales Privat- und Zivilverfahrensrecht',
    english: 'Private international law and international civil procedure',
  },
  { value: 'Jugendstrafsachen', english: 'Juvenile criminal matters' },
  { value: 'Kartellrecht', english: 'Antitrust and cartel law' },
  { value: 'Klauselentscheidungen', english: 'Standard-contract-terms (clause) decisions' },
  {
    value: 'Konsumentenschutz und Produkthaftung',
    english: 'Consumer protection and product liability',
  },
  { value: 'Medienrecht', english: 'Media law' },
  { value: 'Persönlichkeitsschutzrecht', english: 'Personality-rights protection' },
  { value: 'Schadenersatz nach Verkehrsunfall', english: 'Damages after traffic accidents' },
  { value: 'Schlepperei/FPG', english: 'Human smuggling and Aliens Police Act matters' },
  { value: 'Schiedsverfahrensrecht', english: 'Arbitration law' },
  { value: 'Sexualdelikte', english: 'Sexual offences' },
  { value: 'Sozialrecht', english: 'Social security law' },
  {
    value: 'Standes- und Disziplinarrecht für Anwälte',
    english: 'Professional and disciplinary law for lawyers',
  },
  { value: 'Suchtgiftdelikte', english: 'Narcotics offences' },
  { value: 'Transportrecht', english: 'Transport law' },
  { value: 'Unionsrecht', english: 'European Union law' },
  {
    value: 'Unterbringungs- und Heimaufenthaltsrecht',
    english: 'Involuntary placement and residential-care law',
  },
  { value: 'Unterhaltsrecht inkl. UVG', english: 'Maintenance law (incl. UVG advances)' },
  {
    value: 'Unternehmens-, Gesellschafts- und Wertpapierrecht',
    english: 'Company, corporate, and securities law',
  },
  { value: 'Urheberrecht', english: 'Copyright law' },
  { value: 'Versicherungsvertragsrecht', english: 'Insurance contract law' },
  { value: 'Wirtschaftsstrafsachen', english: 'Economic criminal matters' },
  { value: 'Wohnungseigentumsrecht', english: 'Condominium (residential property) law' },
  { value: 'Zivilverfahrensrecht', english: 'Civil procedure law' },
] as const satisfies readonly JustizSubjectArea[];
