/**
 * Regression: left-click on the plate body must route the inspector
 * to the plate's carrier, not carriers[0].
 *
 * Before the fix (deck-interact.ts), clicking anywhere other than a
 * well circle (plate label, plate rect, empty position) made the
 * inspector breadcrumb read "WasteBlock › pos N › <lw>" because the
 * code took `carrierIdx` from the INNER slot <g>'s `data-carrier-idx`
 * attribute (which doesn't exist on the slot — only on the outer
 * carrier <g>). `Number(undefined ?? 0)` fell back to 0, and
 * carriers[0] in Method1.lay is the WasteBlock. Volumes also appeared
 * empty because the Well Map then looked up `WasteBlock:N:*` keys.
 *
 * Fix: compute carrierIdx by `findIndex(id === carrierId)` from the
 * slot's own `data-carrier-id`, which is always correct.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as path from "path";
import {
  setupBrowser, teardownBrowser, getPage, resetAndReload,
  fillPlate, evaluate, getBaseUrl,
} from "./browser-fixture";

beforeAll(async () => { await setupBrowser(); });
afterAll(async () => { await teardownBrowser(); });

async function loadMethod1(): Promise<void> {
  const layPath = "C:\\Program Files (x86)\\Hamilton\\Methods\\Method1.lay";
  const r = await fetch(`${getBaseUrl()}/api/deck/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: layPath }),
  });
  const j = await r.json();
  if (j.error) {
    throw new Error(`skip: Method1.lay not available (${j.error})`);
  }
  await getPage().waitForTimeout(400);
}

describe("Click routing on plate body (Method1.lay regression)", () => {
  beforeEach(async () => { await resetAndReload(); });

  it("clicks on the plate LABWARE-BG rect route to PLT_CAR, not WasteBlock", async () => {
    // Skip gracefully if this machine has no Hamilton install — the
    // test needs Method1.lay to exercise the WasteBlock-in-carriers[0]
    // scenario that triggered the bug.
    try { await loadMethod1(); } catch (e: any) {
      if (String(e.message).includes("skip:")) return;
      throw e;
    }
    await fillPlate("PLT_CAR_L5AC_A00_0001", 0, "Water", 8000);

    const result = await evaluate<{ breadcrumb: string; wellsFilled: string }>(`() => {
      Twin.Inspector.clear();
      const svg = document.getElementById('deck-svg');
      const pltG = Array.from(svg.querySelectorAll('g.carrier'))
        .find(g => g.getAttribute('data-carrier-id') === 'PLT_CAR_L5AC_A00_0001');
      const slot0 = pltG.querySelector('[data-position="0"]');
      const plateRect = slot0.querySelector('rect.labware-bg');
      const r = plateRect.getBoundingClientRect();
      const cx = r.left + 2, cy = r.top + 2;
      const el = document.elementFromPoint(cx, cy);
      el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:cx, clientY:cy}));
      return new Promise(resolve => setTimeout(() => {
        const panel = document.getElementById('inspector-content');
        const bc = panel.querySelector('.insp-breadcrumb')?.textContent || '';
        const m = (panel.innerHTML || '').match(/Wells filled[^0-9]*(\\d+)\\s*\\/\\s*(\\d+)/);
        resolve({ breadcrumb: bc, wellsFilled: m ? m[1] + '/' + m[2] : '' });
      }, 300));
    }`);

    expect(result.breadcrumb).toContain("PLT_CAR_L5AC_A00_0001");
    expect(result.breadcrumb).not.toContain("WasteBlock");
    expect(result.wellsFilled).toBe("96/96");
  });

  it("clicks on a well CIRCLE route to PLT_CAR", async () => {
    try { await loadMethod1(); } catch (e: any) {
      if (String(e.message).includes("skip:")) return;
      throw e;
    }
    await fillPlate("PLT_CAR_L5AC_A00_0001", 0, "Water", 8000);

    const result = await evaluate<{ breadcrumb: string }>(`() => {
      Twin.Inspector.clear();
      const svg = document.getElementById('deck-svg');
      const circle = svg.querySelector('circle[data-well-key="PLT_CAR_L5AC_A00_0001:0:0"]');
      const r = circle.getBoundingClientRect();
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      circle.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:cx, clientY:cy}));
      return new Promise(resolve => setTimeout(() => {
        const bc = document.getElementById('inspector-content')
          ?.querySelector('.insp-breadcrumb')?.textContent || '';
        resolve({ breadcrumb: bc });
      }, 300));
    }`);

    expect(result.breadcrumb).toContain("PLT_CAR_L5AC_A00_0001");
    expect(result.breadcrumb).not.toContain("WasteBlock");
  });

  it("empty-slot labels read 1..N top→bottom (VENUS SiteId order)", async () => {
    // VENUS Deck Editor numbers sites 1..N top→bottom (SiteId 1 = rear).
    // Twin previously used `positions - i` which produced 5,4,3,2,1
    // top→bottom — visually backwards from what VENUS shows.
    try { await loadMethod1(); } catch (e: any) {
      if (String(e.message).includes("skip:")) return;
      throw e;
    }

    const labels = await evaluate<Array<{label: string; y: number}>>(`() => {
      const svg = document.getElementById('deck-svg');
      const pltG = Array.from(svg.querySelectorAll('g.carrier'))
        .find(g => g.getAttribute('data-carrier-id') === 'PLT_CAR_L5AC_A00_0001');
      const out = [];
      pltG.querySelectorAll('text.slot-empty-label').forEach(t => {
        out.push({ label: t.textContent, y: Number(t.getAttribute('y')) });
      });
      return out;
    }`);

    // In deck-Y (unflipped) coords, larger Y = rear = top on screen after
    // Y-flip. Sorted largest-Y-first = top→bottom visual order.
    labels.sort((a, b) => b.y - a.y);
    const texts = labels.map(l => l.label);

    // Method1.lay leaves positions 2/3/4 empty (pos 0 and pos 4 = SiteIds
    // 1 and 5 are occupied by Cos_96_DW_1mL plates). The labels we can
    // see on the deck are therefore '2','3','4' in that order — VENUS
    // SiteId order, not reversed.
    expect(texts).toEqual(["2", "3", "4"]);
  });

  it("placeChild agrees with applySiteOverride (VENUS SiteId = pos + 1)", async () => {
    // Previously placeChild used `positions - siteNum` while
    // applySiteOverride used `siteNum - 1`, so the .lay's stated Y for
    // SiteId N landed on the wrong slot. When two different labware
    // types share a carrier this mis-swaps them on the deck. For
    // Method1.lay we check that SiteId 1 lands at pos 0 and SiteId 5 at
    // pos 4.
    try { await loadMethod1(); } catch (e: any) {
      if (String(e.message).includes("skip:")) return;
      throw e;
    }
    const placements = await evaluate<Array<{labwareId: string; position: number}>>(`() =>
      fetch('/api/deck/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'C:\\\\Program Files (x86)\\\\Hamilton\\\\Methods\\\\Method1.lay' }),
      }).then(r => r.json())
        .then(j => j.placements.filter(p => p.carrierId === 'PLT_CAR_L5AC_A00_0001'))
    `);

    const byId = Object.fromEntries(placements.map(p => [p.labwareId, p.position]));
    expect(byId["Cos_96_DW_1mL_0001"]).toBe(0);  // SiteId 1 → pos 0 (rear)
    expect(byId["Cos_96_DW_1mL_0002"]).toBe(4);  // SiteId 5 → pos 4 (front)
  });

  it("volume updates live after aspirate (was hidden when click misrouted)", async () => {
    try { await loadMethod1(); } catch (e: any) {
      if (String(e.message).includes("skip:")) return;
      throw e;
    }
    await fillPlate("PLT_CAR_L5AC_A00_0001", 0, "Water", 8000);

    const send = async (raw: string) => {
      await fetch(`${getBaseUrl()}/command`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
    };
    await send("C0VIid8001");
    await send("C0DIid8002");
    await send("C0TPid8010xp01180yp05298tm1tt04tp2264th2450td1");
    await send("C0ASid8011xp02756yp05300av03000tm1lm0zp01500th2450");  // 300 µL
    await getPage().waitForTimeout(400);

    const result = await evaluate<{ stateVol: number; tooltip: string }>(`() => {
      const svg = document.getElementById('deck-svg');
      const circle = svg.querySelector('circle[data-well-key="PLT_CAR_L5AC_A00_0001:0:0"]');
      const r = circle.getBoundingClientRect();
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      circle.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, cancelable:true, clientX:cx, clientY:cy}));
      return new Promise(resolve => setTimeout(() => {
        const tt = document.getElementById('deck-tooltip');
        resolve({
          stateVol: Twin.State.deckTracking.wellVolumes['PLT_CAR_L5AC_A00_0001:0:0'],
          tooltip: tt?.innerHTML || '',
        });
      }, 150));
    }`);

    // 8000 - 3000 (0.1 µL units) = 5000 remaining → tooltip shows 500.00 µL
    expect(result.stateVol).toBe(5000);
    expect(result.tooltip).toContain("500.00 µL");
    expect(result.tooltip).toContain("A1");
  });
});
