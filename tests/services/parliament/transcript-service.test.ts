/**
 * @fileoverview Complete business-to-subject debate joins and upstream identity checks.
 * @module tests/services/parliament/transcript-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchTranscriptsTool } from '@/mcp-server/tools/definitions/search-transcripts.tool.js';
import type { Source } from '@/services/parliament/provenance.js';
import { resolveSubjectBusinesses } from '@/services/parliament/transcript-service.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import { parliamentHttp, textContent } from '../../helpers/parliament.js';
import {
  companyLawSubjectPage,
  marriageSubjectBusiness,
  requestedSubjects,
  subjectBusinessPage,
  transcriptId,
  transcriptRow,
} from '../../helpers/transcript-fixtures.js';
import { expectVoteParity } from '../../helpers/vote-fixtures.js';

let http: ReturnType<typeof parliamentHttp> | undefined;
afterEach(() => {
  http?.restore();
  vi.useRealTimers();
});

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
    if (url.pathname === '/odata.svc/SubjectBusiness' && requestedSubjects(url).length > 0)
      return subjectBusinessPage(
        url,
        subjects.map((subject) => ({ ...subject, SortOrder: 1, Title: 'Synthetic business' })),
      );
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
      '/odata.svc/SubjectBusiness',
    ]);
    expect(urls[1]?.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (BusinessNumber eq 20991234)",
    );
    const subjectPredicates = subjects.map((row) => `IdSubject eq ${row.IdSubject}L`).join(' or ');
    expect(urls[4]?.searchParams.get('$filter')).toBe(
      `Language eq 'DE' and ((${subjectPredicates}))`,
    );
    expect(urls[4]?.searchParams.get('$orderby')).toBe(
      'MeetingDate asc,MeetingVerbalixOid asc,IdSubject asc,SortOrder asc,ID asc',
    );
    // A business-scoped page still resolves every subject: a subject can carry other businesses.
    expect(urls[5]?.searchParams.get('$filter')).toBe(
      `Language eq 'DE' and (${subjectPredicates})`,
    );
    expect(
      searchTranscriptsTool.output.parse(result.structuredContent).provenance.sources,
    ).toHaveLength(6);
    expectVoteParity(result);
  });

  it.each([true, false])(
    'accepts exactly 20 subjects with count=$0, probing a count-free full-page boundary',
    async (withCount) => {
      const subjects = subjectsFixture(20, withCount);
      const result = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        scopeFound: true,
        returnedCount: 20,
        totalCount: 20,
        hasMore: false,
      });
      const passageQuery = http?.calls
        .map((call) => new URL(call.request.url))
        .find((url) => url.pathname === '/odata.svc/Transcript');
      expect(passageQuery?.searchParams.get('$filter')).toBe(
        `Language eq 'DE' and ((${subjects.map((row) => `IdSubject eq ${row.IdSubject}L`).join(' or ')}))`,
      );
      const calls =
        http?.calls
          .map((call) => new URL(call.request.url))
          .filter(
            (url) =>
              url.pathname === '/odata.svc/SubjectBusiness' && requestedSubjects(url).length === 0,
          ) ?? [];
      expect(calls).toHaveLength(withCount ? 1 : 2);
      if (!withCount) {
        expect(calls[1]?.searchParams.get('$skip')).toBe('20');
        expect(calls[1]?.searchParams.get('$top')).toBe('1');
        expect(calls[1]?.searchParams.get('$filter')).toBe(calls[0]?.searchParams.get('$filter'));
      }
      expectVoteParity(result);
    },
  );

  it('fits 20 maximum-width subjects, every non-text filter, and the debate order in one passage query', async () => {
    const subjects = Array.from({ length: 20 }, (_, i) => ({
      IdSubject: String(9_223_372_036_854_775_807n - BigInt(i)),
      BusinessNumber: 99_999_999,
      Language: 'DE',
    }));
    http = parliamentHttp((request) => {
      const url = new URL(request.url);
      if (url.search.length - 1 > 2048) throw new Error('Query string exceeds the source limit.');
      if (url.pathname.startsWith('/odata.svc/Business('))
        return Response.json({ d: { ID: 99_999_999, Language: 'DE' } });
      if (url.pathname === '/odata.svc/SubjectBusiness')
        return Response.json({ d: { results: subjects, __count: '20' } });
      return Response.json({ d: { results: [], __count: '0' } });
    });
    const result = await runToolContract(searchTranscriptsTool, {
      businessId: '99999999',
      personNumber: '2147483647',
      sessionId: '2147483647',
      council: 'S',
      dateFrom: '1999-12-01',
      dateTo: '2026-11-19',
      limit: 100,
      offset: Number.MAX_SAFE_INTEGER,
    });
    expect(result.isError).not.toBe(true);
    const passageQuery = http.calls
      .map((call) => new URL(call.request.url))
      .find((url) => url.pathname === '/odata.svc/Transcript');
    expect(passageQuery?.searchParams.get('$orderby')).toBe(
      'MeetingDate asc,MeetingVerbalixOid asc,IdSubject asc,SortOrder asc,ID asc',
    );
    expect(passageQuery?.searchParams.get('$skip')).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(passageQuery?.searchParams.get('$filter')).toContain(
      "MeetingCouncilAbbreviation eq 'S' and MeetingDate ge '19991201' and MeetingDate le '20261119'",
    );
    expect((passageQuery?.search.length ?? Infinity) - 1).toBeLessThanOrEqual(2048);
  });

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

/** Serve 16.077: the business, its subject reads, a passage per requested subject, no lookups. */
function companyLawBusiness(withCount = true) {
  http = parliamentHttp((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/odata.svc/Business('))
      return Response.json({ d: { ID: 20160077, Language: 'DE' } });
    if (url.pathname === '/odata.svc/SubjectBusiness')
      return requestedSubjects(url).length > 0
        ? subjectBusinessPage(url, [])
        : companyLawSubjectPage(url, withCount);
    if (url.pathname === '/odata.svc/Transcript') {
      const results = requestedSubjects(url).map((IdSubject, i) => ({
        ID: String(1000 + i),
        Language: 'DE',
        IdSubject,
      }));
      return Response.json({ d: { results, __count: String(results.length) } });
    }
    throw new Error(`Unexpected Parliament path ${url.pathname}`);
  });
}

function callUrls(): URL[] {
  return http?.calls.map((call) => new URL(call.request.url)) ?? [];
}

/** SubjectBusiness reads of a business's subjects, as distinct from the subjectBusinesses lookup. */
function subjectReads(): URL[] {
  return callUrls().filter(
    (url) => url.pathname === '/odata.svc/SubjectBusiness' && requestedSubjects(url).length === 0,
  );
}

const COMPANY_LAW_SUBJECTS = "Language eq 'DE' and (BusinessNumber eq 20160077)";

describe('broad business narrowing', () => {
  it.each([
    {
      input: { council: 'S', dateFrom: '2020-06-01', dateTo: '2020-06-19' },
      predicates:
        "Subjects/Meetings/Council eq 2 and Subjects/Meetings/Date ge datetime'2020-06-01T00:00:00' and Subjects/Meetings/Date le datetime'2020-06-19T23:59:59.999'",
      subjects: ['48962', '49174', '49178', '49399', '49435'],
    },
    {
      input: { sessionId: '5104' },
      predicates: 'Subjects/Meetings/IdSession eq 5104',
      subjects: ['48962', '48974', '49091', '49174', '49178', '49366', '49399', '49435', '49477'],
    },
    {
      input: { council: 'N' },
      predicates: 'Subjects/Meetings/Council eq 1',
      subjects: [
        '43617',
        '43642',
        '43644',
        '46336',
        '46349',
        '46351',
        '48173',
        '48507',
        '48719',
        '48974',
        '49091',
        '49366',
        '49477',
      ],
    },
    {
      input: { dateFrom: '2020-06-19', dateTo: '2020-06-19' },
      predicates:
        "Subjects/Meetings/Date ge datetime'2020-06-19T00:00:00' and Subjects/Meetings/Date le datetime'2020-06-19T23:59:59.999'",
      subjects: ['49435', '49477'],
    },
    {
      input: { council: 'Ständerat', dateTo: '2018-12-11', personNumber: '4102' },
      predicates:
        "Subjects/Meetings/Council eq 2 and Subjects/Meetings/Date le datetime'2018-12-11T23:59:59.999'",
      subjects: ['44960'],
    },
  ])('narrows a 27-subject business with $input', async ({ input, predicates, subjects }) => {
    companyLawBusiness();
    const result = await runToolContract(searchTranscriptsTool, {
      businessId: '20160077',
      ...input,
    });
    expect(result.isError).not.toBe(true);
    expect(callUrls().map((url) => url.pathname)).toEqual([
      "/odata.svc/Business(ID=20160077,Language='DE')",
      '/odata.svc/SubjectBusiness',
      '/odata.svc/SubjectBusiness',
      '/odata.svc/Transcript',
      '/odata.svc/SubjectBusiness',
    ]);
    const [all, narrowed] = subjectReads();
    expect(all?.searchParams.get('$filter')).toBe(COMPANY_LAW_SUBJECTS);
    expect(narrowed?.searchParams.get('$filter')).toBe(
      `Language eq 'DE' and (BusinessNumber eq 20160077 and ${predicates})`,
    );
    expect(narrowed?.searchParams.get('$top')).toBe('20');
    const passageQuery = callUrls().find((url) => url.pathname === '/odata.svc/Transcript');
    expect(passageQuery && requestedSubjects(passageQuery)).toEqual(subjects);
    expect(
      searchTranscriptsTool.output
        .parse(result.structuredContent)
        .transcripts.map((passage) => passage.subjectId),
    ).toEqual(subjects);
    expect(result.structuredContent).toMatchObject({
      scopeFound: true,
      returnedCount: subjects.length,
      totalCount: subjects.length,
      hasMore: false,
    });
    for (const url of callUrls()) expect(url.search.length - 1).toBeLessThanOrEqual(2048);
    expectVoteParity(result);
  });

  it('narrows without source counts, probing each full subject page once', async () => {
    companyLawBusiness(false);
    const result = await runToolContract(searchTranscriptsTool, {
      businessId: '20160077',
      council: 'S',
      dateFrom: '2020-06-01',
      dateTo: '2020-06-19',
    });
    expect(result.isError).not.toBe(true);
    expect(
      subjectReads().map((url) => [
        url.searchParams.get('$filter') === COMPANY_LAW_SUBJECTS,
        url.searchParams.get('$skip'),
        url.searchParams.get('$top'),
      ]),
    ).toEqual([
      [true, '0', '20'],
      [true, '20', '1'],
      [false, '0', '20'],
    ]);
    expect(result.structuredContent).toMatchObject({ returnedCount: 5, totalCount: 5 });
  });

  it.each([true, false])(
    'refuses a business that keeps more than 20 subjects after narrowing (count=$0)',
    async (withCount) => {
      companyLawBusiness(withCount);
      const result = await runToolContract(searchTranscriptsTool, {
        businessId: '20160077',
        dateFrom: '2018-01-01',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('council, session, and date filters'),
          data: {
            reason: 'business_scope_too_broad',
            recovery: { hint: expect.stringContaining('council, sessionId, or a narrower date') },
          },
        },
      });
      expect(textContent(result)).toContain('section subjects');
      const narrowed = `Language eq 'DE' and (BusinessNumber eq 20160077 and Subjects/Meetings/Date ge datetime'2018-01-01T00:00:00')`;
      expect(
        subjectReads().map((url) => [
          url.searchParams.get('$filter'),
          url.searchParams.get('$skip'),
        ]),
      ).toEqual(
        withCount
          ? [
              [COMPANY_LAW_SUBJECTS, '0'],
              [narrowed, '0'],
            ]
          : [
              [COMPANY_LAW_SUBJECTS, '0'],
              [COMPANY_LAW_SUBJECTS, '20'],
              [narrowed, '0'],
              [narrowed, '20'],
            ],
      );
      expect(callUrls().some((url) => url.pathname === '/odata.svc/Transcript')).toBe(false);
    },
  );

  it('refuses a broad business searched by speaker alone without a narrowed read', async () => {
    companyLawBusiness();
    const result = await runToolContract(searchTranscriptsTool, {
      businessId: '20160077',
      personNumber: '4102',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        message: 'This business has more than 20 associated debate subjects.',
        data: { reason: 'business_scope_too_broad' },
      },
    });
    expect(subjectReads().map((url) => url.searchParams.get('$filter'))).toEqual([
      COMPANY_LAW_SUBJECTS,
    ]);
    expect(callUrls()).toHaveLength(2);
  });

  it('answers a business narrowed to no subject as a no-match, without a passage query', async () => {
    companyLawBusiness();
    const result = await runToolContract(searchTranscriptsTool, {
      businessId: '20160077',
      council: 'S',
      dateFrom: '2018-06-14',
      dateTo: '2018-06-15',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      scopeFound: true,
      transcripts: [],
      returnedCount: 0,
      totalCount: 0,
      hasMore: false,
    });
    expect(textContent(result)).toContain('No Bulletin passages matched');
    expect(textContent(result)).not.toContain('no published debate subjects');
    expect(callUrls().map((url) => url.pathname)).toEqual([
      "/odata.svc/Business(ID=20160077,Language='DE')",
      '/odata.svc/SubjectBusiness',
      '/odata.svc/SubjectBusiness',
    ]);
    expectVoteParity(result);
  });

  it.each([true, false])(
    'keeps a business of 20 subjects on its unnarrowed path despite meeting filters (count=$0)',
    async (withCount) => {
      const subjects = subjectsFixture(20, withCount);
      const result = await runToolContract(searchTranscriptsTool, {
        businessId: '20991234',
        council: 'S',
        sessionId: '5104',
        dateFrom: '2020-06-01',
        dateTo: '2020-06-19',
      });
      expect(result.isError).not.toBe(true);
      expect(subjectReads()).toHaveLength(withCount ? 1 : 2);
      expect(
        callUrls().some((url) => url.searchParams.get('$filter')?.includes('Subjects/Meetings')),
      ).toBe(false);
      const passageQuery = callUrls().find((url) => url.pathname === '/odata.svc/Transcript');
      expect(passageQuery?.searchParams.get('$filter')).toBe(
        `Language eq 'DE' and ((${subjects.map((row) => `IdSubject eq ${row.IdSubject}L`).join(' or ')}) and IdSession eq '5104' and MeetingCouncilAbbreviation eq 'S' and MeetingDate ge '20200601' and MeetingDate le '20200619')`,
      );
      expect(result.structuredContent).toMatchObject({ returnedCount: 20, totalCount: 20 });
    },
  );
});

/** Resolve inside a real workflow; `before` runs inside it, ahead of the lookup. */
function lookup(ids: string[], options: { signal?: AbortSignal; before?: () => void } = {}) {
  return withWorkflow(
    createMockContext(options.signal ? { signal: options.signal } : {}),
    async (workflow) => {
      options.before?.();
      const result = await resolveSubjectBusinesses(ids, 'de', workflow);
      return { result, sources: workflow.sources.map((source) => source.url) };
    },
  );
}

/** A lookup request that settles only when its signal aborts. */
function hang(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) =>
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
  );
}

function lookupCalls(): URL[] {
  return http?.calls.map((call) => new URL(call.request.url)) ?? [];
}

const useLookupClock = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

describe('subject business lookup', () => {
  it('sends nothing for a page without debate subjects', async () => {
    http = parliamentHttp(() => {
      throw new Error('Unexpected request.');
    });
    await expect(lookup([])).resolves.toEqual({
      result: { status: 'resolved', entries: [] },
      sources: [],
    });
    expect(http.calls).toHaveLength(0);
  });

  it('batches 100 subjects into two language-scoped lookups of 50 in first-appearance order', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(200_000 - i));
    const mappings = [
      { IdSubject: ids[0], BusinessNumber: 20_010_002, Language: 'DE', SortOrder: 2, Title: 'B' },
      { IdSubject: ids[0], BusinessNumber: 20_010_001, Language: 'DE', SortOrder: 1, Title: 'A' },
      { IdSubject: ids[1], BusinessNumber: 20_010_003, Language: 'DE', SortOrder: 1, Title: null },
      {
        IdSubject: ids[99],
        BusinessNumber: 20_010_004,
        Language: 'DE',
        SortOrder: 1,
        BusinessShortNumber: '01.0004',
      },
    ];
    http = parliamentHttp((request) => subjectBusinessPage(new URL(request.url), mappings));
    const { result, sources } = await lookup(ids);
    if (result.status !== 'resolved') throw new Error('Expected a resolved lookup.');
    expect(result.entries.map((entry) => entry.subjectId)).toEqual(ids);
    expect(result.entries[0]?.businesses).toEqual([
      { businessId: '20010001', title: 'A' },
      { businessId: '20010002', title: 'B' },
    ]);
    expect(result.entries[1]?.businesses).toEqual([{ businessId: '20010003' }]);
    expect(result.entries[2]?.businesses).toEqual([]);
    expect(result.entries[99]?.businesses).toEqual([
      { businessId: '20010004', shortNumber: '01.0004' },
    ]);
    const urls = lookupCalls();
    expect(urls.map(requestedSubjects)).toEqual([ids.slice(0, 50), ids.slice(50)]);
    expect(urls[0]?.searchParams.get('$filter')).toMatch(
      /^Language eq 'DE' and \(IdSubject eq 200000L or IdSubject eq 199999L or /,
    );
    expect(urls[0]?.searchParams.get('$select')).toBe(
      'IdSubject,BusinessNumber,Language,BusinessShortNumber,Title,SortOrder',
    );
    expect(urls[0]?.searchParams.get('$orderby')).toBe(
      'IdSubject asc,SortOrder asc,BusinessNumber asc',
    );
    for (const url of urls) expect(url.search.length - 1).toBeLessThanOrEqual(2048);
    expect(sources).toEqual(http.calls.map((call) => call.request.url));
  });

  it('sizes batches by encoded bytes so maximum-width subject IDs never overrun the source limit', async () => {
    const ids = Array.from({ length: 100 }, (_, i) =>
      String(9_223_372_036_854_775_807n - BigInt(i)),
    );
    const mappings = [
      ...ids.slice(0, 48).flatMap((id, i) =>
        Array.from({ length: 21 }, (_, order) => ({
          IdSubject: id,
          BusinessNumber: 20_000_000 + i * 100 + order,
          Language: 'DE',
          SortOrder: order + 1,
        })),
      ),
      { ...marriageSubjectBusiness, IdSubject: ids[99] },
    ];
    http = parliamentHttp((request) => {
      const url = new URL(request.url);
      return url.search.length - 1 > 2048
        ? new Response('<html>404 - File or directory not found.</html>', {
            status: 404,
            headers: { 'Content-Type': 'text/html' },
          })
        : subjectBusinessPage(url, mappings);
    });
    const { result } = await lookup(ids);
    if (result.status !== 'resolved') throw new Error('Expected a resolved lookup.');
    expect(result.entries.map((entry) => entry.subjectId)).toEqual(ids);
    expect(result.entries[0]?.businesses).toHaveLength(21);
    expect(result.entries[99]?.businesses).toEqual([
      { businessId: '20130468', shortNumber: '13.468', title: 'Ehe für alle' },
    ]);
    const urls = lookupCalls();
    expect(
      urls.map((url) => [requestedSubjects(url).length, url.searchParams.get('$skip')]),
    ).toEqual([
      [48, '0'],
      [48, '1000'],
      [48, '0'],
      [4, '0'],
    ]);
    for (const url of urls) expect(url.search.length - 1).toBeLessThanOrEqual(2048);
  });

  it('sizes a batch so its later source pages fit too, not only its first', async () => {
    // 48 maximum-width IDs plus '10' fit at $skip=0 (2046 bytes) but not at $skip=1000 (2049).
    const ids = [
      ...Array.from({ length: 48 }, (_, i) => String(9_223_372_036_854_775_807n - BigInt(i))),
      '10',
    ];
    const mappings = ids.slice(0, 48).flatMap((id, i) =>
      Array.from({ length: 21 }, (_, order) => ({
        IdSubject: id,
        BusinessNumber: 20_000_000 + i * 100 + order,
        Language: 'DE',
        SortOrder: order + 1,
      })),
    );
    http = parliamentHttp((request) => subjectBusinessPage(new URL(request.url), mappings));
    const { result } = await lookup(ids);
    expect(result.status).toBe('resolved');
    const urls = lookupCalls();
    expect(
      urls.map((url) => [requestedSubjects(url).length, url.searchParams.get('$skip')]),
    ).toEqual([
      [48, '0'],
      [48, '1000'],
      [1, '0'],
    ]);
    for (const url of urls) expect(url.search.length - 1).toBeLessThanOrEqual(2048);
  });

  it('drains every mapping of a batch beyond one 1000-row source page', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(300_000 + i));
    const mappings = ids.flatMap((id, i) =>
      Array.from({ length: 21 }, (_, order) => ({
        IdSubject: id,
        BusinessNumber: 20_000_000 + i * 100 + order,
        Language: 'DE',
        SortOrder: order + 1,
      })),
    );
    http = parliamentHttp((request) => subjectBusinessPage(new URL(request.url), mappings));
    const { result } = await lookup(ids);
    if (result.status !== 'resolved') throw new Error('Expected a resolved lookup.');
    expect(result.entries.map((entry) => entry.businesses.length)).toEqual(ids.map(() => 21));
    expect(result.entries[49]?.businesses.at(-1)).toEqual({ businessId: '20004920' });
    expect(lookupCalls().map((url) => url.searchParams.get('$skip'))).toEqual(['0', '1000']);
  });

  it('recovers with its one retry inside the bound', async () => {
    useLookupClock();
    http = parliamentHttp((request) =>
      http?.calls.length === 1
        ? new Response('', { status: 503 })
        : subjectBusinessPage(new URL(request.url), [marriageSubjectBusiness]),
    );
    const pending = lookup(['50854']);
    await vi.advanceTimersByTimeAsync(2_500);
    const { result, sources } = await pending;
    expect(result).toEqual({
      status: 'resolved',
      entries: [
        {
          subjectId: '50854',
          businesses: [{ businessId: '20130468', shortNumber: '13.468', title: 'Ehe für alle' }],
        },
      ],
    });
    expect(http.calls).toHaveLength(2);
    expect(sources).toHaveLength(1);
  });

  it.each<{
    name: string;
    respond: () => Response;
    reason: string;
    requests: number;
    /** Responses read whole before their rows were rejected; provenance keeps every one. */
    recorded?: number;
  }>([
    {
      name: 'HTTP 429 asking past the retry cap',
      respond: () => new Response('', { status: 429, headers: { 'Retry-After': '999' } }),
      reason: 'rate_limited',
      requests: 1,
    },
    {
      name: 'HTTP 429 twice',
      respond: () => new Response('', { status: 429 }),
      reason: 'rate_limited',
      requests: 2,
    },
    {
      name: 'HTTP 503 twice',
      respond: () => new Response('', { status: 503 }),
      reason: 'upstream_unavailable',
      requests: 2,
    },
    {
      name: 'an HTTP 502 gateway page',
      respond: () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      reason: 'upstream_unavailable',
      requests: 2,
    },
    ...[401, 403, 404, 422].map((status) => ({
      name: `HTTP ${status}`,
      respond: () => new Response('', { status }),
      reason: 'upstream_unavailable',
      requests: 1,
    })),
    {
      name: 'HTTP 408 twice',
      respond: () => new Response('', { status: 408 }),
      reason: 'upstream_unavailable',
      requests: 2,
    },
    {
      name: 'an unreachable network',
      respond: () => {
        throw new TypeError('fetch failed');
      },
      reason: 'upstream_unavailable',
      requests: 2,
    },
    {
      name: 'a non-network fetch failure',
      respond: () => {
        throw new Error('Socket gave up');
      },
      reason: 'upstream_unavailable',
      requests: 1,
    },
    {
      name: 'a broken body stream',
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"d":'));
              controller.error(new TypeError('connection reset'));
            },
          }),
        ),
      reason: 'upstream_unavailable',
      requests: 2,
    },
    {
      name: 'an HTML gateway page served with HTTP 200',
      respond: () => new Response('<!doctype html><html>Gateway</html>'),
      reason: 'upstream_unavailable',
      requests: 2,
    },
    {
      name: 'malformed JSON',
      respond: () => new Response('{broken'),
      reason: 'unexpected_response',
      requests: 1,
    },
    {
      name: 'a schema-failing row',
      respond: () =>
        Response.json({ d: { results: [{ ...marriageSubjectBusiness, SortOrder: 'first' }] } }),
      reason: 'unexpected_response',
      requests: 1,
    },
    {
      name: 'a row in another language',
      respond: () =>
        Response.json({ d: { results: [{ ...marriageSubjectBusiness, Language: 'FR' }] } }),
      reason: 'unexpected_response',
      requests: 1,
      recorded: 1,
    },
    {
      name: 'a row for an unrequested subject',
      respond: () =>
        Response.json({ d: { results: [{ ...marriageSubjectBusiness, IdSubject: '50855' }] } }),
      reason: 'unexpected_response',
      requests: 1,
      recorded: 1,
    },
    {
      name: 'a duplicated row',
      respond: () =>
        Response.json({ d: { results: [marriageSubjectBusiness, marriageSubjectBusiness] } }),
      reason: 'unexpected_response',
      requests: 1,
      recorded: 1,
    },
  ])('degrades on $name', async ({ respond, reason, requests, recorded = 0 }) => {
    useLookupClock();
    http = parliamentHttp(respond);
    const pending = lookup(['50854']);
    await vi.advanceTimersByTimeAsync(2_500);
    const { result, sources } = await pending;
    expect(result).toEqual({ status: 'unavailable', reason });
    expect(sources).toEqual(http.calls.slice(0, recorded).map((call) => call.request.url));
    expect(http.calls).toHaveLength(requests);
  });

  it('fails the call on a programmer error in its own code', async () => {
    http = parliamentHttp((request) =>
      subjectBusinessPage(new URL(request.url), [marriageSubjectBusiness]),
    );
    // Recording provenance on a frozen ledger throws a TypeError inside the client, not upstream.
    const sources = Object.freeze<Source[]>([]) as Source[];
    const failure = await withWorkflow(createMockContext(), (workflow) =>
      resolveSubjectBusinesses(['50854'], 'de', { ...workflow, sources }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(McpError);
    expect(http.calls).toHaveLength(1);
  });

  it('degrades when a request outlasts the 10-second bound', async () => {
    useLookupClock();
    http = parliamentHttp(hang);
    let settled = false;
    const pending = lookup(['50854']).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      result: { status: 'unavailable', reason: 'bound_expired' },
      sources: [],
    });
    expect(http.calls).toHaveLength(1);
  });

  it('ends the bound one second before the workflow deadline', async () => {
    useLookupClock();
    http = parliamentHttp(hang);
    let settled = false;
    const pending = lookup(['50854'], { before: () => vi.advanceTimersByTime(36_000) }).finally(
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      result: { status: 'unavailable', reason: 'bound_expired' },
    });
    expect(http.calls).toHaveLength(1);
  });

  it.each([44_000, 44_500])(
    'sends nothing when the lookup would start %i ms into the workflow',
    async (elapsedMs) => {
      useLookupClock();
      http = parliamentHttp(() => {
        throw new Error('Unexpected request.');
      });
      await expect(
        lookup(['50854'], { before: () => vi.advanceTimersByTime(elapsedMs) }),
      ).resolves.toEqual({
        result: { status: 'unavailable', reason: 'bound_expired' },
        sources: [],
      });
      expect(http.calls).toHaveLength(0);
    },
  );

  it('fails on an expired workflow deadline instead of degrading', async () => {
    useLookupClock();
    http = parliamentHttp(() => {
      throw new Error('Unexpected request.');
    });
    await expect(
      lookup(['50854'], { before: () => vi.advanceTimersByTime(45_000) }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'workflow_deadline_exceeded' },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects an expired workflow deadline from the lookup itself, before the enclosing workflow checks', async () => {
    useLookupClock();
    http = parliamentHttp(() => {
      throw new Error('Unexpected request.');
    });
    let outcome: { thrown?: unknown; returned?: unknown } = {};
    await withWorkflow(createMockContext(), async (workflow) => {
      vi.advanceTimersByTime(45_000);
      outcome = await resolveSubjectBusinesses(['50854'], 'de', workflow).then(
        (returned) => ({ returned }),
        (thrown: unknown) => ({ thrown }),
      );
    }).catch(() => undefined);
    expect(outcome).not.toHaveProperty('returned');
    expect(outcome.thrown).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'workflow_deadline_exceeded' },
    });
  });

  it('rethrows caller cancellation during a request', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Stop the lookup.', 'AbortError');
    http = parliamentHttp((request) => {
      const settled = hang(request);
      controller.abort(reason);
      return settled;
    });
    await expect(lookup(['50854'], { signal: controller.signal })).rejects.toBe(reason);
    expect(http.calls).toHaveLength(1);
  });

  it('rethrows caller cancellation during the retry backoff', async () => {
    useLookupClock();
    const controller = new AbortController();
    const reason = new DOMException('Stop retrying the lookup.', 'AbortError');
    http = parliamentHttp(() => new Response('', { status: 503 }));
    const pending = lookup(['50854'], { signal: controller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await assertion;
    expect(http.calls).toHaveLength(1);
  });
});
