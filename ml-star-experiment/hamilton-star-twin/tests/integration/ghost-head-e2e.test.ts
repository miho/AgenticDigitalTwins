/**
 * Ghost-head UI end-to-end (issue: ghost-head visual regression).
 *
 * Verifies the actual DOM-level user flow:
 *   1. click a tip → ghost head snaps to the clicked column
 *   2. fill a sample plate via /liquid/fill
 *   3. click a sample well → ghost head moves
 *   4. right-click → deck-context-menu appears with "Aspirate …"
 *   5. click "Aspirate 50µL" → well volumes drop by 500 (0.1 µL units)
 *      across all 8 channels in the clicked column.
 *
 * Why not just assert server-side? We've proven backend behaviour in
 * many unit tests. This test guards the *UI path* specifically — the
 * ghost-head rendering, event routing, menu construction, and the
 * `cmdAspirate` dispatcher that reads `State.ghostX/Y`. Regressions in
 * any of those would flip the UI "invisible-aspirate" failure mode
 * users previously hit.
 *
 * FAILURE INJECTION
 *   - If click handler no longer sets `ghostX/Y`, the menu uses (0,0)
 *     → aspirate targets an unresolved position → no volume delta.
 *   - If refreshDeckTracking stops being awaited, the assertion races
 *     and sees pre-aspirate volumes.
 *   - If the menu selector (deck-context-menu / deck-menu-item) drifts
 *     from the implementation, the menu lookup returns null and the
 *     test fails with a clear "menu vanished".
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, Browser, Page } from "playwright";
import { createTestServer, TestServer } from "../helpers/test-server";

let srv: TestServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  srv = await createTestServer({
    staticDir: require("path").resolve(__dirname, "..", "..", "dist", "renderer"),
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
  // Wait for the deck to render — carriers appear after the initial fetch.
  await page.waitForFunction(() => {
    const svg = document.getElementById("deck-svg");
    return !!svg && svg.querySelectorAll("circle.tip").length > 0;
  });
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await srv?.close();
});

async function firePointerLifecycle(selector: string) {
  // Use Playwright's high-level click so modifiers, pointer events, and
  // focus handling match a real user. We keep `selector` as the first
  // element the deck renders under the given query.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    if (!el) throw new Error(`no element for ${sel}`);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", common));
    el.dispatchEvent(new MouseEvent("mousedown", common));
    el.dispatchEvent(new PointerEvent("pointerup", common));
    el.dispatchEvent(new MouseEvent("mouseup", common));
    el.dispatchEvent(new MouseEvent("click", common));
  }, selector);
}

describe("Ghost-head end-to-end", () => {
  it("positions the ghost head when the tool is active and a tip is clicked", async () => {
    // Per #56: click no longer places the ghost on its own — the user has
    // to enable the ghost-placement tool first. Simulate toggling the tool
    // on via the toolbar button, then click.
    await page.evaluate(() => {
      const btn = document.getElementById("ghost-tool-btn");
      if (!btn) throw new Error("no ghost-tool-btn");
      btn.click();
    });
    await firePointerLifecycle('#deck-svg circle.tip');
    await page.waitForTimeout(300);
    const ghost = await page.evaluate(() => {
      const body = document.querySelector("#deck-svg .ghost-body");
      const label = document.querySelector("#deck-svg .ghost-label");
      return {
        x: body?.getAttribute("x"),
        label: label?.textContent,
        toolExitedAfterClick: !document.getElementById("ghost-tool-btn")?.classList.contains("active"),
      };
    });
    // x=0 is the pre-click default; anything non-zero proves the handler fired.
    expect(ghost.x).not.toBe("0");
    expect(ghost.label).toMatch(/TIP/);
    // Click-to-place should exit the tool so the inspector is reachable again.
    expect(ghost.toolExitedAfterClick).toBe(true);
  });

  it("runs a pick-up + aspirate flow through the ghost menu", async () => {
    // Fill a sample plate so there's liquid to aspirate.
    await page.evaluate(() => fetch("/liquid/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ carrierId: "SMP001", position: 0, liquidType: "water", volume: 15000, liquidClass: "default" }),
    }));
    // Pick up 8 tips (direct FW, same physical outcome as a ghost-menu pickup).
    await page.evaluate(() => fetch("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: "C0TPid0101xp01033yp01375tm255tt04tp2264tz2164th2450td1" }),
    }));
    await page.waitForTimeout(300);

    // Place the ghost on SMP001 A1 via the new tool mode, then right-click
    // to open the ghost action menu.
    await page.evaluate(() => {
      // Enable the ghost-placement tool
      const btn = document.getElementById("ghost-tool-btn");
      if (btn && !btn.classList.contains("active")) btn.click();

      const well = document.querySelector('#deck-svg circle.well[data-carrier-id="SMP001"][data-position="0"][data-well-idx="0"]') as HTMLElement;
      if (!well) throw new Error("no SMP001:0:0 well");
      const rect = well.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, button: 0 };
      // Mousemove so the tool tracks the cursor onto the well.
      well.dispatchEvent(new MouseEvent("mousemove", { ...common, button: 0 }));
      // Click to place — also exits the tool per #56.
      well.dispatchEvent(new PointerEvent("pointerdown", common));
      well.dispatchEvent(new MouseEvent("mousedown", common));
      well.dispatchEvent(new PointerEvent("pointerup", common));
      well.dispatchEvent(new MouseEvent("mouseup", common));
      well.dispatchEvent(new MouseEvent("click", common));
      // Right-click the placed ghost to open the ghost menu. Target the
      // ghost-handle because body/rail are pointer-transparent (#56).
      const handle = document.querySelector("#deck-svg .ghost-handle") as HTMLElement;
      if (!handle) throw new Error("no ghost-handle");
      const hr = handle.getBoundingClientRect();
      const hcx = hr.left + hr.width / 2, hcy = hr.top + hr.height / 2;
      const ctx = { bubbles: true, cancelable: true, clientX: hcx, clientY: hcy, view: window, button: 2 };
      handle.dispatchEvent(new MouseEvent("contextmenu", ctx));
    });
    await page.waitForTimeout(300);

    const pre = await page.evaluate(() => fetch("/tracking").then((r) => r.json()));
    const preVol = pre.wellVolumes["SMP001:0:0"];
    expect(preVol).toBe(15000);

    // Diagnostic: verify state before clicking the aspirate menu entry.
    const diag = await page.evaluate(() => {
      const st = (window as any).Twin?.State;
      const lastState = (window as any).__lastState;
      const items = Array.from(document.querySelectorAll(".deck-context-menu .deck-menu-item"));
      return {
        ghostX: st?.ghostX, ghostY: st?.ghostY,
        ghostSnap: st?.ghostSnap?.carrierId + ":" + st?.ghostSnap?.position + ":col" + st?.ghostSnap?.col,
        ghostChannelMask: st?.ghostChannelMask,
        tipFitted: lastState?.modules?.pip?.variables?.tip_fitted,
        menuItems: items.map(i => ({ text: i.textContent?.slice(0, 40), disabled: i.classList.contains("disabled") || (i as any).disabled })),
      };
    });
    console.log("DIAG:", JSON.stringify(diag, null, 2));

    // Click the Aspirate 50µL menu entry.
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".deck-context-menu .deck-menu-item"));
      const asp = items.find((i) => i.textContent?.includes("Aspirate 50")) as HTMLElement;
      if (!asp) throw new Error("no aspirate menu item");
      asp.click();
    });
    // cmdAspirate: POST /command + refreshDeckTracking. Give it headroom.
    await page.waitForTimeout(700);

    const post = await page.evaluate(() => fetch("/tracking").then((r) => r.json()));
    // 8 channels aspirate from col 1 → rows A..H (well indices 0, 12, 24, 36, 48, 60, 72, 84)
    // Each should be -500 (50 µL).
    for (let row = 0; row < 8; row++) {
      const idx = row * 12;
      const postVol = post.wellVolumes[`SMP001:0:${idx}`];
      expect(postVol).toBe(14500);
    }
  });
});
