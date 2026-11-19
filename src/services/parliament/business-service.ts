/**
 * @fileoverview Stateless business resolution, keyset discovery, and procedural section workflows.
 * @module services/parliament/business-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { readBusinessCursor } from './business-cursor.js';
import {
  BUSINESS_DETAIL_FIELDS,
  BUSINESS_ROLE_CODES,
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
import {
  type Language,
  odataDay,
  odataInt32,
  odataString,
  RawId,
  RawLanguage,
  utf8ByteLength,
} from './normalization.js';
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
  if (filters.tagId !== undefined) {
    // Tags is a pipe-delimited ID list; match whole elements so 12 never matches 1216 or 28|1216.
    const tags = `${prefix}Tags`;
    const id = filters.tagId;
    clauses.push(
      `(${tags} eq ${odataString(id)} or startswith(${tags},${odataString(`${id}|`)}) or endswith(${tags},${odataString(`|${id}`)}) or substringof(${odataString(`|${id}|`)},${tags}))`,
    );
  }
  return clauses;
}

/**
 * Route business discovery: committee and member searches read BusinessRole rows; every other
 * search reads Business directly. Cursors are checked against the filters before any request.
 */
export function searchBusiness(
  filters: BusinessSearchFilters,
  workflow: WorkflowContext,
): Promise<ODataPage<BusinessSummary>> {
  const after = readBusinessCursor(filters);
  if (filters.committeeId !== undefined)
    return searchRoles(
      filters,
      { label: 'committee', owner: [`CommitteeNumber eq ${odataInt32(filters.committeeId)}`] },
      after,
      workflow,
    );
  if (filters.personNumber !== undefined)
    return searchRoles(
      filters,
      {
        label: 'member',
        owner: [
          `MemberCouncilNumber eq ${odataInt32(filters.personNumber)}`,
          ...(filters.role !== undefined ? [`Role eq ${BUSINESS_ROLE_CODES[filters.role]}`] : []),
        ],
        counted: filters.role !== undefined,
      },
      after,
      workflow,
    );
  return searchDirect(filters, after, workflow);
}

/**
 * Direct author discovery uses lookahead; other direct searches retain exact source totals. A tag
 * continuation reports none: recounting would repeat the costly Tags scan the page already paid.
 */
async function searchDirect(
  filters: BusinessSearchFilters,
  after: string | undefined,
  workflow: WorkflowContext,
): Promise<ODataPage<BusinessSummary>> {
  const authorSearch = filters.author !== undefined;
  const predicates = businessPredicates(filters);
  const base: ODataQuery = {
    entity: 'Business',
    language: filters.language,
    select: BUSINESS_SUMMARY_FIELDS,
    orderBy: [{ field: 'ID', direction: 'desc' }],
    ...(authorSearch && { includeCount: false }),
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
    { limit: filters.limit + (authorSearch ? 1 : 0), offset: 0 },
    workflow,
  );
  if (authorSearch) {
    return {
      items: page.items
        .slice(0, filters.limit)
        .map((row) => normalizeBusiness(row, filters.language)),
      hasMore: page.items.length > filters.limit,
    };
  }
  const total =
    after === undefined
      ? page.totalCount
      : filters.tagId !== undefined
        ? undefined
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

/** Whose BusinessRole rows a role search reads, and whether they are one row per business. */
interface RoleOwner {
  /** Count the rows: only a single member role is known to hold one row per business. */
  readonly counted?: boolean;
  readonly label: 'committee' | 'member';
  readonly owner: readonly string[];
}

/**
 * Page role rows by business number, collapse each business's rows, hydrate summaries in batches,
 * and probe one older row for continuation. Uncounted routes never request a count they discard;
 * a counted route takes its first page's inline count and recounts the original filters later.
 */
async function searchRoles(
  filters: BusinessSearchFilters,
  { counted = false, label, owner }: RoleOwner,
  after: string | undefined,
  workflow: WorkflowContext,
): Promise<ODataPage<BusinessSummary>> {
  const predicates = [
    ...owner,
    `Businesses/Language eq ${odataString(filters.language.toUpperCase())}`,
    ...businessPredicates(filters, 'Businesses/'),
  ];
  const roleSchema = z.object({ ID: z.guid(), Language: RawLanguage, BusinessNumber: RawId });
  const base: ODataQuery = {
    entity: 'BusinessRole',
    language: filters.language,
    select: ['ID', 'Language', 'BusinessNumber'],
    orderBy: [
      { field: 'BusinessNumber', direction: 'desc' },
      { field: 'ID', direction: 'asc' },
    ],
    filter: predicates.join(' and '),
    includeCount: false,
  };
  const page = await client.collection(
    {
      ...base,
      includeCount: counted && after === undefined,
      ...(after !== undefined && {
        filter: [...predicates, `BusinessNumber lt ${odataInt32(after)}`].join(' and '),
      }),
    },
    roleSchema,
    { limit: filters.limit, offset: 0 },
    workflow,
  );
  const totalCount = !counted
    ? undefined
    : after === undefined
      ? page.totalCount
      : (
          await client.collection(
            { ...base, includeCount: true },
            roleSchema,
            { limit: 1, offset: 0 },
            workflow,
          )
        ).totalCount;
  const total = totalCount !== undefined ? { totalCount } : {};
  const businessIds = new Set<number>();
  for (const row of page.items) {
    if (row.Language !== filters.language.toUpperCase())
      throw serializationError(
        `Parliament returned a ${label} role in a different metadata language.`,
      );
    businessIds.add(row.BusinessNumber);
  }
  const ids = [...businessIds].sort((a, b) => b - a);
  const businesses = new Map<number, BusinessSummary>();
  // Fifty full-summary IDs fit the source's query-string limit; 100 IDs return HTTP 404.
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    const expected = new Set(batch);
    const summaries = await client.collection(
      {
        entity: 'Business',
        language: filters.language,
        select: BUSINESS_SUMMARY_FIELDS,
        orderBy: [{ field: 'ID', direction: 'desc' }],
        filter: batch.map((id) => `ID eq ${odataInt32(String(id))}`).join(' or '),
      },
      RawBusinessSchema,
      { limit: batch.length, offset: 0 },
      workflow,
    );
    for (const row of summaries.items) {
      if (!expected.has(row.ID) || businesses.has(row.ID))
        throw serializationError(
          `Parliament returned an unexpected or duplicate ${label} business summary.`,
        );
      businesses.set(row.ID, normalizeBusiness(row, filters.language));
    }
    if (summaries.items.length !== batch.length)
      throw serializationError(
        `Parliament omitted a requested ${label} business summary. Retry the search.`,
      );
  }
  const items = [...businesses.values()].sort(
    (a, b) => Number(b.businessId) - Number(a.businessId),
  );
  const smallest = ids.at(-1);
  if (smallest === undefined) return { items, hasMore: false, ...total };
  const older = await client.collection(
    {
      ...base,
      filter: [...predicates, `BusinessNumber lt ${odataInt32(String(smallest))}`].join(' and '),
    },
    roleSchema,
    { limit: 1, offset: 0 },
    workflow,
  );
  for (const row of older.items) {
    if (row.Language !== filters.language.toUpperCase() || row.BusinessNumber >= smallest)
      throw serializationError(`Parliament returned a mismatched ${label} sentinel.`);
  }
  return { items, hasMore: older.items.length > 0, ...total };
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
        ...(value != null && { sizeBytes: utf8ByteLength(value) }),
      };
    }),
  };
}
