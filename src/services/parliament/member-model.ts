/**
 * @fileoverview Public parliamentary identity, affiliations, and profile-section schemas.
 * @module services/parliament/member-model
 */

import { z } from '@cyanheads/mcp-ts-core';
import { Int32IdSchema, LanguageSchema } from './normalization.js';

const text = (description: string) => z.string().optional().describe(description);
const id = (description: string) => Int32IdSchema.optional().describe(description);

/** Supported council spellings, normalized only on caller input. */
export const MemberCouncilInputSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const aliases = new Map([
    ['n', 'N'],
    ['nationalrat', 'N'],
    ['conseil national', 'N'],
    ['consiglio nazionale', 'N'],
    ['s', 'S'],
    ['ständerat', 'S'],
    ['conseil des états', 'S'],
    ['consiglio degli stati', 'S'],
  ]);
  const trimmed = value.trim();
  return trimmed ? (aliases.get(trimmed.toLowerCase()) ?? trimmed) : undefined;
}, z.enum(['N', 'S']).optional());

/** Search result units are affiliation records, rather than deduplicated people. */
export const MembershipSchema = z.enum(['current', 'former', 'all']);

/** Profile sections expose their own independent source collections. */
export const MemberSectionSchema = z.enum(['overview', 'council_terms', 'committees', 'interests']);

const affiliationFields = {
  personNumber: Int32IdSchema.describe('PersonNumber used by every member-profile lookup.'),
  metadataLanguage: LanguageSchema.describe(
    'Selected metadata row language, not a translation claim.',
  ),
  sourceUrl: z.string().describe('HTTPS OData URL for this exact source record.'),
  firstName: text('Published first name.'),
  lastName: text('Published last name.'),
  officialName: text('Published official name.'),
  active: z.boolean().optional().describe('Published activity flag; absent means unknown.'),
  councilId: id('Published council identifier.'),
  councilName: text('Published council name.'),
  councilAbbreviation: text('Published council abbreviation.'),
  cantonId: id('Published canton identifier.'),
  cantonName: text('Published canton name.'),
  cantonAbbreviation: text('Published canton abbreviation.'),
  partyId: id('Published party identifier for this record.'),
  partyName: text('Published party name for this record.'),
  partyAbbreviation: text('Published party abbreviation for this record.'),
  groupId: id('Published parliamentary-group identifier for this record.'),
  groupName: text('Published parliamentary-group name for this record.'),
  groupAbbreviation: text('Published parliamentary-group abbreviation for this record.'),
  joinedDate: text('Council term joining date, without an inferred timezone.'),
  leftDate: text('Council term leaving date, when published.'),
};

/** One MemberCouncil record with its published affiliations and term dates. */
export const MemberSummarySchema = z
  .object({
    memberCouncilId: Int32IdSchema.describe('MemberCouncil.ID; distinct from PersonNumber.'),
    ...affiliationFields,
  })
  .describe('One published MemberCouncil affiliation record.');

/** One historical council record; its GUID is not a Person or MemberCouncil key. */
export const CouncilTermSchema = z
  .object({
    id: z.string().describe('MemberCouncilHistory record GUID.'),
    predecessorId: text('Published predecessor GUID, when known.'),
    ...affiliationFields,
  })
  .describe('One historical council term with its source identifiers.');

/** Parliamentary identity excludes contact, household, and unrelated biography data. */
export const MemberPersonSchema = z.object({
  personNumber: Int32IdSchema.describe('PersonNumber, the profile lookup identifier.'),
  id: Int32IdSchema.describe('Person.ID, which need not equal PersonNumber.'),
  metadataLanguage: LanguageSchema.describe('Selected metadata row language.'),
  sourceUrl: z.string().describe('HTTPS OData URL for this Person record.'),
  firstName: text('Published first name.'),
  lastName: text('Published last name.'),
  officialName: text('Published official name.'),
  nativeLanguage: text('Published native-language value; absence means unknown.'),
});

/** Published MemberCommittee rows are not a complete historical committee ledger. */
export const MemberCommitteeSchema = z
  .object({
    id: z.string().describe('MemberCommittee membership GUID.'),
    committeeId: Int32IdSchema.describe('CommitteeNumber for reference and business queries.'),
    committeeName: text('Published committee name.'),
    abbreviation: text('Published committee Abbreviation.'),
    abbreviation1: text('Published committee Abbreviation1.'),
    abbreviation2: text('Published committee Abbreviation2.'),
    committeeTypeId: id('Published committee type identifier.'),
    committeeTypeName: text('Published committee type name.'),
    committeeTypeAbbreviation: text('Published committee type abbreviation.'),
    councilId: id('Published council identifier.'),
    councilName: text('Published council name.'),
    councilAbbreviation: text('Published council abbreviation.'),
    functionId: z.number().int().optional().describe('Published committee-function code.'),
    functionName: text('Published committee-function name.'),
    sourceUrl: z.string().describe('HTTPS OData URL for this membership record.'),
  })
  .describe('One published committee membership.');

/** Declared interests preserve missing paid flags as unknown rather than unpaid. */
export const MemberInterestSchema = z
  .object({
    id: z.string().describe('PersonInterest record GUID.'),
    interestName: text('Original published interest name.'),
    agency: text('Original published Agency code.'),
    interestType: z.number().int().optional().describe('Published interest type code.'),
    interestTypeText: text('Published interest type text.'),
    organizationType: z.number().int().optional().describe('Published organization type code.'),
    organizationTypeText: text('Published organization type text.'),
    functionInAgency: z.number().int().optional().describe('Published function-in-agency code.'),
    functionInAgencyText: text('Published function-in-agency text.'),
    paid: z.boolean().optional().describe('Published paid flag; absent means unknown.'),
    sortOrder: z.number().int().optional().describe('Published source sort order.'),
    modifiedAt: text('Published modification timestamp without an inferred timezone.'),
    sourceUrl: z.string().describe('HTTPS OData URL for this interest record.'),
  })
  .describe('One declared interest with published paid-status information.');

/** Normalized member-search parameters echoed on both result surfaces. */
export const MemberSearchFiltersSchema = z.object({
  language: LanguageSchema.describe('Effective metadata language.'),
  query: text('Trimmed upstream substring search.'),
  membership: MembershipSchema.describe(
    'current filters Active true; former false; all omits Active.',
  ),
  council: z.enum(['N', 'S']).optional().describe('Effective council filter.'),
  cantonId: id('Effective canton filter.'),
  partyId: id('Effective party filter.'),
  groupId: id('Effective parliamentary-group filter.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .describe('Effective requested record count after clamping.'),
  offset: z.number().int().nonnegative().describe('Effective starting record offset.'),
});

/** Normalized profile parameters; overview has no pagination. */
export const MemberProfileFiltersSchema = z.object({
  personNumber: Int32IdSchema.describe('Effective PersonNumber lookup key.'),
  language: LanguageSchema.describe('Effective metadata language.'),
  section: MemberSectionSchema.describe('Effective profile component.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Effective relationship page size; absent for overview.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Effective relationship offset; absent for overview.'),
});

/** Normalized member-search parameters. */
export type MemberSearchFilters = z.infer<typeof MemberSearchFiltersSchema>;
/** One source affiliation record. */
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
