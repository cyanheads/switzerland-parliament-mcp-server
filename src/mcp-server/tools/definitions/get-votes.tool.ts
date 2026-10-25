/**
 * @fileoverview Discover Nationalrat roll calls, page member decisions, and read complete group totals.
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
  completeResultBytes,
  fitCollectionPage,
  formatParliamentResult,
  renderField,
} from '../parliament-format.js';

const ModeSchema = z.enum(['votes', 'members', 'groups']);
const FiltersSchema = z
  .object({
    mode: ModeSchema.describe('Selected vote workflow.'),
    language: z.enum(['de', 'fr', 'it']).describe('Selected metadata language.'),
    businessId: z.string().optional().describe('Business identifier supplied for vote discovery.'),
    voteId: z.string().optional().describe('Exact selected roll-call identifier.'),
    personNumber: z.string().optional().describe('Exact member filter, when supplied.'),
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
      'Whether the business or selected vote exists; child collections may still be empty.',
    ),
  guidance: z
    .string()
    .optional()
    .describe('Identifier discovery guidance when the parent was not found.'),
  mode: ModeSchema.describe('Vote workflow returned.'),
  coverage: VoteCoverageSchema,
  business: BusinessSummarySchema.optional().describe('Resolved business identity in votes mode.'),
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

/** Read published Nationalrat vote metadata, original member decisions, or complete group counts. */
export const getVotesTool = tool('chparl_get_votes', {
  description:
    'Find Nationalrat roll calls with mode votes and businessId, then select a returned voteId with mode members for a paged roll call or mode groups for complete decision counts by parliamentary group. Member roll calls start in the 2003 winter session and exclude Ständerat member votes; an empty result does not prove no vote occurred. Member counts cover only the delivered page; groups mode reads all published member rows before reporting totals. DecisionText remains unchanged; documented code meanings include 1 yes, 2 no, 3 abstention, 6 excused under Art. 57 para. 4, and 7 president does not vote. Unknown codes and missing decisions are retained. Follow nextOffset with the same mode and filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    mode: ModeSchema.default('votes').describe(
      'Workflow: votes (default), members, or complete groups.',
    ),
    businessId: optionalString(BusinessIdentifierSchema).describe(
      'Votes only: canonical eight-digit business ID or published short number, such as 99.1234.',
    ),
    voteId: optionalString(Int32IdSchema).describe(
      'Members or groups only: positive Int32 Vote.ID discovered through votes mode.',
    ),
    personNumber: optionalString(Int32IdSchema).describe(
      'Members only: exact PersonNumber, not Person.ID or current group affiliation.',
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
  enrichmentTrailer: {
    effectiveFilters: { render: (value) => renderField('effectiveFilters', value) },
    returnedCount: { render: (value) => renderField('returnedCount', value) },
    effectiveLimit: { render: (value) => renderField('effectiveLimit', value) },
    totalCount: { render: (value) => renderField('totalCount', value) },
    nextOffset: { render: (value) => renderField('nextOffset', value) },
    hasMore: { render: (value) => renderField('hasMore', value) },
    notice: { render: (value) => renderField('notice', value) },
  },
  errors: [
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A required mode identifier is missing, identifiers conflict, or a filter or paging field belongs to another mode.',
      recovery:
        'Use chparl_get_votes mode votes with businessId, or mode members or groups with voteId.',
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
      if (input.voteId !== undefined || input.personNumber !== undefined)
        throw ctx.fail('incompatible_fields');
    } else if (
      input.businessId !== undefined ||
      (input.mode === 'groups' &&
        (input.personNumber !== undefined ||
          input.limit !== undefined ||
          input.offset !== undefined))
    )
      throw ctx.fail('incompatible_fields');

    const maxLimit = input.mode === 'votes' ? 50 : 100;
    const requestedLimit = input.limit ?? (input.mode === 'votes' ? 10 : 50);
    const filters = FiltersSchema.parse({
      mode: input.mode,
      language: input.language,
      ...(input.businessId !== undefined && { businessId: input.businessId }),
      ...(input.voteId !== undefined && { voteId: input.voteId }),
      ...(input.personNumber !== undefined && { personNumber: input.personNumber }),
      ...(input.mode !== 'groups' && {
        limit: Math.min(requestedLimit, maxLimit),
        offset: input.offset ?? 0,
      }),
    });
    const clampedNotice =
      requestedLimit > maxLimit
        ? `Requested limit ${requestedLimit} was clamped to ${maxLimit}.`
        : undefined;

    return withWorkflow(ctx, async (workflow): Promise<Output> => {
      const base = { mode: input.mode, coverage };
      if (input.mode === 'votes') {
        if (input.businessId === undefined) throw ctx.fail('incompatible_fields');
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
        const business = normalizeBusiness(raw, input.language);
        const paging = { limit: Math.min(requestedLimit, maxLimit), offset: input.offset ?? 0 };
        const result = await listVotes(business.businessId, input.language, paging, workflow);
        const prepared = fitCollectionPage(result.items, (votes, cut, oversized) => {
          const notices = clampedNotice === undefined ? [] : [clampedNotice];
          if (cut)
            notices.push(
              'Response byte fitting returned fewer whole votes. Continue with nextOffset; no fields were shortened.',
            );
          if (votes.length === 0) {
            if (
              result.totalCount !== undefined &&
              result.totalCount > 0 &&
              paging.offset >= result.totalCount
            )
              notices.push(
                'The requested offset is past the last matching vote. Call chparl_get_votes with mode votes, this businessId, and offset zero.',
              );
            else
              notices.push(
                'No Nationalrat member roll calls were found for this business. Coverage starts in the 2003 winter session and does not include Ständerat member votes; use chparl_search_transcripts for published debate and aggregate vote announcements.',
              );
          }
          if (oversized)
            notices.push(
              `One indivisible vote or its provenance exceeds 24000 bytes. Retrieve this exact page with chparl_get_votes mode=votes, businessId=${business.businessId}, language=${input.language}, offset=${paging.offset}, limit=1. The vote is returned whole.`,
            );
          const hasMore = cut || result.hasMore;
          return {
            output: {
              ...base,
              found: true,
              business,
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
              ...(notices.length > 0 && { notice: notices.join(' ') }),
            },
          };
        });
        ctx.enrich(prepared.enrichment);
        return prepared.output;
      }

      if (input.voteId === undefined) throw ctx.fail('incompatible_fields');
      const vote = await getVote(input.voteId, input.language, workflow);
      if (!vote) {
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
        const result = await getGroupDecisions(input.voteId, input.language, workflow);
        const output: Output = {
          ...base,
          found: true,
          vote,
          groups: result.items,
          ...(result.decisionCounts !== undefined && { decisionCounts: result.decisionCounts }),
          provenance: provenance(workflow.sources),
        };
        const enrichment: z.infer<typeof EnrichmentSchema> = {
          effectiveFilters: filters,
          returnedCount: result.items.length,
          hasMore: false,
          ...(result.items.length === 0 && {
            notice:
              'Member data is unavailable for this published vote. No complete zero-vote totals can be inferred; use chparl_search_transcripts for published vote announcements.',
          }),
        };
        if (completeResultBytes(output, enrichment) >= 24_000)
          enrichment.notice = `${enrichment.notice === undefined ? '' : `${enrichment.notice} `}The complete indivisible group aggregate or its provenance exceeds 24000 bytes. This is the exact chparl_get_votes mode=groups, voteId=${input.voteId}, language=${input.language} result; all groups and counts are retained.`;
        ctx.enrich(enrichment);
        return output;
      }

      const paging = { limit: Math.min(requestedLimit, maxLimit), offset: input.offset ?? 0 };
      const result = await listMemberDecisions(
        input.voteId,
        input.language,
        paging,
        workflow,
        input.personNumber,
      );
      const prepared = fitCollectionPage(result.items, (members, cut, oversized) => {
        const notices = clampedNotice === undefined ? [] : [clampedNotice];
        if (cut)
          notices.push(
            'Response byte fitting returned fewer whole member decisions. Continue with nextOffset; page counts cover only the delivered rows and no fields were shortened.',
          );
        if (members.length === 0) {
          if (
            result.totalCount !== undefined &&
            result.totalCount > 0 &&
            paging.offset >= result.totalCount
          )
            notices.push(
              'The requested offset is past the last matching member decision. Call chparl_get_votes with mode members, this voteId, the same filters, and offset zero.',
            );
          else if (input.personNumber !== undefined)
            notices.push(
              'No member decisions matched this personNumber. Use chparl_search_members to discover a PersonNumber, or call chparl_get_votes mode members with this voteId without personNumber.',
            );
          else
            notices.push(
              'Member data is unavailable for this published vote. No complete zero-vote totals can be inferred; use chparl_search_transcripts for published vote announcements.',
            );
        }
        if (oversized)
          notices.push(
            `One indivisible member decision or its provenance exceeds 24000 bytes. Retrieve this exact page with chparl_get_votes mode=members, voteId=${input.voteId}, language=${input.language}, offset=${paging.offset}, limit=1${input.personNumber === undefined ? '' : `, personNumber=${input.personNumber}`}. The decision is returned whole.`,
          );
        const hasMore = cut || result.hasMore;
        return {
          output: {
            ...base,
            found: true,
            vote,
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
            ...(notices.length > 0 && { notice: notices.join(' ') }),
          },
        };
      });
      ctx.enrich(prepared.enrichment);
      return prepared.output;
    });
  },
  format: formatParliamentResult,
});
