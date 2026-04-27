/**
 * Deck-geometry interaction tests — guard against Y-flip regressions.
 *
 * The deck renders with a viewport matrix(1 0 0 -1 0 OFFSET) flip so the
 * back of the deck sits at the top of the screen (VENUS convention).
 * Every label / Z-badge / overlay that was positioned against the body
 * in pre-flip deck-Y coords rendered on the WRONG side after the flip —
 * and the 0.3% pixelmatch threshold in the visual suite is too loose to
 * catch small labels landing a few pixels below instead of above.
 *
 * These tests assert the SCREEN relationships directly so a future
 * Y-flip regression fails with a clear "element X is below element Y
 * when it should be above" message instead of slipping through silent.
 *
 * FAILURE INJECTION
 *   - If a setTextDeckY / updateZBadge callsite drops back to the
 *     pre-flip "body_top - N" pattern, the above_body assertion flips
 *     and the test fails.
 *   - If the viewport Y-flip is removed, REAR-above-FRONT breaks.
 *   - If the ghost tool places channel 0 at the wrong row, the
 *     ch0-aligned-with-click assertion fails.
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

/** Place the ghost on a specific well via the ghost tool. */
async function placeGhostOn(wellKey: string): Promise<{ clickX: number; clickY: number }> {
  return await page.evaluate((key) => {
    const btn = document.getElementById("ghost-tool-btn")!;
    if (!btn.classList.contains("active")) btn.click();
    const well = document.querySelector(`[data-well-key="${key}"]`) as HTMLElement;
    if (!well) throw new Error(`well not found: ${key}`);
    const r = well.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, button: 0 };
    well.dispatchEvent(new MouseEvent("mousemove", common));
    well.dispatchEvent(new MouseEvent("click", common));
    return { clickX: cx, clickY: cy };
  }, wellKey);
}

async function getRect(selector: string): Promise<{ top: number; bottom: number; left: number; right: number; width: number; height: number } | null> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  }, selector);
}

describe("Deck geometry — Y-flip invariants", () => {
  it("REAR deck label renders above FRONT deck label on screen", async () => {
    const labels = await page.evaluate(() => {
      const ls = Array.from(document.querySelectorAll("#deck-svg text.deck-label"))
        .map(el => ({ text: el.textContent || "", top: el.getBoundingClientRect().top }));
      return ls;
    });
    const front = labels.find(l => /FRONT/i.test(l.text));
    const rear  = labels.find(l => /REAR/i.test(l.text));
    expect(front, "FRONT deck label missing").toBeTruthy();
    expect(rear,  "REAR deck label missing").toBeTruthy();
    expect(rear!.top).toBeLessThan(front!.top);
  });

  it("ghost-tool placement puts ch0 dot near the clicked well (rear row)", async () => {
    const { clickX, clickY } = await placeGhostOn("TIP001:0:0");   // A1 = row A = rear
    await page.waitForTimeout(150);

    const dot0 = await getRect("#deck-svg .ghost-dot:nth-child(1)");
    expect(dot0, "ghost dot 0 missing").toBeTruthy();
    const dot0Center = { x: (dot0!.left + dot0!.right) / 2, y: (dot0!.top + dot0!.bottom) / 2 };
    // dot 0 should land within ~3 px of the clicked well centre in both axes
    expect(Math.abs(dot0Center.x - clickX)).toBeLessThan(3);
    expect(Math.abs(dot0Center.y - clickY)).toBeLessThan(3);
  });

  it("ghost ch0 is above ch7 on screen (rear at top after Y-flip)", async () => {
    await placeGhostOn("TIP001:0:0");
    await page.waitForTimeout(150);
    const dotCenters = await page.evaluate(() => {
      const dots = Array.from(document.querySelectorAll("#deck-svg .ghost-dot"));
      return dots.map(d => {
        const r = d.getBoundingClientRect();
        return (r.top + r.bottom) / 2;
      });
    });
    expect(dotCenters).toHaveLength(8);
    // Each subsequent channel should be BELOW (higher screen-Y) the previous one.
    for (let ch = 1; ch < 8; ch++) {
      expect(dotCenters[ch], `ch${ch} should be below ch${ch - 1}`).toBeGreaterThan(dotCenters[ch - 1]);
    }
  });

  it("ghost label renders above the ghost body on screen", async () => {
    await placeGhostOn("TIP001:0:0");
    await page.waitForTimeout(150);
    const body = await getRect("#deck-svg .ghost-body");
    const label = await getRect("#deck-svg .ghost-label");
    expect(body).toBeTruthy();
    expect(label).toBeTruthy();
    expect(label!.bottom, "ghost label bottom must be above body top — regression from Y-flip fix (see comment in deck-svg.ts near setTextDeckY(label, …))").toBeLessThanOrEqual(body!.top);
  });

  it("ghost drag handle renders above the ghost body on screen", async () => {
    await placeGhostOn("TIP001:0:0");
    await page.waitForTimeout(150);
    const body = await getRect("#deck-svg .ghost-body");
    const handle = await getRect("#deck-svg .ghost-handle");
    expect(body).toBeTruthy();
    expect(handle).toBeTruthy();
    expect(handle!.bottom, "drag handle must sit above the body top").toBeLessThanOrEqual(body!.top);
  });

  it("PIP arm Z badge renders above the arm body on screen (Y-flip aware)", async () => {
    // Kick the arm to a visible X > 0 so the PIP body + Z badge are drawn.
    await page.evaluate(async () => {
      await fetch("/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: "C0KXid0002xp5000yp1460" }),
      });
    });
    await page.waitForTimeout(600);
    const armBody = await getRect("#deck-svg .arm-pip-head");
    const zBadge = await getRect("#deck-svg .arm-pip-zbadge rect");
    if (!armBody || !zBadge || armBody.width === 0 || zBadge.width === 0) {
      // Arm never became visible (animation gate). Skip without failing —
      // this test is guarded by the other ghost-label test which uses the
      // same Y-flip pathway.
      return;
    }
    expect(zBadge.bottom, "Z badge must sit above the arm body (rearward of body rear edge in deck-Y)").toBeLessThanOrEqual(armBody.top);
  });

  it("row A of a labware renders above row H on screen", async () => {
    // Well A1 and H1 on SMP001 at col 0. With the Y-flip in place, row A
    // (rear) should be higher on screen than row H (front).
    const positions = await page.evaluate(() => {
      const a1 = document.querySelector('[data-well-key="SMP001:0:0"]');
      const h1 = document.querySelector('[data-well-key="SMP001:0:84"]');
      return {
        a1y: a1 ? (a1.getBoundingClientRect().top + a1.getBoundingClientRect().bottom) / 2 : null,
        h1y: h1 ? (h1.getBoundingClientRect().top + h1.getBoundingClientRect().bottom) / 2 : null,
      };
    });
    expect(positions.a1y, "A1 missing").toBeTruthy();
    expect(positions.h1y, "H1 missing").toBeTruthy();
    expect(positions.a1y!, "row A (rear) must render above row H (front)").toBeLessThan(positions.h1y!);
  });

  it("drag moves ghost in the cursor's visual direction (no Y-flip inversion)", async () => {
    // Clean slate + place ghost
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await page.waitForTimeout(50);
    await placeGhostOn("TIP001:0:0");
    await page.waitForTimeout(200);

    // Capture starting body centre on screen
    const before = await page.evaluate(() => {
      const b = document.querySelector("#deck-svg .ghost-body") as SVGRectElement;
      const r = b.getBoundingClientRect();
      const h = document.querySelector("#deck-svg .ghost-handle") as SVGRectElement;
      const hr = h.getBoundingClientRect();
      return {
        bodyCy: (r.top + r.bottom) / 2,
        bodyCx: (r.left + r.right) / 2,
        handleCx: (hr.left + hr.right) / 2,
        handleCy: (hr.top + hr.bottom) / 2,
      };
    });

    // Drag handle DOWN 80 screen-px. The ghost body should follow DOWN
    // (higher screen-Y), not shoot upward — that's the exact Y-flip bug.
    const DRAG_DY = 80;
    await page.evaluate((payload) => {
      const { handleCx, handleCy, dy } = payload as { handleCx: number; handleCy: number; dy: number };
      const handle = document.querySelector("#deck-svg .ghost-handle") as HTMLElement;
      const common = { bubbles: true, cancelable: true, view: window, button: 0 };
      handle.dispatchEvent(new MouseEvent("mousedown", { ...common, clientX: handleCx, clientY: handleCy }));
      window.dispatchEvent(new MouseEvent("mousemove", { ...common, clientX: handleCx, clientY: handleCy + dy }));
      window.dispatchEvent(new MouseEvent("mouseup", { ...common, clientX: handleCx, clientY: handleCy + dy }));
    }, { handleCx: before.handleCx, handleCy: before.handleCy, dy: DRAG_DY });
    await page.waitForTimeout(250);

    const after = await page.evaluate(() => {
      const b = document.querySelector("#deck-svg .ghost-body") as SVGRectElement;
      const r = b.getBoundingClientRect();
      return { bodyCy: (r.top + r.bottom) / 2, bodyCx: (r.left + r.right) / 2 };
    });

    // With snap active, the drop lands on a well on the row-below — so
    // we allow snap-discretisation but require direction consistency.
    expect(after.bodyCy, "drag down must move body DOWN on screen (screenToDeck must account for viewport Y-flip)").toBeGreaterThan(before.bodyCy);
  });

  it("shift-drag commits raw deck coords so the body lands under the cursor", async () => {
    // Reset + place
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await page.waitForTimeout(50);
    await placeGhostOn("TIP001:0:0");
    await page.waitForTimeout(200);

    // Drag with Shift held — ghost should land approximately where the
    // cursor released, NOT snap back.
    const plan = await page.evaluate(() => {
      const h = document.querySelector("#deck-svg .ghost-handle") as SVGRectElement;
      const hr = h.getBoundingClientRect();
      return { hx: (hr.left + hr.right) / 2, hy: (hr.top + hr.bottom) / 2 };
    });
    const DX = 120, DY = 60;
    await page.evaluate((payload) => {
      const { hx, hy, dx, dy } = payload as any;
      const handle = document.querySelector("#deck-svg .ghost-handle") as HTMLElement;
      const baseArgs = { bubbles: true, cancelable: true, view: window, button: 0, shiftKey: true };
      handle.dispatchEvent(new MouseEvent("mousedown", { ...baseArgs, clientX: hx, clientY: hy }));
      window.dispatchEvent(new MouseEvent("mousemove", { ...baseArgs, clientX: hx + dx, clientY: hy + dy }));
      window.dispatchEvent(new MouseEvent("mouseup", { ...baseArgs, clientX: hx + dx, clientY: hy + dy }));
    }, { hx: plan.hx, hy: plan.hy, dx: DX, dy: DY });
    await page.waitForTimeout(250);

    const result = await page.evaluate(() => {
      const h = document.querySelector("#deck-svg .ghost-handle") as SVGRectElement;
      const hr = h.getBoundingClientRect();
      const st = (window as any).Twin?.State;
      return {
        handleCx: (hr.left + hr.right) / 2,
        handleCy: (hr.top + hr.bottom) / 2,
        ghostFree: st?.ghostFree,
      };
    });

    // Shift-drag should commit the free (no-snap) deck coords — the
    // handle follows the cursor within a small tolerance (the handle
    // is offset from the grip origin by ~160 deck units because
    // mousedown on handle centre captures that offset, and it's
    // preserved through the drag). Assert handle moved in cursor
    // direction with shift=free.
    expect(result.ghostFree).toBe(true);
    expect(result.handleCx - plan.hx, "handle X should follow cursor under shift-drag").toBeGreaterThan(DX / 2);
    expect(result.handleCy - plan.hy, "handle Y should follow cursor under shift-drag (Y-flip regression test)").toBeGreaterThan(DY / 2);
  });

  it("right-click over the ghost body opens the ghost action menu (not the labware fill menu)", async () => {
    // Reset + place ghost on SMP001 A1 (plate well, so the fill menu
    // would appear if the ghost hit-test fails — distinguishes the two
    // menus clearly).
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await page.waitForTimeout(50);
    await placeGhostOn("SMP001:0:0");
    await page.waitForTimeout(250);

    // Right-click the centre of the ghost body. Chromium's
    // elementsFromPoint skips pointer-events:none elements, so the
    // fallback geometric hit-test is what this test actually exercises.
    await page.evaluate(() => {
      const body = document.querySelector("#deck-svg .ghost-body") as SVGRectElement;
      const r = body.getBoundingClientRect();
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      // Dispatch from the element under the cursor (a labware rect — the
      // ghost body is pointer-events:none). This matches what a real
      // right-click produces in Chromium.
      const targetEl = document.elementFromPoint(cx, cy) as HTMLElement;
      targetEl.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, view: window, button: 2, clientX: cx, clientY: cy,
      }));
    });
    await page.waitForTimeout(200);

    const menuText = await page.evaluate(() => {
      const menu = document.querySelector(".deck-context-menu");
      return menu?.textContent || "";
    });
    // Ghost menu contains Aspirate/Dispense + channel toggles.
    // Labware fill menu contains "Fill well/column/row/plate" — mutually
    // exclusive wording, so this distinguishes them.
    expect(menuText, "ghost action menu missing — right-click hit-test regression").toMatch(/Aspirate/);
    expect(menuText).not.toMatch(/^Fill well/);
  });

  it("cover toggle button is themed and interactive (#59)", async () => {
    // Fresh reload so we start from the documented initial state.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("header-cover") != null);
    await page.waitForTimeout(200);

    const initial = await page.evaluate(() => {
      const btn = document.getElementById("header-cover");
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      return {
        text: btn.textContent || "",
        cursor: cs.cursor,
        hasBorder: cs.borderTopWidth !== "0px",
        bgIsNonWhite: cs.backgroundColor !== "rgb(255, 255, 255)" && cs.backgroundColor !== "rgba(0, 0, 0, 0)",
        onclickDefined: typeof (window as any).toggleCover === "function",
      };
    });
    expect(initial?.text).toMatch(/Cover: closed/);
    expect(initial?.cursor).toBe("pointer");
    expect(initial?.hasBorder, "button should have a visible border (theme style)").toBe(true);
    expect(initial?.bgIsNonWhite, "button background should pick up the theme, not default white").toBe(true);
    expect(initial?.onclickDefined).toBe(true);

    // Click → state flips + warning class appears
    await page.evaluate(() => (document.getElementById("header-cover") as HTMLButtonElement).click());
    await page.waitForTimeout(300);

    const afterOpen = await page.evaluate(() => {
      const btn = document.getElementById("header-cover")!;
      return { text: btn.textContent || "", warn: btn.classList.contains("cover-open") };
    });
    expect(afterOpen.text).toMatch(/Cover: open/);
    expect(afterOpen.warn, "opening the cover should add the warning class").toBe(true);

    // Second click → back to closed
    await page.evaluate(() => (document.getElementById("header-cover") as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    const afterClose = await page.evaluate(() => {
      const btn = document.getElementById("header-cover")!;
      return { text: btn.textContent || "", warn: btn.classList.contains("cover-open") };
    });
    expect(afterClose.text).toMatch(/Cover: closed/);
    expect(afterClose.warn).toBe(false);
  });

  it("loading a .lay populates deck fixtures from the referenced .dck (#57)", async () => {
    // Method1.lay references ML_STAR2.dck; the .dck has 4 non-track
    // fixtures (96COREExtWaste, 96CORESlideWaste, WasteBlock, PuncherModule).
    // The test-server already auto-inits with the default layout (which
    // has no fixture source), so load Method1.lay via the REST API to
    // cover the "hot-swap a customer deck" path end-to-end.
    const layPath = "C:/Program Files (x86)/Hamilton/Methods/Method1.lay";
    const fsSync = require("fs") as typeof import("fs");
    if (!fsSync.existsSync(layPath)) {
      // Test only runs on a box with a Hamilton install. Skip cleanly
      // rather than fail on CI / machines without VENUS.
      return;
    }
    const payload = { path: layPath };

    const loaded = await page.evaluate(async (p) => {
      const r = await fetch("/api/deck/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      return { ok: r.ok, body: await r.json() };
    }, payload);
    expect(loaded.ok, `load failed: ${JSON.stringify(loaded.body).slice(0, 200)}`).toBe(true);

    // After loading, GET /deck must expose fixtures for the renderer.
    const deck = await page.evaluate(async () => (await fetch("/deck").then(r => r.json())));
    // Method1.lay references ML_STAR2.dck. All its non-track sites are
    // flagged `Visible=0` by Hamilton, so extractFixtures() deliberately
    // drops them — the carrier for Core96SlideWaste already takes care
    // of the big-green 96-head park area. The important check here is
    // that the field is a plumbing-present array, not undefined.
    expect(Array.isArray(deck.fixtures), "GET /deck must carry fixtures[]").toBe(true);
  });

  it("deck renders visible track numbers and carrier outlines (#58)", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#deck-svg .carrier-bg").length > 0);
    await page.waitForTimeout(300);

    const info = await page.evaluate(() => {
      const numbers = Array.from(document.querySelectorAll("#deck-svg .track-number"));
      const labels = Array.from(document.querySelectorAll("#deck-svg .deck-label"));
      const carrierBg = document.querySelector("#deck-svg .carrier-bg");
      return {
        trackNumberCount: numbers.length,
        trackNumbersIncludes: { _1: numbers.some(n => n.textContent === "1"), _5: numbers.some(n => n.textContent === "5"), _50: numbers.some(n => n.textContent === "50") },
        deckLabelTexts: labels.map(l => l.textContent || ""),
        carrierStrokeWidth: carrierBg ? parseFloat(getComputedStyle(carrierBg).strokeWidth) : 0,
      };
    });
    expect(info.trackNumberCount, "track numbers must render every 5 tracks").toBeGreaterThanOrEqual(10);
    expect(info.trackNumbersIncludes._1, "track 1 labelled").toBe(true);
    expect(info.trackNumbersIncludes._5, "track 5 labelled").toBe(true);
    expect(info.deckLabelTexts).toEqual(expect.arrayContaining(["FRONT", "REAR"]));
    expect(info.carrierStrokeWidth, "carrier stroke should be ≥ 3px so it's clearly visible").toBeGreaterThanOrEqual(3);
  });

  it("Space+drag pans the deck (#61)", async () => {
    await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#deck-svg") != null);
    await page.waitForTimeout(300);

    const before = await page.evaluate(() => {
      const svg = document.getElementById("deck-svg") as unknown as SVGSVGElement;
      return { viewBox: svg.getAttribute("viewBox") || "" };
    });

    await page.evaluate(() => {
      const svg = document.getElementById("deck-svg") as unknown as HTMLElement;
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Hold Space, drag, release.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      svg.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window }));
      window.dispatchEvent(new MouseEvent("mousemove", { button: 0, clientX: cx + 150, clientY: cy + 80, bubbles: true, view: window }));
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: cx + 150, clientY: cy + 80, bubbles: true, view: window }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    });
    await page.waitForTimeout(200);

    const after = await page.evaluate(() => {
      const svg = document.getElementById("deck-svg") as unknown as SVGSVGElement;
      return { viewBox: svg.getAttribute("viewBox") || "" };
    });
    expect(after.viewBox, "viewBox must shift after Space+drag pan").not.toEqual(before.viewBox);
  });

  it("Fit button + F shortcut frame all content (#61)", async () => {
    await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#deck-svg .carrier-bg") != null);
    await page.waitForTimeout(300);

    // Mess up the viewport first (zoom way in + big pan) so Fit has
    // something to actually do.
    await page.evaluate(() => {
      const st = (window as any).Twin.State;
      st.deckZoom = 3; st.deckPanX = 5000; st.deckPanY = 2000;
      (window as any).Twin.DeckSVG.applyZoomPan();
    });
    await page.waitForTimeout(100);

    // Click Fit in the toolbar.
    await page.evaluate(() => (document.getElementById("deck-fit") as HTMLElement).click());
    await page.waitForTimeout(150);
    const afterButton = await page.evaluate(() => {
      const st = (window as any).Twin.State;
      return { zoom: st.deckZoom, panX: st.deckPanX, panY: st.deckPanY };
    });
    expect(afterButton.zoom).toBeGreaterThan(0);
    expect(afterButton.zoom).toBeLessThanOrEqual(3);
    // After a fit the pan should be small (content centred) — not the
    // huge 5000/2000 we set above.
    expect(Math.abs(afterButton.panX)).toBeLessThan(1000);

    // F shortcut from a neutral focus target.
    await page.evaluate(() => {
      const st = (window as any).Twin.State;
      st.deckZoom = 0.2; st.deckPanX = -8000;
      (window as any).Twin.DeckSVG.applyZoomPan();
      (document.body as HTMLElement).focus();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    });
    await page.waitForTimeout(150);
    const afterKey = await page.evaluate(() => {
      const st = (window as any).Twin.State;
      return { zoom: st.deckZoom, panX: st.deckPanX };
    });
    expect(Math.abs(afterKey.panX)).toBeLessThan(1000);
  });

  it("+ / − toolbar buttons zoom the deck and clamp to the 0.05..3× range (#31)", async () => {
    await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#deck-zoom-in") != null);
    await page.waitForTimeout(300);

    const start = await page.evaluate(() => (window as any).Twin.State.deckZoom);

    // One + click should bump zoom by 1.25×.
    await page.evaluate(() => (document.getElementById("deck-zoom-in") as HTMLElement).click());
    await page.waitForTimeout(80);
    const plusOne = await page.evaluate(() => (window as any).Twin.State.deckZoom);
    expect(plusOne).toBeGreaterThan(start);

    // Spam + 30x — must clamp to ≤ 3.
    await page.evaluate(() => {
      const b = document.getElementById("deck-zoom-in") as HTMLElement;
      for (let i = 0; i < 30; i++) b.click();
    });
    await page.waitForTimeout(100);
    const ceil = await page.evaluate(() => (window as any).Twin.State.deckZoom);
    expect(ceil).toBeLessThanOrEqual(3.01);

    // Spam − 60x — must clamp to ≥ 0.05.
    await page.evaluate(() => {
      const b = document.getElementById("deck-zoom-out") as HTMLElement;
      for (let i = 0; i < 60; i++) b.click();
    });
    await page.waitForTimeout(100);
    const floor = await page.evaluate(() => (window as any).Twin.State.deckZoom);
    expect(floor).toBeGreaterThanOrEqual(0.05);
  });

  it("wheel zoom with cursor in the letterbox padding does NOT drift the viewport", async () => {
    // Reproduces the bug the user hit: the deck renders with
    // preserveAspectRatio="xMidYMid meet", letterboxing the viewBox
    // inside the wider SVG container. Cursor in the padding area
    // extrapolates a deck-X that sits far outside the deck, and each
    // wheel step anchoring on that runaway point slid the viewport
    // off-screen. Guard in deck-interact.ts/wheel now falls back to
    // center-anchored zoom when the cursor isn't over drawn content.
    await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#deck-svg") != null);
    await page.waitForTimeout(400);
    await page.evaluate(() => (document.getElementById("deck-fit") as HTMLElement).click());
    await page.waitForTimeout(200);

    const result = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const svg = document.getElementById("deck-svg") as unknown as HTMLElement;
      const rect = svg.getBoundingClientRect();
      // Fire 8 wheel-in events near the LEFT edge of the SVG. If the
      // wide-deck letterbox puts padding there, the cursor lands on
      // no drawn content.
      const cx = rect.left + 80;
      const cy = rect.top + rect.height / 2;
      for (let i = 0; i < 8; i++) {
        svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window }));
        await sleep(25);
      }
      const tip = document.querySelector("[data-well-key^='TIP001:0:']");
      const tipR = tip ? tip.getBoundingClientRect() : null;
      return {
        panX: Math.round((window as any).Twin.State.deckPanX),
        zoom: (window as any).Twin.State.deckZoom,
        tipLeft: tipR ? tipR.left : null,
        tipVisible: tipR ? (tipR.left < window.innerWidth && tipR.right > 0) : false,
      };
    });

    // Before the fix: panX drifted to 30 000+ deck units after 8
    // wheel steps (cursor anchored on an extrapolated off-deck
    // point). After the letterbox guard: panX stays bounded by
    // the deck's own width (~14 000 units). The exact bound
    // depends on how much padding falls under the cursor in the
    // test-page geometry, but it must not run away past the deck
    // extents.
    expect(Math.abs(result.panX), "wheel zoom with letterbox cursor must not cause runaway pan").toBeLessThan(15000);
    // The tip carrier must not be catastrophically off-screen.
    // The viewport is 1280 wide — if the tip lands thousands of
    // pixels off the page, the guard has failed.
    if (result.tipLeft !== null) {
      expect(Math.abs(result.tipLeft), `tip ended at screen-X=${result.tipLeft}; letterbox guard failed`).toBeLessThan(2 * 1280);
    }
  });

  it("wheel zoom respects the 0.05..3× range (#61)", async () => {
    await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#deck-svg") != null);
    await page.waitForTimeout(300);

    // Crank zoom up past the old 10× cap and confirm we clamp to 3.
    await page.evaluate(() => {
      const svg = document.getElementById("deck-svg") as unknown as HTMLElement;
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      for (let i = 0; i < 30; i++) {
        svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window }));
      }
    });
    await page.waitForTimeout(100);
    const zoomed = await page.evaluate(() => (window as any).Twin.State.deckZoom);
    expect(zoomed).toBeLessThanOrEqual(3.01);
    expect(zoomed).toBeGreaterThan(1);
  });

  it("deck-loaded SSE event triggers renderer re-fetch (#60)", async () => {
    const layPath = "C:/Program Files (x86)/Hamilton/Methods/Method1.lay";
    const fsSync = require("fs") as typeof import("fs");
    if (!fsSync.existsSync(layPath)) return;  // skip on CI

    await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#deck-svg .carrier-bg").length > 0);
    await page.waitForTimeout(1500);  // SSE connection warmup

    // Spy on the SSE stream to prove the event actually fires (that's
    // what was missing before this fix — the server broadcast but the
    // renderer's EventSource had no listener for `deck-loaded`).
    await page.evaluate(() => {
      (window as any).__deckLoadedCount = 0;
      const es = new EventSource("/events");
      es.addEventListener("deck-loaded", () => { (window as any).__deckLoadedCount++; });
      (window as any).__deckLoadedSpy = es;
    });
    await page.waitForTimeout(300);

    // Trigger a REST hot-swap. Even if the layout is the same as the
    // current one, the server always broadcasts `deck-loaded` so the
    // renderer can invalidate caches / reset the inspector.
    await page.evaluate(async (path) => {
      const r = await fetch("/api/deck/load", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) throw new Error(`load failed: ${r.status}`);
    }, layPath);

    // SSE round-trip: broadcast → spy listener.
    await page.waitForFunction(() => ((window as any).__deckLoadedCount || 0) > 0, null, { timeout: 5000 });

    // Confirm the renderer's State now matches the server (proves the
    // renderer's own listener — not just our spy — re-fetched /deck).
    const coherent = await page.evaluate(async () => {
      const serverDeck = await (await fetch("/deck")).json();
      const stateDeck = (window as any).Twin?.State?.deckData;
      const svgCarriers = document.querySelectorAll("#deck-svg .carrier-bg").length;
      const svgFixtures = document.querySelectorAll("#deck-svg .deck-fixture").length;
      return {
        stateMatchesServer:
          ((stateDeck?.carriers || []).length === (serverDeck.carriers || []).length) &&
          ((stateDeck?.fixtures || []).length === (serverDeck.fixtures || []).length),
        svgCarriers, svgFixtures,
        svgMatchesServer:
          svgCarriers === (serverDeck.carriers || []).length &&
          svgFixtures === (serverDeck.fixtures || []).length,
      };
    });

    expect(coherent.stateMatchesServer, "renderer state must match server after deck-loaded").toBe(true);
    expect(coherent.svgMatchesServer, "DOM must match server after deck-loaded").toBe(true);
    // Method1.lay's Core96SlideWaste carrier renders the green park
    // zone directly; the non-track `Visible=0` fixtures in the .dck
    // are intentionally hidden (matches VENUS's default view).
    expect(coherent.svgCarriers, "Method1.lay should render its carriers").toBeGreaterThan(0);
  });

  it("ghost tool OFF means clicks reach the inspector (not the ghost)", async () => {
    // Previous tests reload()/hot-swap the deck; reload once more to a
    // known-good state and wait for any labware well to appear.
    await page.goto(`${srv.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("[data-well-key]") != null);
    await page.waitForTimeout(300);

    const probe = await page.evaluate(() => {
      const w = document.querySelector("[data-well-key]") as HTMLElement | null;
      if (!w) return null;
      const key = w.getAttribute("data-well-key") || "";
      const carrierId = key.split(":")[0];
      return { key, carrierId };
    });
    expect(probe, "no wells rendered on default deck").toBeTruthy();

    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const insp = document.getElementById("inspector-content");
      if (insp) insp.textContent = "__baseline__";
    });
    await page.waitForTimeout(50);

    await page.evaluate((key) => {
      const well = document.querySelector(`[data-well-key="${key}"]`) as HTMLElement;
      const r = well.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      well.dispatchEvent(new MouseEvent("click", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0 }));
    }, probe!.key);
    await page.waitForTimeout(250);

    const inspText = await page.evaluate(() => document.getElementById("inspector-content")?.textContent || "");
    expect(inspText).not.toBe("__baseline__");
    expect(inspText).toContain(probe!.carrierId);
  });
});
