/**
 * @fileoverview Fixed-origin OData v2 boundary, safe retries, and complete caller-sized pages.
 * @module services/parliament/odata-client
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import {
  type Language,
  ODataCountSchema,
  odataInt32,
  odataInt64,
  odataString,
} from './normalization.js';
import { remainingWorkflowMs, type WorkflowContext } from './workflow.js';

/** Verified Parliament OData origin; callers cannot choose a server. */
export const PARLIAMENT_ORIGIN = 'https://ws.parlament.ch';

/** Entity sets used by the record-research workflows. */
export type ParliamentEntity =
  | 'Business'
  | 'BusinessType'
  | 'BusinessRole'
  | 'BusinessStatus'
  | 'Objective'
  | 'Resolution'
  | 'Publication'
  | 'External'
  | 'Preconsultation'
  | 'Bill'
  | 'BillLink'
  | 'BillStatus'
  | 'BusinessResponsibility'
  | 'RelatedBusiness'
  | 'SubjectBusiness'
  | 'Subject'
  | 'Transcript'
  | 'Vote'
  | 'Voting'
  | 'Person'
  | 'MemberCouncil'
  | 'MemberCommittee'
  | 'PersonInterest'
  | 'PersonOccupation'
  | 'MemberCouncilHistory'
  | 'MemberCommitteeHistory'
  | 'MemberParlGroup'
  | 'MemberParty'
  | 'Council'
  | 'Canton'
  | 'Party'
  | 'ParlGroup'
  | 'Committee'
  | 'Session';

/** Internal typed query options; no caller-authored query expression or URL reaches this API. */
export interface ODataQuery {
  readonly entity: ParliamentEntity;
  readonly expand?: readonly string[];
  readonly filter?: string;
  readonly language: Language;
  readonly orderBy: readonly { readonly field: string; readonly direction: 'asc' | 'desc' }[];
  readonly select: readonly string[];
}

/** Verified composite-key lookups use the entity's ID and requested Language. */
export interface ODataEntityQuery {
  readonly entity:
    | 'Business'
    | 'Person'
    | 'Vote'
    | 'Subject'
    | 'Transcript'
    | 'BusinessType'
    | 'Council'
    | 'Canton'
    | 'Party'
    | 'ParlGroup'
    | 'Committee'
    | 'Session';
  readonly expand?: readonly string[];
  readonly id: string;
  readonly language: Language;
  readonly select: readonly string[];
}

/** One caller-sized page; totalCount is absent when upstream supplied no count. */
export interface ODataPage<T> {
  readonly hasMore: boolean;
  readonly items: T[];
  readonly nextOffset?: number;
  readonly totalCount?: number;
}

const PagingSchema = z.object({
  limit: z.number().int().positive().max(1000),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const QUERY_OPTIONS = new Set([
  '$format',
  '$filter',
  '$select',
  '$expand',
  '$orderby',
  '$top',
  '$skip',
  '$skiptoken',
  '$inlinecount',
]);
const SEMANTIC_OPTIONS = [
  '$format',
  '$filter',
  '$select',
  '$expand',
  '$orderby',
  '$inlinecount',
] as const;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*$/;

/** Build only verified service paths and allowlisted options, always constraining metadata language. */
export function buildODataUrl(query: ODataQuery, limit: number, offset: number): URL {
  PagingSchema.parse({ limit, offset });
  if (query.select.length === 0 || query.orderBy.length === 0) {
    throw internalError('Parliament queries require an explicit projection and stable order.');
  }
  for (const field of [
    ...query.select,
    ...(query.expand ?? []),
    ...query.orderBy.map((order) => order.field),
  ]) {
    if (!FIELD_PATH.test(field))
      throw internalError('Parliament query contains an invalid field path.');
  }
  const url = new URL(`/odata.svc/${query.entity}`, PARLIAMENT_ORIGIN);
  url.searchParams.set('$format', 'json');
  const languageFilter = `Language eq ${odataString(query.language.toUpperCase())}`;
  url.searchParams.set(
    '$filter',
    query.filter ? `${languageFilter} and (${query.filter})` : languageFilter,
  );
  url.searchParams.set('$select', query.select.join(','));
  if (query.expand?.length) url.searchParams.set('$expand', query.expand.join(','));
  url.searchParams.set(
    '$orderby',
    query.orderBy.map(({ field, direction }) => `${field} ${direction}`).join(','),
  );
  url.searchParams.set('$inlinecount', 'allpages');
  url.searchParams.set('$top', String(limit));
  url.searchParams.set('$skip', String(offset));
  return url;
}

/** Validate a server-provided continuation without interpreting its opaque skiptoken. */
export function validateContinuation(
  value: string,
  original: URL,
  remaining: number,
  deliveredOffset: number,
): URL {
  const candidate = URL.parse(value);
  const expectedPath = original.pathname.replace(/^\/odata\.svc\//, '/');
  if (
    candidate?.protocol !== 'https:' ||
    candidate.origin !== PARLIAMENT_ORIGIN ||
    candidate.username ||
    candidate.password ||
    candidate.hash ||
    !/^\/(?:odata|OData)\.svc\//.test(candidate.pathname) ||
    candidate.pathname.replace(/^\/(?:odata|OData)\.svc\//, '/') !== expectedPath
  ) {
    throw serializationError('Parliament returned an unsafe or mismatched continuation.');
  }
  for (const key of candidate.searchParams.keys()) {
    if (!QUERY_OPTIONS.has(key) || candidate.searchParams.getAll(key).length !== 1) {
      throw serializationError('Parliament returned an unsupported continuation query.');
    }
  }
  for (const key of SEMANTIC_OPTIONS) {
    if (candidate.searchParams.get(key) !== original.searchParams.get(key)) {
      throw serializationError('Parliament continuation changed the requested query semantics.');
    }
  }
  const top = candidate.searchParams.get('$top');
  if (
    top !== null &&
    (!/^\d+$/.test(top) ||
      !Number.isSafeInteger(Number(top)) ||
      Number(top) < 1 ||
      Number(top) > Number(original.searchParams.get('$top')))
  ) {
    throw serializationError('Parliament returned an invalid continuation page size.');
  }
  const skip = candidate.searchParams.get('$skip');
  const token = candidate.searchParams.get('$skiptoken');
  if (
    skip !== null &&
    (!/^\d+$/.test(skip) || !Number.isSafeInteger(Number(skip)) || Number(skip) < 0)
  ) {
    throw serializationError('Parliament returned an invalid continuation offset.');
  }
  if (token === '' || (token === null && (skip === null || Number(skip) !== deliveredOffset))) {
    throw serializationError('Parliament continuation did not advance to the next source page.');
  }
  if (
    token !== null &&
    skip !== null &&
    Number(skip) !== deliveredOffset &&
    Number(skip) !== Number(original.searchParams.get('$skip'))
  ) {
    throw serializationError('Parliament continuation changed the requested starting offset.');
  }
  // The caller page may end before the source continuation; keep every token byte intact.
  candidate.searchParams.set(
    '$top',
    String(Math.min(remaining, top === null ? remaining : Number(top))),
  );
  return candidate;
}

function safeHttpFailure(error: unknown, entity: ParliamentEntity): unknown {
  if (!(error instanceof McpError)) return error;
  const status = error.data?.status;
  if (typeof status === 'number') {
    const code =
      status === 429
        ? JsonRpcErrorCode.RateLimited
        : status === 401 || status === 403
          ? JsonRpcErrorCode.ServiceUnavailable
          : status === 408 || status === 504
            ? JsonRpcErrorCode.Timeout
            : status >= 500
              ? JsonRpcErrorCode.ServiceUnavailable
              : JsonRpcErrorCode.InternalError;
    return new McpError(
      code,
      `Parliament ${entity} request failed with HTTP ${status}.`,
      {
        status,
        endpoint: entity,
        retryable: RETRY_STATUSES.has(status),
        ...(status === 429 && { reason: 'upstream_rate_limited' }),
        ...(typeof error.data?.retryAfter === 'string' && { retryAfter: error.data.retryAfter }),
      },
      { cause: error },
    );
  }
  if (error.data?.errorSource === 'FetchNetworkErrorWrapper') {
    const cause = error.cause;
    const networkCode = cause instanceof Error && 'code' in cause ? cause.code : undefined;
    const retryable =
      cause instanceof TypeError ||
      (typeof networkCode === 'string' &&
        /^(?:E[A-Z]+|ConnectionRefused|ConnectionReset|SocketClosed)$/.test(networkCode));
    return new McpError(
      retryable ? JsonRpcErrorCode.ServiceUnavailable : JsonRpcErrorCode.InternalError,
      `Parliament ${entity} could not be reached.`,
      { endpoint: entity, retryable },
      { cause: error },
    );
  }
  return error;
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof McpError &&
    (error.data?.retryable === true || error.data?.errorSource === 'FetchTimeout')
  );
}

function continuationIdentity(url: URL): string {
  const identity = new URL(url);
  identity.pathname = identity.pathname.replace(/^\/OData\.svc\//, '/odata.svc/');
  identity.searchParams.delete('$top');
  identity.searchParams.sort();
  return identity.href;
}

/** A typed network seam; validates complete bodies and never returns raw .NET error payloads. */
export class ODataClient {
  #read<T>(
    url: URL,
    entity: ParliamentEntity,
    schema: z.ZodType<T>,
    workflow: WorkflowContext,
    expectedStatuses: number[] = [],
  ): Promise<T> {
    const deadlineMs = remainingWorkflowMs(workflow);
    return withRetry(
      async (attempt) => {
        remainingWorkflowMs(workflow);
        let response: Response;
        try {
          response = await fetchWithTimeout(
            url,
            Math.min(30_000, attempt.remainingMs, remainingWorkflowMs(workflow)),
            workflow.request,
            {
              signal: attempt.signal,
              errorBodyLimit: 0,
              redirect: 'manual',
              headers: { Accept: 'application/json' },
              expectedStatuses,
            },
          );
        } catch (error) {
          remainingWorkflowMs(workflow);
          throw safeHttpFailure(error, entity);
        }
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          remainingWorkflowMs(workflow);
          if (error instanceof McpError || (error instanceof Error && error.name === 'AbortError'))
            throw error;
          throw serviceUnavailable(
            `Parliament ${entity} response stream failed.`,
            { endpoint: entity, retryable: true },
            { cause: error },
          );
        }
        const retrievedAt = new Date().toISOString();
        remainingWorkflowMs(workflow);
        if (/^\s*<(?:!doctype\s+html|html\b)/i.test(text)) {
          throw serviceUnavailable(`Parliament ${entity} returned an HTML gateway response.`, {
            endpoint: entity,
            retryable: true,
          });
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch (error) {
          throw serializationError(
            `Parliament ${entity} returned malformed complete JSON.`,
            { endpoint: entity },
            { cause: error },
          );
        }
        const result = schema.safeParse(payload);
        if (!result.success) {
          throw serializationError(
            `Parliament ${entity} response did not match its documented fields.`,
            { endpoint: entity },
          );
        }
        remainingWorkflowMs(workflow);
        workflow.sources.push({ url: url.href, retrievedAt });
        return result.data;
      },
      {
        operation: `Parliament.${entity}`,
        context: workflow.request,
        signal: workflow.signal,
        deadlineMs,
        maxRetries: 1,
        baseDelayMs: 500,
        maxDelayMs: 2000,
        isTransient,
      },
    );
  }

  /** Read a verified composite-key entity; a keyed 404 or explicit null is a missing entity. */
  async entity<T>(
    query: ODataEntityQuery,
    schema: z.ZodType<T>,
    workflow: WorkflowContext,
  ): Promise<T | undefined> {
    const url = buildODataUrl({ ...query, orderBy: [{ field: 'ID', direction: 'asc' }] }, 1, 0);
    const id =
      query.entity === 'Subject' || query.entity === 'Transcript'
        ? odataInt64(query.id)
        : odataInt32(query.id);
    url.pathname = `/odata.svc/${query.entity}(ID=${id},Language=${odataString(query.language.toUpperCase())})`;
    for (const key of ['$filter', '$orderby', '$top', '$skip', '$inlinecount'])
      url.searchParams.delete(key);
    try {
      const result = await this.#read(
        url,
        query.entity,
        z.object({ d: schema.nullable() }),
        workflow,
        [404],
      );
      return result.d ?? undefined;
    } catch (error) {
      remainingWorkflowMs(workflow);
      if (error instanceof McpError && error.data?.status === 404) {
        workflow.sources.push({ url: url.href, retrievedAt: new Date().toISOString() });
        return undefined;
      }
      throw error;
    }
  }

  /** Fill a page through source continuations and count-backed offsets, advancing by delivered rows. */
  async collection<T>(
    query: ODataQuery,
    schema: z.ZodType<T>,
    paging: { limit: number; offset: number },
    workflow: WorkflowContext,
  ): Promise<ODataPage<T>> {
    const { limit, offset } = PagingSchema.parse(paging);
    const envelope = z.object({
      d: z.union([
        z.array(schema),
        z.object({
          results: z.array(schema),
          __count: ODataCountSchema.optional(),
          __next: z.string().optional(),
        }),
      ]),
    });
    const initial = buildODataUrl(query, limit, offset);
    let url = initial;
    const visited = new Set<string>();
    const visitedTokens = new Set<string>();
    const items: T[] = [];
    let totalCount: number | undefined;
    let hasMore = false;
    for (;;) {
      const identity = continuationIdentity(url);
      if (visited.has(identity))
        throw serializationError('Parliament returned a cyclic continuation.');
      visited.add(identity);
      const token = url.searchParams.get('$skiptoken');
      if (token !== null) visitedTokens.add(token);
      const payload = await this.#read(url, query.entity, envelope, workflow);
      const data = payload.d;
      const rows = Array.isArray(data) ? data : data.results;
      const count = Array.isArray(data) ? undefined : data.__count;
      const next = Array.isArray(data) ? undefined : data.__next;
      if (count !== undefined) {
        if (totalCount !== undefined && totalCount !== count)
          throw serializationError(
            'Parliament count changed while reading the page. Retry the query.',
          );
        totalCount = count;
      }
      if (rows.length > limit - items.length)
        throw serializationError('Parliament exceeded the requested page size.');
      items.push(...rows);
      const nextOffset = offset + items.length;
      if (!Number.isSafeInteger(nextOffset))
        throw serializationError('Parliament continuation exceeds the safe offset range.');
      if (totalCount !== undefined && rows.length > 0 && nextOffset > totalCount)
        throw serializationError('Parliament returned rows beyond the advertised total.');
      if (
        rows.length === 0 &&
        (next !== undefined || (totalCount !== undefined && nextOffset < totalCount))
      ) {
        throw serializationError('Parliament source pagination stopped making progress.');
      }
      hasMore =
        next !== undefined ||
        (totalCount !== undefined
          ? nextOffset < totalCount
          : rows.length === Number(url.searchParams.get('$top')));
      // Validate even a link that lies beyond this caller page; never claim it is usable otherwise.
      const continuation =
        next === undefined
          ? undefined
          : validateContinuation(next, initial, Math.max(1, limit - items.length), nextOffset);
      if (continuation) {
        const nextToken = continuation.searchParams.get('$skiptoken');
        if (
          visited.has(continuationIdentity(continuation)) ||
          (nextToken !== null && visitedTokens.has(nextToken))
        ) {
          throw serializationError('Parliament returned a cyclic continuation.');
        }
      }
      if (items.length === limit || !hasMore || rows.length === 0) break;
      url = continuation ?? buildODataUrl(query, limit - items.length, nextOffset);
    }
    remainingWorkflowMs(workflow);
    return {
      items,
      hasMore,
      ...(totalCount !== undefined && { totalCount }),
      ...(hasMore && { nextOffset: offset + items.length }),
    };
  }
}
