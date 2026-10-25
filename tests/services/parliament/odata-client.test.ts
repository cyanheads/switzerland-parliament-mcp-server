/**
 * @fileoverview Real OData fetch/body/paging behavior against a synthetic network boundary.
 * @module tests/services/parliament/odata-client.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildODataUrl, ODataClient, type ODataQuery } from '@/services/parliament/odata-client.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import { parliamentHttp } from '../../helpers/parliament.js';

const query = {
  entity: 'Session',
  language: 'fr',
  select: ['ID', 'Language', 'SessionName'],
  orderBy: [{ field: 'ID', direction: 'asc' }],
  filter: "substringof('L''école & été',SessionName)",
} satisfies ODataQuery;
const row = z.object({ ID: z.number().int() });
let http: ReturnType<typeof parliamentHttp>;

beforeEach(() => {
  http = parliamentHttp(() => {
    throw new Error('Unexpected request.');
  });
});
afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

function respond(factory: (request: Request) => Response | Promise<Response>) {
  http.reset();
  http.route({
    match: (request) => new URL(request.url).origin === 'https://ws.parlament.ch',
    respond: factory,
  });
}

function collection(limit = 3, offset = 0, signal = new AbortController().signal) {
  return withWorkflow(createMockContext({ signal }), async (workflow) => ({
    page: await new ODataClient().collection(query, row, { limit, offset }, workflow),
    sources: workflow.sources,
  }));
}

describe('OData request and complete pages', () => {
  it('builds an encoded fixed-origin language-constrained query', () => {
    const url = buildODataUrl(query, 3, 9);
    expect(url.origin).toBe('https://ws.parlament.ch');
    expect(url.pathname).toBe('/odata.svc/Session');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      $format: 'json',
      $filter: "Language eq 'FR' and (substringof('L''école & été',SessionName))",
      $select: 'ID,Language,SessionName',
      $orderby: 'ID asc',
      $inlinecount: 'allpages',
      $top: '3',
      $skip: '9',
    });
    expect(() => buildODataUrl({ ...query, select: ['ID&$filter=bad'] }, 1, 0)).toThrow();
    expect(() => buildODataUrl({ ...query, orderBy: [] }, 1, 0)).toThrow();
  });

  it('accepts verbose bare arrays and strips additive upstream properties', async () => {
    respond(() =>
      Response.json({
        d: [
          {
            ID: 1,
            AddedLater: 'ignored',
            Navigation: { __deferred: { uri: 'https://example.test/' } },
          },
        ],
      }),
    );
    const result = await collection();
    expect(result.page).toEqual({ items: [{ ID: 1 }], hasMore: false });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      url: http.calls[0]?.request.url,
      retrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('fills count-backed pages without __next and advances by actual source rows', async () => {
    respond((request) => {
      const url = new URL(request.url);
      const skip = url.searchParams.get('$skip');
      return Response.json({
        d: { results: skip === '5' ? [{ ID: 6 }] : [{ ID: 7 }, { ID: 8 }], __count: '12' },
      });
    });
    expect((await collection(3, 5)).page).toEqual({
      items: [{ ID: 6 }, { ID: 7 }, { ID: 8 }],
      totalCount: 12,
      hasMore: true,
      nextOffset: 8,
    });
    expect(
      http.calls.map(({ request }) => {
        const url = new URL(request.url);
        return [url.searchParams.get('$skip'), url.searchParams.get('$top')];
      }),
    ).toEqual([
      ['5', '3'],
      ['6', '2'],
    ]);
  });

  it('retains opaque skiptoken bytes and every semantic query option across source pages', async () => {
    const token = "opaque,+/=é'";
    respond((request) => {
      const url = new URL(request.url);
      if (url.searchParams.has('$skiptoken'))
        return Response.json({ d: { results: [{ ID: 2 }, { ID: 3 }], __count: '3' } });
      url.pathname = '/OData.svc/Session';
      url.searchParams.set('$skiptoken', token);
      return Response.json({ d: { results: [{ ID: 1 }], __count: '3', __next: url.href } });
    });
    expect((await collection()).page).toEqual({
      items: [{ ID: 1 }, { ID: 2 }, { ID: 3 }],
      totalCount: 3,
      hasMore: false,
    });
    const first = new URL(http.calls[0]?.request.url ?? '');
    const second = new URL(http.calls[1]?.request.url ?? '');
    expect(second.searchParams.get('$skiptoken')).toBe(token);
    expect(second.searchParams.get('$top')).toBe('2');
    for (const key of ['$format', '$filter', '$select', '$orderby', '$inlinecount'])
      expect(second.searchParams.get(key)).toBe(first.searchParams.get(key));
  });

  it.each([
    { count: '0', offset: 0 },
    { count: '4', offset: 4 },
    { count: '4', offset: 8 },
  ])('keeps empty and past-end totals honest (%o)', async ({ count, offset }) => {
    respond(() => Response.json({ d: { results: [], __count: count } }));
    expect((await collection(3, offset)).page).toEqual({
      items: [],
      hasMore: false,
      totalCount: Number(count),
    });
  });

  it.each(['host', 'entity', 'language', 'option', 'fragment', 'duplicate', 'cycle'])(
    'rejects %s continuations even beyond the caller page',
    async (attack) => {
      respond((request) => {
        const next = new URL(request.url);
        next.searchParams.set('$skip', '1');
        if (attack === 'host') next.hostname = 'ws.parlament.ch.example.test';
        if (attack === 'entity') next.pathname = '/odata.svc/Person';
        if (attack === 'language') next.searchParams.set('$filter', "Language eq 'DE'");
        if (attack === 'option') next.searchParams.set('$danger', '1');
        if (attack === 'fragment') next.hash = 'secret';
        if (attack === 'duplicate') next.searchParams.append('$top', '1');
        if (attack === 'cycle') next.searchParams.set('$skip', '0');
        return Response.json({ d: { results: [{ ID: 1 }], __next: next.href } });
      });
      await expect(collection(1)).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
      expect(http.calls).toHaveLength(1);
    },
  );

  it('rejects repeated opaque tokens and source pages that stop making progress', async () => {
    respond((request) => {
      const next = new URL(request.url);
      next.searchParams.set('$skiptoken', 'same');
      return Response.json({ d: { results: [{ ID: http.calls.length }], __next: next.href } });
    });
    await expect(collection()).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
    expect(http.calls).toHaveLength(2);
    respond(() => Response.json({ d: { results: [], __count: '3' } }));
    await expect(collection()).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
  });

  it('validates keyed entity ranges and distinguishes explicit null from missing paths', async () => {
    respond(() => Response.json({ d: { ID: 7, Ignored: 'extra' } }));
    await expect(
      withWorkflow(createMockContext(), (workflow) =>
        new ODataClient().entity(
          { entity: 'Transcript', id: '9007199254740993', language: 'fr', select: ['ID'] },
          row,
          workflow,
        ),
      ),
    ).resolves.toEqual({ ID: 7 });
    expect(decodeURIComponent(new URL(http.calls[0]?.request.url ?? '').pathname)).toBe(
      "/odata.svc/Transcript(ID=9007199254740993L,Language='FR')",
    );
    respond(() => Response.json({ d: null }));
    await expect(
      withWorkflow(createMockContext(), (workflow) =>
        new ODataClient().entity(
          { entity: 'Vote', id: '7', language: 'de', select: ['ID'] },
          row,
          workflow,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('tracks source continuation through three partial pages to the 1000-row maximum', async () => {
    respond((request) => {
      const url = new URL(request.url);
      const skip = Number(url.searchParams.get('$skip'));
      const size = Math.min(400, 1000 - skip);
      const next = new URL(url);
      next.searchParams.set('$skip', String(skip + size));
      return Response.json({
        d: {
          results: Array.from({ length: size }, (_, index) => ({ ID: skip + index + 1 })),
          __count: '1000',
          ...(skip + size < 1000 && { __next: next.href }),
        },
      });
    });
    const result = await collection(1000);
    expect(result.page.items).toHaveLength(1000);
    expect(result.page.items[999]).toEqual({ ID: 1000 });
    expect(result.page.hasMore).toBe(false);
    expect(result.sources).toHaveLength(3);
    expect(http.calls.map(({ request }) => new URL(request.url).searchParams.get('$skip'))).toEqual(
      ['0', '400', '800'],
    );
  });

  it.each(['changed-count', 'too-many', 'beyond-total', 'invalid-count'])(
    'rejects inconsistent %s pagination',
    async (failure) => {
      respond(() => {
        if (failure === 'too-many')
          return Response.json({ d: [{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }] });
        return Response.json({
          d: {
            results: [{ ID: http.calls.length }],
            __count:
              failure === 'invalid-count'
                ? '9007199254740992'
                : failure === 'beyond-total'
                  ? '0'
                  : http.calls.length === 1
                    ? '3'
                    : '4',
          },
        });
      });
      await expect(collection()).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
    },
  );

  it('maps keyed 404 to missing with provenance but rejects collection 404', async () => {
    respond(() => Response.json({ error: { innererror: 'do not publish' } }, { status: 404 }));
    const result = await withWorkflow(createMockContext(), async (workflow) => ({
      item: await new ODataClient().entity(
        { entity: 'Vote', id: '7', language: 'de', select: ['ID'] },
        row,
        workflow,
      ),
      sources: workflow.sources,
    }));
    expect(result.item).toBeUndefined();
    expect(result.sources).toHaveLength(1);
    await expect(collection()).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { status: 404 },
    });
  });
});

describe('OData failures and resilience', () => {
  it.each([400, 401, 403, 404])('never retries HTTP %i or exposes .NET bodies', async (status) => {
    respond(() => Response.json({ error: { innererror: 'private-dotnet-stack' } }, { status }));
    await expect(collection()).rejects.toMatchObject({
      code:
        status === 401 || status === 403
          ? JsonRpcErrorCode.ServiceUnavailable
          : JsonRpcErrorCode.InternalError,
      data: { status, retryable: false },
    });
    expect(http.calls).toHaveLength(1);
  });

  it.each(['{broken', '{"d":{"results":[{"ID":"wrong"}]}}'])(
    'never retries completed invalid payload %s',
    async (body) => {
      respond(() => new Response(body));
      await expect(collection()).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
      expect(http.calls).toHaveLength(1);
    },
  );

  it('retries a failed body stream once and records only the contributing response', async () => {
    vi.useFakeTimers();
    respond(() =>
      http.calls.length === 1
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"d":'));
                controller.error(new TypeError('connection reset'));
              },
            }),
          )
        : Response.json({ d: [{ ID: 1 }] }),
    );
    const pending = collection();
    const assertion = expect(pending).resolves.toMatchObject({
      page: { items: [{ ID: 1 }] },
      sources: [{ url: expect.any(String), retrievedAt: expect.any(String) }],
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(http.calls).toHaveLength(2);
  });

  it.each([503, 429, 'html'] as const)('retries transient %s once', async (failure) => {
    vi.useFakeTimers();
    respond(() =>
      http.calls.length === 1
        ? failure === 'html'
          ? new Response('<!doctype html><html>Gateway</html>')
          : new Response('', { status: failure, headers: { 'Retry-After': '1' } })
        : Response.json({ d: [] }),
    );
    const pending = collection();
    const assertion = expect(pending).resolves.toMatchObject({
      page: { items: [], hasMore: false },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(http.calls).toHaveLength(2);
  });

  it('stops cancellation during fetch and never starts a second request', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Research cancelled.', 'AbortError');
    respond(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
          controller.abort(reason);
        }),
    );
    await expect(collection(3, 0, controller.signal)).rejects.toBe(reason);
    expect(http.calls).toHaveLength(1);
  });

  it('cancels during retry backoff without another fetch', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new DOMException('Stop retrying.', 'AbortError');
    respond(() => new Response('', { status: 503 }));
    const pending = collection(3, 0, controller.signal);
    const assertion = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await assertion;
    expect(http.calls).toHaveLength(1);
  });

  it('stops cancellation while consuming a response body', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Stop reading response.', 'AbortError');
    let bodyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    respond(
      (request) =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"d":'));
              request.signal.addEventListener('abort', () => stream.error(request.signal.reason), {
                once: true,
              });
              bodyStarted?.();
            },
          }),
        ),
    );
    const pending = collection(3, 0, controller.signal);
    const assertion = expect(pending).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await assertion;
    expect(http.calls).toHaveLength(1);
  });

  it('shares the remaining deadline with a second page and its body read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    respond(
      (request) =>
        new Response(
          new ReadableStream({
            start(stream) {
              request.signal.addEventListener('abort', () => stream.error(request.signal.reason), {
                once: true,
              });
              if (http.calls.length === 1) {
                setTimeout(() => {
                  stream.enqueue(
                    new TextEncoder().encode('{"d":{"results":[{"ID":1}],"__count":"3"}}'),
                  );
                  stream.close();
                }, 20_000);
              }
            },
          }),
        ),
    );
    const pending = collection();
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'workflow_deadline_exceeded' },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(http.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
    expect(http.calls).toHaveLength(2);
  });

  it('retries only classified network failures and exhausts after one retry', async () => {
    vi.useFakeTimers();
    respond(() => {
      throw new TypeError('fetch failed');
    });
    const pending = collection();
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: true },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(http.calls).toHaveLength(2);
    respond(() => {
      throw new Error('Programmer mistake');
    });
    await expect(collection()).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { retryable: false },
    });
    expect(http.calls).toHaveLength(1);
  });
});
