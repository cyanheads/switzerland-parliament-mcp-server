/**
 * @fileoverview Public parliamentary identity, affiliations, and profile-section schemas.
 * @module services/parliament/member-model
 */

import { z } from '@cyanheads/mcp-ts-core';
import { Int32IdSchema, IsoDaySchema, LanguageSchema } from './normalization.js';

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
    ['conseil des etats', 'S'],
    ['consiglio degli stati', 'S'],
  ]);
  const trimmed = value.trim();
  return trimmed ? (aliases.get(trimmed.toLowerCase()) ?? trimmed) : undefined;
}, z.enum(['N', 'S']).optional());

/** Search result units are affiliation records, rather than deduplicated people. */
export const MembershipSchema = z.enum(['current', 'former', 'all']);

/**
 * A calendar day, or a date-time as this server emits one (`2014-03-03T00:00:00.000`, with an
 * offset when the source supplied one); the caller reads it as its written day. `Z` is refused:
 * a UTC instant's Swiss day can differ from its written date. The length bound runs first, so the
 * pattern never scans more than one date-time.
 */
export const AsOfInputSchema = z
  .string()
  .max(29, { abort: true })
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/,
    { abort: true },
  )
  .refine((value) => IsoDaySchema.safeParse(value.slice(0, 10)).success, 'Not a calendar day.');

/** Profile sections expose their own independent source collections. */
export const MemberSectionSchema = z.enum([
  'overview',
  'council_terms',
  'committees',
  'committee_history',
  'interests',
]);

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
  id: Int32IdSchema.describe('Person.ID of this Person record.'),
  metadataLanguage: LanguageSchema.describe('Selected metadata row language.'),
  sourceUrl: z.string().describe('HTTPS OData URL for this Person record.'),
  firstName: text('Published first name.'),
  lastName: text('Published last name.'),
  officialName: text('Published official name.'),
  nativeLanguage: text('Published native-language value; absence means unknown.'),
});

/** MemberCommittee rows hold current memberships; MemberCommitteeHistory holds the ledger. */
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

/**
 * One MemberCommitteeHistory membership: the committee row fields without the committee type, plus
 * the membership's own first and last day. A few published rows carry no committee, function, or
 * dates, so committeeId is optional here.
 */
export const MemberCommitteeHistorySchema = MemberCommitteeSchema.omit({
  committeeTypeId: true,
  committeeTypeName: true,
  committeeTypeAbbreviation: true,
})
  .extend({
    id: z.string().describe('MemberCommitteeHistory membership GUID.'),
    committeeId: id(
      'CommitteeNumber for reference and business queries; absent on a published row that names no committee.',
    ),
    joinedDate: text('First day of this committee membership, without an inferred timezone.'),
    leftDate: text(
      'Last day of this committee membership, when published; it can lie in the future, and an open membership has none.',
    ),
  })
  .describe(
    'One published committee membership, past or current, with the council recorded for it and its dates.',
  );

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
    dateFrom: text(
      'Published start date (DateFrom) of this declaration, without an inferred timezone.',
    ),
    sourceUrl: z.string().describe('HTTPS OData URL for this interest record.'),
  })
  .describe('One declared interest with published paid-status information.');

/**
 * A member-search row: the MemberCouncil record, plus the membership function on committee rosters,
 * the membership's own dates and recorded affiliation on rosters as of a day, and the declaration
 * on interest searches.
 */
export const MemberSearchRowSchema = MemberSummarySchema.extend({
  committeeFunctionId: z
    .number()
    .int()
    .optional()
    .describe(
      'Committee searches only: published CommitteeFunction code, such as 1 Mitglied, 2 Präsident/in, or 6 Vizepräsident/in.',
    ),
  committeeFunctionName: text('Committee searches only: published CommitteeFunctionName.'),
  committeeJoinedDate: text(
    'asOf rosters only: the day this committee membership began, without an inferred timezone.',
  ),
  committeeLeftDate: text(
    'asOf rosters only: the last day of this committee membership, when published; it can lie in the future.',
  ),
  interest: MemberInterestSchema.optional().describe(
    'interest searches only: the declaration this row reports, as chparl_get_member section interests returns it, with its own id and sourceUrl.',
  ),
}).describe(
  'One published MemberCouncil affiliation record; on committee searches, one committee membership; on interest searches, one declaration with its declarant’s record. On asOf rosters, sourceUrl cites the MemberCommitteeHistory record, names, council, canton, party, and group are those recorded for that membership, officialName and memberCouncilId come from the current MemberCouncil record, and active, joinedDate, and leftDate are omitted.',
);

/** Normalized member-search parameters echoed on both result surfaces. */
export const MemberSearchFiltersSchema = z.object({
  language: LanguageSchema.describe('Effective metadata language.'),
  query: text('Trimmed upstream substring search.'),
  membership: MembershipSchema.describe(
    'current filters Active true; former false; all omits Active, except on interest searches, where it requires a published declarant record with either value. Committee rosters send no Active filter.',
  ),
  committeeId: id('Effective CommitteeNumber whose roster is listed.'),
  asOf: IsoDaySchema.optional().describe(
    'Effective roster day, YYYY-MM-DD; absent for the current roster.',
  ),
  interest: text('Effective trimmed substring of a declared interest name.'),
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
/** One member-search row, with committee fields on rosters and the declaration on interest searches. */
export type MemberSearchRow = z.infer<typeof MemberSearchRowSchema>;
/** One declared interest. */
export type MemberInterest = z.infer<typeof MemberInterestSchema>;
