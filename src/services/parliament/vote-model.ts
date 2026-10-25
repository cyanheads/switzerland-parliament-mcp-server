/**
 * @fileoverview Nationalrat vote schemas and lossless source normalization.
 * @module services/parliament/vote-model
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { type Language, ODataDateSchema, odataString } from './normalization.js';
import { PARLIAMENT_ORIGIN } from './odata-client.js';

const RawInt32 = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const RawId = RawInt32.positive();
const RawText = z.string().nullish();

/** Vote metadata projection deliberately excludes all member decisions. */
export const VOTE_FIELDS = [
  'ID',
  'Language',
  'BusinessNumber',
  'BusinessShortNumber',
  'BusinessTitle',
  'BillNumber',
  'BillTitle',
  'RegistrationNumber',
  'IdLegislativePeriod',
  'IdSession',
  'SessionName',
  'Subject',
  'MeaningYes',
  'MeaningNo',
  'VoteEnd',
  'VoteEndWithTimezone',
] as const;

/** Published per-member fields, including the affiliation at the time of this roll call. */
export const VOTING_FIELDS = [
  'ID',
  'Language',
  'IdVote',
  'PersonNumber',
  'FirstName',
  'LastName',
  'CantonID',
  'Canton',
  'CantonName',
  'ParlGroupCode',
  'ParlGroupName',
  'Decision',
  'DecisionText',
] as const;

/** Validate selected vote fields once at the HTTP edge. */
export const RawVoteSchema = z.object({
  ID: RawId,
  Language: z.enum(['DE', 'FR', 'IT']),
  BusinessNumber: RawInt32.nullish(),
  BusinessShortNumber: RawText,
  BusinessTitle: RawText,
  BillNumber: RawInt32.nullish(),
  BillTitle: RawText,
  RegistrationNumber: RawInt32.nullish(),
  IdLegislativePeriod: z.number().int().min(-32_768).max(32_767).nullish(),
  IdSession: RawInt32.nullish(),
  SessionName: RawText,
  Subject: RawText,
  MeaningYes: RawText,
  MeaningNo: RawText,
  VoteEnd: ODataDateSchema.nullish(),
  VoteEndWithTimezone: ODataDateSchema.nullish(),
});

/** Validated vote metadata. */
export type RawVote = z.infer<typeof RawVoteSchema>;

/** Validate projected member decisions, preserving null and missing decision codes. */
export const RawVotingSchema = z.object({
  ID: RawId,
  Language: z.enum(['DE', 'FR', 'IT']),
  IdVote: RawId,
  PersonNumber: RawInt32.nullish(),
  FirstName: RawText,
  LastName: RawText,
  CantonID: RawInt32.nullish(),
  Canton: RawText,
  CantonName: RawText,
  ParlGroupCode: RawText,
  ParlGroupName: RawText,
  Decision: RawInt32.nullish(),
  DecisionText: RawText,
});

/** Validated member decision, also used for the narrow aggregate projection. */
export type RawVoting = z.infer<typeof RawVotingSchema>;

/** Available member-level roll-call coverage; empty results never imply that no vote took place. */
export const VoteCoverageSchema = z
  .object({
    council: z.literal('N').describe('Member roll calls cover the Nationalrat only.'),
    memberRollCallsSince: z
      .literal('2003-winter-session')
      .describe('Beginning of published member roll-call coverage.'),
  })
  .describe('Coverage of the published member decisions.');

/** Small metadata record used to select a roll call before fetching member decisions. */
export const VoteSummarySchema = z
  .object({
    voteId: z.string().describe('Vote.ID as a decimal string.'),
    metadataLanguage: z
      .enum(['de', 'fr', 'it'])
      .describe('Selected metadata row language; published text is not translated.'),
    sourceUrl: z.string().describe('Exact HTTPS OData composite-key vote URL.'),
    businessId: z.string().optional().describe('Canonical BusinessNumber when published.'),
    businessShortNumber: z.string().optional().describe('Published business short number.'),
    businessTitle: z.string().optional().describe('Published business title.'),
    billNumber: z.number().int().optional().describe('Published bill number.'),
    billTitle: z.string().optional().describe('Published bill title.'),
    registrationNumber: z
      .number()
      .int()
      .optional()
      .describe('Published roll-call registration number.'),
    legislativePeriod: z.number().int().optional().describe('Published legislative period.'),
    sessionId: z.string().optional().describe('Published session identifier.'),
    sessionName: z.string().optional().describe('Published session name.'),
    subject: z.string().optional().describe('Original roll-call subject.'),
    meaningYes: z.string().optional().describe('Original meaning of a yes decision.'),
    meaningNo: z.string().optional().describe('Original meaning of a no decision.'),
    endTime: z
      .string()
      .optional()
      .describe('Published vote end time, retaining the source offset when supplied.'),
  })
  .describe('One Nationalrat roll call, without per-member enrichment.');

/** Normalized vote identity and source metadata. */
export type VoteSummary = z.infer<typeof VoteSummarySchema>;

/** A published member decision; absent fields remain unknown. */
export const MemberDecisionSchema = z
  .object({
    votingId: z.string().describe('Voting.ID as a decimal string.'),
    personNumber: z
      .string()
      .optional()
      .describe('Published PersonNumber, distinct from Person.ID.'),
    firstName: z.string().optional().describe('Published member first name.'),
    lastName: z.string().optional().describe('Published member last name.'),
    cantonId: z.string().optional().describe('Published CantonID.'),
    cantonCode: z.string().optional().describe('Published Canton abbreviation.'),
    cantonName: z.string().optional().describe('Published canton name.'),
    groupCode: z.string().optional().describe('Parliamentary group code on this Voting row.'),
    groupName: z
      .string()
      .optional()
      .describe('Published parliamentary group name on this Voting row.'),
    decisionCode: z
      .number()
      .int()
      .optional()
      .describe('Published open integer decision code; absence is a separate unknown bucket.'),
    decisionText: z
      .string()
      .optional()
      .describe('Original DecisionText, without replacement translation.'),
  })
  .describe('One original member roll-call decision.');

/** Member page item. */
export type MemberDecision = z.infer<typeof MemberDecisionSchema>;

/** One decision-code bucket, including an absent-code bucket for unknown decisions. */
export const DecisionCountSchema = z
  .object({
    decisionCode: z
      .number()
      .int()
      .optional()
      .describe('Original code; absent for missing or null Decision.'),
    count: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of published member rows in this bucket.'),
  })
  .describe('Count of rows carrying a decision code or an unknown decision.');

/** Counts are explicitly scoped to the delivered page or a completely read vote. */
export const DecisionCountsSchema = z
  .union([
    z
      .object({
        scope: z.literal('page').describe('Counts cover only the delivered members page.'),
        counts: z.array(DecisionCountSchema).describe('Decision buckets on the delivered page.'),
      })
      .describe('Delivered-page counts, never whole-vote totals.'),
    z
      .object({
        scope: z.literal('vote').describe('Counts cover the complete published roll call.'),
        complete: z.literal(true).describe('Every published member row was consumed.'),
        memberRowCount: z
          .number()
          .int()
          .positive()
          .describe('Published member rows, not electoral seats.'),
        counts: z
          .array(DecisionCountSchema)
          .describe('All decision buckets in the complete roll call.'),
      })
      .describe('Complete nonempty roll-call counts.'),
  ])
  .describe('Explicit scope of the decision counts.');

/** Full-roll-call count of one published parliamentary group or unknown group bucket. */
export const GroupDecisionSchema = z
  .object({
    groupCode: z.string().optional().describe('Published group code; absent when unknown.'),
    groupName: z
      .string()
      .optional()
      .describe('Published group name; no synthetic unknown-group label.'),
    memberRowCount: z
      .number()
      .int()
      .positive()
      .describe('Published rows attributed to this group.'),
    counts: z
      .array(DecisionCountSchema)
      .describe('Decision buckets across all published rows for this group.'),
  })
  .describe('Complete decision counts for one group at the time of the vote.');

/** Normalize present source vote metadata; source strings are never trimmed or translated. */
export function normalizeVote(raw: RawVote, language: Language): VoteSummary {
  if (raw.Language !== language.toUpperCase())
    throw serializationError('Parliament returned a vote in a different metadata language.');
  const endTime = raw.VoteEndWithTimezone ?? raw.VoteEnd;
  return {
    voteId: String(raw.ID),
    metadataLanguage: language,
    sourceUrl: `${PARLIAMENT_ORIGIN}/odata.svc/Vote(ID=${raw.ID},Language=${odataString(language.toUpperCase())})?$format=json`,
    ...(raw.BusinessNumber != null && { businessId: String(raw.BusinessNumber) }),
    ...(raw.BusinessShortNumber != null && { businessShortNumber: raw.BusinessShortNumber }),
    ...(raw.BusinessTitle != null && { businessTitle: raw.BusinessTitle }),
    ...(raw.BillNumber != null && { billNumber: raw.BillNumber }),
    ...(raw.BillTitle != null && { billTitle: raw.BillTitle }),
    ...(raw.RegistrationNumber != null && { registrationNumber: raw.RegistrationNumber }),
    ...(raw.IdLegislativePeriod != null && { legislativePeriod: raw.IdLegislativePeriod }),
    ...(raw.IdSession != null && { sessionId: String(raw.IdSession) }),
    ...(raw.SessionName != null && { sessionName: raw.SessionName }),
    ...(raw.Subject != null && { subject: raw.Subject }),
    ...(raw.MeaningYes != null && { meaningYes: raw.MeaningYes }),
    ...(raw.MeaningNo != null && { meaningNo: raw.MeaningNo }),
    ...(endTime != null && { endTime }),
  };
}

/** Normalize one Voting row without applying present-day affiliations or decision translations. */
export function normalizeMemberDecision(raw: RawVoting): MemberDecision {
  return {
    votingId: String(raw.ID),
    ...(raw.PersonNumber != null && { personNumber: String(raw.PersonNumber) }),
    ...(raw.FirstName != null && { firstName: raw.FirstName }),
    ...(raw.LastName != null && { lastName: raw.LastName }),
    ...(raw.CantonID != null && { cantonId: String(raw.CantonID) }),
    ...(raw.Canton != null && { cantonCode: raw.Canton }),
    ...(raw.CantonName != null && { cantonName: raw.CantonName }),
    ...(raw.ParlGroupCode != null && { groupCode: raw.ParlGroupCode }),
    ...(raw.ParlGroupName != null && { groupName: raw.ParlGroupName }),
    ...(raw.Decision != null && { decisionCode: raw.Decision }),
    ...(raw.DecisionText != null && { decisionText: raw.DecisionText }),
  };
}

/** Every row contributes to exactly one numeric or absent decision bucket. */
export function countDecisions(
  rows: readonly Pick<MemberDecision, 'decisionCode'>[],
): z.infer<typeof DecisionCountSchema>[] {
  const counts = new Map<number | undefined, number>();
  for (const row of rows) counts.set(row.decisionCode, (counts.get(row.decisionCode) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => (left === undefined ? 1 : right === undefined ? -1 : left - right))
    .map(([decisionCode, count]) => ({
      ...(decisionCode !== undefined && { decisionCode }),
      count,
    }));
}
