/**
 * @fileoverview Bulletin scopes, original-text disclosure, and both public MCP surfaces.
 * @module tests/mcp-server/tools/transcripts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchTranscriptsTool } from '@/mcp-server/tools/definitions/search-transcripts.tool.js';
import { parliamentHttp, textContent } from '../../helpers/parliament.js';
import {
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
beforeEach(() => {
  rows = [transcriptRow];
  http = parliamentHttp((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/odata.svc/Transcript('))
      return Response.json({ d: rows[0] ?? null });
    if (url.pathname !== '/odata.svc/Transcript')
      throw new Error(`Unexpected path ${url.pathname}`);
    const offset = Number(url.searchParams.get('$skip'));
    const top = Number(url.searchParams.get('$top'));
    return Response.json({
      d: { results: rows.slice(offset, offset + top), __count: String(rows.length) },
    });
  });
});
afterEach(() => http.restore());

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
    expect(url.searchParams.get('$orderby')).toBe('ID asc');
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
    expect(http.calls).toHaveLength(1);
    expectVoteParity(result);
  });

  it.each([
    { includeText: false, max: 100, count: 100 },
    { includeText: true, max: 10, count: 10 },
  ])(
    'requests the includeText=$includeText maximum and fits the complete response',
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
        notice: expect.stringContaining(`clamped to ${max}`),
      });
      const delivered = searchTranscriptsTool.output.parse(result.structuredContent).transcripts
        .length;
      expect(delivered).toBeGreaterThan(0);
      expect(delivered).toBeLessThanOrEqual(count);
      expect(WireSchema.parse(result.structuredContent).returnedCount).toBe(delivered);
      expect(WireSchema.parse(result.structuredContent).hasMore).toBe(delivered < count);
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$top')).toBe(String(max));
      expectVoteParity(result);
    },
  );

  it('fits whole text passages and advances only by actual delivered records', async () => {
    rows = Array.from({ length: 10 }, (_, i) => ({
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
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThan(8);
    expect(passages.map((row) => row.text)).toEqual(
      rows.slice(2, 2 + passages.length).map((row) => row.Text),
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: passages.length,
      nextOffset: 2 + passages.length,
      totalCount: 10,
      hasMore: true,
    });
    expect(
      new TextEncoder().encode(
        JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
      ).byteLength,
    ).toBeLessThan(24_000);
    expectVoteParity(result);
  });

  it.each([true, false])(
    'retains an indivisible oversized passage whole in exact=$0 mode',
    async (exact) => {
      const original = `<p>${'é原'.repeat(10_000)}\r\n</p>`;
      rows = [{ ...transcriptRow, Text: original }];
      const result = await runToolContract(
        searchTranscriptsTool,
        exact ? { transcriptId } : { sessionId: '50', includeText: true, limit: 1 },
      );
      expect(result.structuredContent).toMatchObject({
        transcripts: [{ text: original }],
        notice: expect.stringContaining('returned whole'),
      });
      expect(textContent(result)).toContain(exact ? transcriptId : 'sessionId');
      expectVoteParity(result);
    },
  );

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
