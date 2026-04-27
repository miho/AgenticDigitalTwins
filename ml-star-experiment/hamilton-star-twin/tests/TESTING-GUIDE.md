# Testing Guide — Hamilton STAR Digital Twin

**Last updated:** 2026-04-16
**Status:** Required reading before writing or modifying tests.

## Why this guide exists

The digital twin is a physical-state simulator. Tests that only verify "the command was accepted" tell us nothing about whether the physics is correct. A broken twin that accepts every command and produces wrong state would pass such tests silently — exactly the failure mode we must prevent.

This guide defines the minimum assertion discipline for every test. Every new test and every modification to an existing test must comply.

## Principles

1. **Test physical outcomes, not command mechanics.** Aspirating does not mean the command was accepted — it means the source volume went down. Dispensing means the destination volume went up. Those are the only things that matter.
2. **Capture before, capture after, verify the difference.** When testing a state change, snapshot the relevant state before and after, then assert on the delta. Raw "after" values can pass for the wrong reason.
3. **Prefer exact equality over range checks.** `toBe(1000)` catches a bug that `toBeGreaterThan(0)` silently passes.
4. **Make tests fail meaningfully.** If a test fails, the error message should point to the broken contract, not a cryptic expectation mismatch.
5. **Every test must be demonstrably able to catch regressions.** A test that never fails against bugs is worse than no test — it creates false confidence. See "Failure injection" below.

## Banned patterns

### ❌ `accepted: true` as the sole assertion

```typescript
// BAD — passes even if the twin forgot to actually aspirate
const r = await sendCommand("C0ASid0001xp02383yp01375tm255av01000lm0");
expect(r.accepted).toBe(true);
expect(r.errorCode).toBe(0);
```

```typescript
// GOOD — verifies the aspirate physically happened
const volBefore = await getColumnVolumes("SMP001", 0, 0);
const r = await sendCommand("C0ASid0001xp02383yp01375tm255av01000lm0");
expect(r.accepted).toBe(true);
expect(r.errorCode).toBe(0);
const volAfter = await getColumnVolumes("SMP001", 0, 0);
// Every targeted row decreased by exactly 100 µL (1000 in 0.1-µL units)
for (let row = 0; row < 8; row++) {
  expect(volAfter[row]).toBe(volBefore[row] - 1000);
}
```

**Exception:** pure rejection tests are fine if they assert that `accepted` is false OR the error code is a specific expected value, AND verify the downstream state is unchanged.

### ❌ `toBeDefined()` without value check

```typescript
// BAD — passes if tadm is {} or some random object
expect(tadm.curve).toBeDefined();
```

```typescript
// GOOD — tests the actual contract
expect(tadm.curve).toBeInstanceOf(Array);
expect(tadm.curve.length).toBeGreaterThanOrEqual(30);
expect(tadm.curve[0]).toMatchObject({ time: expect.any(Number), pressure: expect.any(Number) });
expect(tadm.peakPressure).toBeGreaterThan(50);
```

### ❌ `toBeGreaterThan(0)` as a contract test

```typescript
// BAD — any non-zero value passes, even nonsensical ones
expect(r.errorCode).toBeGreaterThan(0);
```

```typescript
// GOOD — test for the specific error code you expect
expect(r.errorCode).toBe(8);  // 8 = "no tip fitted"
expect(r.errorDescription).toMatch(/no tip/i);
```

**Exception:** when the exact value genuinely varies (e.g., elapsed time), use a tight range: `expect(ms).toBeGreaterThan(500).toBeLessThan(2000)` with a comment explaining the bounds.

### ❌ Assertions on derived/echoed values

```typescript
// BAD — checking that pip.volume[0] is 1000 after aspirating 1000 proves nothing —
// the twin could set volume directly without actually tracking the source.
await sendCommand("...aspirate 1000 µL...");
const pip = await getModuleVars("pip");
expect(pip.volume[0]).toBe(1000);
```

Always pair channel/module checks with source/destination well volume changes.

### ❌ Tests that don't reset between runs

All integration tests go through `beforeEach(async () => { await resetAndInit(); })`. Do not share state between tests. A test that only passes because a prior test left the twin in a specific state is broken.

### ❌ Magic sleep() waits

```typescript
// BAD — fragile, may fail or pass for wrong reasons
await new Promise(r => setTimeout(r, 2000));
```

```typescript
// GOOD — wait for the actual condition
await waitForModuleState("master", "sys_ready", 30000);
```

Any `setTimeout` > 500ms in an integration test requires an inline comment explaining why no observable state transition exists to wait on.

## Required patterns

### Capture-before / capture-after

Every state-changing test follows this template:

```typescript
it("<what changes>", async () => {
  // 1. Setup (reset is automatic via beforeEach)
  await fillPlate("SMP001", 0, "Water", 2000);
  
  // 2. Capture before state
  const volBefore = await getColumnVolumes("SMP001", 0, 0);
  const tipsBefore = (await getModuleVars("pip")).tip_fitted.slice(0, 8);
  
  // 3. Execute the action under test
  const result = await sendCommand("C0TPid0100xp01033yp01375tm255tt04");
  
  // 4. Verify command mechanics
  expect(result.accepted).toBe(true);
  expect(result.errorCode).toBe(0);
  
  // 5. Verify physical outcomes
  const tipsAfter = (await getModuleVars("pip")).tip_fitted.slice(0, 8);
  expect(tipsAfter).toEqual([true, true, true, true, true, true, true, true]);
  expect(tipsAfter).not.toEqual(tipsBefore);  // state actually changed
});
```

### Error-path tests

Test that an invalid command is rejected AND that no side effects occurred:

```typescript
it("rejects aspirate without tips AND leaves source volume unchanged", async () => {
  await fillPlate("SMP001", 0, "Water", 2000);
  const volBefore = await getColumnVolumes("SMP001", 0, 0);
  
  const r = await sendCommand("C0ASid0001xp02383yp01375tm255av01000lm0");
  
  // Rejected (either accepted=false OR correct error code)
  expect(r.errorCode).toBe(8);  // 8 = no tip fitted
  
  // No side effect — source wells unchanged
  const volAfter = await getColumnVolumes("SMP001", 0, 0);
  expect(volAfter).toEqual(volBefore);
});
```

### Specific error codes, not `> 0`

The twin documents its error codes in `hamilton-star-digital-twin.json`:

| Code | Meaning |
|:---:|---|
| 0 | success |
| 3 | not initialized |
| 6 | too little liquid |
| 7 | tip crash / tip already fitted |
| 8 | no tip fitted |
| 9 | no carrier |
| 15 | not allowed in current state |
| 18 | wash fluid error |
| 19 | temperature error |
| 22 | no element / no tip rack |
| 27 | position not reachable |
| 99 | slave error (check per-channel errors) |

Tests must assert the specific expected code. If more than one code is acceptable, document why.

### Conservation checks

Liquid handling must conserve volume (aside from documented dead volume effects). When testing transfers, assert:

```typescript
const totalBefore = volBefore.reduce((a, b) => a + b, 0);
const totalAfter = volAfter.reduce((a, b) => a + b, 0);
expect(totalAfter).toBe(totalBefore);  // conservation
```

## Failure injection

Every test file must contain a `// FAILURE INJECTION` comment documenting at least one known breakage that the tests in that file would catch. Example:

```typescript
// FAILURE INJECTION
// If DeckTracker.processCommand() forgets to decrement source well volumes,
// the "aspirates decreases source well volume" test in this file will fail
// with volAfter[0] === 2000 instead of 1000.
```

This is not a replacement for the `tests/unit/failure-injection.test.ts` suite (which programmatically verifies test bite), but it forces authors to think about what their tests actually catch.

## Test organization

- `tests/unit/` — pure-function and in-process twin tests. No HTTP server. Uses `createTestTwin()` helper. Should be the majority of new tests.
- `tests/integration/` — HTTP-based end-to-end tests. Uses a fresh test server per file via `createTestServer()`. No hardcoded ports.
- `tests/contract/` — API endpoint / MCP tool shape tests with golden file snapshots. Ensures backwards compatibility.
- `tests/e2e/` — Playwright browser tests (visual regression, click-through scenarios).

### Naming

- `*.test.ts` is recognized by Vitest.
- Describe blocks mirror the feature under test: `describe("DeckTracker.processCommand", ...)`, not `describe("deck tracker", ...)`.
- Test names state the expected outcome: `it("decrements source well volume by aspirate amount")`, not `it("aspirate works")`.

## Coverage

`npm run test:coverage` produces an HTML report in `coverage/`. Target thresholds:

| Phase | Lines | Branches | Applies to |
|---|:---:|:---:|---|
| After Phase 0 | 40% | — | baseline |
| After Phase 1 | 55% | — | `src/twin/` + `src/services/` |
| After Phase 3 | 70% | 60% | all production code |
| After Phase 4 | 75% | 65% | all production code |

CI will fail if coverage drops below the current phase threshold. New code should meet or exceed 75% coverage locally.

## Running tests

| Command | What it runs |
|---|---|
| `npm test` | Full suite (unit + integration + contract) |
| `npm run test:unit` | Only unit tests (fastest, no server needed) |
| `npm run test:integration` | Only HTTP integration tests |
| `npm run test:contract` | Only API contract tests |
| `npm run test:coverage` | Full suite with coverage report |
| `npm run test:ci` | CI pipeline: unit → contract → integration, enforces thresholds |
| `npm run test:watch` | Watch mode for TDD |

## Review checklist for new tests

Before merging, verify:

- [ ] Every command-accepted check is paired with a physical-outcome check.
- [ ] No `toBeDefined()` without a subsequent value assertion.
- [ ] Error paths assert the specific error code, not `> 0`.
- [ ] No `setTimeout` > 500ms without justifying comment.
- [ ] State is captured before AND after every mutation.
- [ ] File contains `// FAILURE INJECTION` comment with example breakage.
- [ ] Test name states the expected outcome (not just the action).

## Anti-patterns in the existing suite

The audit at `tests/AUDIT-2026-04.md` catalogs specific weak tests that were hiding errors. When touching those tests, fix them to meet this guide. When adding related tests, reference the audit to avoid repeating the same anti-patterns.
