/**
 * @fileoverview Complete business-to-subject debate joins and upstream identity checks.
 * @module tests/services/parliament/transcript-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { searchTranscriptsTool } from '@/mcp-server/tools/definitions/search-transcripts.tool.js';
import { parliamentHttp, textContent } from '../../helpers/parliament.js';
import { transcriptId, transcriptRow } from '../../helpers/transcript-fixtures.js';
import { expectVoteParity } from '../../helpers/vote-fixtures.js';

let http: ReturnType<typeof parliamentHttp> | undefined;
afterEach(() => http?.restore());

function subjectsFixture(count: number, withCount: boolean, sourcePageSize = 20) {
  const subjects = Array.from({ length: count }, (_, i) => ({
    IdSubject: String(9007199254740993n + BigInt(i)),
    BusinessNumber: 20991234,
    Language: 'DE',
  }));
  http = parliamentHttp((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/odata.svc/Business('))
      return Response.json({
        d: {
          ID: 20991234,
          Language: 'DE',
          Transcripts: { results: [{ ID: '1', Language: 'DE', Text: 'Only a vote announcement' }] },
        },
      });
    if (url.pathname === '/odata.svc/SubjectBusiness') {
      const offset = Number(url.searchParams.get('$skip'));
      const top = Math.min(sourcePageSize, Number(url.searchParams.get('$top')));
      const results = subjects.slice(offset, offset + top);
      const next = new URL(url);
      next.searchParams.set('$skip', String(offset + results.length));
      const hasSourcePage = offset + results.length < count;
      return Response.json({
        d: {
          results,
          ...(withCount && { __count: String(count) }),
          ...(hasSourcePage && sourcePageSize < 20 && { __next: next.href }),
        },
      });
    }
    if (url.pathname === '/odata.svc/Transcript')
      return Response.json({
        d: {
          results: subjects.map((subject, i) => ({
            ID: String(1000 + i),
            Language: 'DE',
            IdSubject: subject.IdSubject,
          })),
          __count: String(count),
        },
      });
    throw new Error(`Unexpected Parliament path ${url.pathname}`);
  });
  return subjects;
}

describe('transcript relationship service', () => {
  it('joins every subject across source pages rather than reading the Business/Transcripts navigation', async () => {
    const subjects = subjectsFixture(7, true, 3);
    const result = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      scopeFound: true,
      returnedCount: 7,
      totalCount: 7,
      hasMore: false,
    });
    expect(
      searchTranscriptsTool.output
        .parse(result.structuredContent)
        .transcripts.map((row) => row.subjectId),
    ).toEqual(subjects.map((subject) => subject.IdSubject));
    const urls = http?.calls.map((call) => new URL(call.request.url)) ?? [];
    expect(urls.map((url) => url.pathname)).toEqual([
      "/odata.svc/Business(ID=20991234,Language='DE')",
      '/odata.svc/SubjectBusiness',
      '/odata.svc/SubjectBusiness',
      '/odata.svc/SubjectBusiness',
      '/odata.svc/Transcript',
    ]);
    expect(urls[1]?.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (BusinessNumber eq 20991234)",
    );
    expect(urls[4]?.searchParams.get('$filter')).toBe(
      `Language eq 'DE' and ((${subjects.map((row) => `IdSubject eq ${row.IdSubject}L`).join(' or ')}))`,
    );
    expect(
      searchTranscriptsTool.output.parse(result.structuredContent).provenance.sources,
    ).toHaveLength(5);
    expectVoteParity(result);
  });

  it.each([true, false])(
    'accepts exactly 20 subjects with count=$0, probing a count-free full-page boundary',
    async (withCount) => {
      subjectsFixture(20, withCount);
      const result = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        scopeFound: true,
        returnedCount: 20,
        totalCount: 20,
      });
      const calls =
        http?.calls
          .map((call) => new URL(call.request.url))
          .filter((url) => url.pathname === '/odata.svc/SubjectBusiness') ?? [];
      expect(calls).toHaveLength(withCount ? 1 : 2);
      if (!withCount) {
        expect(calls[1]?.searchParams.get('$skip')).toBe('20');
        expect(calls[1]?.searchParams.get('$top')).toBe('1');
        expect(calls[1]?.searchParams.get('$filter')).toBe(calls[0]?.searchParams.get('$filter'));
      }
      expectVoteParity(result);
    },
  );

  it.each([true, false])(
    'refuses more than 20 subjects with count=$0 before any passage fetch',
    async (withCount) => {
      subjectsFixture(21, withCount);
      const result = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'business_scope_too_broad',
            recovery: { hint: expect.stringContaining('section subjects') },
          },
        },
      });
      expect(textContent(result)).toContain('subjectId');
      expect(textContent(result)).toContain('section subjects');
      expect(
        http?.calls.every((call) => new URL(call.request.url).pathname !== '/odata.svc/Transcript'),
      ).toBe(true);
    },
  );

  it('distinguishes missing business, no subjects, and no matching passages', async () => {
    http = parliamentHttp(() => Response.json({ d: null }));
    const missing = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
    expect(missing.structuredContent).toMatchObject({
      scopeFound: false,
      transcripts: [],
      returnedCount: 0,
      effectiveLimit: 20,
      hasMore: false,
    });
    expect(missing.structuredContent).not.toHaveProperty('totalCount');
    expect(textContent(missing)).toContain('chparl_search_business');
    expect(http.calls).toHaveLength(1);
    http.restore();
    subjectsFixture(0, true);
    const noSubjects = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
    expect(noSubjects.structuredContent).toMatchObject({
      scopeFound: true,
      transcripts: [],
      totalCount: 0,
      hasMore: false,
    });
    expect(textContent(noSubjects)).toContain('no published debate subjects');
    expect(http?.calls).toHaveLength(2);
    http?.restore();
    http = parliamentHttp((request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/odata.svc/Business('))
        return Response.json({ d: { ID: 20991234, Language: 'DE' } });
      return Response.json({
        d: {
          results:
            path === '/odata.svc/SubjectBusiness'
              ? [{ IdSubject: '1', BusinessNumber: 20991234, Language: 'DE' }]
              : [],
          __count: path === '/odata.svc/SubjectBusiness' ? '1' : '0',
        },
      });
    });
    const noPassages = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
    expect(noPassages.structuredContent).toMatchObject({
      scopeFound: true,
      transcripts: [],
      totalCount: 0,
    });
    expect(textContent(noPassages)).toContain('No Bulletin passages matched');
    expectVoteParity(missing);
    expectVoteParity(noSubjects);
    expectVoteParity(noPassages);
  });

  it.each([
    { ID: '9007199254740994', Language: 'DE' },
    { ...transcriptRow, Language: 'FR' },
    { ...transcriptRow, ID: 9007199254740992 },
  ])('rejects a mismatched or lossy exact passage %o', async (row) => {
    http = parliamentHttp(() => Response.json({ d: row }));
    const result = await runToolContract(searchTranscriptsTool, { transcriptId });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { BusinessNumber: 19991234, Language: 'DE' },
    { BusinessNumber: 20991234, Language: 'FR' },
  ])('rejects an unrelated or wrong-language subject %o', async (identity) => {
    http = parliamentHttp((request) =>
      Response.json({
        d: new URL(request.url).pathname.startsWith('/odata.svc/Business(')
          ? { ID: 20991234, Language: 'DE' }
          : { results: [{ IdSubject: '1', ...identity }], __count: '1' },
      }),
    );
    const result = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(http.calls).toHaveLength(2);
  });
});
