/**
 * @fileoverview Search current and former parliamentary affiliation records and committee rosters.
 * @module mcp-server/tools/definitions/search-members.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  MemberCouncilInputSchema,
  MemberSearchFiltersSchema,
  MemberSearchRowSchema,
  MembershipSchema,
} from '@/services/parliament/member-model.js';
import { MemberService } from '@/services/parliament/member-service.js';
import {
  Int32IdSchema,
  LanguageSchema,
  optionalString,
} from '@/services/parliament/normalization.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  clampNotice,
  fieldTrailer,
  fitCollectionPage,
  formatParliamentResult,
  isPastEnd,
  joinNotices,
} from '../parliament-format.js';

const service = new MemberService();

const EnrichmentSchema = z.object({
  effectiveFilters: MemberSearchFiltersSchema.describe(
    'Normalized search filters and resolved defaults.',
  ),
  returnedCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Number of complete MemberCouncil records delivered; committee memberships on committee searches.',
    ),
  effectiveLimit: z
    .number()
    .int()
    .positive()
    .max(100)
    .describe('Effective requested page size after clamping.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Exact whole-query MemberCouncil record count when supplied upstream; committee memberships on committee searches.',
    ),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Starting offset plus delivered records; absent when exhausted.'),
  hasMore: z.boolean().describe('Whether further matching affiliation records remain.'),
  notice: z
    .string()
    .optional()
    .describe('Combined clamping, byte fitting, empty-result, empty-roster, or past-end guidance.'),
});

const committeeNotFoundGuidance =
  'No committee matched this committeeId. Use chparl_list_reference with topic committees to discover a valid committeeId.';

/** Find affiliation records with stable paging and unchanged source names and labels. */
export const searchMembersTool = tool('chparl_search_members', {
  description:
    'Find current or former Swiss Parliament affiliation records by name, council, canton, party, or parliamentary group, or list a committee’s current members with committeeId. membership defaults to current; former selects inactive records and all omits the activity filter. committeeId returns one row per published membership with its committee function; rosters are current composition only, so membership former or all cannot be combined with it. query matches a substring of a published first, last, or official name. Use each record’s personNumber with chparl_get_member for identity, full council terms, committees, and declared interests. Follow nextOffset with the same filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: optionalString(z.string()).describe(
      'Optional name substring, trimmed without changing internal punctuation or diacritics.',
    ),
    membership: MembershipSchema.default('current').describe(
      'current (default), former, or all MemberCouncil records. With committeeId, only current is accepted.',
    ),
    committeeId: optionalString(Int32IdSchema).describe(
      'Optional CommitteeNumber from chparl_list_reference topic committees. Lists that committee’s current members, one row per membership; a sub-committee has its own number and roster. Other filters narrow the roster.',
    ),
    council: MemberCouncilInputSchema.describe(
      'N or S; exact German, French, and Italian council names are accepted. Resolve codes with chparl_list_reference topic councils.',
    ),
    cantonId: optionalString(Int32IdSchema).describe(
      'Optional Canton identifier from chparl_list_reference topic cantons.',
    ),
    partyId: optionalString(Int32IdSchema).describe(
      'Optional Party identifier from chparl_list_reference topic parties.',
    ),
    groupId: optionalString(Int32IdSchema).describe(
      'Optional ParlGroupNumber from chparl_list_reference topic groups.',
    ),
    language: LanguageSchema.describe(
      'Metadata language: de (default), fr, or it; uppercase is accepted.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(20)
      .describe(
        'Requested page size, default 20, effective maximum 100 with notice. Whole records may be fitted to the response byte budget.',
      ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0)
      .describe(
        'Starting MemberCouncil record offset, or committee membership offset with committeeId; continue with returned nextOffset.',
      ),
  }),
  output: z.object({
    committeeFound: z
      .boolean()
      .optional()
      .describe(
        'Committee searches only: whether the committee exists, independently of published members.',
      ),
    guidance: z
      .string()
      .optional()
      .describe('How to discover a valid committeeId when the committee was not found.'),
    members: z
      .array(MemberSearchRowSchema)
      .describe(
        'Complete MemberCouncil affiliation records delivered on this page; one per committee membership on committee searches.',
      ),
    provenance: ProvenanceSchema,
  }),
  enrichment: EnrichmentSchema.shape,
  enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape),
  errors: [
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'committeeId is combined with membership former or all.',
      recovery:
        'Committee rosters list current members only: omit membership or set it to current with committeeId, or use chparl_get_member section committees for one member’s committee rows.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'Parliament returned HTTP 429.',
      recovery:
        'Wait for the supplied retry delay, then retry this tool; use chparl_list_reference with topic coverage to review source limits.',
    },
    {
      reason: 'request_too_long',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The text filters make the URL-encoded Parliament request longer than its 2048-byte query-string limit.',
      recovery:
        'Shorten query and retry this tool; the request carries query three times, once each for first, last, and official name.',
    },
  ],
  handler(input, ctx) {
    if (input.committeeId !== undefined && input.membership !== 'current')
      throw ctx.fail('incompatible_fields');
    const filters = MemberSearchFiltersSchema.parse({
      ...input,
      limit: Math.min(input.limit, 100),
    });
    const narrowed = [
      filters.query,
      filters.council,
      filters.cantonId,
      filters.partyId,
      filters.groupId,
    ].some((value) => value !== undefined);
    return withWorkflow(ctx, async (workflow) => {
      const page = await service.searchMembers(filters, workflow);
      const prepared = fitCollectionPage(page.items, (members, cut, oversized) => {
        const hasMore = cut || page.hasMore;
        const notice = joinNotices(
          clampNotice(input.limit, filters.limit),
          cut &&
            'Response byte fitting returned fewer whole member records. Continue with nextOffset; no record fields were shortened.',
          members.length === 0 &&
            page.committeeFound !== false &&
            (isPastEnd(page.totalCount, filters.offset)
              ? 'The requested offset is past the last matching member record. Call chparl_search_members with the same filters and offset zero.'
              : filters.committeeId === undefined
                ? 'No member records matched these filters. Try chparl_search_members with membership all, or use chparl_list_reference with topic councils, cantons, parties, or groups.'
                : narrowed
                  ? 'No current members of this committee matched these filters. Omit query, council, cantonId, partyId, and groupId to list the whole roster, or use chparl_list_reference with topic councils, cantons, parties, or groups.'
                  : 'This committee exists but has no published members; MemberCommittee lists the current composition only. Use chparl_list_reference with topic committees to choose another committee or sub-committee.'),
          oversized &&
            `One indivisible member record or its provenance exceeds 24000 bytes. Retrieve it with chparl_search_members using effectiveFilters unchanged except offset=${filters.offset} and limit=1. The record is returned whole.`,
        );
        return {
          output: {
            ...(page.committeeFound !== undefined && { committeeFound: page.committeeFound }),
            ...(page.committeeFound === false && { guidance: committeeNotFoundGuidance }),
            members,
            provenance: provenance(workflow.sources),
          },
          enrichment: {
            effectiveFilters: filters,
            returnedCount: members.length,
            effectiveLimit: filters.limit,
            ...(page.totalCount !== undefined && { totalCount: page.totalCount }),
            ...(hasMore && { nextOffset: filters.offset + members.length }),
            hasMore,
            ...(notice !== undefined && { notice }),
          },
        };
      });
      ctx.enrich(prepared.enrichment);
      return prepared.output;
    });
  },
  format: formatParliamentResult,
});
