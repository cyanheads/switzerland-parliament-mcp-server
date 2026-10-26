/**
 * @fileoverview Shared date-range acceptance and error contracts across Parliament tools.
 * @module tests/mcp-server/tools/date-ranges.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBusinessTool } from '@/mcp-server/tools/definitions/search-business.tool.js';
import { searchTranscriptsTool } from '@/mcp-server/tools/definitions/search-transcripts.tool.js';
import { initParliamentService } from '@/services/parliament/parliament-service.js';
import { parliamentHttp, textContent } from '../../helpers/parliament.js';

const cases = [
  {
    name: 'business',
    lower: 'submittedFrom',
    upper: 'submittedTo',
    call: (input: Record<string, unknown>) => runToolContract(searchBusinessTool, input),
  },
  {
    name: 'transcripts',
    lower: 'dateFrom',
    upper: 'dateTo',
    call: (input: Record<string, unknown>) => runToolContract(searchTranscriptsTool, input),
  },
  {
    name: 'sessions',
    lower: 'dateFrom',
    upper: 'dateTo',
    call: (input: Record<string, unknown>) =>
      runToolContract(listReferenceTool, { topic: 'sessions', ...input }),
  },
];

let http: ReturnType<typeof parliamentHttp>;
beforeEach(() => {
  initParliamentService();
  http = parliamentHttp(() => Response.json({ d: { results: [], __count: '0' } }));
});
afterEach(() => http.restore());

describe.each(cases)('$name date ranges', ({ lower, upper, call }) => {
  it('declares reversed ranges consistently before upstream I/O', async () => {
    const result = await call({ [lower]: '2024-02-01', [upper]: '2024-01-01' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: `${lower} must be on or before ${upper}.`,
        data: {
          reason: 'incompatible_fields',
          recovery: { hint: expect.stringContaining('ascending') },
        },
      },
    });
    expect(textContent(result)).toContain('incompatible_fields');
    expect(textContent(result)).toContain('ascending');
    expect(http.calls).toHaveLength(0);
  });

  it.each(['equal', 'lower', 'upper'] as const)('accepts %s bounds', async (kind) => {
    const result = await call({
      ...(kind !== 'upper' && { [lower]: '2024-02-01' }),
      ...(kind !== 'lower' && { [upper]: '2024-02-01' }),
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ returnedCount: 0, hasMore: false });
    expect(http.calls).toHaveLength(1);
    expect(textContent(result)).toContain('**returnedCount:** 0');
  });
});
