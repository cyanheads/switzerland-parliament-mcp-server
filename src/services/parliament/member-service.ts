/**
 * @fileoverview Member searches and profile sections through the shared OData network boundary.
 * @module services/parliament/member-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { MemberSearchFilters, MemberSummary } from './member-model.js';
import {
  type Language,
  odataInt32,
  odataString,
  RawDate,
  RawId,
  RawInt32,
  RawLanguage,
  RawText,
} from './normalization.js';
import {
  ODataClient,
  type ODataPage,
  odataEntityUrl,
  type ParliamentEntity,
} from './odata-client.js';
import { remainingWorkflowMs, type WorkflowContext } from './workflow.js';

const RawAffiliationSchema = z.object({
  Language: RawLanguage,
  PersonNumber: RawId,
  FirstName: RawText,
  LastName: RawText,
  OfficialName: RawText,
  Active: z.boolean().nullish(),
  Council: RawId.nullish(),
  CouncilName: RawText,
  CouncilAbbreviation: RawText,
  Canton: RawId.nullish(),
  CantonName: RawText,
  CantonAbbreviation: RawText,
  Party: RawId.nullish(),
  PartyName: RawText,
  PartyAbbreviation: RawText,
  ParlGroupNumber: RawId.nullish(),
  ParlGroupName: RawText,
  ParlGroupAbbreviation: RawText,
  DateJoining: RawDate,
  DateLeaving: RawDate,
});
const RawMemberSchema = RawAffiliationSchema.extend({ ID: RawId });
const RawTermSchema = RawAffiliationSchema.extend({
  ID: z.uuid(),
  IdPredecessor: z.uuid().nullish(),
});
const RawPersonSchema = z.object({
  ID: RawId,
  PersonNumber: RawId,
  Language: RawLanguage,
  FirstName: RawText,
  LastName: RawText,
  OfficialName: RawText,
  NativeLanguage: RawText,
});
const RawCommitteeSchema = z.object({
  ID: z.uuid(),
  Language: RawLanguage,
  PersonNumber: RawId,
  CommitteeNumber: RawId,
  CommitteeName: RawText,
  Abbreviation: RawText,
  Abbreviation1: RawText,
  Abbreviation2: RawText,
  CommitteeType: RawId.nullish(),
  CommitteeTypeName: RawText,
  CommitteeTypeAbbreviation: RawText,
  Council: RawId.nullish(),
  CouncilName: RawText,
  CouncilAbbreviation: RawText,
  CommitteeFunction: RawInt32,
  CommitteeFunctionName: RawText,
});
const RawInterestSchema = z.object({
  ID: z.uuid(),
  Language: RawLanguage,
  PersonNumber: RawId,
  InterestName: RawText,
  Agency: RawText,
  InterestType: RawInt32,
  InterestTypeText: RawText,
  OrganizationType: RawInt32,
  OrganizationTypeText: RawText,
  FunctionInAgency: RawInt32,
  FunctionInAgencyText: RawText,
  Paid: z.boolean().nullish(),
  SortOrder: RawInt32,
  Modified: RawDate,
});
const affiliationSelect = Object.keys(RawAffiliationSchema.shape);

function sourceUrl(entity: ParliamentEntity, id: number | string, language: Language): string {
  return odataEntityUrl(entity, typeof id === 'number' ? String(id) : `guid'${id}'`, language);
}

function verifyLanguage(raw: { Language: string }, language: Language): void {
  if (raw.Language !== language.toUpperCase())
    throw serializationError(
      'Parliament returned a member record in a different metadata language.',
    );
}

function affiliation(raw: z.infer<typeof RawAffiliationSchema>, language: Language) {
  verifyLanguage(raw, language);
  return {
    personNumber: String(raw.PersonNumber),
    metadataLanguage: language,
    ...(raw.FirstName != null && { firstName: raw.FirstName }),
    ...(raw.LastName != null && { lastName: raw.LastName }),
    ...(raw.OfficialName != null && { officialName: raw.OfficialName }),
    ...(raw.Active != null && { active: raw.Active }),
    ...(raw.Council != null && { councilId: String(raw.Council) }),
    ...(raw.CouncilName != null && { councilName: raw.CouncilName }),
    ...(raw.CouncilAbbreviation != null && { councilAbbreviation: raw.CouncilAbbreviation }),
    ...(raw.Canton != null && { cantonId: String(raw.Canton) }),
    ...(raw.CantonName != null && { cantonName: raw.CantonName }),
    ...(raw.CantonAbbreviation != null && { cantonAbbreviation: raw.CantonAbbreviation }),
    ...(raw.Party != null && { partyId: String(raw.Party) }),
    ...(raw.PartyName != null && { partyName: raw.PartyName }),
    ...(raw.PartyAbbreviation != null && { partyAbbreviation: raw.PartyAbbreviation }),
    ...(raw.ParlGroupNumber != null && { groupId: String(raw.ParlGroupNumber) }),
    ...(raw.ParlGroupName != null && { groupName: raw.ParlGroupName }),
    ...(raw.ParlGroupAbbreviation != null && { groupAbbreviation: raw.ParlGroupAbbreviation }),
    ...(raw.DateJoining != null && { joinedDate: raw.DateJoining }),
    ...(raw.DateLeaving != null && { leftDate: raw.DateLeaving }),
  };
}

function member(raw: z.infer<typeof RawMemberSchema>, language: Language): MemberSummary {
  return {
    memberCouncilId: String(raw.ID),
    ...affiliation(raw, language),
    sourceUrl: sourceUrl('MemberCouncil', raw.ID, language),
  };
}

/** Stateless member workflows, with one explicit context shared across every source page. */
export class MemberService {
  readonly #client = new ODataClient();

  /** Search affiliation records, preserving the current/former/all distinction upstream. */
  async searchMembers(
    filters: MemberSearchFilters,
    workflow: WorkflowContext,
  ): Promise<ODataPage<MemberSummary>> {
    const predicates: string[] = [];
    if (filters.membership !== 'all')
      predicates.push(`Active eq ${filters.membership === 'current'}`);
    if (filters.query !== undefined) {
      const query = odataString(filters.query);
      predicates.push(
        `(substringof(${query},FirstName) or substringof(${query},LastName) or substringof(${query},OfficialName))`,
      );
    }
    if (filters.council) predicates.push(`Council eq ${filters.council === 'N' ? 1 : 2}`);
    if (filters.cantonId) predicates.push(`Canton eq ${odataInt32(filters.cantonId)}`);
    if (filters.partyId) predicates.push(`Party eq ${odataInt32(filters.partyId)}`);
    if (filters.groupId) predicates.push(`ParlGroupNumber eq ${odataInt32(filters.groupId)}`);
    const page = await this.#client.collection(
      {
        entity: 'MemberCouncil',
        language: filters.language,
        select: ['ID', ...affiliationSelect],
        orderBy: [
          { field: 'LastName', direction: 'asc' },
          { field: 'FirstName', direction: 'asc' },
          { field: 'ID', direction: 'asc' },
        ],
        ...(predicates.length > 0 && { filter: predicates.join(' and ') }),
      },
      RawMemberSchema,
      filters,
      workflow,
    );
    return { ...page, items: page.items.map((raw) => member(raw, filters.language)) };
  }

  /** Resolve Person by PersonNumber rather than assuming it equals Person.ID. */
  async getPerson(personNumber: string, language: Language, workflow: WorkflowContext) {
    const page = await this.#client.collection(
      {
        entity: 'Person',
        language,
        filter: `PersonNumber eq ${odataInt32(personNumber)}`,
        select: Object.keys(RawPersonSchema.shape),
        orderBy: [{ field: 'ID', direction: 'asc' }],
      },
      RawPersonSchema,
      { limit: 2, offset: 0 },
      workflow,
    );
    if (page.items.length > 1 || page.hasMore)
      throw serializationError(
        'Parliament returned multiple Person records for one PersonNumber and language.',
      );
    const raw = page.items[0];
    if (!raw) return;
    verifyLanguage(raw, language);
    return {
      personNumber: String(raw.PersonNumber),
      id: String(raw.ID),
      metadataLanguage: language,
      sourceUrl: sourceUrl('Person', raw.ID, language),
      ...(raw.FirstName != null && { firstName: raw.FirstName }),
      ...(raw.LastName != null && { lastName: raw.LastName }),
      ...(raw.OfficialName != null && { officialName: raw.OfficialName }),
      ...(raw.NativeLanguage != null && { nativeLanguage: raw.NativeLanguage }),
    };
  }

  /** Drain all base affiliation records; overview never substitutes a first source page for completeness. */
  async memberships(
    personNumber: string,
    language: Language,
    workflow: WorkflowContext,
  ): Promise<MemberSummary[]> {
    const items: MemberSummary[] = [];
    let offset = 0;
    for (;;) {
      remainingWorkflowMs(workflow);
      const page = await this.#client.collection(
        {
          entity: 'MemberCouncil',
          language,
          filter: `PersonNumber eq ${odataInt32(personNumber)}`,
          select: ['ID', ...affiliationSelect],
          orderBy: [{ field: 'ID', direction: 'asc' }],
        },
        RawMemberSchema,
        { limit: 1000, offset },
        workflow,
      );
      items.push(...page.items.map((raw) => member(raw, language)));
      if (!page.hasMore) return items;
      if (!page.nextOffset || page.nextOffset <= offset)
        throw serializationError('Parliament membership pagination stopped making progress.');
      offset = page.nextOffset;
    }
  }

  /** Page complete historical council rows, preserving history and predecessor GUIDs. */
  async councilTerms(
    personNumber: string,
    language: Language,
    paging: { limit: number; offset: number },
    workflow: WorkflowContext,
  ) {
    const page = await this.#client.collection(
      {
        entity: 'MemberCouncilHistory',
        language,
        filter: `PersonNumber eq ${odataInt32(personNumber)}`,
        select: ['ID', 'IdPredecessor', ...affiliationSelect],
        orderBy: [
          { field: 'DateJoining', direction: 'asc' },
          { field: 'ID', direction: 'asc' },
        ],
      },
      RawTermSchema,
      paging,
      workflow,
    );
    return {
      ...page,
      items: page.items.map((raw) => ({
        id: raw.ID,
        ...(raw.IdPredecessor != null && { predecessorId: raw.IdPredecessor }),
        ...affiliation(raw, language),
        sourceUrl: sourceUrl('MemberCouncilHistory', raw.ID, language),
      })),
    };
  }

  /** Page the published MemberCommittee collection without claiming a historical ledger. */
  async committees(
    personNumber: string,
    language: Language,
    paging: { limit: number; offset: number },
    workflow: WorkflowContext,
  ) {
    const page = await this.#client.collection(
      {
        entity: 'MemberCommittee',
        language,
        filter: `PersonNumber eq ${odataInt32(personNumber)}`,
        select: Object.keys(RawCommitteeSchema.shape),
        orderBy: [
          { field: 'CommitteeNumber', direction: 'asc' },
          { field: 'ID', direction: 'asc' },
        ],
      },
      RawCommitteeSchema,
      paging,
      workflow,
    );
    return {
      ...page,
      items: page.items.map((raw) => {
        verifyLanguage(raw, language);
        return {
          id: raw.ID,
          committeeId: String(raw.CommitteeNumber),
          sourceUrl: sourceUrl('MemberCommittee', raw.ID, language),
          ...(raw.CommitteeName != null && { committeeName: raw.CommitteeName }),
          ...(raw.Abbreviation != null && { abbreviation: raw.Abbreviation }),
          ...(raw.Abbreviation1 != null && { abbreviation1: raw.Abbreviation1 }),
          ...(raw.Abbreviation2 != null && { abbreviation2: raw.Abbreviation2 }),
          ...(raw.CommitteeType != null && { committeeTypeId: String(raw.CommitteeType) }),
          ...(raw.CommitteeTypeName != null && { committeeTypeName: raw.CommitteeTypeName }),
          ...(raw.CommitteeTypeAbbreviation != null && {
            committeeTypeAbbreviation: raw.CommitteeTypeAbbreviation,
          }),
          ...(raw.Council != null && { councilId: String(raw.Council) }),
          ...(raw.CouncilName != null && { councilName: raw.CouncilName }),
          ...(raw.CouncilAbbreviation != null && { councilAbbreviation: raw.CouncilAbbreviation }),
          ...(raw.CommitteeFunction != null && { functionId: raw.CommitteeFunction }),
          ...(raw.CommitteeFunctionName != null && { functionName: raw.CommitteeFunctionName }),
        };
      }),
    };
  }

  /** Page declared interests; an absent/null Paid value remains absent, and false remains false. */
  async interests(
    personNumber: string,
    language: Language,
    paging: { limit: number; offset: number },
    workflow: WorkflowContext,
  ) {
    const page = await this.#client.collection(
      {
        entity: 'PersonInterest',
        language,
        filter: `PersonNumber eq ${odataInt32(personNumber)}`,
        select: Object.keys(RawInterestSchema.shape),
        orderBy: [
          { field: 'SortOrder', direction: 'asc' },
          { field: 'ID', direction: 'asc' },
        ],
      },
      RawInterestSchema,
      paging,
      workflow,
    );
    return {
      ...page,
      items: page.items.map((raw) => {
        verifyLanguage(raw, language);
        return {
          id: raw.ID,
          sourceUrl: sourceUrl('PersonInterest', raw.ID, language),
          ...(raw.InterestName != null && { interestName: raw.InterestName }),
          ...(raw.Agency != null && { agency: raw.Agency }),
          ...(raw.InterestType != null && { interestType: raw.InterestType }),
          ...(raw.InterestTypeText != null && { interestTypeText: raw.InterestTypeText }),
          ...(raw.OrganizationType != null && { organizationType: raw.OrganizationType }),
          ...(raw.OrganizationTypeText != null && {
            organizationTypeText: raw.OrganizationTypeText,
          }),
          ...(raw.FunctionInAgency != null && { functionInAgency: raw.FunctionInAgency }),
          ...(raw.FunctionInAgencyText != null && {
            functionInAgencyText: raw.FunctionInAgencyText,
          }),
          ...(raw.Paid != null && { paid: raw.Paid }),
          ...(raw.SortOrder != null && { sortOrder: raw.SortOrder }),
          ...(raw.Modified != null && { modifiedAt: raw.Modified }),
        };
      }),
    };
  }
}
