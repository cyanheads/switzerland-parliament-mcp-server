/**
 * @fileoverview One cancellable deadline and provenance ledger per complete tool workflow.
 * @module services/parliament/workflow
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import type { Source } from './provenance.js';

/** Explicit request state shared by every fetch, join, continuation, and retry. */
export interface WorkflowContext {
  readonly deadlineAt: number;
  readonly request: Context;
  readonly signal: AbortSignal;
  readonly sources: Source[];
}

/** Caller cancellation takes precedence over the workflow deadline. Returns remaining milliseconds. */
export function remainingWorkflowMs(workflow: WorkflowContext): number {
  workflow.request.signal.throwIfAborted();
  const remainingMs = workflow.deadlineAt - performance.now();
  if (remainingMs <= 0 || workflow.signal.aborted) {
    throw timeout(
      'The Parliament workflow exceeded its 45-second deadline. Narrow the request and retry.',
      {
        reason: 'workflow_deadline_exceeded',
      },
    );
  }
  return remainingMs;
}

/** Run a complete operation under one 45-second budget; always disarm the deadline. */
export async function withWorkflow<T>(
  request: Context,
  operation: (workflow: WorkflowContext) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException('Parliament workflow deadline exceeded.', 'TimeoutError')),
    45_000,
  );
  const workflow: WorkflowContext = {
    request,
    signal: AbortSignal.any([request.signal, deadline.signal]),
    deadlineAt: performance.now() + 45_000,
    sources: [],
  };
  try {
    remainingWorkflowMs(workflow);
    const result = await operation(workflow);
    remainingWorkflowMs(workflow);
    return result;
  } catch (error) {
    remainingWorkflowMs(workflow);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
