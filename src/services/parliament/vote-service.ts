/**
 * @fileoverview Paged business/session vote discovery, member history, and selected-roll-call aggregation.
 * @module services/parliament/vote-service
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { CANTON_SOURCE } from './canton-mapping.js';
import { type Language, odataInt32 } from './normalization.js';
import { ODataClient, type ODataPage } from './odata-client.js';
import {
  countDecisions,
  type GroupDecisionSchema,
  HISTORY_VOTING_FIELDS,
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

/** List metadata filtered by business, session, or both, without retrieving member rows. */
export async function listVotes(
  businessId: string | undefined,
  language: Language,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
  sessionId?: string,
): Promise<ODataPage<VoteSummary>> {
  const page = await client.collection(
    {
      entity: 'Vote',
      language,
      select: VOTE_FIELDS,
      orderBy: [{ field: 'ID', direction: 'desc' }],
      filter: [
        ...(businessId === undefined ? [] : [`BusinessNumber eq ${odataInt32(businessId)}`]),
        ...(sessionId === undefined ? [] : [`IdSession eq ${odataInt32(sessionId)}`]),
      ].join(' and '),
    },
    RawVoteSchema,
    paging,
    workflow,
  );
  for (const row of page.items)
    if (
      (businessId !== undefined && String(row.BusinessNumber) !== businessId) ||
      (sessionId !== undefined && String(row.IdSession) !== sessionId)
    )
      throw serializationError(
        'Parliament returned a vote belonging to a different business or session.',
      );
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

function verifyVoting(row: RawVoting, voteId: string | undefined, language: Language): void {
  if (
    (voteId !== undefined && String(row.IdVote) !== voteId) ||
    row.Language !== language.toUpperCase()
  )
    throw serializationError(
      'Parliament returned a member decision for a different roll call or metadata language.',
    );
}

/** Read source affiliations and exact filtered totals; without voteId, page history newest roll call first. */
export async function listMemberDecisions(
  voteId: string | undefined,
  language: Language,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
  personNumber?: string,
  scopes: { businessId?: string; sessionId?: string } = {},
): Promise<ODataPage<MemberDecision>> {
  const mode = voteId === undefined ? 'history' : 'selected';
  const page = await client.collection(
    {
      entity: 'Voting',
      language,
      select: mode === 'history' ? HISTORY_VOTING_FIELDS : VOTING_FIELDS,
      orderBy:
        mode === 'history'
          ? [
              { field: 'IdVote', direction: 'desc' },
              { field: 'ID', direction: 'desc' },
            ]
          : [
              { field: 'PersonNumber', direction: 'asc' },
              { field: 'ID', direction: 'asc' },
            ],
      filter: [
        ...(voteId === undefined ? [] : [`IdVote eq ${odataInt32(voteId)}`]),
        ...(personNumber === undefined ? [] : [`PersonNumber eq ${odataInt32(personNumber)}`]),
        ...(scopes.businessId === undefined
          ? []
          : [`BusinessNumber eq ${odataInt32(scopes.businessId)}`]),
        ...(scopes.sessionId === undefined ? [] : [`IdSession eq ${odataInt32(scopes.sessionId)}`]),
      ].join(' and '),
    },
    RawVotingSchema,
    paging,
    workflow,
  );
  for (const row of page.items) {
    verifyVoting(row, voteId, language);
    if (personNumber !== undefined && String(row.PersonNumber) !== personNumber)
      throw serializationError('Parliament returned a member decision for a different person.');
    if (
      (scopes.businessId !== undefined && String(row.BusinessNumber) !== scopes.businessId) ||
      (scopes.sessionId !== undefined && String(row.IdSession) !== scopes.sessionId)
    )
      throw serializationError(
        'Parliament returned a member decision for a different business or session.',
      );
  }
  if (page.items.length > 0) workflow.sources.push({ ...CANTON_SOURCE });
  return {
    ...page,
    items: page.items.map((row) => normalizeMemberDecision(row, mode)),
  };
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
        select: [
          'ID',
          'Language',
          'IdVote',
          'Decision',
          'DecisionText',
          'ParlGroupCode',
          'ParlGroupName',
        ],
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
      rows.push(normalizeMemberDecision(row, 'selected'));
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
  // Unknown groups sort last; a group's name is the first one published on its rows.
  const items: z.infer<typeof GroupDecisionSchema>[] = [
    ...Map.groupBy(rows, (row) => row.groupCode),
  ]
    .sort(([left], [right]) =>
      left === undefined ? 1 : right === undefined ? -1 : left.localeCompare(right),
    )
    .map(([groupCode, memberRows]) => {
      const groupName = memberRows.find((row) => row.groupName !== undefined)?.groupName;
      return {
        ...(groupCode !== undefined && { groupCode }),
        ...(groupName !== undefined && { groupName }),
        memberRowCount: memberRows.length,
        counts: countDecisions(memberRows),
      };
    });
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
