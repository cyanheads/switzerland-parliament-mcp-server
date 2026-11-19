/**
 * @fileoverview Member searches and profile sections through the shared OData network boundary.
 * @module services/parliament/member-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type {
  MemberInterest,
  MemberSearchFilters,
  MemberSearchRow,
  MemberSummary,
} from './member-model.js';
import {
  type Language,
  odataDay,
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
/**
 * One of a person's own MemberCommitteeHistory rows: the MemberCommittee fields without the
 * committee type, plus the membership's dates (DateLeaving is its last day). A few published rows
 * name no committee, function, or dates.
 */
const RawCommitteeHistorySchema = RawCommitteeSchema.omit({
  CommitteeType: true,
  CommitteeTypeName: true,
  CommitteeTypeAbbreviation: true,
}).extend({ CommitteeNumber: RawId.nullish(), DateJoining: RawDate, DateLeaving: RawDate });
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
  DateFrom: RawDate,
});
/** One MemberCommittee membership with its singular, non-optional MemberCouncil expansion. */
const RawRosterSchema = z.object({
  ID: z.uuid(),
  Language: RawLanguage,
  CommitteeFunction: RawInt32,
  CommitteeFunctionName: RawText,
  MembersCouncil: RawMemberSchema,
});
/**
 * One MemberCommitteeHistory membership. Its names, council, canton, party (`PartyNumber`), and
 * group are recorded for that membership; DateJoining/DateLeaving are committee dates, DateLeaving
 * the last day. The expansion holds the person's latest MemberCouncil record, so only its key and
 * official name are read.
 */
const RawHistoryRosterSchema = z.object({
  ID: z.uuid(),
  Language: RawLanguage,
  PersonNumber: RawId,
  FirstName: RawText,
  LastName: RawText,
  CommitteeFunction: RawInt32,
  CommitteeFunctionName: RawText,
  DateJoining: RawDate,
  DateLeaving: RawDate,
  Council: RawId.nullish(),
  CouncilName: RawText,
  CouncilAbbreviation: RawText,
  Canton: RawId.nullish(),
  CantonName: RawText,
  CantonAbbreviation: RawText,
  PartyNumber: RawId.nullish(),
  PartyName: RawText,
  PartyAbbreviation: RawText,
  ParlGroupNumber: RawId.nullish(),
  ParlGroupName: RawText,
  ParlGroupAbbreviation: RawText,
  MembersCouncil: z.object({ ID: RawId, Language: RawLanguage, OfficialName: RawText }),
});
/** One declaration with its declarant's MemberCouncil record, reached through Person. */
const RawInterestSearchSchema = RawInterestSchema.extend({
  Persons: z.object({ MembersCouncil: RawMemberSchema }),
});
const affiliationSelect = Object.keys(RawAffiliationSchema.shape);
const memberSelect = ['ID', ...affiliationSelect];
const interestSelect = Object.keys(RawInterestSchema.shape);

/** A member-search page; committee searches also report whether the committee exists. */
export interface MemberSearchPage extends ODataPage<MemberSearchRow> {
  readonly committeeFound?: boolean;
}

/** The source field each narrowing filter reads on one route. */
interface NarrowingFields {
  readonly canton: string;
  readonly council: string;
  readonly group: string;
  readonly names: readonly [string, string, string];
  readonly party: string;
}

/** MemberCouncil fields reached through `path`: the record itself, or a singular expansion. */
function memberCouncilFields(
  path: '' | 'MembersCouncil/' | 'Persons/MembersCouncil/',
): NarrowingFields {
  return {
    names: [`${path}FirstName`, `${path}LastName`, `${path}OfficialName`],
    council: `${path}Council`,
    canton: `${path}Canton`,
    party: `${path}Party`,
    group: `${path}ParlGroupNumber`,
  };
}

/** A history membership's own recorded fields; only the official name comes from the expansion. */
const historyFields: NarrowingFields = {
  names: ['FirstName', 'LastName', 'MembersCouncil/OfficialName'],
  council: 'Council',
  canton: 'Canton',
  party: 'PartyNumber',
  group: 'ParlGroupNumber',
};

/** Name, council, canton, party, and group predicates, in one order on every route. */
function narrowingPredicates(filters: MemberSearchFilters, fields: NarrowingFields): string[] {
  const predicates: string[] = [];
  if (filters.query !== undefined) {
    const query = odataString(filters.query);
    predicates.push(
      `(${fields.names.map((field) => `substringof(${query},${field})`).join(' or ')})`,
    );
  }
  if (filters.council) predicates.push(`${fields.council} eq ${filters.council === 'N' ? 1 : 2}`);
  if (filters.cantonId) predicates.push(`${fields.canton} eq ${odataInt32(filters.cantonId)}`);
  if (filters.partyId) predicates.push(`${fields.party} eq ${odataInt32(filters.partyId)}`);
  if (filters.groupId) predicates.push(`${fields.group} eq ${odataInt32(filters.groupId)}`);
  return predicates;
}

const searchOrder = [
  { field: 'LastName', direction: 'asc' },
  { field: 'FirstName', direction: 'asc' },
  { field: 'ID', direction: 'asc' },
] as const;

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

/** Committee, recorded council, and function fields of a member's current and past rows. */
function committeeMembership(raw: z.infer<typeof RawCommitteeHistorySchema>) {
  return {
    ...(raw.CommitteeName != null && { committeeName: raw.CommitteeName }),
    ...(raw.Abbreviation != null && { abbreviation: raw.Abbreviation }),
    ...(raw.Abbreviation1 != null && { abbreviation1: raw.Abbreviation1 }),
    ...(raw.Abbreviation2 != null && { abbreviation2: raw.Abbreviation2 }),
    ...(raw.Council != null && { councilId: String(raw.Council) }),
    ...(raw.CouncilName != null && { councilName: raw.CouncilName }),
    ...(raw.CouncilAbbreviation != null && { councilAbbreviation: raw.CouncilAbbreviation }),
    ...(raw.CommitteeFunction != null && { functionId: raw.CommitteeFunction }),
    ...(raw.CommitteeFunctionName != null && { functionName: raw.CommitteeFunctionName }),
  };
}

/** One declaration; an absent/null Paid value remains absent, and false remains false. */
function interest(raw: z.infer<typeof RawInterestSchema>, language: Language): MemberInterest {
  verifyLanguage(raw, language);
  return {
    id: raw.ID,
    sourceUrl: sourceUrl('PersonInterest', raw.ID, language),
    ...(raw.InterestName != null && { interestName: raw.InterestName }),
    ...(raw.Agency != null && { agency: raw.Agency }),
    ...(raw.InterestType != null && { interestType: raw.InterestType }),
    ...(raw.InterestTypeText != null && { interestTypeText: raw.InterestTypeText }),
    ...(raw.OrganizationType != null && { organizationType: raw.OrganizationType }),
    ...(raw.OrganizationTypeText != null && { organizationTypeText: raw.OrganizationTypeText }),
    ...(raw.FunctionInAgency != null && { functionInAgency: raw.FunctionInAgency }),
    ...(raw.FunctionInAgencyText != null && { functionInAgencyText: raw.FunctionInAgencyText }),
    ...(raw.Paid != null && { paid: raw.Paid }),
    ...(raw.SortOrder != null && { sortOrder: raw.SortOrder }),
    ...(raw.Modified != null && { modifiedAt: raw.Modified }),
    ...(raw.DateFrom != null && { dateFrom: raw.DateFrom }),
  };
}

/** Stateless member workflows, with one explicit context shared across every source page. */
export class MemberService {
  readonly #client = new ODataClient();

  /**
   * Search affiliation records, preserving the current/former/all distinction upstream. With a
   * committeeId, page that committee's MemberCommittee memberships instead, or with asOf its
   * MemberCommitteeHistory memberships open on that day; the caller rejects membership former/all
   * on rosters, which these sources cannot answer. With an interest, page matching declarations;
   * the caller rejects it beside committeeId or asOf.
   */
  async searchMembers(
    filters: MemberSearchFilters,
    workflow: WorkflowContext,
  ): Promise<MemberSearchPage> {
    if (filters.interest !== undefined)
      return this.#interestSearch(filters.interest, filters, workflow);
    if (filters.committeeId !== undefined)
      return filters.asOf === undefined
        ? this.#committeeRoster(filters.committeeId, filters, workflow)
        : this.#historyRoster(filters.committeeId, filters.asOf, filters, workflow);
    const predicates = [
      ...(filters.membership === 'all' ? [] : [`Active eq ${filters.membership === 'current'}`]),
      ...narrowingPredicates(filters, memberCouncilFields('')),
    ];
    const page = await this.#client.collection(
      {
        entity: 'MemberCouncil',
        language: filters.language,
        select: memberSelect,
        orderBy: searchOrder,
        ...(predicates.length > 0 && { filter: predicates.join(' and ') }),
      },
      RawMemberSchema,
      filters,
      workflow,
    );
    return { ...page, items: page.items.map((raw) => member(raw, filters.language)) };
  }

  /** One membership per row, ordered by MemberCommittee's own names and membership GUID. */
  async #committeeRoster(
    committeeId: string,
    filters: MemberSearchFilters,
    workflow: WorkflowContext,
  ): Promise<MemberSearchPage> {
    const page = await this.#client.collection(
      {
        entity: 'MemberCommittee',
        language: filters.language,
        // CommitteeNumber leads, so every MembersCouncil/ navigation predicate stays scoped to one roster.
        filter: [
          `CommitteeNumber eq ${odataInt32(committeeId)}`,
          ...narrowingPredicates(filters, memberCouncilFields('MembersCouncil/')),
        ].join(' and '),
        expand: ['MembersCouncil'],
        select: [
          'ID',
          'Language',
          'CommitteeFunction',
          'CommitteeFunctionName',
          ...memberSelect.map((field) => `MembersCouncil/${field}`),
        ],
        orderBy: searchOrder,
      },
      RawRosterSchema,
      filters,
      workflow,
    );
    const items = page.items.map((raw): MemberSearchRow => {
      verifyLanguage(raw, filters.language);
      return {
        ...member(raw.MembersCouncil, filters.language),
        ...(raw.CommitteeFunction != null && { committeeFunctionId: raw.CommitteeFunction }),
        ...(raw.CommitteeFunctionName != null && {
          committeeFunctionName: raw.CommitteeFunctionName,
        }),
      };
    });
    return this.#withCommitteeFound({ ...page, items }, committeeId, filters.language, workflow);
  }

  /**
   * One membership open on `asOf` per row, ordered by the history row's own names and GUID. A
   * person holds two rows on a day their function changed: DateLeaving is the last day of one row
   * and the next row joins that day.
   */
  async #historyRoster(
    committeeId: string,
    asOf: string,
    filters: MemberSearchFilters,
    workflow: WorkflowContext,
  ): Promise<MemberSearchPage> {
    const page = await this.#client.collection(
      {
        entity: 'MemberCommitteeHistory',
        language: filters.language,
        filter: [
          `CommitteeNumber eq ${odataInt32(committeeId)}`,
          `DateJoining le ${odataDay(asOf, 'end')}`,
          `(DateLeaving ge ${odataDay(asOf)} or DateLeaving eq null)`,
          ...narrowingPredicates(filters, historyFields),
        ].join(' and '),
        expand: ['MembersCouncil'],
        select: [
          ...Object.keys(RawHistoryRosterSchema.shape).filter(
            (field) => field !== 'MembersCouncil',
          ),
          'MembersCouncil/ID',
          'MembersCouncil/Language',
          'MembersCouncil/OfficialName',
        ],
        orderBy: searchOrder,
      },
      RawHistoryRosterSchema,
      filters,
      workflow,
    );
    const items = page.items.map((raw): MemberSearchRow => {
      verifyLanguage(raw, filters.language);
      verifyLanguage(raw.MembersCouncil, filters.language);
      return {
        memberCouncilId: String(raw.MembersCouncil.ID),
        personNumber: String(raw.PersonNumber),
        metadataLanguage: filters.language,
        sourceUrl: sourceUrl('MemberCommitteeHistory', raw.ID, filters.language),
        ...(raw.FirstName != null && { firstName: raw.FirstName }),
        ...(raw.LastName != null && { lastName: raw.LastName }),
        ...(raw.MembersCouncil.OfficialName != null && {
          officialName: raw.MembersCouncil.OfficialName,
        }),
        ...(raw.Council != null && { councilId: String(raw.Council) }),
        ...(raw.CouncilName != null && { councilName: raw.CouncilName }),
        ...(raw.CouncilAbbreviation != null && { councilAbbreviation: raw.CouncilAbbreviation }),
        ...(raw.Canton != null && { cantonId: String(raw.Canton) }),
        ...(raw.CantonName != null && { cantonName: raw.CantonName }),
        ...(raw.CantonAbbreviation != null && { cantonAbbreviation: raw.CantonAbbreviation }),
        ...(raw.PartyNumber != null && { partyId: String(raw.PartyNumber) }),
        ...(raw.PartyName != null && { partyName: raw.PartyName }),
        ...(raw.PartyAbbreviation != null && { partyAbbreviation: raw.PartyAbbreviation }),
        ...(raw.ParlGroupNumber != null && { groupId: String(raw.ParlGroupNumber) }),
        ...(raw.ParlGroupName != null && { groupName: raw.ParlGroupName }),
        ...(raw.ParlGroupAbbreviation != null && { groupAbbreviation: raw.ParlGroupAbbreviation }),
        ...(raw.CommitteeFunction != null && { committeeFunctionId: raw.CommitteeFunction }),
        ...(raw.CommitteeFunctionName != null && {
          committeeFunctionName: raw.CommitteeFunctionName,
        }),
        ...(raw.DateJoining != null && { committeeJoinedDate: raw.DateJoining }),
        ...(raw.DateLeaving != null && { committeeLeftDate: raw.DateLeaving }),
      };
    });
    return this.#withCommitteeFound({ ...page, items }, committeeId, filters.language, workflow);
  }

  /**
   * One declaration per row, ordered by the declaration's own names. Every filter reads the
   * declarant's MemberCouncil record through Person; membership all still requires that record
   * (Active true or false), so a declarant with no published MemberCouncil record matches no
   * membership value and every row keeps its memberCouncilId and sourceUrl.
   */
  async #interestSearch(
    interestName: string,
    filters: MemberSearchFilters,
    workflow: WorkflowContext,
  ): Promise<MemberSearchPage> {
    const active = 'Persons/MembersCouncil/Active';
    const page = await this.#client.collection(
      {
        entity: 'PersonInterest',
        language: filters.language,
        filter: [
          `substringof(${odataString(interestName)},InterestName)`,
          filters.membership === 'all'
            ? `(${active} eq true or ${active} eq false)`
            : `${active} eq ${filters.membership === 'current'}`,
          ...narrowingPredicates(filters, memberCouncilFields('Persons/MembersCouncil/')),
        ].join(' and '),
        expand: ['Persons/MembersCouncil'],
        select: [
          ...interestSelect,
          ...memberSelect.map((field) => `Persons/MembersCouncil/${field}`),
        ],
        orderBy: [
          { field: 'LastName', direction: 'asc' },
          { field: 'FirstName', direction: 'asc' },
          { field: 'PersonNumber', direction: 'asc' },
          { field: 'SortOrder', direction: 'asc' },
          { field: 'ID', direction: 'asc' },
        ],
      },
      RawInterestSearchSchema,
      filters,
      workflow,
    );
    return {
      ...page,
      items: page.items.map(
        (raw): MemberSearchRow => ({
          ...member(raw.Persons.MembersCouncil, filters.language),
          interest: interest(raw, filters.language),
        }),
      ),
    };
  }

  /** An empty roster and an unknown committee answer identically; only then read Committee. */
  async #withCommitteeFound(
    page: ODataPage<MemberSearchRow>,
    committeeId: string,
    language: Language,
    workflow: WorkflowContext,
  ): Promise<MemberSearchPage> {
    const knownNonEmpty =
      page.items.length > 0 || (page.totalCount !== undefined && page.totalCount > 0);
    return {
      ...page,
      committeeFound:
        knownNonEmpty || (await this.#committeeExists(committeeId, language, workflow)),
    };
  }

  /** Read Committee by CommitteeNumber rather than assuming it equals Committee.ID. */
  async #committeeExists(
    committeeId: string,
    language: Language,
    workflow: WorkflowContext,
  ): Promise<boolean> {
    const page = await this.#client.collection(
      {
        entity: 'Committee',
        language,
        filter: `CommitteeNumber eq ${odataInt32(committeeId)}`,
        select: ['ID'],
        orderBy: [{ field: 'ID', direction: 'asc' }],
        includeCount: false,
      },
      z.object({ ID: RawId }),
      { limit: 1, offset: 0 },
      workflow,
    );
    return page.items.length > 0;
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
          select: memberSelect,
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

  /** Page the published MemberCommittee collection: the person's current memberships. */
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
          ...committeeMembership(raw),
          ...(raw.CommitteeType != null && { committeeTypeId: String(raw.CommitteeType) }),
          ...(raw.CommitteeTypeName != null && { committeeTypeName: raw.CommitteeTypeName }),
          ...(raw.CommitteeTypeAbbreviation != null && {
            committeeTypeAbbreviation: raw.CommitteeTypeAbbreviation,
          }),
        };
      }),
    };
  }

  /** Page every published committee membership of one person, past and current, oldest first. */
  async committeeHistory(
    personNumber: string,
    language: Language,
    paging: { limit: number; offset: number },
    workflow: WorkflowContext,
  ) {
    const page = await this.#client.collection(
      {
        entity: 'MemberCommitteeHistory',
        language,
        filter: `PersonNumber eq ${odataInt32(personNumber)}`,
        select: Object.keys(RawCommitteeHistorySchema.shape),
        orderBy: [
          { field: 'DateJoining', direction: 'asc' },
          { field: 'ID', direction: 'asc' },
        ],
      },
      RawCommitteeHistorySchema,
      paging,
      workflow,
    );
    return {
      ...page,
      items: page.items.map((raw) => {
        verifyLanguage(raw, language);
        return {
          id: raw.ID,
          ...(raw.CommitteeNumber != null && { committeeId: String(raw.CommitteeNumber) }),
          sourceUrl: sourceUrl('MemberCommitteeHistory', raw.ID, language),
          ...committeeMembership(raw),
          ...(raw.DateJoining != null && { joinedDate: raw.DateJoining }),
          ...(raw.DateLeaving != null && { leftDate: raw.DateLeaving }),
        };
      }),
    };
  }

  /** Page one person's declared interests in their source order. */
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
        select: interestSelect,
        orderBy: [
          { field: 'SortOrder', direction: 'asc' },
          { field: 'ID', direction: 'asc' },
        ],
      },
      RawInterestSchema,
      paging,
      workflow,
    );
    return { ...page, items: page.items.map((raw) => interest(raw, language)) };
  }
}
