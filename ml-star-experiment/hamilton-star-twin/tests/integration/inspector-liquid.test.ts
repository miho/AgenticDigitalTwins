/**
 * Inspector liquid-preview + coordinate-only resolution regression
 * tests. The user hit two failures the existing hundreds of tests
 * didn't catch:
 *
 *   1. After filling a plate via /liquid/fill, the inspector still
 *      showed "empty" for wells. Root cause was clicking + rendering
 *      a stale labware snapshot (or the liquid tracker ever not
 *      populating wellVolumes for the right key). Either way the
 *      user-facing DOM is the authoritative signal — this test
 *      fills, clicks a well, and asserts the inspector DOM contains
 *      the right µL value both as summary and in the per-well map.
 *
 *   2. VENUS-sent aspirate / dispense coords reported "no carrier"
 *      when the X/Y fell outside a track-derived carrier rect.
 *      `deck-tracker.resolvePosition` now scans every well on every
 *      labware and matches on proximity alone, no carrier-rect gate.
 *      This test hits a well directly by its absolute coords (via
 *      POST /command) and asserts both (a) no unresolved_position
 *      assessment fires and (b) the well volume actually changes
 *      after the aspirate.
 *
 * Gated behind the Hamilton install for the Method1.lay-based
 * scenarios; the default-deck scenarios run everywhere.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import { chromium, Browser, Page } from "playwright";
import { createTestServer, TestServer } from "../helpers/test-server";

const METHOD1_LAY = "C:/Program Files (x86)/Hamilton/Methods/Method1.lay";

describe("Inspector liquid preview + coordinate-only resolution", () => {
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
    await page.waitForFunction(() => document.querySelectorAll("[data-well-key]").length > 0);
    await page.waitForTimeout(500);
  }, 90000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await srv?.close();
  });

  it("fills a plate, clicks a well, inspector DOM shows the volume (plate + per-well)", async () => {
    const result = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      // Fill SMP001 pos 0 with 150 µL / well (default deck)
      await fetch("/liquid/fill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrierId: "SMP001", position: 0, liquidType: "water", volume: 1500 }),
      });
      await sleep(250);

      const well = document.querySelector("[data-well-key='SMP001:0:0']") as HTMLElement;
      const r = well.getBoundingClientRect();
      well.dispatchEvent(new MouseEvent("click", {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true, view: window, button: 0,
      }));
      await sleep(300);

      const inspText = document.getElementById("inspector-content")?.textContent || "";
      // Hover the well so the tooltip renders too
      well.dispatchEvent(new MouseEvent("mousemove", {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, view: window,
      }));
      await sleep(150);
      const tooltipText = document.getElementById("deck-tooltip")?.textContent || "";
      return { inspText: inspText.slice(0, 800), tooltipText };
    });

    // Summary fields
    expect(result.inspText, "plate summary must say '96 / 96' filled").toMatch(/96\s*\/\s*96/);
    expect(result.inspText, "total volume must appear in µL").toMatch(/14400\.00 µL/);
    // Per-well list
    expect(result.inspText, "A1 must show the per-well volume in the map").toContain("A1: 150.00 µL water");
    expect(result.inspText, "inspector must not claim the plate is empty").not.toMatch(/\bA1: empty\b/);
    // Tooltip too
    expect(result.tooltipText).toMatch(/150\.00 µL/);
  });

  it("aspirate at VENUS-sent coords resolves to the well + mutates volume (coordinate-only)", async () => {
    // Drive aspirate directly via the REST /command surface — the
    // same path VENUS's FW bridge uses.
    const result = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      // Fresh fill so we know the starting volume
      await fetch("/liquid/fill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrierId: "SMP001", position: 0, liquidType: "water", volume: 1500 }),
      });
      await sleep(150);

      // Init + tip pickup at SMP001 row A
      const deck = await (await fetch("/deck")).json() as any;
      const smp = deck.carriers.find((c: any) => c.id === "SMP001");
      const labware = smp.labware[0];
      const smpA1X = smp.xMin + (labware.offsetX ?? 145);  // A1 X in 0.1 mm
      const smpA1Y = 630 + (smp.siteYOffsets?.[0] ?? 0) + (labware.offsetY ?? 745);
      const tipCarrier = deck.carriers.find((c: any) => c.type?.includes("TIP") || c.id.startsWith("TIP"));
      const tipLw = tipCarrier.labware[0];
      const tipA1X = tipCarrier.xMin + (tipLw.offsetX ?? 145);
      const tipA1Y = 630 + (tipCarrier.siteYOffsets?.[0] ?? 0) + (tipLw.offsetY ?? 745);
      const pad5 = (n: number) => Math.round(n).toString().padStart(5, "0");

      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: "C0VIid0001" }) });
      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: "C0DIid0002" }) });
      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: `C0TPid0003xp${pad5(tipA1X)}yp${pad5(tipA1Y)}tm255tt04tp2264tz2164th2450td1` }) });

      const preTrack = await (await fetch("/tracking")).json() as any;
      const preVol = preTrack.wellVolumes["SMP001:0:0"] ?? 0;

      // Deliberately nudge Y by 2 mm (20 units) to prove proximity
      // matching works — pure carrier-rect matching wouldn't care,
      // but our well-by-well matcher should still find A1.
      const nudgedY = smpA1Y + 20;
      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: `C0ASid0004xp${pad5(smpA1X)}yp${pad5(nudgedY)}av00500tm255lm0` }) });
      // Poll /tracking until the well volume actually drops (the
      // aspirate has a physics-driven delay that exceeds a single
      // fixed sleep).
      let postTrack: any = preTrack, postVol = preVol;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        postTrack = await (await fetch("/tracking")).json();
        postVol = postTrack.wellVolumes["SMP001:0:0"] ?? preVol;
        if (postVol < preVol) break;
      }

      // Assessments — must NOT include unresolved_position for this
      // command (id 0004).
      const assessments = await (await fetch("/assessment?count=40")).json();
      const unresolved = (assessments || []).filter((a: any) => a.category === "unresolved_position");

      return { preVol, postVol, unresolvedCount: unresolved.length };
    });

    expect(result.unresolvedCount, "no unresolved_position on a within-tolerance aspirate").toBe(0);
    expect(result.preVol, "plate must have been filled pre-aspirate").toBeGreaterThan(0);
    expect(result.postVol, "aspirate must have drawn liquid from the well").toBeLessThan(result.preVol);
  });

  it("aspirate on Method1.lay targets resolve correctly (#55/#60 regression)", async () => {
    if (!fs.existsSync(METHOD1_LAY)) return;  // skip on CI

    const result = await page.evaluate(async (layPath) => {
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      // Reset first so tips / volumes from prior tests in this file
      // don't bleed over and break the Method1 scenario.
      await fetch("/reset", { method: "POST" });
      await sleep(400);

      // Hot-swap to Method1.lay
      await fetch("/api/deck/load", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: layPath }),
      });
      await sleep(800);

      // Fill the DW 96 plate at PLT_CAR_L5AC pos 0. After the SiteId
      // flip (commit 350e791), pos 0 is REAR (VENUS SiteId 1) — the
      // plate at TForm.3.Y=530 mm = yp=5300 (0.1 mm units).
      await fetch("/liquid/fill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrierId: "PLT_CAR_L5AC_A00_0001", position: 0, liquidType: "water", volume: 2000 }),
      });
      await sleep(200);

      // Init + pickup tips
      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: "C0VIid0001" }) });
      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: "C0DIid0002" }) });
      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: "C0TPid0003xp01180yp05298tm255tt04tp2264tz2164th2450td1" }) });

      // Aspirate at VENUS's rear-plate coords: xp=2755, yp=5300 (row
      // A of the pos-0 = SiteId 1 plate). Before the flip the test
      // used yp=1460 (front) because pos 0 used to mean the front
      // plate; that's been corrected.
      const preTrack = await (await fetch("/tracking")).json() as any;
      const preVol = preTrack.wellVolumes["PLT_CAR_L5AC_A00_0001:0:0"] ?? 0;
      await fetch("/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: "C0ASid0004xp02755yp05300av00500tm255lm0" }) });
      // Aspirate's physics `_delay` (Z-traverse + Y-travel + pump time)
      // can run 500 ms-plus; poll /tracking until the well volume
      // reflects the draw rather than racing a fixed sleep.
      let postTrack: any = preTrack;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        postTrack = await (await fetch("/tracking")).json();
        if ((postTrack.wellVolumes["PLT_CAR_L5AC_A00_0001:0:0"] ?? preVol) < preVol) break;
      }
      const postVol = postTrack.wellVolumes["PLT_CAR_L5AC_A00_0001:0:0"] ?? 0;

      const assessments = await (await fetch("/assessment?count=50")).json();
      const unresolved = (assessments || []).filter((a: any) => a.category === "unresolved_position");

      // Column-1 wells A1..H1 under the 8-channel aspirate — the 8
      // channels span 9 mm pitch, so the whole column should lose volume.
      const colVols = [0, 12, 24, 36, 48, 60, 72, 84]
        .map(idx => postTrack.wellVolumes[`PLT_CAR_L5AC_A00_0001:0:${idx}`] ?? 0);

      return { preVol, postVol, colVols, unresolved: unresolved.map((a: any) => a.description?.slice(0, 100)) };
    }, METHOD1_LAY);

    expect(result.unresolved, "aspirate at VENUS's (275.5, 146) must resolve to PLT site-0 A1").toEqual([]);
    expect(result.preVol).toBe(2000);
    // With an 8-channel aspirate, SOME column-1 well must show a drop.
    // If the resolver mis-matches, all 8 stay at 2000.
    const minColVol = Math.min(...result.colVols);
    expect(minColVol, `at least one column-1 well must have dropped; saw ${JSON.stringify(result.colVols)}`).toBeLessThan(result.preVol);
  });
});
