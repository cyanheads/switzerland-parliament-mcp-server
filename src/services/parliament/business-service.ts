/**
 * @fileoverview Stateless business resolution, keyset discovery, and procedural section workflows.
 * @module services/parliament/business-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { readBusinessCursor } from './business-cursor.js';
import {
  BUSINESS_DETAIL_FIELDS,
  BUSINESS_SUMMARY_FIELDS,
  BUSINESS_TEXT_FIELDS,
  BusinessIdentifierSchema,
  type BusinessSearchFilters,
  type BusinessSummary,
  BusinessTextFieldSchema,
  normalizeBusiness,
  type RawBusiness,
  RawBusinessSchema,
} from './business-model.js';
import { type BusinessRelationshipSection, listBusinessSection } from './business-relations.js';
import { type Language, odataDay, odataInt32, odataString } from './normalization.js';
import { ODataClient, type ODataPage, type ODataQuery } from './odata-client.js';
import type { WorkflowContext } from './workflow.js';

const client = new ODataClient();

/** Resolve an exact canonical ID or published short number; all network work shares this context. */
export async function resolveBusiness(
  identifier: string,
  language: Language,
  workflow: WorkflowContext,
  detail = false,
): Promise<RawBusiness | undefined> {
  const id = BusinessIdentifierSchema.parse(identifier);
  let canonical = id;
  if (!/^[1-9]\d{7}$/.test(id)) {
    const lookup = await client.collection(
      {
        entity: 'Business',
        language,
        select: ['ID', 'Language'],
        orderBy: [{ field: 'ID', direction: 'desc' }],
        filter: `BusinessShortNumber eq ${odataString(id)}`,
      },
      RawBusinessSchema,
      { limit: 2, offset: 0 },
      workflow,
    );
    for (const row of lookup.items)
      if (row.Language !== language.toUpperCase())
        throw serializationError(
          'Parliament returned a short-number lookup in a different metadata language.',
        );
    if (
      lookup.items.length > 1 ||
      (lookup.totalCount !== undefined && lookup.totalCount > 1) ||
      lookup.hasMore
    )
      throw validationError(
        'The published short number matches more than one canonical business.',
        { reason: 'ambiguous_business_number' },
      );
    const match = lookup.items[0];
    if (!match) return undefined;
    canonical = String(match.ID);
  }
  const raw = await client.entity(
    {
      entity: 'Business',
      id: canonical,
      language,
      select: [...BUSINESS_SUMMARY_FIELDS, ...(detail ? BUSINESS_DETAIL_FIELDS : [])],
    },
    RawBusinessSchema,
    workflow,
  );
  if (raw && (String(raw.ID) !== canonical || raw.Language !== language.toUpperCase()))
    throw serializationError(
      'Parliament returned a different business than the requested composite key.',
    );
  return raw;
}

function businessPredicates(filters: BusinessSearchFilters, prefix = ''): string[] {
  const clauses: string[] = [];
  if (filters.query !== undefined)
    clauses.push(`substringof(${odataString(filters.query)},${prefix}Title)`);
  if (filters.author !== undefined)
    clauses.push(`substringof(${odataString(filters.author)},${prefix}SubmittedBy)`);
  for (const [value, field] of [
    [filters.typeId, 'BusinessType'],
    [filters.statusId, 'BusinessStatus'],
    [filters.sessionId, 'SubmissionSession'],
  ] as const) {
    if (value !== undefined) clauses.push(`${prefix}${field} eq ${odataInt32(value)}`);
  }
  if (filters.submittedFrom !== undefined)
    clauses.push(`${prefix}SubmissionDate ge ${odataDay(filters.submittedFrom)}`);
  if (filters.submittedTo !== undefined)
    clauses.push(`${prefix}SubmissionDate le ${odataDay(filters.submittedTo, 'end')}`);
  return clauses;
}

/** Business discovery returns an exact total only on the direct Business route. */
export async function searchBusiness(
  filters: BusinessSearchFilters,
  workflow: WorkflowContext,
): Promise<ODataPage<BusinessSummary>> {
  const after = readBusinessCursor(filters);
  if (!filters.committeeId) {
    const predicates = businessPredicates(filters);
    const base: ODataQuery = {
      entity: 'Business',
      language: filters.language,
      select: BUSINESS_SUMMARY_FIELDS,
      orderBy: [{ field: 'ID', direction: 'desc' }],
      ...(predicates.length > 0 && { filter: predicates.join(' and ') }),
    };
    const page = await client.collection(
      {
        ...base,
        ...(after !== undefined && {
          filter: [...predicates, `ID lt ${odataInt32(after)}`].join(' and '),
        }),
      },
      RawBusinessSchema,
      { limit: filters.limit, offset: 0 },
      workflow,
    );
    const total =
      after === undefined
        ? page.totalCount
        : (
            await client.collection(
              { ...base, select: ['ID', 'Language'] },
              RawBusinessSchema,
              { limit: 1, offset: 0 },
              workflow,
            )
          ).totalCount;
    return {
      items: page.items.map((row) => normalizeBusiness(row, filters.language)),
      hasMore: page.hasMore,
      ...(total !== undefined && { totalCount: total }),
    };
  }
  const predicates = [
    `CommitteeNumber eq ${odataInt32(filters.committeeId)}`,
    `Businesses/Language eq ${odataString(filters.language.toUpperCase())}`,
    ...businessPredicates(filters, 'Businesses/'),
  ];
  const roleSchema = z.object({
    ID: z.guid(),
    Language: z.enum(['DE', 'FR', 'IT']),
    BusinessNumber: z.number().int().positive().max(2_147_483_647),
    Businesses: RawBusinessSchema,
  });
  const base: ODataQuery = {
    entity: 'BusinessRole',
    language: filters.language,
    select: [
      'ID',
      'Language',
      'BusinessNumber',
      ...BUSINESS_SUMMARY_FIELDS.map((field) => `Businesses/${field}`),
    ],
    expand: ['Businesses'],
    orderBy: [
      { field: 'BusinessNumber', direction: 'desc' },
      { field: 'ID', direction: 'asc' },
    ],
    filter: predicates.join(' and '),
  };
  const page = await client.collection(
    {
      ...base,
      ...(after !== undefined && {
        filter: [...predicates, `BusinessNumber lt ${odataInt32(after)}`].join(' and '),
      }),
    },
    roleSchema,
    { limit: filters.limit, offset: 0 },
    workflow,
  );
  const businesses = new Map<string, BusinessSummary>();
  for (const row of page.items) {
    if (row.Language !== filters.language.toUpperCase() || row.BusinessNumber !== row.Businesses.ID)
      throw serializationError('Parliament returned a mismatched committee role expansion.');
    const business = normalizeBusiness(row.Businesses, filters.language);
    if (!businesses.has(business.businessId)) businesses.set(business.businessId, business);
  }
  const items = [...businesses.values()];
  const smallest = items.at(-1)?.businessId;
  const older =
    smallest === undefined
      ? undefined
      : await client.collection(
          {
            ...base,
            filter: [...predicates, `BusinessNumber lt ${odataInt32(smallest)}`].join(' and '),
          },
          roleSchema,
          { limit: 1, offset: 0 },
          workflow,
        );
  if (older)
    for (const row of older.items) {
      if (
        row.Language !== filters.language.toUpperCase() ||
        row.BusinessNumber !== row.Businesses.ID ||
        row.Businesses.Language !== filters.language.toUpperCase()
      )
        throw serializationError('Parliament returned a mismatched committee sentinel.');
    }
  return { items, hasMore: older !== undefined && older.items.length > 0 };
}

/** Build overview metadata and availability without putting large text into the overview. */
export function businessOverview(raw: RawBusiness, language: Language) {
  return {
    ...normalizeBusiness(raw, language),
    ...(raw.ResponsibleDepartment != null && {
      responsibleDepartmentId: String(raw.ResponsibleDepartment),
    }),
    ...(raw.ResponsibleDepartmentName != null && {
      responsibleDepartmentName: raw.ResponsibleDepartmentName,
    }),
    ...(raw.ResponsibleDepartmentAbbreviation != null && {
      responsibleDepartmentAbbreviation: raw.ResponsibleDepartmentAbbreviation,
    }),
    ...(raw.FederalCouncilProposal != null && {
      federalCouncilProposalId: String(raw.FederalCouncilProposal),
    }),
    ...(raw.FederalCouncilProposalDate != null && {
      federalCouncilProposalDate: raw.FederalCouncilProposalDate,
    }),
    ...(raw.FirstCouncil1 != null && { firstCouncil1Id: String(raw.FirstCouncil1) }),
    ...(raw.FirstCouncil1Name != null && { firstCouncil1Name: raw.FirstCouncil1Name }),
    ...(raw.FirstCouncil2 != null && { firstCouncil2Id: String(raw.FirstCouncil2) }),
    ...(raw.FirstCouncil2Name != null && { firstCouncil2Name: raw.FirstCouncil2Name }),
    ...(raw.Tags != null && { tags: raw.Tags }),
    ...(raw.TagNames != null && { tagNames: raw.TagNames }),
    ...(raw.Category != null && { category: raw.Category }),
    availableTextFields: BusinessTextFieldSchema.options.map((name) => {
      const value = raw[BUSINESS_TEXT_FIELDS[name]];
      return {
        name,
        ...(value != null && { sizeBytes: new TextEncoder().encode(value).byteLength }),
      };
    }),
  };
}

/** Read one independently paged procedural collection using the same shared client and deadline. */
export function getBusinessSection(
  businessId: string,
  section: BusinessRelationshipSection,
  language: Language,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
) {
  return listBusinessSection(client, businessId, section, language, paging, workflow);
}
