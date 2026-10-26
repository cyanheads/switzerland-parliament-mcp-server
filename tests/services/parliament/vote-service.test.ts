/**
 * @fileoverview Vote identity validation and complete aggregation over deep source pagination.
 * @module tests/services/parliament/vote-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGroupDecisions,
  getVote,
  listMemberDecisions,
  listVotes,
} from '@/services/parliament/vote-service.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import { parliamentHttp } from '../../helpers/parliament.js';

let http: ReturnType<typeof parliamentHttp> | undefined;
afterEach(() => http?.restore());

describe('vote services', () => {
  it('isolates the checked-in canton citation from mutations in earlier workflow results', async () => {
    http = parliamentHttp(() =>
      Response.json({
        d: {
          results: [{ ID: 1, Language: 'DE', IdVote: 500, Canton: 'VD', CantonID: 23 }],
          __count: '1',
        },
      }),
    );
    const sources = async () =>
      withWorkflow(createMockContext(), async (workflow) => {
        await listMemberDecisions('500', 'de', { limit: 50, offset: 0 }, workflow);
        return workflow.sources;
      });
    const first = (await sources()).find((source) => source.url.includes('/Canton?'));
    if (!first) throw new Error('Expected the canton mapping citation.');
    first.retrievedAt = 'mutated';
    first.url = 'https://example.invalid/mutated';
    const second = (await sources()).filter((source) => source.url.includes('/Canton?'));
    expect(second).toEqual([
      {
        url: 'https://ws.parlament.ch/odata.svc/Canton?%24format=json&%24filter=Language+eq+%27DE%27&%24select=ID%2CLanguage%2CCantonNumber%2CCantonAbbreviation%2CCantonName&%24top=100&%24orderby=CantonNumber+asc%2CID+asc&%24inlinecount=allpages',
        retrievedAt: '2026-10-26',
      },
    ]);
  });

  it.each([
    {
      operation: 'history',
      row: {
        ID: 1,
        IdVote: 500,
        Language: 'FR',
        PersonNumber: 491,
        BusinessNumber: 20130468,
        IdSession: 5107,
      },
    },
    {
      operation: 'history',
      row: {
        ID: 1,
        IdVote: 500,
        Language: 'DE',
        PersonNumber: 492,
        BusinessNumber: 20130468,
        IdSession: 5107,
      },
    },
    {
      operation: 'history',
      row: {
        ID: 1,
        IdVote: 500,
        Language: 'DE',
        PersonNumber: 491,
        BusinessNumber: 20130469,
        IdSession: 5107,
      },
    },
    {
      operation: 'history',
      row: {
        ID: 1,
        IdVote: 500,
        Language: 'DE',
        PersonNumber: 491,
        BusinessNumber: 20130468,
        IdSession: 5108,
      },
    },
    { operation: 'session', row: { ID: 500, Language: 'DE', IdSession: 5108 } },
    { operation: 'session', row: { ID: 500, Language: 'FR', IdSession: 5107 } },
  ])(
    'rejects mismatched $operation scope at the real normalization boundary',
    async ({ operation, row }) => {
      http = parliamentHttp(() => Response.json({ d: { results: [row], __count: '1' } }));
      await expect(
        withWorkflow<unknown>(createMockContext(), (workflow) =>
          operation === 'history'
            ? listMemberDecisions(undefined, 'de', { limit: 50, offset: 0 }, workflow, '491', {
                businessId: '20130468',
                sessionId: '5107',
              })
            : listVotes(undefined, 'de', { limit: 10, offset: 0 }, workflow, '5107'),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      expect(http.calls).toHaveLength(1);
    },
  );

  it('preserves label source order and deduplicates across aggregate source batches', async () => {
    const rows = Array.from({ length: 1003 }, (_, index) => ({
      ID: index + 1,
      Language: 'DE',
      IdVote: 500,
      Decision: 5,
      ParlGroupCode: 'A',
      DecisionText:
        index < 1000 ? ' first ' : index === 1000 ? '' : index === 1001 ? 'second' : ' first ',
    }));
    http = parliamentHttp((request) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get('$skip'));
      const top = Number(url.searchParams.get('$top'));
      const selected = url.searchParams.get('$select')?.split(',') ?? [];
      return Response.json({
        d: {
          results: rows
            .slice(offset, offset + top)
            .map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => selected.includes(key))),
            ),
          __count: '1003',
        },
      });
    });
    const result = await withWorkflow(createMockContext(), (workflow) =>
      getGroupDecisions('500', 'de', workflow),
    );
    const counts = [{ decisionCode: 5, count: 1003, decisionTexts: [' first ', '', 'second'] }];
    expect(result.items).toEqual([{ groupCode: 'A', memberRowCount: 1003, counts }]);
    expect(result.decisionCounts).toEqual({
      scope: 'vote',
      complete: true,
      memberRowCount: 1003,
      counts,
    });
    expect(http.calls).toHaveLength(2);
  });

  it('characterizes a sparse selected decision without inventing affiliations or labels', async () => {
    http = parliamentHttp(() =>
      Response.json({
        d: {
          results: [
            { ID: 1, Language: 'DE', IdVote: 500, Decision: null, DecisionText: '', Canton: null },
          ],
          __count: '1',
        },
      }),
    );
    const page = await withWorkflow(createMockContext(), (workflow) =>
      listMemberDecisions('500', 'de', { limit: 50, offset: 0 }, workflow),
    );
    expect(page.items).toEqual([{ votingId: '1', decisionText: '' }]);
    expect(page.totalCount).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it('drains more than 1000 decisions before publishing complete counts, retaining unknown buckets', async () => {
    const rows = Array.from({ length: 1003 }, (_, index) => ({
      ID: index + 1,
      Language: 'DE',
      IdVote: 500,
      ...(index < 1000
        ? { Decision: 1, ParlGroupCode: 'A', ParlGroupName: 'Original A' }
        : index === 1000
          ? { Decision: 987, ParlGroupCode: 'B' }
          : {}),
    }));
    http = parliamentHttp((request) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get('$skip'));
      const top = Math.min(333, Number(url.searchParams.get('$top')));
      return Response.json({ d: { results: rows.slice(offset, offset + top), __count: '1003' } });
    });
    const result = await withWorkflow(createMockContext(), (workflow) =>
      getGroupDecisions('500', 'de', workflow),
    );
    expect(result).toEqual({
      items: [
        {
          groupCode: 'A',
          groupName: 'Original A',
          memberRowCount: 1000,
          counts: [{ decisionCode: 1, count: 1000 }],
        },
        { groupCode: 'B', memberRowCount: 1, counts: [{ decisionCode: 987, count: 1 }] },
        { memberRowCount: 2, counts: [{ count: 2 }] },
      ],
      decisionCounts: {
        scope: 'vote',
        complete: true,
        memberRowCount: 1003,
        counts: [{ decisionCode: 1, count: 1000 }, { decisionCode: 987, count: 1 }, { count: 2 }],
      },
    });
    const urls = http.calls.map((call) => new URL(call.request.url));
    expect(urls.map((url) => url.searchParams.get('$skip'))).toEqual([
      '0',
      '333',
      '666',
      '999',
      '1000',
    ]);
    expect(urls[0]?.searchParams.get('$select')).toBe(
      'ID,Language,IdVote,Decision,DecisionText,ParlGroupCode,ParlGroupName',
    );
  });

  it('rejects count drift between aggregate batches rather than claiming complete totals', async () => {
    http = parliamentHttp((request) => {
      const offset = Number(new URL(request.url).searchParams.get('$skip'));
      return Response.json({
        d: {
          results:
            offset === 0
              ? Array.from({ length: 1000 }, (_, i) => ({ ID: i + 1, Language: 'DE', IdVote: 500 }))
              : [{ ID: 1001, Language: 'DE', IdVote: 500 }],
          __count: offset === 0 ? '1001' : '1002',
        },
      });
    });
    await expect(
      withWorkflow(createMockContext(), (workflow) => getGroupDecisions('500', 'de', workflow)),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: expect.stringContaining('count changed'),
    });
  });

  it('rejects a stalled incomplete aggregate source rather than inferring zero missing decisions', async () => {
    http = parliamentHttp((request) =>
      Response.json({
        d: {
          results:
            Number(new URL(request.url).searchParams.get('$skip')) === 0
              ? [{ ID: 1, Language: 'DE', IdVote: 500 }]
              : [],
          __count: '2',
        },
      }),
    );
    await expect(
      withWorkflow(createMockContext(), (workflow) => getGroupDecisions('500', 'de', workflow)),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: expect.stringContaining('stopped making progress'),
    });
  });

  it.each([
    { operation: 'vote', row: { ID: 501, Language: 'DE' } },
    { operation: 'vote', row: { ID: 500, Language: 'FR' } },
    { operation: 'votes', row: { ID: 500, Language: 'DE', BusinessNumber: 19991234 } },
    { operation: 'members', row: { ID: 1, Language: 'DE', IdVote: 501 } },
    { operation: 'members', row: { ID: 1, Language: 'FR', IdVote: 500 } },
    { operation: 'person', row: { ID: 1, Language: 'DE', IdVote: 500, PersonNumber: 2 } },
  ])('rejects mismatched $operation identity at the HTTP boundary', async ({ operation, row }) => {
    http = parliamentHttp(() =>
      Response.json({ d: operation === 'vote' ? row : { results: [row], __count: '1' } }),
    );
    await expect(
      withWorkflow<unknown>(createMockContext(), (workflow) => {
        if (operation === 'vote') return getVote('500', 'de', workflow);
        if (operation === 'votes')
          return listVotes('20991234', 'de', { limit: 10, offset: 0 }, workflow);
        return listMemberDecisions(
          '500',
          'de',
          { limit: 50, offset: 0 },
          workflow,
          operation === 'person' ? '1' : undefined,
        );
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
    expect(http.calls).toHaveLength(1);
  });
});
