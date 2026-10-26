/**
 * @fileoverview Discover Nationalrat roll calls, page member decisions or history, and read complete group totals.
 * @module mcp-server/tools/definitions/get-votes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  BusinessIdentifierSchema,
  BusinessSummarySchema,
  normalizeBusiness,
} from '@/services/parliament/business-model.js';
import { resolveBusiness } from '@/services/parliament/business-service.js';
import {
  Int32IdSchema,
  LanguageSchema,
  MetadataLanguageSchema,
  optionalString,
} from '@/services/parliament/normalization.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import {
  countDecisions,
  DecisionCountsSchema,
  GroupDecisionSchema,
  MemberDecisionSchema,
  VoteCoverageSchema,
  VoteSummarySchema,
} from '@/services/parliament/vote-model.js';
import {
  getGroupDecisions,
  getVote,
  listMemberDecisions,
  listVotes,
} from '@/services/parliament/vote-service.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  COLLECTION_RESULT_LIMIT_BYTES,
  clampNotice,
  completeResultBytes,
  fieldTrailer,
  fitCollectionPage,
  formatParliamentResult,
  isPastEnd,
  joinNotices,
} from '../parliament-format.js';

const ModeSchema = z.enum(['votes', 'members', 'groups']);
const FiltersSchema = z
  .object({
    mode: ModeSchema.describe('Selected vote workflow.'),
    language: MetadataLanguageSchema.describe('Selected metadata language.'),
    businessId: z
      .string()
      .optional()
      .describe('Business identifier supplied for vote discovery or member history.'),
    voteId: z.string().optional().describe('Exact selected roll-call identifier.'),
    personNumber: z.string().optional().describe('Exact member filter, when supplied.'),
    sessionId: z
      .string()
      .optional()
      .describe('Exact session filter for vote discovery or member history.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Effective page size for votes or members.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Starting row offset for a paged mode.'),
  })
  .describe('Normalized mode, identifiers, metadata language, and applicable paging defaults.');

const OutputSchema = z.object({
  found: z
    .boolean()
    .describe(
      'Whether a supplied business or selected vote exists; unkeyed history/session searches succeed with true even when empty.',
    ),
  guidance: z
    .string()
    .optional()
    .describe('Identifier discovery guidance when the parent was not found.'),
  mode: ModeSchema.describe('Vote workflow returned.'),
  coverage: VoteCoverageSchema,
  business: BusinessSummarySchema.optional().describe(
    'Resolved business identity when supplied for vote discovery or member history.',
  ),
  vote: VoteSummarySchema.optional().describe(
    'Resolved roll-call metadata in members or groups mode.',
  ),
  votes: z
    .array(VoteSummarySchema)
    .optional()
    .describe('Whole metadata records delivered in votes mode.'),
  members: z
    .array(MemberDecisionSchema)
    .optional()
    .describe('Whole member decisions delivered in members mode.'),
  decisionCounts: DecisionCountsSchema.optional().describe(
    'Page counts in members mode or complete nonempty vote counts in groups mode.',
  ),
  groups: z
    .array(GroupDecisionSchema)
    .optional()
    .describe('Complete group aggregates; empty when member data is unavailable.'),
  provenance: ProvenanceSchema,
});
type Output = z.infer<typeof OutputSchema>;

const EnrichmentSchema = z.object({
  effectiveFilters: FiltersSchema,
  returnedCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Number of delivered vote, member, or group records.'),
  effectiveLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Effective page size after mode-specific clamping.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact whole-query count of votes or filtered member rows, when supplied.'),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Original offset plus delivered rows; absent when exhausted.'),
  hasMore: z
    .boolean()
    .optional()
    .describe('Whether more rows remain after the delivered page; false for complete groups.'),
  notice: z
    .string()
    .optional()
    .describe('Combined clamping, whole-item fitting, empty-result, or coverage guidance.'),
});

const coverage = { council: 'N' as const, memberRollCallsSince: '2003-winter-session' as const };
const MEMBER_DATA_UNAVAILABLE =
  'Member data is unavailable for this published vote. No complete zero-vote totals can be inferred; use chparl_search_transcripts for published vote announcements.';

/** Read published Nationalrat vote metadata, original member decisions, or complete group counts. */
export const getVotesTool = tool('chparl_get_votes', {
  description:
    'Find Nationalrat roll calls with mode votes and businessId, sessionId, or both. Use mode members with voteId for one paged roll call, or personNumber without voteId for member history optionally filtered by businessId and sessionId. Use mode groups with voteId for complete decision counts by parliamentary group. Member roll calls start in the 2003 winter session and exclude Ständerat member votes; an empty result does not prove no vote occurred. Member counts cover only delivered rows; groups mode reads all published member rows before reporting totals. Verbatim decisionTexts accompany code buckets when published. Code meanings include 1 yes, 2 no, 3 abstention, 4 present, 5 did not participate, 6 excused under Art. 57 para. 4, 7 president does not vote, and 8 resigned. Unknown codes and missing decisions are retained. Follow nextOffset with the same mode and filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    mode: ModeSchema.default('votes').describe(
      'Workflow: votes (default), members, or complete groups.',
    ),
    businessId: optionalString(BusinessIdentifierSchema).describe(
      'Votes or member history only: canonical eight-digit businessId from chparl_search_business, or a published short number such as 99.1234.',
    ),
    voteId: optionalString(Int32IdSchema).describe(
      'Members or groups only: positive Int32 Vote.ID discovered through votes mode; omit for personNumber history. Cannot combine with businessId or sessionId.',
    ),
    personNumber: optionalString(Int32IdSchema).describe(
      'Members only: exact PersonNumber from chparl_search_members, distinct from Person.ID or current group affiliation.',
    ),
    sessionId: optionalString(Int32IdSchema).describe(
      'Votes or member history only: positive Int32 Session.ID from chparl_list_reference topic sessions; combine with businessId to narrow discovery.',
    ),
    language: LanguageSchema.describe(
      'Metadata language: de (default), fr, or it; decision text remains as published.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe(
        'Paged modes only: votes default 10/max 50, members default 50/max 100; higher requests are clamped with notice.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        'Paged modes only: starting row offset, default zero; continue using returned nextOffset.',
      ),
  }),
  output: OutputSchema,
  enrichment: EnrichmentSchema.shape,
  enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape),
  errors: [
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A required mode identifier is missing, identifiers conflict, or a filter or paging field belongs to another mode.',
      recovery:
        'Use mode votes with businessId, sessionId, or both and no voteId or personNumber. Use mode members with voteId, or personNumber without voteId for history optionally narrowed by businessId/sessionId. Use groups with voteId only; omit paging in groups.',
    },
    {
      reason: 'ambiguous_business_number',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A short business number resolves to multiple canonical businesses.',
      recovery: 'Use chparl_search_business to identify the intended canonical businessId.',
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
  ],
  handler(input, ctx) {
    if (input.mode === 'votes') {
      if (
        input.voteId !== undefined ||
        input.personNumber !== undefined ||
        (input.businessId === undefined && input.sessionId === undefined)
      )
        throw ctx.fail('incompatible_fields');
    } else {
      if (
        (input.voteId === undefined &&
          (input.mode === 'groups' || input.personNumber === undefined)) ||
        (input.voteId !== undefined &&
          (input.businessId !== undefined || input.sessionId !== undefined)) ||
        (input.mode === 'groups' &&
          (input.businessId !== undefined ||
            input.sessionId !== undefined ||
            input.personNumber !== undefined ||
            input.limit !== undefined ||
            input.offset !== undefined))
      )
        throw ctx.fail('incompatible_fields');
    }

    const requestedLimit = input.limit ?? (input.mode === 'votes' ? 10 : 50);
    const paging = {
      limit: Math.min(requestedLimit, input.mode === 'votes' ? 50 : 100),
      offset: input.offset ?? 0,
    };
    const filters = FiltersSchema.parse({
      mode: input.mode,
      language: input.language,
      ...(input.businessId !== undefined && { businessId: input.businessId }),
      ...(input.voteId !== undefined && { voteId: input.voteId }),
      ...(input.personNumber !== undefined && { personNumber: input.personNumber }),
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      ...(input.mode !== 'groups' && paging),
    });

    return withWorkflow(ctx, async (workflow): Promise<Output> => {
      const base = { mode: input.mode, coverage };
      let business: z.infer<typeof BusinessSummarySchema> | undefined;
      if (input.businessId !== undefined) {
        const raw = await resolveBusiness(input.businessId, input.language, workflow);
        if (!raw) {
          ctx.enrich({ effectiveFilters: filters });
          return {
            ...base,
            found: false,
            guidance:
              'No business matched this identifier. Use chparl_search_business to discover a valid businessId.',
            provenance: provenance(workflow.sources),
          };
        }
        business = normalizeBusiness(raw, input.language);
      }
      if (input.mode === 'votes') {
        const result = await listVotes(
          business?.businessId,
          input.language,
          paging,
          workflow,
          input.sessionId,
        );
        const prepared = fitCollectionPage(result.items, (votes, cut, oversized) => {
          const hasMore = cut || result.hasMore;
          const notice = joinNotices(
            clampNotice(requestedLimit, paging.limit),
            cut &&
              'Response byte fitting returned fewer whole votes. Continue with nextOffset; no fields were shortened.',
            votes.length === 0 &&
              (isPastEnd(result.totalCount, paging.offset)
                ? 'The requested offset is past the last matching vote. Call chparl_get_votes with mode votes, the same filters, and offset zero.'
                : 'No Nationalrat member roll calls matched these filters. Coverage starts in the 2003 winter session and does not include Ständerat member votes; use chparl_search_transcripts for published debate and aggregate vote announcements.'),
            oversized &&
              `One indivisible vote or its provenance exceeds 24000 bytes. Retrieve this exact page with chparl_get_votes mode=votes${input.businessId === undefined ? '' : `, businessId=${input.businessId}`}${input.sessionId === undefined ? '' : `, sessionId=${input.sessionId}`}, language=${input.language}, offset=${paging.offset}, limit=1. The vote is returned whole.`,
          );
          return {
            output: {
              ...base,
              found: true,
              ...(business !== undefined && { business }),
              votes,
              provenance: provenance(workflow.sources),
            },
            enrichment: {
              effectiveFilters: filters,
              returnedCount: votes.length,
              effectiveLimit: paging.limit,
              ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
              hasMore,
              ...(hasMore && { nextOffset: paging.offset + votes.length }),
              ...(notice !== undefined && { notice }),
            },
          };
        });
        ctx.enrich(prepared.enrichment);
        return prepared.output;
      }

      const vote =
        input.voteId === undefined
          ? undefined
          : await getVote(input.voteId, input.language, workflow);
      if (input.voteId !== undefined && !vote) {
        ctx.enrich({ effectiveFilters: filters });
        return {
          ...base,
          found: false,
          guidance:
            'No roll call matched this voteId. Use chparl_get_votes with mode votes and a businessId to discover valid vote IDs.',
          provenance: provenance(workflow.sources),
        };
      }
      if (input.mode === 'groups') {
        if (input.voteId === undefined) throw ctx.fail('incompatible_fields');
        const result = await getGroupDecisions(input.voteId, input.language, workflow);
        const output: Output = {
          ...base,
          found: true,
          vote,
          groups: result.items,
          ...(result.decisionCounts !== undefined && { decisionCounts: result.decisionCounts }),
          provenance: provenance(workflow.sources),
        };
        const unavailable = result.items.length === 0 && MEMBER_DATA_UNAVAILABLE;
        const enrichment = {
          effectiveFilters: filters,
          returnedCount: result.items.length,
          hasMore: false,
        };
        const oversized =
          completeResultBytes(output, {
            ...enrichment,
            ...(unavailable && { notice: unavailable }),
          }) >= COLLECTION_RESULT_LIMIT_BYTES;
        const notice = joinNotices(
          unavailable,
          oversized &&
            `The complete indivisible group aggregate or its provenance exceeds 24000 bytes. This is the exact chparl_get_votes mode=groups, voteId=${input.voteId}, language=${input.language} result; all groups and counts are retained.`,
        );
        ctx.enrich({ ...enrichment, ...(notice !== undefined && { notice }) });
        return output;
      }

      const result = await listMemberDecisions(
        input.voteId,
        input.language,
        paging,
        workflow,
        input.personNumber,
        {
          ...(business !== undefined && { businessId: business.businessId }),
          ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
        },
      );
      const prepared = fitCollectionPage(result.items, (members, cut, oversized) => {
        const hasMore = cut || result.hasMore;
        const notice = joinNotices(
          clampNotice(requestedLimit, paging.limit),
          cut &&
            'Response byte fitting returned fewer whole member decisions. Continue with nextOffset; page counts cover only the delivered rows and no fields were shortened.',
          members.length === 0 &&
            (isPastEnd(result.totalCount, paging.offset)
              ? 'The requested offset is past the last matching member decision. Call chparl_get_votes with mode members, the same filters, and offset zero.'
              : input.personNumber !== undefined
                ? input.voteId === undefined
                  ? 'No member decisions matched these history filters. This does not establish whether the person or session exists. Use chparl_search_members or chparl_list_reference topic sessions to resolve identifiers.'
                  : 'No member decisions matched this personNumber. Use chparl_search_members to discover a PersonNumber, or call chparl_get_votes mode members with this voteId without personNumber.'
                : MEMBER_DATA_UNAVAILABLE),
          oversized &&
            `One indivisible member decision or its provenance exceeds 24000 bytes. Retrieve this exact page with chparl_get_votes mode=members${input.voteId === undefined ? '' : `, voteId=${input.voteId}`}, language=${input.language}, offset=${paging.offset}, limit=1${input.personNumber === undefined ? '' : `, personNumber=${input.personNumber}`}${input.businessId === undefined ? '' : `, businessId=${input.businessId}`}${input.sessionId === undefined ? '' : `, sessionId=${input.sessionId}`}. The decision is returned whole.`,
        );
        return {
          output: {
            ...base,
            found: true,
            ...(vote !== undefined && { vote }),
            ...(business !== undefined && { business }),
            members,
            decisionCounts: { scope: 'page' as const, counts: countDecisions(members) },
            provenance: provenance(workflow.sources),
          },
          enrichment: {
            effectiveFilters: filters,
            returnedCount: members.length,
            effectiveLimit: paging.limit,
            ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
            hasMore,
            ...(hasMore && { nextOffset: paging.offset + members.length }),
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
