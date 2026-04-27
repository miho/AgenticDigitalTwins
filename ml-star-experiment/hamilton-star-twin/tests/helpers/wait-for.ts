/**
 * Poll-based waiters for integration tests.
 *
 * Replaces magic setTimeout(N) with explicit condition waits. Every waiter
 * has a timeout and fails loudly (not silently) when the condition isn't met.
 */

export interface WaitOptions {
  /** Max wait in milliseconds. Default: 30_000 (30s). */
  timeoutMs?: number;
  /** Poll interval in milliseconds. Default: 50. */
  pollMs?: number;
  /** Human label for failure messages. */
  label?: string;
}

/**
 * Poll until `predicate()` returns a truthy value, or the timeout elapses.
 * Throws with a descriptive error on timeout.
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: WaitOptions = {}
): Promise<NonNullable<T>> {
  const { timeoutMs = 30_000, pollMs = 50, label = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result as NonNullable<T>;
      lastValue = result;
    } catch (err) {
      lastError = err;
    }
    await sleep(pollMs);
  }

  const msg = `waitFor(${label}) timed out after ${timeoutMs}ms. ` +
    `Last value: ${JSON.stringify(lastValue)}. ` +
    (lastError ? `Last error: ${(lastError as Error).message || String(lastError)}` : "");
  throw new Error(msg);
}

/** Sleep helper (only for polling loops; never use as a substitute for a condition wait). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until a module enters a specific state (via an HTTP getState() function).
 *
 * @example
 *   await waitForModuleState(() => fetch("/state").then(r => r.json()), "master", "sys_ready");
 */
export async function waitForModuleStateOverHttp(
  getState: () => Promise<any>,
  moduleId: string,
  expectedState: string,
  options: WaitOptions = {}
): Promise<void> {
  await waitFor(
    async () => {
      const state = await getState();
      const states: string[] = state?.modules?.[moduleId]?.states || [];
      return states.includes(expectedState);
    },
    { ...options, label: `${moduleId}.${expectedState}` }
  );
}
