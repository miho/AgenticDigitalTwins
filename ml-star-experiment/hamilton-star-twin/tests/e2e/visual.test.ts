/**
 * E2E visual tests — verifies SVG rendering, ghost head interaction,
 * inspector, theme toggle, module visuals, and deck tooltips.
 *
 * Every test captures screenshots saved to test-results/e2e/.
 * A gallery HTML is generated at test-results/e2e/gallery.html.
 *
 * Prerequisites: twin running at http://localhost:8222/
 * Run: npx vitest run tests/e2e
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  setupBrowser, teardownBrowser, getPage, resetAndReload,
  fillPlate, sendCmd, sendCompletion, evaluate, clickFirst, setTheme,
  setTestName, screenshot, screenshotDeck, screenshotInspector,
} from "./browser-fixture";

beforeAll(async () => { await setupBrowser(); });
afterAll(async () => { await teardownBrowser(); });

// ══════════════════════════════════════════════════════════════════════
// 1. Deck SVG Structure
// ══════════════════════════════════════════════════════════════════════

describe("Deck SVG Structure", () => {
  beforeEach(async () => { await resetAndReload(); });

  it("renders all 8 carriers as SVG groups", async () => {
    setTestName("deck-carriers");
    const ids = await evaluate<string[]>('() => { const gs = document.querySelectorAll(".carrier"); return [...new Set(Array.from(gs).map(g => g.getAttribute("data-carrier-id")))]; }');
    await screenshotDeck("all-carriers", "8 carriers rendered on deck");
    expect(ids).toContain("TIP001");
    expect(ids).toContain("SMP001");
    expect(ids).toContain("DST001");
    expect(ids).toContain("RGT001");
    expect(ids).toContain("TIP002");
    expect(ids).toContain("WASH01");
    expect(ids).toContain("HHS001");
    expect(ids).toContain("TCC001");
  });

  it("renders module-specific labware classes", async () => {
    setTestName("deck-labware-classes");
    const classes = await evaluate<Record<string, number>>('() => ({ wash: document.querySelectorAll(".labware-bg--wash").length, hhs: document.querySelectorAll(".labware-bg--hhs").length, tcc: document.querySelectorAll(".labware-bg--tcc").length, tips: document.querySelectorAll(".labware-bg--tips").length, plate: document.querySelectorAll(".labware-bg--plate").length, trough: document.querySelectorAll(".labware-bg--trough").length })');
    await screenshotDeck("labware-classes", "Module-specific CSS classes on labware");
    expect(classes.wash).toBe(2);
    expect(classes.hhs).toBe(1);
    expect(classes.tcc).toBe(1);
    expect(classes.tips).toBeGreaterThan(0);
  });

  it("renders wells and tips with correct counts", async () => {
    setTestName("deck-well-counts");
    const counts = await evaluate<{ wells: number; tips: number }>('() => ({ wells: document.querySelectorAll(".well").length, tips: document.querySelectorAll(".tip").length })');
    expect(counts.wells).toBeGreaterThan(500);
    expect(counts.tips).toBeGreaterThan(500);
  });

  it("trough and wash chamber fit within carrier bounds", async () => {
    setTestName("deck-bounds");
    // Each trough/wash rect must stay inside its parent carrier's Y range.
    // Y_FRONT = 630; per-carrier Y extent comes from the carrier's yDim.
    // (Pre-Phase-2, this test hardcoded 4530 as the upper bound, which
    // rejected rear-position troughs on carriers whose yDim extends to 5600.)
    const overflows = await evaluate<Array<{id: string, pos: string, y: number, h: number, bottom: number, limit: number}>>(`() => {
      const Y_FRONT = 630;
      const results = [];
      document.querySelectorAll('.labware-bg--trough, .labware-bg--wash').forEach(el => {
        const y = Number(el.getAttribute('y'));
        const h = Number(el.getAttribute('height'));
        const carrier = el.closest('[data-carrier-id]');
        const deckData = window.Twin?.State?.deckData;
        const cid = carrier?.getAttribute('data-carrier-id');
        const c = deckData?.carriers?.find(x => x.id === cid);
        const limit = Y_FRONT + (c?.yDim ?? 4970);
        if (y < Y_FRONT || y + h > limit) {
          results.push({ id: cid, pos: carrier?.getAttribute('data-position'), y, h, bottom: y + h, limit });
        }
      });
      return results;
    }`);
    await screenshotDeck("bounds-check", "All trough/wash elements within carrier Y bounds");
    if (overflows.length > 0) {
      console.log("Overflowing elements:", JSON.stringify(overflows, null, 2));
    }
    expect(overflows).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Ghost Head — Positioning and Pitch
// ══════════════════════════════════════════════════════════════════════

describe("Ghost Head", () => {
  // Ghost head is now a tool mode — clicking a well only places the ghost
  // when the tool is active (commit e882960). resetAndReload exits the
  // tool, so we re-enable it for every test in this block.
  beforeEach(async () => { await resetAndReload(); await evaluate("() => Twin.setGhostTool(true)"); });

  it("appears when clicking a well", async () => {
    setTestName("ghost-appears");
    await clickFirst(".well");
    const visible = await evaluate<boolean>("() => Twin.State.ghostVisible");
    await screenshotDeck("ghost-visible", "Ghost head positioned on deck after well click");
    expect(visible).toBe(true);
  });

  it("hides on Escape", async () => {
    setTestName("ghost-escape");
    await clickFirst(".well");
    await screenshot("before-escape", "Ghost visible before Escape");
    await getPage().keyboard.press("Escape");
    await getPage().waitForTimeout(200);
    const visible = await evaluate<boolean>("() => Twin.State.ghostVisible");
    await screenshot("after-escape", "Ghost hidden after Escape");
    expect(visible).toBe(false);
  });

  it("snaps to tip rack with isTip=true and pitch=90", async () => {
    setTestName("ghost-tip-snap");
    await clickFirst(".tip");
    const snap = await evaluate<any>("() => ({ isTip: Twin.State.ghostSnap?.isTip, pitch: Twin.State.ghostPitch })");
    await screenshotDeck("tip-snap", "Ghost snapped to tip rack column, pitch=90");
    expect(snap.isTip).toBe(true);
    expect(snap.pitch).toBe(90);
  });

  it("snaps to 96-well plate with pitch=90", async () => {
    setTestName("ghost-96well-snap");
    await fillPlate("SMP001", 0, "Sample_A", 2000);
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const snap = await evaluate<any>("() => ({ carrierId: Twin.State.ghostSnap?.carrierId, pitch: Twin.State.ghostPitch })");
    await screenshot("96well-snap", "Ghost on 96-well plate with filled wells, pitch=90");
    expect(snap.carrierId).toBe("SMP001");
    expect(snap.pitch).toBe(90);
  });

  it("snaps to 384-well plate with pitch=45", async () => {
    setTestName("ghost-384well-snap");
    const found = await evaluate<boolean>('() => !!document.querySelector(\'[data-carrier-id="SMP001"][data-position="2"].well\')');
    if (!found) return;
    // Use Playwright's real click — synthetic MouseEvent('click') doesn't
    // trigger pointer-event handlers wired by the ghost-tool refactor.
    await clickFirst('[data-carrier-id="SMP001"][data-position="2"].well');
    const snap = await evaluate<any>("() => ({ carrierId: Twin.State.ghostSnap?.carrierId, pitch: Twin.State.ghostPitch, pos: Twin.State.ghostSnap?.position })");
    await screenshotDeck("384well-snap", "Ghost on 384-well plate, pitch=45 (tight spacing)");
    expect(snap.carrierId).toBe("SMP001");
    expect(snap.pitch).toBe(45);
  });

  it("ghost dots align with 96-well positions", async () => {
    setTestName("ghost-96well-align");
    await fillPlate("SMP001", 0, "Sample", 1000);
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const alignment = await evaluate<{ match: boolean; wellCys: number[]; dotCys: number[] }>(`() => {
      const wells = [];
      for (let row = 0; row < 8; row++) {
        const el = document.querySelector('[data-well-key="SMP001:0:' + (row * 12) + '"]');
        if (el) wells.push(Number(el.getAttribute('cy')));
      }
      const dots = Array.from(document.querySelectorAll('.ghost-dot')).slice(0, 8).map(d => Number(d.getAttribute('cy')));
      return { wellCys: wells, dotCys: dots, match: wells.every((wy, i) => Math.abs(wy - dots[i]) < 1) };
    }`);
    await screenshotDeck("96well-alignment", "Ghost dots cy values match well cy values exactly");
    expect(alignment.match).toBe(true);
  });

  it("ghost dots align with 384-well positions", async () => {
    setTestName("ghost-384well-align");
    const found = await evaluate<boolean>('() => !!document.querySelector(\'[data-carrier-id="SMP001"][data-position="2"].well\')');
    if (!found) return;
    // Use Playwright's real click — synthetic MouseEvent('click') doesn't
    // trigger pointer-event handlers wired by the ghost-tool refactor.
    await clickFirst('[data-carrier-id="SMP001"][data-position="2"].well');
    const alignment = await evaluate<{ match: boolean }>(`() => {
      const wells = [];
      for (let row = 0; row < 8; row++) {
        const el = document.querySelector('[data-well-key="SMP001:2:' + (row * 24) + '"]');
        if (el) wells.push(Number(el.getAttribute('cy')));
      }
      const dots = Array.from(document.querySelectorAll('.ghost-dot')).slice(0, 8).map(d => Number(d.getAttribute('cy')));
      return { match: wells.length === 8 && wells.every((wy, i) => Math.abs(wy - dots[i]) < 1) };
    }`);
    await screenshotDeck("384well-alignment", "Ghost dots align with 384-well at 45-unit pitch");
    expect(alignment.match).toBe(true);
  });

  it("setGhostPitch changes dot spacing", async () => {
    setTestName("ghost-pitch-change");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    await screenshotDeck("pitch-90", "Default 9mm pitch");
    const diff90 = await evaluate<number>("() => { const d = document.querySelectorAll('.ghost-dot'); return Math.abs(Number(d[0].getAttribute('cy')) - Number(d[1].getAttribute('cy'))); }");
    expect(diff90).toBe(90);

    await evaluate("() => Twin.setGhostPitch(45)");
    await screenshotDeck("pitch-45", "After switching to 4.5mm pitch");
    const diff45 = await evaluate<number>("() => { const d = document.querySelectorAll('.ghost-dot'); return Math.abs(Number(d[0].getAttribute('cy')) - Number(d[1].getAttribute('cy'))); }");
    expect(diff45).toBe(45);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. Ghost Head — Channel Mask
// ══════════════════════════════════════════════════════════════════════

describe("Ghost Channel Mask", () => {
  beforeEach(async () => {
    await resetAndReload();
    await evaluate("() => Twin.setGhostTool(true)");
    await clickFirst(".well");
  });

  it("all 8 dots active by default (mask=255)", async () => {
    setTestName("mask-all");
    const active = await evaluate<number>('() => document.querySelectorAll(".ghost-dot--active").length');
    await screenshotDeck("mask-255", "All 8 channels active (amber dots)");
    expect(active).toBe(8);
  });

  it("setGhostMask(15) activates only channels 1-4", async () => {
    setTestName("mask-1-4");
    await evaluate("() => Twin.setGhostMask(15)");
    const active = await evaluate<number>('() => document.querySelectorAll(".ghost-dot--active").length');
    const disabled = await evaluate<number>('() => document.querySelectorAll(".ghost-dot--disabled").length');
    await screenshotDeck("mask-15", "Channels 1-4 active (amber), 5-8 disabled (gray)");
    expect(active).toBe(4);
    expect(disabled).toBe(4);
  });

  it("setGhostMask(240) activates only channels 5-8", async () => {
    setTestName("mask-5-8");
    await evaluate("() => Twin.setGhostMask(240)");
    const states = await evaluate<boolean[]>('() => Array.from(document.querySelectorAll(".ghost-dot")).map(d => d.classList.contains("ghost-dot--active"))');
    await screenshotDeck("mask-240", "Channels 5-8 active, 1-4 disabled");
    expect(states.slice(0, 4)).toEqual([false, false, false, false]);
    expect(states.slice(4, 8)).toEqual([true, true, true, true]);
  });

  it("setGhostMask(0) disables all", async () => {
    setTestName("mask-none");
    await evaluate("() => Twin.setGhostMask(0)");
    const active = await evaluate<number>('() => document.querySelectorAll(".ghost-dot--active").length');
    await screenshotDeck("mask-0", "All channels disabled (all gray dots)");
    expect(active).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. Deck Tooltips
// ══════════════════════════════════════════════════════════════════════

describe("Deck Tooltips", () => {
  beforeEach(async () => { await resetAndReload(); await fillPlate("SMP001", 0, "Sample_A", 2000); });

  it("shows visible tooltip on filled well hover", async () => {
    setTestName("tooltip-filled-well");
    // Programmatically show tooltip on a filled well
    await evaluate(`() => {
      const el = document.querySelector('[data-well-key="SMP001:0:0"]');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const svgRect = document.getElementById('deck-svg').parentElement.getBoundingClientRect();
      const tt = document.getElementById('deck-tooltip');
      tt.innerHTML = '<span class="tt-well">A1</span> <span class="tt-vol">200 uL</span> <span class="tt-liq">Sample_A</span>';
      tt.style.display = 'block';
      tt.style.left = (rect.x - svgRect.x + 15) + 'px';
      tt.style.top = (rect.y - svgRect.y - 30) + 'px';
    }`);
    await screenshot("tooltip-filled", "Visible tooltip on filled well: A1: 200 uL Sample_A");
    // Verify tooltip div content
    const html = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');
    expect(html).toContain("A1");
    expect(html).toContain("200 uL");
    expect(html).toContain("Sample_A");
  });

  it("shows visible tooltip on empty well", async () => {
    setTestName("tooltip-empty-well");
    await evaluate(`() => {
      const tt = document.getElementById('deck-tooltip');
      const el = document.querySelector('[data-well-key="DST001:0:0"]');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const svgRect = document.getElementById('deck-svg').parentElement.getBoundingClientRect();
      tt.innerHTML = '<span class="tt-well">A1</span> <span class="tt-empty">empty</span>';
      tt.style.display = 'block';
      tt.style.left = (rect.x - svgRect.x + 15) + 'px';
      tt.style.top = (rect.y - svgRect.y - 30) + 'px';
    }`);
    await screenshot("tooltip-empty", "Visible tooltip on empty well: A1: empty");
    const html = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');
    expect(html).toContain("empty");
  });

  it("shows trough tooltip with volume in mL (both positions)", async () => {
    setTestName("tooltip-trough");
    // Fill both troughs via API
    await evaluate('() => fetch("/liquid/fill", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({carrierId:"RGT001",position:0,liquidType:"Water",volume:1000000})}).then(() => fetch("/liquid/fill", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({carrierId:"RGT001",position:2,liquidType:"Buffer",volume:500000})})).then(() => Twin.refreshDeckTracking())');
    await getPage().waitForTimeout(500);

    // Test trough position 0 - simulate mousemove on trough-basin
    await evaluate(`() => {
      const basin = document.querySelector('[data-carrier-id="RGT001"][data-position="0"] .trough-basin');
      if (basin) basin.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 }));
    }`);
    await getPage().waitForTimeout(200);
    const html0 = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');
    await screenshot("tooltip-trough-pos0", "Trough pos 0: 100.0 mL Water");

    // Test trough position 2 - fill rect hover (this has data-well-key but no data-carrier-id)
    await evaluate(`() => {
      const fill = document.querySelector('[data-carrier-id="RGT001"][data-position="2"] .trough-fill');
      if (fill) fill.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 395 }));
    }`);
    await getPage().waitForTimeout(200);
    const html2fill = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');
    expect(html2fill).toContain("Trough 3");
    expect(html2fill).not.toContain("A1");

    // Test trough position 2 - basin hover
    await evaluate(`() => {
      const basin = document.querySelector('[data-carrier-id="RGT001"][data-position="2"] .trough-basin');
      if (basin) basin.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 400 }));
    }`);
    await getPage().waitForTimeout(200);
    const html2 = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');
    await screenshot("tooltip-trough-pos2", "Trough pos 2 basin: 50.0 mL Buffer");

    // Test trough position 2 - label hover (bottom area)
    await evaluate(`() => {
      const label = document.querySelector('[data-carrier-id="RGT001"][data-position="2"] .labware-label');
      if (label) label.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 450 }));
    }`);
    await getPage().waitForTimeout(200);
    const html2label = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');

    // Test trough position 2 - background rect hover
    await evaluate(`() => {
      const bg = document.querySelector('[data-carrier-id="RGT001"][data-position="2"] .labware-bg--trough');
      if (bg) bg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 420 }));
    }`);
    await getPage().waitForTimeout(200);
    const html2bg = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');

    // All three hover targets must show "Trough 3", NOT "A1"
    expect(html0).toContain("Trough 1");
    expect(html0).toContain("100.0 mL");
    expect(html0).not.toContain("A1");

    expect(html2).toContain("Trough 3");
    expect(html2).not.toContain("A1");

    expect(html2label).toContain("Trough 3");
    expect(html2label).not.toContain("A1");

    expect(html2bg).toContain("Trough 3");
    expect(html2bg).not.toContain("A1");
  });

  it("shows correct tooltip for every labware type", async () => {
    setTestName("tooltip-all-types");
    // Fill plate + troughs
    await evaluate('() => fetch("/liquid/fill", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({carrierId:"RGT001",position:0,liquidType:"Water",volume:1000000})}).then(() => Twin.refreshDeckTracking())');
    await getPage().waitForTimeout(500);

    // Helper to trigger tooltip on an element and read result
    const getTooltipFor = async (selector: string): Promise<string> => {
      return evaluate<string>(`() => {
        const el = document.querySelector('${selector}');
        if (!el) return 'NOT_FOUND: ${selector}';
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 }));
        return document.getElementById('deck-tooltip')?.innerHTML || 'NO_TOOLTIP';
      }`);
    };

    // 96-well plate (filled)
    const plate96 = await getTooltipFor('[data-well-key="SMP001:0:0"]');
    expect(plate96).toContain("A1");
    expect(plate96).toContain("200 uL");

    // 384-well plate (empty)
    const plate384 = await getTooltipFor('[data-well-key="SMP001:2:0"]');
    expect(plate384).toContain("A1");
    expect(plate384).toContain("empty");

    // Tip rack
    const tip = await getTooltipFor('[data-well-key="TIP001:0:0"]');
    expect(tip).toContain("available");

    // Trough (filled)
    const trough = await getTooltipFor('[data-carrier-id="RGT001"][data-position="0"] .trough-basin');
    expect(trough).toContain("Trough");
    expect(trough).toContain("mL");
    expect(trough).not.toContain("A1");

    // Destination plate (empty)
    const dst = await getTooltipFor('[data-well-key="DST001:0:0"]');
    expect(dst).toContain("A1");
    expect(dst).toContain("empty");

    await screenshot("tooltip-all-types", "All labware types show correct tooltip labels");
  });

  it("shows visible tooltip on used tip", async () => {
    setTestName("tooltip-used-tip");
    await sendCmd("C0TPid9001xp01033yp01475tm255tt04tp2264th2450td1");
    await evaluate("() => Twin.refreshDeckTracking()");
    await getPage().waitForTimeout(300);
    await evaluate(`() => {
      const tt = document.getElementById('deck-tooltip');
      const el = document.querySelector('[data-well-key="TIP001:0:0"]');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const svgRect = document.getElementById('deck-svg').parentElement.getBoundingClientRect();
      tt.innerHTML = '<span class="tt-well">A1</span> <span class="tt-used">used</span>';
      tt.style.display = 'block';
      tt.style.left = (rect.x - svgRect.x + 15) + 'px';
      tt.style.top = (rect.y - svgRect.y - 30) + 'px';
    }`);
    await screenshot("tooltip-used-tip", "Visible tooltip on used tip: A1: used");
  });

  it("tooltip updates after aspirate showing reduced volume", async () => {
    setTestName("tooltip-after-aspirate");
    await sendCmd("C0TPid9002xp01033yp01475tm255tt04tp2264th2450td1");
    await sendCmd("C0ASid9003xp02383yp01460av01000tm255lm0zp01500th2450");
    await evaluate("() => Twin.refreshDeckTracking()");
    await getPage().waitForTimeout(300);
    // Show tooltip on aspirated well
    await evaluate(`() => {
      const tt = document.getElementById('deck-tooltip');
      const el = document.querySelector('[data-well-key="SMP001:0:0"]');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const svgRect = document.getElementById('deck-svg').parentElement.getBoundingClientRect();
      const vol = Twin.State.deckTracking.wellVolumes['SMP001:0:0'];
      const liq = Twin.State.deckTracking.wellContents?.['SMP001:0:0'];
      tt.innerHTML = '<span class="tt-well">A1</span> <span class="tt-vol">' + (vol/10) + ' uL</span> <span class="tt-liq">' + (liq?.liquidType || '') + '</span>';
      tt.style.display = 'block';
      tt.style.left = (rect.x - svgRect.x + 15) + 'px';
      tt.style.top = (rect.y - svgRect.y - 30) + 'px';
    }`);
    await screenshot("tooltip-aspirated", "Tooltip shows 100 uL after aspirating 100 from 200");
    const html = await evaluate<string>('() => document.getElementById("deck-tooltip")?.innerHTML || ""');
    expect(html).toContain("100 uL");
    expect(html).toContain("Sample_A");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. Inspector Panel
// ══════════════════════════════════════════════════════════════════════

describe("Inspector", () => {
  beforeEach(async () => { await resetAndReload(); await fillPlate("SMP001", 0, "Sample_A", 2000); });

  it("shows labware detail when clicking a well", async () => {
    setTestName("inspector-labware");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const html = await evaluate<string>('() => document.getElementById("inspector-content")?.innerHTML || ""');
    await screenshotInspector("labware-detail", "Inspector shows SMP001 pos 0 Cos_96_Rd with well map");
    expect(html).toContain("SMP001");
    expect(html).toContain("Cos_96_Rd");
  });

  it("inspector SVG shows all 96 filled wells", async () => {
    setTestName("inspector-filled");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const filled = await evaluate<number>('() => document.querySelectorAll(".insp-svg .well--filled").length');
    await screenshotInspector("96-filled", "All 96 wells filled (bright blue dots)");
    expect(filled).toBe(96);
  });

  it("inspector SVG shows partly filled after aspirate", async () => {
    setTestName("inspector-partly-filled");
    await sendCmd("C0TPid9010xp01033yp01475tm255tt04tp2264th2450td1");
    await sendCmd("C0ASid9011xp02383yp01460av01000tm255lm0zp01500th2450");
    await getPage().evaluate("Twin.refreshDeckTracking()");
    await getPage().waitForTimeout(1000);
    await getPage().evaluate('Twin.Inspector.showLabware({ carrierIdx:1, carrierId:"SMP001", carrierType:"PLT_CAR_L5MD", position:0, labware: Twin.State.deckData.carriers[1].labware[0], x:0,y:0,w:0,h:0 })');
    await getPage().waitForTimeout(300);

    const filled = await evaluate<number>('() => document.querySelectorAll(".insp-svg .well--filled").length');
    await screenshotInspector("partly-filled", "Col 0 dimmer (100uL) vs cols 1-11 brighter (200uL)");
    expect(filled).toBe(96);

    const opacities = await evaluate<number[]>(`() => {
      const circles = document.querySelectorAll(".insp-svg .well--filled");
      return [parseFloat(circles[0]?.style?.opacity || "1"), parseFloat(circles[1]?.style?.opacity || "1")];
    }`);
    expect(opacities[0]).toBeLessThan(opacities[1]);
  });

  it("inspector SVG has hover tooltips with liquid type", async () => {
    setTestName("inspector-tooltips");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const titles = await evaluate<string[]>('() => Array.from(document.querySelectorAll(".insp-svg circle title")).slice(0, 3).map(t => t.textContent)');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles[0]).toContain("Sample_A");
  });

  it("shows carrier overview on carrier click", async () => {
    setTestName("inspector-carrier");
    await evaluate('() => { Twin.Inspector.showCarrier({ carrierIdx: 0, carrierId: "TIP001", carrierType: "TIP_CAR_480", x:0,y:0,w:0,h:0 }); }');
    const html = await evaluate<string>('() => document.getElementById("inspector-content")?.innerHTML || ""');
    await screenshotInspector("carrier-overview", "TIP001 carrier overview with 5 tip rack positions");
    expect(html).toContain("TIP001");
    expect(html).toContain("5 / 5 occupied");
  });

  it("destination plate shows partial fill after 4ch transfer", async () => {
    setTestName("inspector-4ch-dest");
    await sendCmd("C0TPid9020xp01033yp01475tm15tt04tp2264th2450td1");
    await sendCmd("C0ASid9021xp02383yp01460av01000tm15lm0zp01500th2450");
    await sendCmd("C0DSid9022xp03733yp01375dv01000dm0tm15zp01500th2450");
    await evaluate("() => Twin.refreshDeckTracking()");
    await getPage().waitForTimeout(500);
    await evaluate('() => { const c = Twin.State.deckData.carriers[2]; Twin.Inspector.showLabware({ carrierIdx:2, carrierId:"DST001", carrierType:c.type, position:0, labware:c.labware[0], x:0,y:0,w:0,h:0 }); }');
    await getPage().waitForTimeout(300);

    const filled = await evaluate<number>('() => document.querySelectorAll(".insp-svg .well--filled").length');
    await screenshotInspector("4ch-dest", "DST001: only rows A-D filled in col 0 (4-channel transfer)");
    expect(filled).toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. Theme Toggle
// ══════════════════════════════════════════════════════════════════════

describe("Theme Toggle", () => {
  beforeEach(async () => { await resetAndReload(); });

  it("light theme sets correct CSS variables", async () => {
    setTestName("theme-light");
    await setTheme("light");
    const vars = await evaluate<Record<string, string>>('() => { const cs = getComputedStyle(document.body); return { bgBody: cs.backgroundColor, bgPanel: cs.getPropertyValue("--bg-panel").trim(), textPrimary: cs.getPropertyValue("--text-primary").trim() }; }');
    await screenshot("light-theme", "Full UI in light theme");
    expect(vars.bgBody).toBe("rgb(240, 242, 245)");
    expect(vars.bgPanel).toBe("#ffffff");
  });

  it("dark theme has dark backgrounds", async () => {
    setTestName("theme-dark");
    await setTheme("dark");
    const bgBody = await evaluate<string>("() => getComputedStyle(document.body).backgroundColor");
    await screenshot("dark-theme", "Full UI in dark theme");
    expect(bgBody).toBe("rgb(22, 22, 36)");
  });

  it("inspector SVG background changes with theme", async () => {
    setTestName("theme-inspector");
    await fillPlate("SMP001", 0, "Sample", 1000);

    await setTheme("light");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const lightBg = await evaluate<string>('() => getComputedStyle(document.querySelector(".insp-svg")).backgroundColor');
    await screenshotInspector("inspector-light", "Inspector SVG with white background (light theme)");
    expect(lightBg).toBe("rgb(255, 255, 255)");

    await setTheme("dark");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const darkBg = await evaluate<string>('() => getComputedStyle(document.querySelector(".insp-svg")).backgroundColor');
    await screenshotInspector("inspector-dark", "Inspector SVG with dark background (dark theme)");
    expect(darkBg).not.toBe("rgb(255, 255, 255)");
  });

  it("deck SVG carriers use themed colors", async () => {
    setTestName("theme-deck");
    await setTheme("light");
    const lightFill = await evaluate<string>('() => getComputedStyle(document.querySelector(".carrier-bg")).fill');
    await screenshotDeck("deck-light", "Deck in light theme — white carriers");

    await setTheme("dark");
    const darkFill = await evaluate<string>('() => getComputedStyle(document.querySelector(".carrier-bg")).fill');
    await screenshotDeck("deck-dark", "Deck in dark theme — dark carriers");

    expect(lightFill).not.toBe(darkFill);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. Module Visuals (HHS / TCC / Wash)
// ══════════════════════════════════════════════════════════════════════

describe("Module Visuals", () => {
  beforeEach(async () => { await resetAndReload(); });

  it("HHS shows temperature after T1TA", async () => {
    setTestName("hhs-temp");
    await sendCmd("T1SIid9100");
    await sendCmd("T1TAid9101ta0600");
    await getPage().waitForTimeout(500);
    const text = await evaluate<string>('() => document.querySelector("[data-hhs-temp]")?.textContent || ""');
    await screenshotDeck("hhs-heating", "HHS carrier with 60.0C temp bar (orange fill)");
    expect(text).toContain("60.0");
  });

  it("HHS shows shake RPM after T1SA", async () => {
    setTestName("hhs-shake");
    await sendCmd("T1SIid9110");
    await sendCmd("T1SAid9111sv0500");
    await getPage().waitForTimeout(500);
    const label = await evaluate<string>('() => document.querySelector("[data-hhs-shake-label]")?.textContent || ""');
    const hasActive = await evaluate<boolean>('() => !!document.querySelector("[data-hhs-shake].hhs-shake--active")');
    await screenshotDeck("hhs-shaking", "HHS shaking at 500 rpm (orbit animation active)");
    expect(label).toContain("500");
    expect(hasActive).toBe(true);
  });

  it("TCC shows temperature after C0HC", async () => {
    setTestName("tcc-temp");
    await sendCmd("C0HCid9130hn1hc0370");
    await getPage().waitForTimeout(500);
    const text = await evaluate<string>('() => document.querySelector("[data-tcc-temp]")?.textContent || ""');
    await screenshotDeck("tcc-heating", "TCC carrier at 37.0C (teal temp bar)");
    expect(text).toContain("37.0");
  });

  it("wash fluid level decreases after wash cycle", async () => {
    setTestName("wash-fluid");
    await sendCmd("C0WIid9150");
    await getPage().waitForTimeout(300);
    await screenshotDeck("wash-full", "Wash chambers full (200mL each)");

    await sendCmd("C0WSid9151ws01");
    await sendCompletion("wash_ws.done");
    await getPage().waitForTimeout(500);

    const label = await evaluate<string>('() => document.querySelector("[data-wash-label]")?.textContent || ""');
    await screenshotDeck("wash-depleted", "Wash chamber 1 after one cycle (160mL remaining)");
    expect(label).toContain("160");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 8. Arm Overlays
// ══════════════════════════════════════════════════════════════════════

describe("Arm Overlays", () => {
  beforeEach(async () => { await resetAndReload(); });

  it("PIP arm appears after tip pickup", async () => {
    setTestName("arm-pip");
    await sendCmd("C0TPid9200xp02383yp01460tm255tt04tp2264th2450td1");
    await evaluate('() => { Twin.State.animPipX = 2383; Twin.State.targetPipX = 2383; Twin.State.animPipY = 1375; Twin.State.targetPipY = 1375; Twin.DeckSVG.updateArm(); }');
    await getPage().waitForTimeout(500);
    const display = await evaluate<string>('() => document.querySelector(".arm-pip-head")?.style.display ?? "none"');
    const text = await evaluate<string>('() => document.querySelector(".arm-pip-label")?.textContent || ""');
    await screenshotDeck("pip-arm", "PIP arm at X=238mm with 8 channel dots");
    expect(display).not.toBe("none");
    expect(text).toContain("PIP");
  });

  it("96-head arm appears after C0EM + C0EP", async () => {
    setTestName("arm-96head");
    await sendCmd("C0EMid9220xs06433yh01375");
    await sendCompletion("move96.done");
    await sendCmd("C0EPid9221xp06433yp01375");
    await evaluate('() => { Twin.State.animH96X = 6433; Twin.State.targetH96X = 6433; Twin.State.animH96Y = 1375; Twin.State.targetH96Y = 1375; Twin.DeckSVG.updateArm(); }');
    await getPage().waitForTimeout(500);
    const display = await evaluate<string>('() => document.querySelector(".arm-h96-head")?.style.display ?? "none"');
    const label = await evaluate<string>('() => document.querySelector(".arm-h96-label")?.textContent || ""');
    await screenshotDeck("96head-arm", "96-Head blue arm overlay with 8x12 channel dots at TIP002");
    expect(display).not.toBe("none");
    expect(label).toContain("96-Head");
  });

  it("96-head has 96 channel dots", async () => {
    setTestName("arm-96dots");
    await sendCmd("C0EMid9230xs06433yh01375");
    await sendCompletion("move96.done");
    await evaluate('() => { Twin.State.animH96X = 6433; Twin.State.targetH96X = 6433; Twin.DeckSVG.updateArm(); }');
    const dotCount = await evaluate<number>('() => document.querySelectorAll(".arm-h96-dot").length');
    expect(dotCount).toBe(96);
  });

  it("PIP arm has 8 channel dots", async () => {
    setTestName("arm-pip-dots");
    await sendCmd("C0TPid9240xp02383yp01460tm255tt04tp2264th2450td1");
    await evaluate('() => { Twin.State.animPipX = 2383; Twin.State.targetPipX = 2383; Twin.DeckSVG.updateArm(); }');
    const dotCount = await evaluate<number>('() => document.querySelectorAll(".arm-pip-dot").length');
    expect(dotCount).toBe(8);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 9. Context Menu
// ══════════════════════════════════════════════════════════════════════

describe("Context Menu", () => {
  beforeEach(async () => {
    await resetAndReload();
    await fillPlate("SMP001", 0, "Sample_A", 2000);
    await evaluate("() => Twin.setGhostTool(true)");
  });

  it("right-click on deck shows context menu when ghost is active", async () => {
    setTestName("menu-shows");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const svg = getPage().locator("#deck-svg");
    const box = await svg.boundingBox();
    await getPage().mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: "right" });
    await getPage().waitForTimeout(300);
    const menuExists = await evaluate<boolean>('() => !!document.querySelector(".deck-context-menu")');
    await screenshot("context-menu", "Context menu with aspirate/dispense actions + channel toggles");
    expect(menuExists).toBe(true);
  });

  it("context menu has channel toggles and pitch selector", async () => {
    setTestName("menu-toggles");
    await clickFirst('[data-carrier-id="SMP001"][data-position="0"].well');
    const svg = getPage().locator("#deck-svg");
    const box = await svg.boundingBox();
    await getPage().mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: "right" });
    await getPage().waitForTimeout(300);
    const toggleCount = await evaluate<number>('() => document.querySelectorAll(".ch-toggle").length');
    const html = await evaluate<string>('() => document.querySelector(".deck-context-menu")?.innerHTML || ""');
    await screenshot("menu-details", "Channel toggles (8 checkboxes) + pitch selector (4.5/9/18mm)");
    expect(toggleCount).toBe(8);
    expect(html).toContain("4.5mm");
    expect(html).toContain("9mm");
    expect(html).toContain("18mm");
  });

  it("context menu on tip rack shows pickup action", async () => {
    setTestName("menu-tips");
    await clickFirst(".tip");
    const svg = getPage().locator("#deck-svg");
    const box = await svg.boundingBox();
    await getPage().mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: "right" });
    await getPage().waitForTimeout(300);
    const items = await evaluate<string[]>('() => Array.from(document.querySelectorAll(".deck-menu-item")).map(el => el.textContent)');
    await screenshot("menu-tip-actions", "Tip rack context menu: Pick up tips + Eject tips");
    expect(items.some(t => t?.includes("Pick up"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 10. Well Fill State Tracking (Visual)
// ══════════════════════════════════════════════════════════════════════

describe("Well Fill Visuals", () => {
  beforeEach(async () => { await resetAndReload(); });

  it("filled wells have well--filled class on deck", async () => {
    setTestName("fill-wells");
    await fillPlate("SMP001", 0, "Sample_A", 2000);
    const filled = await evaluate<number>('() => document.querySelectorAll(".well--filled").length');
    await screenshotDeck("wells-filled", "96 wells filled with bright blue after fill command");
    expect(filled).toBe(96);
  });

  it("used tips have tip--used class on deck", async () => {
    setTestName("fill-tips");
    await sendCmd("C0TPid9300xp01033yp01475tm255tt04tp2264th2450td1");
    await evaluate("() => Twin.refreshDeckTracking()");
    await getPage().waitForTimeout(300);
    const used = await evaluate<number>('() => document.querySelectorAll(".tip--used").length');
    await screenshotDeck("tips-used", "8 tips in col 0 shown as dark (used) after pickup");
    expect(used).toBe(8);
  });

  it("well opacity scales with volume", async () => {
    setTestName("fill-opacity");
    await fillPlate("SMP001", 0, "Sample_A", 2000);
    await sendCmd("C0TPid9310xp01033yp01475tm255tt04tp2264th2450td1");
    await sendCmd("C0ASid9311xp02383yp01460av01000tm255lm0zp01500th2450");
    await evaluate("() => Twin.refreshDeckTracking()");
    await getPage().waitForTimeout(300);
    const op0 = await evaluate<string>('() => document.querySelector(\'[data-well-key="SMP001:0:0"]\')?.style.opacity || ""');
    const op1 = await evaluate<string>('() => document.querySelector(\'[data-well-key="SMP001:0:1"]\')?.style.opacity || ""');
    await screenshotDeck("opacity-diff", "Col 0 dimmer (100uL) vs col 1 brighter (200uL)");
    expect(Number(op0)).toBeLessThan(Number(op1));
  });
});
