/**
 * @fileoverview Search parliamentary affiliation records, committee rosters (current or on a past
 * day), and declared interests.
 * @module mcp-server/tools/definitions/search-members.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AsOfInputSchema,
  MemberCouncilInputSchema,
  type MemberSearchFilters,
  MemberSearchFiltersSchema,
  MemberSearchRowSchema,
  MembershipSchema,
} from '@/services/parliament/member-model.js';
import { type MemberSearchPage, MemberService } from '@/services/parliament/member-service.js';
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
      'Number of rows delivered: MemberCouncil records, committee memberships on committee searches, or declarations on interest searches.',
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
    .describe('Exact whole-query row count when supplied upstream, in the unit of returnedCount.'),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Starting offset plus delivered rows; absent when exhausted.'),
  hasMore: z.boolean().describe('Whether further matching rows remain.'),
  notice: z
    .string()
    .optional()
    .describe('Combined clamping, empty-result, empty-roster, or past-end guidance.'),
});

const committeeNotFoundGuidance =
  'No committee matched this committeeId. Use chparl_list_reference with topic committees to discover a valid committeeId.';

const swissCalendar = new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's calendar day in Switzerland, YYYY-MM-DD. */
function swissToday(): string {
  const parts = new Map(
    swissCalendar.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

/** Guidance for an empty page of an existing search scope, by route. */
function emptyPageNotice(filters: MemberSearchFilters, page: MemberSearchPage): string {
  if (isPastEnd(page.totalCount, filters.offset))
    return 'The requested offset is past the last matching member record. Call chparl_search_members with the same filters and offset zero.';
  if (filters.interest !== undefined)
    return 'No declared interest matched these filters. Interest names are declared once and never translated: search the name as declared in another language, use membership all to include former members, or omit the other filters. An empty result does not establish that no member has a tie to the organisation.';
  if (filters.committeeId === undefined)
    return 'No member records matched these filters. Try chparl_search_members with membership all, or use chparl_list_reference with topic councils, cantons, parties, or groups.';
  const narrowed = [
    filters.query,
    filters.council,
    filters.cantonId,
    filters.partyId,
    filters.groupId,
  ].some((value) => value !== undefined);
  if (filters.asOf !== undefined)
    return narrowed
      ? `No members of this committee on ${filters.asOf} matched these filters. Omit query, council, cantonId, partyId, and groupId to list that day’s whole roster, or use chparl_list_reference with topic councils, cantons, parties, or groups.`
      : `No membership of this committee is published for ${filters.asOf}. Published committee history starts per committee, 1995-12-04 for standing committees. Try a later asOf, omit asOf for the current roster, or use chparl_list_reference with topic committees to choose another committee.`;
  return narrowed
    ? 'No current members of this committee matched these filters. Omit query, council, cantonId, partyId, and groupId to list the whole roster, or use chparl_list_reference with topic councils, cantons, parties, or groups.'
    : 'This committee exists but has no published members; MemberCommittee lists the current composition only. Pass asOf with a past day to read its composition then, or use chparl_list_reference with topic committees to choose another committee or sub-committee.';
}

/** Find affiliation records with stable paging and unchanged source names and labels. */
export const searchMembersTool = tool('chparl_search_members', {
  description:
    'Find current or former Swiss Parliament affiliation records by name, council, canton, party, or parliamentary group; list a committee’s members with committeeId, its current composition or with asOf its composition on a past day; or find the members who declare an interest with interest. membership defaults to current; former selects inactive records and all omits the activity filter. committeeId returns one row per published membership with its committee function and takes membership current only; with asOf, rows carry the names, council, canton, party, and group recorded for that membership, plus its committee dates. interest returns one row per matching declaration: the declarant’s member record, filtered by the other inputs, plus the declaration. query matches a substring of a published first, last, or official name. Use each record’s personNumber with chparl_get_member for identity, full council terms, committees, and declared interests. Follow nextOffset with the same filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: optionalString(z.string()).describe(
      'Optional name substring, trimmed without changing internal punctuation or diacritics.',
    ),
    membership: MembershipSchema.default('current').describe(
      'current (default), former, or all MemberCouncil records; with interest, the declarant’s record. Current records include the Federal Council (councilId 99) and the Federal Chancellor (councilId 98) beside the parliamentarians. With committeeId, only current is accepted.',
    ),
    interest: optionalString(z.string()).describe(
      'Optional substring of a declared interest name, such as an organisation. Returns one row per matching declaration: the declarant’s member record plus the declaration. The match ignores case and accents but is otherwise literal, on a name declared once and never translated (Groupe de réflexion Groupe Mutuel, Gruppo di riflessione Groupe Mutuel), so search the name as declared in each language; an empty result does not establish that no member has a tie. A newly sworn-in member’s declarations can be missing until the member record is published. Cannot be combined with committeeId or asOf.',
    ),
    committeeId: optionalString(Int32IdSchema).describe(
      'Optional CommitteeNumber from chparl_list_reference topic committees. Lists that committee’s members, one row per membership: its current roster, or its roster on asOf. A sub-committee has its own number and roster. Other filters narrow the roster.',
    ),
    asOf: optionalString(AsOfInputSchema).describe(
      'Optional day, YYYY-MM-DD, or a date-time as this server returns one (2014-03-03T00:00:00.000), read as its day; requires committeeId. Lists the memberships open on that day in the published committee history, a membership’s last day included, so a person holds two rows on a day their function changed. council, cantonId, partyId, and groupId filter the affiliation recorded for each membership. History starts per committee, 1995-12-04 for standing committees; a day after today in Switzerland is rejected.',
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
      .describe('Requested page size, default 20, effective maximum 100 with notice.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0)
      .describe(
        'Starting row offset: MemberCouncil records, committee memberships with committeeId, or declarations with interest; continue with returned nextOffset.',
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
        'Rows delivered on this page: MemberCouncil affiliation records; one committee membership per row on committee searches, as recorded on that day with asOf; or one declaration per row with interest.',
      ),
    provenance: ProvenanceSchema,
  }),
  enrichment: EnrichmentSchema.shape,
  enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape),
  errors: [
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'committeeId is combined with membership former or all, asOf is supplied without committeeId, or interest is combined with committeeId or asOf.',
      recovery:
        'Committee rosters take membership current only, asOf needs committeeId, and interest searches declarations without committeeId or asOf: omit membership with committeeId, add committeeId to asOf, or run the interest search on its own. Use chparl_get_member section committees for one member’s current committee rows.',
    },
    {
      reason: 'as_of_in_future',
      code: JsonRpcErrorCode.ValidationError,
      when: 'asOf is after today’s date in Switzerland.',
      recovery:
        'Use today or an earlier day as asOf, or omit asOf for the current roster; the source records scheduled departures but no future arrivals.',
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
      when: 'The text filters, query or interest, make the URL-encoded Parliament request longer than its 2048-byte query-string limit.',
      recovery:
        'Shorten query or interest and retry this tool; the request carries query three times, once each for first, last, and official name.',
    },
  ],
  handler(input, ctx) {
    if (
      input.interest !== undefined &&
      (input.committeeId !== undefined || input.asOf !== undefined)
    )
      throw ctx.fail(
        'incompatible_fields',
        'interest cannot be combined with committeeId or asOf; it searches declarations, not a committee roster.',
      );
    if (input.committeeId !== undefined && input.membership !== 'current')
      throw ctx.fail(
        'incompatible_fields',
        'Committee rosters take membership current only; omit membership or set it to current with committeeId.',
      );
    if (input.asOf !== undefined && input.committeeId === undefined)
      throw ctx.fail(
        'incompatible_fields',
        'asOf needs committeeId: it selects the day of a committee roster.',
      );
    const asOf = input.asOf?.slice(0, 10);
    if (asOf !== undefined) {
      const today = swissToday();
      if (asOf > today)
        throw ctx.fail('as_of_in_future', `asOf ${asOf} is after today in Switzerland (${today}).`);
    }
    const filters = MemberSearchFiltersSchema.parse({
      ...input,
      asOf,
      limit: Math.min(input.limit, 100),
    });
    return withWorkflow(ctx, async (workflow) => {
      const page = await service.searchMembers(filters, workflow);
      const members = page.items;
      const notice = joinNotices(
        clampNotice(input.limit, filters.limit),
        members.length === 0 && page.committeeFound !== false && emptyPageNotice(filters, page),
      );
      ctx.enrich({
        effectiveFilters: filters,
        returnedCount: members.length,
        effectiveLimit: filters.limit,
        ...(page.totalCount !== undefined && { totalCount: page.totalCount }),
        ...(page.nextOffset !== undefined && { nextOffset: page.nextOffset }),
        hasMore: page.hasMore,
        ...(notice !== undefined && { notice }),
      });
      return {
        ...(page.committeeFound !== undefined && { committeeFound: page.committeeFound }),
        ...(page.committeeFound === false && { guidance: committeeNotFoundGuidance }),
        members,
        provenance: provenance(workflow.sources),
      };
    });
  },
  format: formatParliamentResult,
});
