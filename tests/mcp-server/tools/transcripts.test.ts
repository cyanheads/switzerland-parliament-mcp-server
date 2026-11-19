/**
 * @fileoverview Bulletin scopes, original-text disclosure, and both public MCP surfaces.
 * @module tests/mcp-server/tools/transcripts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchTranscriptsTool } from '@/mcp-server/tools/definitions/search-transcripts.tool.js';
import {
  decodeParliamentMarkdown,
  parliamentHttp,
  resultBytes,
  textContent,
} from '../../helpers/parliament.js';
import {
  marriageSpeechRows,
  marriageSubjectBusiness,
  requestedSubjects,
  sansPapiersSubjectBusinesses,
  subjectBusinessPage,
  subjectId,
  transcriptId,
  transcriptRow,
  transcriptText,
} from '../../helpers/transcript-fixtures.js';
import { expectVoteParity } from '../../helpers/vote-fixtures.js';

if (!searchTranscriptsTool.enrichment)
  throw new Error('Transcript enrichment contract must be declared.');
const WireSchema = searchTranscriptsTool.output.extend(searchTranscriptsTool.enrichment);

let http: ReturnType<typeof parliamentHttp>;
let rows: Record<string, unknown>[];
let mappings: Record<string, unknown>[];
beforeEach(() => {
  rows = [transcriptRow];
  mappings = [];
  http = parliamentHttp((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/odata.svc/Transcript('))
      return Response.json({ d: rows[0] ?? null });
    if (url.pathname === '/odata.svc/SubjectBusiness') return subjectBusinessPage(url, mappings);
    if (url.pathname !== '/odata.svc/Transcript')
      throw new Error(`Unexpected path ${url.pathname}`);
    const offset = Number(url.searchParams.get('$skip'));
    const top = Number(url.searchParams.get('$top'));
    return Response.json({
      d: { results: rows.slice(offset, offset + top), __count: String(rows.length) },
    });
  });
});
afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

/** Serve passage pages from `rows` and answer every SubjectBusiness lookup with `lookup`. */
function routeLookup(lookup: (request: Request) => Response | Promise<Response>) {
  http.reset();
  http.route({
    match: () => true,
    respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/odata.svc/SubjectBusiness') return lookup(request);
      if (url.pathname.startsWith('/odata.svc/Transcript('))
        return Response.json({ d: rows[0] ?? null });
      return Response.json({ d: { results: rows, __count: String(rows.length) } });
    },
  });
}

function lookupUrls(): URL[] {
  return http.calls
    .map((call) => new URL(call.request.url))
    .filter((url) => url.pathname === '/odata.svc/SubjectBusiness');
}

describe('chparl_search_transcripts', () => {
  it.each([
    { exact: true, disclosure: undefined, expected: true },
    { exact: true, disclosure: true, expected: true },
    { exact: true, disclosure: false, expected: false },
    { exact: false, disclosure: undefined, expected: false },
    { exact: false, disclosure: true, expected: true },
    { exact: false, disclosure: false, expected: false },
  ])(
    'resolves includeText=$disclosure in exact=$exact mode and preserves the original text language',
    async ({ exact, disclosure, expected }) => {
      const result = await runToolContract(searchTranscriptsTool, {
        ...(exact ? { transcriptId } : { sessionId: '50' }),
        ...(disclosure === undefined ? {} : { includeText: disclosure }),
      });
      expect(result.isError).not.toBe(true);
      const output = searchTranscriptsTool.output.parse(result.structuredContent);
      expect(output.transcripts[0]).toMatchObject({
        transcriptId,
        subjectId,
        metadataLanguage: 'de',
        languageOfText: 'fr',
        speakerName: ' Synthetic [Speaker] ',
        speakerFunction: '',
        meetingDate: '2026-10-25',
        startTime: '1970-01-01T02:00:00.000+02:00',
        endTime: '1970-01-01T02:00:01.000+02:00',
        textSizeBytes: new TextEncoder().encode(transcriptText).byteLength,
        sourceUrl:
          "https://ws.parlament.ch/odata.svc/Transcript(ID=9007199254740993L,Language='DE')?$format=json",
      });
      expect(WireSchema.parse(result.structuredContent).effectiveFilters).toMatchObject({
        language: 'de',
        includeText: expected,
      });
      const passage = output.transcripts[0];
      if (expected) {
        expect(passage?.text).toBe(transcriptText);
        expect(passage?.references).toEqual([
          {
            kind: 'link',
            originalUrl: 'https://example.test/a?q=1&amp;x=2',
            url: 'https://example.test/a?q=1&x=2',
          },
          { kind: 'image', originalUrl: '/image.png' },
          {
            kind: 'image',
            originalUrl: 'https://example.test/image.png',
            url: 'https://example.test/image.png',
            label: 'Original',
          },
        ]);
      } else {
        expect(passage).not.toHaveProperty('text');
        expect(passage).not.toHaveProperty('references');
      }
      if (exact) {
        expect(output.found).toBe(true);
        expect(result.structuredContent).not.toHaveProperty('returnedCount');
        expect(WireSchema.parse(result.structuredContent).effectiveFilters).not.toHaveProperty(
          'limit',
        );
        expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe(
          "/odata.svc/Transcript(ID=9007199254740993L,Language='DE')",
        );
      } else {
        expect(output).not.toHaveProperty('found');
        expect(result.structuredContent).toMatchObject({
          returnedCount: 1,
          effectiveLimit: expected ? 3 : 20,
        });
      }
      expect(
        new URL(http.calls[0]?.request.url ?? '').searchParams.get('$select')?.split(','),
      ).toContain('Text');
      const decoded = expectVoteParity(result);
      if (expected) {
        expect(decoded.strings).toContain(transcriptText);
        expect(decoded.links).toContain('https://example.test/a?q=1&x=2');
        expect(decoded.images).toContain('https://example.test/image.png');
        expect(decoded.strings.some((line) => line.includes('/image.png'))).toBe(true);
      }
    },
  );

  it('preserves missing language/text as unknown and distinguishes an existing empty Text', async () => {
    rows = [
      { ID: transcriptId, Language: 'DE', Text: '' },
      { ID: '9007199254740994', Language: 'DE', Text: null },
      { ID: '9007199254740995', Language: 'DE' },
    ];
    const result = await runToolContract(searchTranscriptsTool, {
      sessionId: '50',
      includeText: true,
    });
    expect(searchTranscriptsTool.output.parse(result.structuredContent).transcripts).toEqual([
      {
        transcriptId,
        metadataLanguage: 'de',
        sourceUrl:
          "https://ws.parlament.ch/odata.svc/Transcript(ID=9007199254740993L,Language='DE')?$format=json",
        textSizeBytes: 0,
        text: '',
        references: [],
      },
      {
        transcriptId: '9007199254740994',
        metadataLanguage: 'de',
        sourceUrl:
          "https://ws.parlament.ch/odata.svc/Transcript(ID=9007199254740994L,Language='DE')?$format=json",
      },
      {
        transcriptId: '9007199254740995',
        metadataLanguage: 'de',
        sourceUrl:
          "https://ws.parlament.ch/odata.svc/Transcript(ID=9007199254740995L,Language='DE')?$format=json",
      },
    ]);
    expectVoteParity(result);
  });

  it('fills a passage businessId only from its vote announcement', async () => {
    rows = [
      { ...marriageSpeechRows[0], VoteId: '24100', VoteBusinessNumber: 20130468 },
      marriageSpeechRows[1] ?? {},
    ];
    const result = await runToolContract(searchTranscriptsTool, { sessionId: '5107' });
    const passages = searchTranscriptsTool.output.parse(result.structuredContent).transcripts;
    expect(passages[0]).toMatchObject({ voteId: '24100', businessId: '20130468' });
    expect(passages[1]).not.toHaveProperty('businessId');
    expectVoteParity(result);
  });

  it('reads a page of passages without debate subjects in exactly one request', async () => {
    rows = [
      { ID: '1001', Language: 'DE' },
      { ID: '1002', Language: 'DE', IdSubject: null },
    ];
    const result = await runToolContract(searchTranscriptsTool, { sessionId: '50' });
    expect(result.isError).not.toBe(true);
    expect(searchTranscriptsTool.output.parse(result.structuredContent).transcripts).toHaveLength(
      2,
    );
    expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
      '/odata.svc/Transcript',
    ]);
    expect(result.structuredContent).not.toHaveProperty('subjectBusinesses');
  });

  it('conjoins Int64 subject, speaker, quoted session, normalized council, calendar dates and escaped substring', async () => {
    const result = await runToolContract(searchTranscriptsTool, {
      subjectId,
      personNumber: '1001',
      sessionId: '50',
      council: ' Conseil national ',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      query: "  l'été & 原  ",
      language: ' DE ',
    });
    expect(result.isError).not.toBe(true);
    expect(WireSchema.parse(result.structuredContent).effectiveFilters).toMatchObject({
      subjectId,
      personNumber: '1001',
      sessionId: '50',
      council: 'N',
      query: "l'été & 原",
      language: 'de',
    });
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and ((IdSubject eq 9007199254740995L) and PersonNumber eq 1001 and IdSession eq '50' and MeetingCouncilAbbreviation eq 'N' and MeetingDate ge '20261001' and MeetingDate le '20261031' and substringof('l''été & 原',Text))",
    );
    expect(url.searchParams.get('$orderby')).toBe(
      'MeetingDate asc,MeetingVerbalixOid asc,IdSubject asc,SortOrder asc,ID asc',
    );
    expectVoteParity(result);
  });

  it.each([
    { dateFrom: '2026-10-01', dateTo: '2026-10-31', query: 'é' },
    { dateFrom: '1999-01-01' },
    { dateTo: '1999-01-01' },
    { personNumber: '1001' },
    { subjectId },
    { sessionId: '50', query: 'é' },
  ])('accepts each valid search scope without an invented date cutoff (%o)', async (input) => {
    const result = await runToolContract(searchTranscriptsTool, input);
    expect(result.isError).not.toBe(true);
    expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
      '/odata.svc/Transcript',
      '/odata.svc/SubjectBusiness',
    ]);
    expectVoteParity(result);
  });

  it.each([
    { includeText: false, max: 100, count: 105 },
    { includeText: true, max: 10, count: 15 },
  ])(
    'requests the includeText=$includeText maximum and returns a full page',
    async ({ includeText, max, count }) => {
      rows = Array.from({ length: count }, (_, i) => ({ ID: String(1000 + i), Language: 'DE' }));
      const result = await runToolContract(searchTranscriptsTool, {
        sessionId: '50',
        includeText,
        limit: 10_000,
      });
      expect(result.structuredContent).toMatchObject({
        effectiveLimit: max,
        totalCount: count,
        returnedCount: max,
        hasMore: true,
        nextOffset: max,
        notice: expect.stringContaining(`clamped to ${max}`),
      });
      expect(
        searchTranscriptsTool.output
          .parse(result.structuredContent)
          .transcripts.map((passage) => passage.transcriptId),
      ).toEqual(rows.slice(0, max).map((row) => row.ID));
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$top')).toBe(String(max));
      expectVoteParity(result);
    },
  );

  it('returns a full text page of large passages and advances by delivered records', async () => {
    rows = Array.from({ length: 20 }, (_, i) => ({
      ID: String(1000 + i),
      Language: 'DE',
      Text: `<p>${'原'.repeat(900)}\r\n${i}</p>`,
    }));
    const result = await runToolContract(searchTranscriptsTool, {
      sessionId: '50',
      includeText: true,
      limit: 10,
      offset: 2,
    });
    const passages = searchTranscriptsTool.output.parse(result.structuredContent).transcripts;
    expect(passages.map((row) => row.text)).toEqual(rows.slice(2, 12).map((row) => row.Text));
    expect(result.structuredContent).toMatchObject({
      returnedCount: 10,
      effectiveLimit: 10,
      nextOffset: 12,
      totalCount: 20,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    // Ten 2.7 KB passages on both surfaces exceed 24,000 bytes; no byte budget cuts the page.
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expectVoteParity(result);
  });

  it('retains an indivisible oversized passage whole in exact=true mode', async () => {
    const original = `<p>${'é原'.repeat(10_000)}\r\n</p>`;
    rows = [{ ...transcriptRow, Text: original }];
    const result = await runToolContract(searchTranscriptsTool, { transcriptId });
    expect(result.structuredContent).toMatchObject({
      transcripts: [{ text: original }],
      notice: expect.stringContaining('returned whole'),
    });
    expect(textContent(result)).toContain(transcriptId);
    expectVoteParity(result);
  });

  it('returns a passage over 24,000 bytes whole on a limit 1 page without a size notice', async () => {
    const original = `<p>${'é原'.repeat(10_000)}\r\n</p>`;
    rows = [
      { ...transcriptRow, Text: original },
      { ...transcriptRow, ID: '9007199254740994' },
    ];
    const result = await runToolContract(searchTranscriptsTool, {
      sessionId: '50',
      includeText: true,
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      transcripts: [{ transcriptId, text: original }],
      returnedCount: 1,
      totalCount: 2,
      hasMore: true,
      nextOffset: 1,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expectVoteParity(result);
  });

  it.each([404, 200])(
    'reports an exact passage miss for HTTP %i with discovery guidance',
    async (status) => {
      http.reset();
      http.route({
        match: () => true,
        respond: Response.json(status === 404 ? {} : { d: null }, { status }),
      });
      const result = await runToolContract(searchTranscriptsTool, { transcriptId });
      expect(result.structuredContent).toMatchObject({
        found: false,
        transcripts: [],
        effectiveFilters: { includeText: true },
      });
      expect(result.structuredContent).not.toHaveProperty('returnedCount');
      expect(textContent(result)).toContain('subjectId, businessId, or sessionId');
      expectVoteParity(result);
    },
  );

  it('distinguishes zero hits and past end, combining clamp and empty guidance', async () => {
    rows = [];
    const empty = await runToolContract(searchTranscriptsTool, { sessionId: '50', limit: 10_000 });
    expect(empty.structuredContent).toMatchObject({
      transcripts: [],
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
    });
    expect(textContent(empty)).toContain('clamped to 100');
    expect(textContent(empty)).toContain('No Bulletin passages matched');
    rows = [transcriptRow];
    const past = await runToolContract(searchTranscriptsTool, { sessionId: '50', offset: 1 });
    expect(past.structuredContent).toMatchObject({
      transcripts: [],
      totalCount: 1,
      hasMore: false,
    });
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
    expect(textContent(past)).toContain('offset:0');
    expectVoteParity(empty);
    expectVoteParity(past);
  });

  it.each([
    [{}, 'search_scope_required'],
    [{ council: 'N' }, 'search_scope_required'],
    [{ query: 'text', subjectId }, 'text_scope_required'],
    [{ query: 'text', dateFrom: '2026-10-01' }, 'text_scope_required'],
    [{ query: 'text', dateFrom: '2026-10-01', dateTo: '2026-11-01' }, 'text_scope_required'],
    [{ businessId: '20991234', subjectId }, 'incompatible_fields'],
    ...[
      'subjectId',
      'businessId',
      'personNumber',
      'sessionId',
      'council',
      'dateFrom',
      'dateTo',
      'query',
      'limit',
      'offset',
    ].map(
      (field) =>
        [
          {
            transcriptId,
            [field]:
              field === 'limit'
                ? 1
                : field === 'offset'
                  ? 0
                  : field === 'dateFrom' || field === 'dateTo'
                    ? '2026-10-01'
                    : field === 'businessId'
                      ? '20991234'
                      : field === 'council'
                        ? 'N'
                        : '1',
          },
          'incompatible_fields',
        ] as const,
    ),
  ] as const)('exposes declared reason and usable recovery for %o', async (input, reason) => {
    const result = await runToolContract(searchTranscriptsTool, input);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason, recovery: { hint: expect.any(String) } },
      },
    });
    expect(textContent(result)).toContain(String(reason));
    expect(textContent(result)).toContain('Recovery:');
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    { transcriptId: '9223372036854775808' },
    { subjectId: '0' },
    { transcriptId: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: '50', limit: 0 },
    { sessionId: '50', limit: 10_001 },
    { sessionId: '50', offset: -1 },
    { sessionId: '50', offset: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: '50', dateFrom: '2026-02-30' },
  ])('rejects invalid boundaries before I/O (%o)', async (input) => {
    const result = await runToolContract(searchTranscriptsTool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects reversed dates with recovery and honors caller cancellation on both surfaces', async () => {
    const reversed = await runToolContract(searchTranscriptsTool, {
      dateFrom: '2026-10-02',
      dateTo: '2026-10-01',
    });
    expect(reversed.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { recovery: { hint: expect.stringContaining('ascending') } },
      },
    });
    expect(textContent(reversed)).toContain('ascending');
    const cancelled = await runToolContract(
      searchTranscriptsTool,
      { transcriptId },
      {
        context: { signal: AbortSignal.abort(new DOMException('Stop this debate.', 'AbortError')) },
      },
    );
    expect(cancelled.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message: 'Stop this debate.' },
    });
    expect(textContent(cancelled)).toContain('Stop this debate.');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses an over-long text query as request_too_long on both surfaces before any request', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        new URL(request.url).search.length - 1 > 2048
          ? new Response('<html>404 - File or directory not found.</html>', {
              status: 404,
              headers: { 'Content-Type': 'text/html' },
            })
          : Response.json({ d: { results: [], __count: '0' } }),
    });
    const result = await runToolContract(searchTranscriptsTool, {
      sessionId: '5107',
      query: 'é'.repeat(400),
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'request_too_long',
          recovery: { hint: 'Shorten the text filters and retry this tool.' },
        },
      },
    });
    expect(textContent(result)).toContain('request_too_long');
    expect(textContent(result)).toContain('Shorten the text filters and retry this tool.');
    expect(http.calls).toHaveLength(0);
  });

  it('publishes ambiguity and rate-limit recoveries without raw upstream errors', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: Response.json({
        d: {
          results: [
            { ID: 20991234, Language: 'DE' },
            { ID: 19991234, Language: 'DE' },
          ],
          __count: '2',
        },
      }),
    });
    const ambiguous = await runToolContract(searchTranscriptsTool, { businessId: '99.1234' });
    expect(ambiguous.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'ambiguous_business_number',
          recovery: { hint: expect.stringContaining('chparl_search_business') },
        },
      },
    });
    expect(textContent(ambiguous)).toContain('chparl_search_business');
    http.reset();
    http.route({
      match: () => true,
      respond: Response.json(
        { innererror: 'dotnet-private' },
        { status: 429, headers: { 'Retry-After': '999' } },
      ),
    });
    const limited = await runToolContract(searchTranscriptsTool, { transcriptId });
    expect(limited.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'upstream_rate_limited',
          retryAfter: '999',
          recovery: { hint: expect.stringContaining('topic coverage') },
        },
      },
    });
    expect(textContent(limited)).toContain('topic coverage');
    expect(JSON.stringify(limited)).not.toContain('dotnet-private');
  });
});

describe('chparl_search_transcripts subjectBusinesses', () => {
  it('resolves the Ehe für alle debate subject to its business on both surfaces', async () => {
    rows = marriageSpeechRows;
    mappings = [marriageSubjectBusiness];
    const result = await runToolContract(searchTranscriptsTool, {
      sessionId: '5107',
      query: 'Ehe für alle',
    });
    expect(result.isError).not.toBe(true);
    const output = searchTranscriptsTool.output.parse(result.structuredContent);
    expect(output.subjectBusinesses).toEqual([
      {
        subjectId: '50854',
        businesses: [{ businessId: '20130468', shortNumber: '13.468', title: 'Ehe für alle' }],
      },
    ]);
    expect(output.transcripts).toHaveLength(3);
    for (const passage of output.transcripts) expect(passage).not.toHaveProperty('businessId');
    expect(decodeParliamentMarkdown(textContent(result)).strings).toEqual(
      expect.arrayContaining([
        'subjectBusinesses[0].subjectId: 50854',
        'subjectBusinesses[0].businesses[0].businessId: 20130468',
        'subjectBusinesses[0].businesses[0].shortNumber: 13.468',
        'subjectBusinesses[0].businesses[0].title: Ehe für alle',
      ]),
    );
    expect(lookupUrls().map((url) => url.searchParams.get('$filter'))).toEqual([
      "Language eq 'DE' and (IdSubject eq 50854L)",
    ]);
    expect(output.provenance.sources.map((source) => source.url)).toEqual(
      http.calls.map((call) => call.request.url),
    );
    expectVoteParity(result);
  });

  it('lists a 13-business subject in SortOrder order and an unmapped subject as empty', async () => {
    rows = [
      { ID: '1', Language: 'DE', IdSubject: '3303' },
      { ID: '2', Language: 'DE', IdSubject: '999999' },
      { ID: '3', Language: 'DE', IdSubject: '3303' },
    ];
    mappings = sansPapiersSubjectBusinesses.toReversed();
    const result = await runToolContract(searchTranscriptsTool, { sessionId: '50' });
    const entries = searchTranscriptsTool.output.parse(result.structuredContent).subjectBusinesses;
    expect(entries?.map((entry) => entry.subjectId)).toEqual(['3303', '999999']);
    expect(entries?.[0]?.businesses.map((business) => business.businessId)).toEqual([
      '20013623',
      '20013592',
      '20013480',
      '20013476',
      '20013473',
      '20013149',
      '20013447',
      '20013442',
      '20013432',
      '20013587',
      '20013497',
      '20003370',
      '20013586',
    ]);
    expect(entries?.[0]?.businesses[1]).toEqual({
      businessId: '20013592',
      shortNumber: '01.3592',
      title: 'Aufenthaltsregelung für jugendliche "sans-papiers"',
    });
    expect(entries?.[1]).toEqual({ subjectId: '999999', businesses: [] });
    expect(textContent(result)).toContain('subjectBusinesses\\[1\\].businesses:** []');
    expect(lookupUrls()).toHaveLength(1);
    expectVoteParity(result);
  });

  it('resolves every subject of a 100-passage page in lookups that fit the source limit', async () => {
    rows = Array.from({ length: 120 }, (_, i) => ({
      ID: String(5000 + i),
      Language: 'DE',
      IdSubject: String(100_000 + i),
    }));
    mappings = rows.map((row, i) => ({
      IdSubject: row.IdSubject,
      BusinessNumber: 20_200_000 + i,
      Language: 'DE',
      SortOrder: 1,
    }));
    const subjects = rows.slice(0, 100).map((row) => row.IdSubject);
    const result = await runToolContract(searchTranscriptsTool, { sessionId: '50', limit: 100 });
    expect(result.isError).not.toBe(true);
    const output = searchTranscriptsTool.output.parse(result.structuredContent);
    expect(output.transcripts.map((passage) => passage.subjectId)).toEqual(subjects);
    // Batch sizing is tabled at the service seam; this page needs its two 50-subject batches.
    expect(lookupUrls().map(requestedSubjects)).toEqual([
      subjects.slice(0, 50),
      subjects.slice(50),
    ]);
    expect(http.calls).toHaveLength(3);
    for (const url of lookupUrls()) expect(url.search.length - 1).toBeLessThanOrEqual(2048);
    expect(output.provenance.sources.map((source) => source.url)).toEqual(
      http.calls.map((call) => call.request.url),
    );
    expect(output.subjectBusinesses?.map((entry) => entry.subjectId)).toEqual(subjects);
    expect(output.subjectBusinesses?.[99]).toEqual({
      subjectId: '100099',
      businesses: [{ businessId: '20200099' }],
    });
    expect(result.structuredContent).toMatchObject({
      returnedCount: 100,
      effectiveLimit: 100,
      totalCount: 120,
      hasMore: true,
      nextOffset: 100,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expectVoteParity(result);
  });

  it('resolves all 100 maximum-width subjects of a speaker page in three lookups', async () => {
    rows = Array.from({ length: 100 }, (_, i) => ({
      ID: String(7000 + i),
      Language: 'DE',
      IdSubject: String(9_223_372_036_854_775_807n - BigInt(i)),
      PersonNumber: 3891,
    }));
    const mapped = rows.map((row, i) => ({
      IdSubject: row.IdSubject,
      BusinessNumber: 20_200_000 + i,
      Language: 'DE',
      BusinessShortNumber: `20.${String(i).padStart(3, '0')}`,
      Title: 'Synthetic business',
      SortOrder: 1,
    }));
    routeLookup((request) => {
      const url = new URL(request.url);
      return url.search.length - 1 > 2048
        ? new Response('<html>404 - File or directory not found.</html>', {
            status: 404,
            headers: { 'Content-Type': 'text/html' },
          })
        : subjectBusinessPage(url, mapped);
    });
    const result = await runToolContract(searchTranscriptsTool, {
      personNumber: '3891',
      limit: 100,
    });
    expect(result.isError).not.toBe(true);
    const output = searchTranscriptsTool.output.parse(result.structuredContent);
    expect(output.transcripts).toHaveLength(100);
    const batches = lookupUrls().map(requestedSubjects);
    expect(batches.map((batch) => batch.length)).toEqual([48, 48, 4]);
    expect(batches.flat()).toEqual(rows.map((row) => row.IdSubject));
    for (const url of lookupUrls()) expect(url.search.length - 1).toBeLessThanOrEqual(2048);
    expect(output.subjectBusinesses).toEqual(
      rows.map((row, i) => ({
        subjectId: row.IdSubject,
        businesses: [
          {
            businessId: String(20_200_000 + i),
            shortNumber: `20.${String(i).padStart(3, '0')}`,
            title: 'Synthetic business',
          },
        ],
      })),
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: 100,
      totalCount: 100,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expectVoteParity(result);
  });

  it('returns every large passage of a full-text page with its subject businesses', async () => {
    // Each passage costs about 8 KB across both surfaces.
    rows = Array.from({ length: 4 }, (_, i) => ({
      ID: String(8000 + i),
      Language: 'DE',
      IdSubject: '50854',
      Text: `<p>${'原'.repeat(1300)}</p>`,
    }));
    mappings = [marriageSubjectBusiness];
    const result = await runToolContract(searchTranscriptsTool, {
      sessionId: '50',
      includeText: true,
      limit: 10,
    });
    const output = searchTranscriptsTool.output.parse(result.structuredContent);
    expect(output.transcripts.map((passage) => passage.transcriptId)).toEqual([
      '8000',
      '8001',
      '8002',
      '8003',
    ]);
    expect(output.subjectBusinesses).toEqual([
      {
        subjectId: '50854',
        businesses: [{ businessId: '20130468', shortNumber: '13.468', title: 'Ehe für alle' }],
      },
    ]);
    expect(lookupUrls().map(requestedSubjects)).toEqual([['50854']]);
    expect(result.structuredContent).toMatchObject({
      returnedCount: 4,
      totalCount: 4,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expectVoteParity(result);
  });

  it('lists all 13 businesses of every subject on a full default page', async () => {
    rows = Array.from({ length: 20 }, (_, i) => ({
      ID: String(6000 + i),
      Language: 'DE',
      IdSubject: String(4000 + i),
    }));
    mappings = rows.flatMap((row) =>
      sansPapiersSubjectBusinesses.map((mapping) => ({ ...mapping, IdSubject: row.IdSubject })),
    );
    const result = await runToolContract(searchTranscriptsTool, { sessionId: '50' });
    const output = searchTranscriptsTool.output.parse(result.structuredContent);
    expect(output.transcripts).toHaveLength(20);
    expect(lookupUrls().map(requestedSubjects)).toEqual([rows.map((row) => row.IdSubject)]);
    expect(output.subjectBusinesses?.map((entry) => entry.subjectId)).toEqual(
      rows.map((row) => row.IdSubject),
    );
    expect(output.subjectBusinesses?.every((entry) => entry.businesses.length === 13)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      returnedCount: 20,
      effectiveLimit: 20,
      totalCount: 20,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expectVoteParity(result);
  });

  it('carries the subject entry of an exact passage', async () => {
    mappings = [{ ...marriageSubjectBusiness, IdSubject: subjectId }];
    const result = await runToolContract(searchTranscriptsTool, { transcriptId });
    const output = searchTranscriptsTool.output.parse(result.structuredContent);
    expect(output).toMatchObject({ found: true, transcripts: [{ transcriptId }] });
    expect(output.subjectBusinesses).toEqual([
      {
        subjectId,
        businesses: [{ businessId: '20130468', shortNumber: '13.468', title: 'Ehe für alle' }],
      },
    ]);
    expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
      "/odata.svc/Transcript(ID=9007199254740993L,Language='DE')",
      '/odata.svc/SubjectBusiness',
    ]);
    expect(output.provenance.sources).toHaveLength(2);
    expectVoteParity(result);
  });

  it.each([
    { name: 'an exact-ID miss', input: { transcriptId }, page: [] },
    { name: 'an empty page', input: { sessionId: '50' }, page: [] },
    { name: 'a past-end offset', input: { sessionId: '50', offset: 1 }, page: [transcriptRow] },
  ])('omits the field and makes no lookup for $name', async ({ input, page }) => {
    rows = page;
    mappings = [{ ...marriageSubjectBusiness, IdSubject: subjectId }];
    const result = await runToolContract(searchTranscriptsTool, input);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty('subjectBusinesses');
    expect(lookupUrls()).toHaveLength(0);
    expect(http.calls).toHaveLength(1);
  });

  it('omits the field and makes no lookup for a missing business', async () => {
    http.reset();
    http.route({ match: () => true, respond: Response.json({ d: null }) });
    const result = await runToolContract(searchTranscriptsTool, { businessId: '20991234' });
    expect(result.structuredContent).toMatchObject({ scopeFound: false, transcripts: [] });
    expect(result.structuredContent).not.toHaveProperty('subjectBusinesses');
    expect(lookupUrls()).toHaveLength(0);
  });

  it('returns unchanged passages without the field and joins the lookup notice with the clamp notice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    rows = marriageSpeechRows;
    mappings = [marriageSubjectBusiness];
    const input = { sessionId: '5107', limit: 10_000 };
    const resolved = await runToolContract(searchTranscriptsTool, input);
    routeLookup(() => new Response('', { status: 503 }));
    const pending = runToolContract(searchTranscriptsTool, input);
    await vi.advanceTimersByTimeAsync(2_500);
    const degraded = await pending;
    expect(degraded.isError).not.toBe(true);
    expect(degraded.structuredContent).not.toHaveProperty('subjectBusinesses');
    expect(searchTranscriptsTool.output.parse(degraded.structuredContent).transcripts).toEqual(
      searchTranscriptsTool.output.parse(resolved.structuredContent).transcripts,
    );
    const notice = WireSchema.parse(degraded.structuredContent).notice;
    expect(notice).toContain('clamped to 100');
    expect(notice).toContain('subjectBusinesses is omitted');
    expect(textContent(degraded)).toContain('subjectBusinesses is omitted');
    expect(lookupUrls()).toHaveLength(2);
    expectVoteParity(degraded);
  });

  it('discloses an unavailable lookup on an exact passage', async () => {
    routeLookup(() => new Response('', { status: 429, headers: { 'Retry-After': '999' } }));
    const result = await runToolContract(searchTranscriptsTool, { transcriptId });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      transcripts: [{ transcriptId }],
      notice: expect.stringContaining('rate-limited'),
    });
    expect(result.structuredContent).not.toHaveProperty('subjectBusinesses');
    expect(lookupUrls()).toHaveLength(1);
    expectVoteParity(result);
  });

  it('joins the oversized-passage and unavailable-lookup notices on an exact passage', async () => {
    const original = `<p>${'é原'.repeat(10_000)}\r\n</p>`;
    rows = [{ ...transcriptRow, Text: original }];
    routeLookup(() => new Response('', { status: 404 }));
    const result = await runToolContract(searchTranscriptsTool, { transcriptId });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty('subjectBusinesses');
    const notice = WireSchema.parse(result.structuredContent).notice;
    for (const part of ['returned whole', 'subjectBusinesses is omitted']) {
      expect(notice).toContain(part);
      expect(textContent(result)).toContain(part);
    }
    expectVoteParity(result);
  });

  it('fails as cancelled when the caller cancels during the lookup', async () => {
    const controller = new AbortController();
    routeLookup(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
          controller.abort(new DOMException('Stop the lookup.', 'AbortError'));
        }),
    );
    const result = await runToolContract(
      searchTranscriptsTool,
      { sessionId: '50' },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message: 'Stop the lookup.' },
    });
    expect(lookupUrls()).toHaveLength(1);
  });

  it.each([
    { ...marriageSubjectBusiness, Language: 'FR' },
    { ...marriageSubjectBusiness, IdSubject: '50855' },
  ])('degrades on lookup row %o, returning the passages unchanged', async (row) => {
    rows = marriageSpeechRows;
    mappings = [marriageSubjectBusiness];
    const resolved = await runToolContract(searchTranscriptsTool, { sessionId: '5107' });
    routeLookup(() => Response.json({ d: { results: [row], __count: '1' } }));
    const degraded = await runToolContract(searchTranscriptsTool, { sessionId: '5107' });
    expect(degraded.isError).not.toBe(true);
    expect(degraded.structuredContent).not.toHaveProperty('subjectBusinesses');
    const output = searchTranscriptsTool.output.parse(degraded.structuredContent);
    expect(output.transcripts).toEqual(
      searchTranscriptsTool.output.parse(resolved.structuredContent).transcripts,
    );
    // The lookup response was read whole before its rows were rejected, so provenance cites it.
    expect(output.provenance.sources.map((source) => source.url)).toEqual(
      http.calls.map((call) => call.request.url),
    );
    const notice = WireSchema.parse(degraded.structuredContent).notice;
    expect(notice).toContain('unexpected response');
    expect(notice).toContain('subjectBusinesses is omitted');
    expect(textContent(degraded)).toContain('unexpected response');
    expect(
      decodeParliamentMarkdown(textContent(degraded)).strings.filter((line) =>
        line.startsWith('subjectBusinesses'),
      ),
    ).toEqual([]);
    expect(lookupUrls()).toHaveLength(1);
    expectVoteParity(degraded);
  });

  it('delivers a full page of large passages with only the lookup notice when the lookup fails', async () => {
    // Each passage costs about 8 KB across both surfaces.
    rows = Array.from({ length: 4 }, (_, i) => ({
      ID: String(8000 + i),
      Language: 'DE',
      IdSubject: '50854',
      Text: `<p>${'原'.repeat(1300)}</p>`,
    }));
    routeLookup(() => new Response('', { status: 404 }));
    const result = await runToolContract(searchTranscriptsTool, {
      sessionId: '50',
      includeText: true,
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const output = searchTranscriptsTool.output.parse(result.structuredContent);
    expect(output.transcripts.map((passage) => passage.transcriptId)).toEqual([
      '8000',
      '8001',
      '8002',
      '8003',
    ]);
    expect(result.structuredContent).not.toHaveProperty('subjectBusinesses');
    expect(result.structuredContent).toMatchObject({
      returnedCount: 4,
      totalCount: 4,
      hasMore: false,
    });
    const notice = WireSchema.parse(result.structuredContent).notice;
    for (const part of ['refused the request', 'subjectBusinesses is omitted']) {
      expect(notice).toContain(part);
      expect(textContent(result)).toContain(part);
    }
    expect(notice).not.toContain('byte fitting');
    expect(lookupUrls().map(requestedSubjects)).toEqual([['50854']]);
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expectVoteParity(result);
  });
});
