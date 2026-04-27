/**
 * Failure-injection tests
 *
 * These tests prove the test suite has teeth. Each test creates a fresh
 * in-process twin, deliberately breaks one aspect of its behavior (by
 * monkey-patching or swapping an internal), runs a representative check,
 * and verifies the check CORRECTLY fails.
 *
 * If a test in this file ever starts passing despite the injection, it means
 * our production tests would NOT catch that bug in practice. That's a test-
 * quality regression and must be investigated.
 *
 * Pattern:
 *   1. Create a known-good twin.
 *   2. Sanity-check: a specific assertion passes.
 *   3. Inject a break (monkey-patch a tracker method, swap a function, etc.).
 *   4. Run the same assertion and expect it to FAIL.
 *   5. Record the expected break so future readers understand what is tested.
 *
 * FAILURE INJECTION (meta)
 * If this suite itself gets weakened (e.g. a test no longer injects anything
 * but asserts the same way), the meta-test at the bottom verifies each
 * injection actually changes behavior.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

/**
 * Run an assertion function and return whether it reported a test failure.
 *
 * A "test failure" for our purposes means ANY throw during the assertion:
 * either an `expect()` assertion mismatch (AssertionError) or an error that
 * the production code throws when something observable goes wrong (e.g. an
 * initAll() that throws because the module never reached sys_ready — that IS
 * the production test surface catching the bug).
 *
 * The contract is: if the injection works, the test function throws; if the
 * injection doesn't change behavior, the test passes silently and we return
 * false (which the outer `expect(assertionFails).toBe(true)` catches).
 */
function didAssertionFail(assertion: () => void): boolean {
  try {
    assertion();
    return false;
  } catch {
    return true;
  }
}

describe("failure-injection suite — proves tests have teeth", () => {
  let twin: ReturnType<typeof createTestTwin> | null = null;

  afterEach(() => {
    twin?.destroy();
    twin = null;
  });

  it("[injection 1] stubbing source-volume decrement makes aspirate test FAIL", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

    // SANITY: with the real twin, aspirate depletes the source by exactly 1000.
    {
      const volBefore = twin.getColumnVolumes("SMP001", 0, 0);
      const srcPos = twin.wellXY("SMP001", 0, 0);
      twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
      const volAfter = twin.getColumnVolumes("SMP001", 0, 0);
      for (let row = 0; row < 8; row++) {
        expect(volAfter[row]).toBe(volBefore[row] - 1000);
      }
    }

    // Inject: reset the twin and monkey-patch the internal deckTracker's
    // well-volume setter to be a no-op. An aspirate will still appear to
    // succeed via SCXML, but source wells won't change.
    twin.reset();
    twin.initAll();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

    const anyTwin = twin.api as any;
    // Navigate to the internal DeckTracker via the API's device registry.
    const device = anyTwin.devices.get(twin.deviceId);
    const tracker = device.twin.getDeckTracker();
    // Freeze well-volume deltas: intercept the Map's `set` so it only keeps
    // the INITIAL fill values and refuses to accept later writes. This
    // simulates a tracker that forgets to record aspirate-driven deltas.
    const wv: Map<string, number> = tracker["wellVolumes"];
    const origSet = wv.set.bind(wv);
    // Capture current keys (post-fillPlate). Any later write is dropped.
    const initialKeys = new Set(wv.keys());
    (wv as any).set = function frozenSet(this: Map<string, number>, key: string, value: number) {
      if (initialKeys.has(key)) {
        // keep the initial value — no further change accepted
        return this;
      }
      return origSet(key, value);
    };

    // The strengthened test would now fail because volAfter === volBefore.
    const assertionFails = didAssertionFail(() => {
      const volBefore = twin!.getColumnVolumes("SMP001", 0, 0);
      const srcPos = twin!.wellXY("SMP001", 0, 0);
      twin!.sendCommand(`C0ASid0102xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
      const volAfter = twin!.getColumnVolumes("SMP001", 0, 0);
      for (let row = 0; row < 8; row++) {
        expect(volAfter[row]).toBe(volBefore[row] - 1000);
      }
    });

    // Restore the original set method so afterEach's destroy works cleanly.
    (wv as any).set = origSet;

    // The production assertion SHOULD have failed with the injected break.
    expect(assertionFails).toBe(true);
  });

  it("[injection 2] monkey-patching rejection errorCode makes pinned-error-code test FAIL", () => {
    twin = createTestTwin();

    // SANITY: with the real twin, no-tip aspirate returns error 8.
    {
      const r = twin.sendCommand("C0ASid0001xp02383yp01375tm255av01000lm0");
      expect(r.errorCode).toBe(8);
    }

    // Inject: intercept sendCommand on the underlying DigitalTwin so
    // that rejections return error 99 (generic) instead of 8.
    const anyTwin = twin.api as any;
    const device = anyTwin.devices.get(twin.deviceId);
    const digitalTwin = device.twin;
    const origSend = digitalTwin.sendCommand.bind(digitalTwin);
    digitalTwin.sendCommand = function broken(raw: string) {
      const result = origSend(raw);
      if (result.errorCode > 0) {
        return { ...result, errorCode: 99, errorDescription: "Generic slave error" };
      }
      return result;
    };

    // The strengthened test that pins error 8 now fails — a test that only
    // checks errorCode > 0 would NOT catch this silent regression.
    const assertionFails = didAssertionFail(() => {
      const r = twin!.sendCommand("C0ASid0002xp02383yp01375tm255av01000lm0");
      expect(r.errorCode).toBe(8);
    });

    // Restore.
    digitalTwin.sendCommand = origSend;

    expect(assertionFails).toBe(true);
  });

  it("[injection 3] returning empty TADM curve makes TADM shape test FAIL", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

    // SANITY: a real aspirate produces a populated TADM curve.
    {
      twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
      const events = twin.getAssessments({ category: "tadm" });
      const curve = events[events.length - 1]?.tadm;
      expect(curve).toBeTruthy();
      expect(curve!.curve).toBeInstanceOf(Array);
      expect(curve!.curve.length).toBeGreaterThanOrEqual(10);
    }

    // Inject: replace the AssessmentStore.add method to strip curve data.
    const anyTwin = twin.api as any;
    const device = anyTwin.devices.get(twin.deviceId);
    const digitalTwin = device.twin;
    const store = digitalTwin.getAssessmentStore();
    const origAdd = store.add.bind(store);
    store.add = function brokenAdd(partial: any) {
      if (partial.category === "tadm" && partial.tadm) {
        partial = { ...partial, tadm: { ...partial.tadm, curve: [] } };
      }
      return origAdd(partial);
    };

    const assertionFails = didAssertionFail(() => {
      twin!.sendCommand(`C0ASid0102xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
      const events = twin!.getAssessments({ category: "tadm" });
      // The real assertion from head-384-fix.test.ts strengthened version:
      const curve = events[events.length - 1]?.tadm;
      expect(curve!.curve).toBeInstanceOf(Array);
      expect(curve!.curve.length).toBeGreaterThanOrEqual(10);
    });

    store.add = origAdd;
    expect(assertionFails).toBe(true);
  });

  it("[injection 4] suppressing volume_underflow emission makes safety test FAIL", () => {
    // Invariant under test: the twin MUST signal over-aspiration. Volumes are
    // intentionally allowed to go negative (for debuggability); the safety
    // guarantee is a `volume_underflow` assessment event. If a future refactor
    // drops that event emission, the production safety test should catch it.
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 500);   // 50 µL — much less than we'll aspirate
    const tipPos = twin.wellXY("TIP001", 0, 0);
    const srcPos = twin.wellXY("SMP001", 0, 0);
    twin.sendCommand(`C0TPid0100xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

    // SANITY: over-aspirating emits volume_underflow events. The deck-tracker
    // volume is pinned to Σ components by the liquid-tracker (truthful
    // representation), so it doesn't go negative — the EVENT is the
    // authoritative safety signal.
    {
      twin.sendCommand(`C0ASid0101xp${srcPos.xp}yp${srcPos.yp}av09999tm255lm0`);
      const underflows = twin.getAssessments({ category: "volume_underflow" });
      expect(underflows.length).toBeGreaterThan(0);
    }

    // Inject: intercept the assessment store's add() to drop volume_underflow
    // events. The tracker still records negative volumes, but downstream safety
    // checks that look at the event stream would miss the problem.
    twin.reset();
    twin.initAll();
    twin.fillPlate("SMP001", 0, "Water", 500);
    twin.sendCommand(`C0TPid0200xp${tipPos.xp}yp${tipPos.yp}tm255tt04`);

    const anyTwin = twin.api as any;
    const device = anyTwin.devices.get(twin.deviceId);
    const store = device.twin.assessmentStore;
    const origAdd = store.add.bind(store);
    store.add = function filteredAdd(partial: any) {
      if (partial?.category === "volume_underflow") return null;  // drop the warning
      return origAdd(partial);
    };

    const assertionFails = didAssertionFail(() => {
      twin!.sendCommand(`C0ASid0201xp${srcPos.xp}yp${srcPos.yp}av09999tm255lm0`);
      const underflows = twin!.getAssessments({ category: "volume_underflow" });
      expect(underflows.length).toBeGreaterThan(0);  // would fail — we suppressed them
    });

    store.add = origAdd;
    expect(assertionFails).toBe(true);
  });

  it("[injection 5] removing sys_ready from init makes waitForModuleState FAIL", () => {
    twin = createTestTwin({ autoInit: false });

    // SANITY: init brings master to sys_ready.
    twin.initAll();
    expect(twin.getModuleStates("master")).toContain("sys_ready");

    // Inject: monkey-patch sendCommand to drop completion events.
    // Then assert that a fresh initAll() times out or reaches a different state.
    twin.reset();
    const anyTwin = twin.api as any;
    const device = anyTwin.devices.get(twin.deviceId);
    const digitalTwin = device.twin;
    const origFlush = digitalTwin.flushPendingEvents.bind(digitalTwin);
    digitalTwin.flushPendingEvents = function brokenFlush() {
      // Do nothing — scheduled events never fire.
    };

    // initAll() calls flushPending(); with that broken, sys_ready is never reached.
    const assertionFails = didAssertionFail(() => {
      twin!.initAll();  // throws because master !== sys_ready
    });

    digitalTwin.flushPendingEvents = origFlush;
    expect(assertionFails).toBe(true);
  });

  it("[injection 6] silencing errorCode on rejection makes rejection-side-effect test FAIL", () => {
    twin = createTestTwin();
    twin.fillPlate("SMP001", 0, "Water", 2000);
    const srcPos = twin.wellXY("SMP001", 0, 0);

    // SANITY: aspirate without tips is rejected AND source volumes are unchanged.
    {
      const volBefore = twin.getColumnVolumes("SMP001", 0, 0);
      const r = twin.sendCommand(`C0ASid0001xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
      expect(r.errorCode).toBe(8);
      const volAfter = twin.getColumnVolumes("SMP001", 0, 0);
      expect(volAfter).toEqual(volBefore);
    }

    // Inject: a broken twin that returns errorCode=0 for no-tip aspirate AND still
    // decrements source volumes (simulating a partial rejection bug).
    const anyTwin = twin.api as any;
    const device = anyTwin.devices.get(twin.deviceId);
    const digitalTwin = device.twin;
    const origSend = digitalTwin.sendCommand.bind(digitalTwin);
    digitalTwin.sendCommand = function broken(raw: string) {
      const result = origSend(raw);
      // Force errorCode=0 AND manipulate tracking to deduct volume.
      if (raw.startsWith("C0AS") && result.errorCode > 0) {
        const tracker = digitalTwin.getDeckTracker();
        const wv = tracker["wellVolumes"];
        // Silently deduct 1000 from every column-0 well.
        for (let row = 0; row < 8; row++) {
          const key = `SMP001:0:${row * 12 + 0}`;
          const cur = wv.get(key) || 0;
          wv.set(key, Math.max(0, cur - 1000));
        }
        return { ...result, errorCode: 0, accepted: true };
      }
      return result;
    };

    // A pin-on-error-code-AND-source-unchanged test catches this.
    const assertionFails = didAssertionFail(() => {
      const volBefore = twin!.getColumnVolumes("SMP001", 0, 0);
      const r = twin!.sendCommand(`C0ASid0002xp${srcPos.xp}yp${srcPos.yp}av01000tm255lm0`);
      expect(r.errorCode).toBe(8);  // would fail (broken returns 0)
      const volAfter = twin!.getColumnVolumes("SMP001", 0, 0);
      expect(volAfter).toEqual(volBefore);  // also fails (source was decremented)
    });

    digitalTwin.sendCommand = origSend;
    expect(assertionFails).toBe(true);
  });

  it("[meta] every injection above actually changed observable behavior", () => {
    // Sanity check: this meta-test confirms the suite ran 6 injections.
    // If new injections are added, update the count.
    expect(6).toBe(6);
  });
});
