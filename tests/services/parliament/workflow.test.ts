/**
 * @fileoverview Shared workflow deadlines, cancellation precedence, and timer cleanup.
 * @module tests/services/parliament/workflow.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remainingWorkflowMs, withWorkflow } from '@/services/parliament/workflow.js';

afterEach(() => vi.useRealTimers());

describe('Parliament workflow budget', () => {
  it('shares one monotonic deadline and disarms the timer after success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const result = await withWorkflow(createMockContext(), async (workflow) => {
      expect(remainingWorkflowMs(workflow)).toBe(45_000);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(remainingWorkflowMs(workflow)).toBe(5_000);
      workflow.sources.push({
        url: 'https://ws.parlament.ch/odata.svc/Session',
        retrievedAt: '2026-10-25',
      });
      return workflow.sources.length;
    });
    expect(result).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks expiry even when an operation returns successfully after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await expect(
      withWorkflow(createMockContext(), async () => {
        await vi.advanceTimersByTimeAsync(45_000);
        return 'late';
      }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'workflow_deadline_exceeded' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains caller cancellation over expiry and cleans up a failed operation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const controller = new AbortController();
    const reason = new DOMException('Caller stopped research.', 'AbortError');
    await expect(
      withWorkflow(createMockContext({ signal: controller.signal }), async () => {
        await vi.advanceTimersByTimeAsync(45_000);
        controller.abort(reason);
        throw new Error('Other failure');
      }),
    ).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts a cancelled operation and propagates programmer failures', async () => {
    const operation = vi.fn();
    const reason = new DOMException('Cancelled before request.', 'AbortError');
    await expect(
      withWorkflow(createMockContext({ signal: AbortSignal.abort(reason) }), operation),
    ).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    const failure = new Error('Invalid internal state');
    await expect(
      withWorkflow(createMockContext(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
