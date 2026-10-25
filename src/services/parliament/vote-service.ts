/**
 * @fileoverview Paged vote discovery and complete selected-roll-call aggregation.
 * @module services/parliament/vote-service
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { type Language, odataInt32 } from './normalization.js';
import { ODataClient, type ODataPage } from './odata-client.js';
import {
  countDecisions,
  type GroupDecisionSchema,
  type MemberDecision,
  normalizeMemberDecision,
  normalizeVote,
  RawVoteSchema,
  type RawVoting,
  RawVotingSchema,
  VOTE_FIELDS,
  VOTING_FIELDS,
  type VoteSummary,
} from './vote-model.js';
import { remainingWorkflowMs, type WorkflowContext } from './workflow.js';

const client = new ODataClient();

/** List metadata only; selecting a roll call makes the cost of member retrieval explicit. */
export async function listVotes(
  businessId: string,
  language: Language,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
): Promise<ODataPage<VoteSummary>> {
  const page = await client.collection(
    {
      entity: 'Vote',
      language,
      select: VOTE_FIELDS,
      orderBy: [{ field: 'ID', direction: 'desc' }],
      filter: `BusinessNumber eq ${odataInt32(businessId)}`,
    },
    RawVoteSchema,
    paging,
    workflow,
  );
  for (const row of page.items)
    if (String(row.BusinessNumber) !== businessId)
      throw serializationError('Parliament returned a vote belonging to a different business.');
  return { ...page, items: page.items.map((row) => normalizeVote(row, language)) };
}

/** Resolve the exact composite key; a keyed 404 or explicit null is a valid miss. */
export async function getVote(
  voteId: string,
  language: Language,
  workflow: WorkflowContext,
): Promise<VoteSummary | undefined> {
  const row = await client.entity(
    { entity: 'Vote', id: voteId, language, select: VOTE_FIELDS },
    RawVoteSchema,
    workflow,
  );
  if (!row) return undefined;
  if (String(row.ID) !== voteId)
    throw serializationError(
      'Parliament returned a different vote than the requested composite key.',
    );
  return normalizeVote(row, language);
}

function verifyVoting(row: RawVoting, voteId: string, language: Language): void {
  if (String(row.IdVote) !== voteId || row.Language !== language.toUpperCase())
    throw serializationError(
      'Parliament returned a member decision for a different roll call or metadata language.',
    );
}

/** Read a member page with exact filtered totals and the affiliation published on each Voting row. */
export async function listMemberDecisions(
  voteId: string,
  language: Language,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
  personNumber?: string,
): Promise<ODataPage<MemberDecision>> {
  const page = await client.collection(
    {
      entity: 'Voting',
      language,
      select: VOTING_FIELDS,
      orderBy: [
        { field: 'PersonNumber', direction: 'asc' },
        { field: 'ID', direction: 'asc' },
      ],
      filter: `IdVote eq ${odataInt32(voteId)}${personNumber === undefined ? '' : ` and PersonNumber eq ${odataInt32(personNumber)}`}`,
    },
    RawVotingSchema,
    paging,
    workflow,
  );
  for (const row of page.items) {
    verifyVoting(row, voteId, language);
    if (personNumber !== undefined && String(row.PersonNumber) !== personNumber)
      throw serializationError('Parliament returned a member decision for a different person.');
  }
  return { ...page, items: page.items.map(normalizeMemberDecision) };
}

/** Drain every source page before exposing complete group or vote counts; an empty source has no totals. */
export async function getGroupDecisions(
  voteId: string,
  language: Language,
  workflow: WorkflowContext,
) {
  const rows: MemberDecision[] = [];
  let offset = 0;
  let totalCount: number | undefined;
  for (;;) {
    const page = await client.collection(
      {
        entity: 'Voting',
        language,
        select: ['ID', 'Language', 'IdVote', 'Decision', 'ParlGroupCode', 'ParlGroupName'],
        orderBy: [{ field: 'ID', direction: 'asc' }],
        filter: `IdVote eq ${odataInt32(voteId)}`,
      },
      RawVotingSchema,
      { limit: 1000, offset },
      workflow,
    );
    if (totalCount !== undefined && page.totalCount !== undefined && totalCount !== page.totalCount)
      throw serializationError(
        'Parliament member count changed while reading the complete roll call.',
      );
    if (page.totalCount !== undefined) totalCount = page.totalCount;
    for (const row of page.items) {
      verifyVoting(row, voteId, language);
      rows.push(normalizeMemberDecision(row));
    }
    if (!page.hasMore) break;
    if (page.items.length === 0)
      throw serializationError('Parliament member pagination stopped making progress.');
    offset += page.items.length;
    remainingWorkflowMs(workflow);
  }
  if (totalCount !== undefined && rows.length !== totalCount)
    throw serializationError(
      'Parliament roll-call rows do not match the advertised complete count.',
    );
  const groups = new Map<
    string | undefined,
    { groupCode?: string; groupName?: string; rows: MemberDecision[] }
  >();
  for (const row of rows) {
    const existing = groups.get(row.groupCode);
    if (existing) {
      existing.rows.push(row);
      if (existing.groupName === undefined && row.groupName !== undefined)
        existing.groupName = row.groupName;
    } else
      groups.set(row.groupCode, {
        ...(row.groupCode !== undefined && { groupCode: row.groupCode }),
        ...(row.groupName !== undefined && { groupName: row.groupName }),
        rows: [row],
      });
  }
  const items: z.infer<typeof GroupDecisionSchema>[] = [...groups.values()]
    .sort((left, right) =>
      left.groupCode === undefined
        ? 1
        : right.groupCode === undefined
          ? -1
          : left.groupCode.localeCompare(right.groupCode),
    )
    .map(({ groupCode, groupName, rows: memberRows }) => ({
      ...(groupCode !== undefined && { groupCode }),
      ...(groupName !== undefined && { groupName }),
      memberRowCount: memberRows.length,
      counts: countDecisions(memberRows),
    }));
  remainingWorkflowMs(workflow);
  return {
    items,
    ...(rows.length > 0 && {
      decisionCounts: {
        scope: 'vote' as const,
        complete: true as const,
        memberRowCount: rows.length,
        counts: countDecisions(rows),
      },
    }),
  };
}
