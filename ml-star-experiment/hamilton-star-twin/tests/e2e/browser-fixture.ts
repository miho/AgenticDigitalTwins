/**
 * Shared Playwright browser fixture for e2e tests.
 * Launches headless Chromium, starts its own headless twin on a random
 * port, navigates the browser to it, and provides page helpers.
 *
 * Every screenshot is captured TWICE — once in light, once in dark theme.
 * A gallery HTML groups them side-by-side for visual comparison.
 *
 * Self-hosting the twin (Step 2.5 followup) means e2e tests are CI-safe:
 * no need to run `npm run start` in another terminal, no collision on
 * the production :8222.
 */

import { chromium, type Browser, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { createTestServer } from "../helpers/test-server";

let browser: Browser;
let page: Page;
let server: { baseUrl: string; port: number; close: () => Promise<void> } | null = null;
// Populated by setupBrowser; exported accessor below so tests reuse the
// same URL we gave Playwright (avoids mismatches between browser + helpers).
let BASE = "http://127.0.0.1:0";
const RESULTS_DIR = path.join(__dirname, "..", "..", "test-results", "e2e");

/** All captured screenshots for gallery generation */
const galleryEntries: Array<{
  test: string;
  step: string;
  lightFile: string;
  darkFile: string;
  description: string;
}> = [];

// ── Setup / teardown ───────────────────────────────────────────────

export async function setupBrowser(): Promise<Page> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  // Bring up a dedicated headless twin with static-file serving enabled so
  // the renderer (index.html + bundled JS) is available.
  const staticDir = path.join(__dirname, "..", "..", "dist", "renderer");
  server = await createTestServer({ staticDir });
  BASE = server.baseUrl;

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction("() => typeof window.Twin?.State?.ghostVisible !== 'undefined'", { timeout: 10000 });
  await page.waitForTimeout(500);
  return page;
}

export async function teardownBrowser(): Promise<void> {
  generateGallery();
  if (browser) await browser.close();
  if (server) {
    await server.close();
    server = null;
  }
}

/** Base URL of the test server — exposed so individual tests can fetch against it. */
export function getBaseUrl(): string {
  return BASE;
}

export function getPage(): Page { return page; }

// ── Screenshot capture (always both themes) ────────────────────────

let currentTestName = "";
export function setTestName(name: string): void { currentTestName = name; }

/** Internal: apply a theme without re-rendering the deck (preserves state). */
async function applyThemeQuiet(theme: "light" | "dark"): Promise<void> {
  if (theme === "light") {
    await page.evaluate('document.body.setAttribute("data-theme","light")');
  } else {
    await page.evaluate('document.body.removeAttribute("data-theme")');
  }
  // Brief wait for CSS to repaint
  await page.waitForTimeout(100);
}

/** Get current theme so we can restore after dual-capture. */
async function getCurrentTheme(): Promise<"light" | "dark"> {
  const t = await page.evaluate('document.body.getAttribute("data-theme")');
  return t === "light" ? "light" : "dark";
}

/** Restore theme after dual-capture. */
async function restoreTheme(theme: "light" | "dark"): Promise<void> {
  await applyThemeQuiet(theme);
}

/** Capture a dual-theme screenshot (full viewport). */
export async function screenshot(step: string, description: string = ""): Promise<void> {
  const base = safeName(step);
  const orig = await getCurrentTheme();
  await applyThemeQuiet("light");
  await page.screenshot({ path: path.join(RESULTS_DIR, `${base}__light.png`), type: "png" });
  await applyThemeQuiet("dark");
  await page.screenshot({ path: path.join(RESULTS_DIR, `${base}__dark.png`), type: "png" });
  await restoreTheme(orig);
  galleryEntries.push({ test: currentTestName, step, lightFile: `${base}__light.png`, darkFile: `${base}__dark.png`, description: description || step });
}

/** Capture a dual-theme screenshot of the deck view (includes tooltip overlay). */
export async function screenshotDeck(step: string, description: string = ""): Promise<void> {
  const base = safeName(step) + "__deck";
  const orig = await getCurrentTheme();
  // Use deck-view (parent) to capture tooltip overlay too
  const deckView = page.locator("#deck-view");
  const box = await deckView.boundingBox();
  const clip = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined;

  await applyThemeQuiet("light");
  await page.screenshot({ path: path.join(RESULTS_DIR, `${base}__light.png`), type: "png", clip });
  await applyThemeQuiet("dark");
  await page.screenshot({ path: path.join(RESULTS_DIR, `${base}__dark.png`), type: "png", clip });
  await restoreTheme(orig);
  galleryEntries.push({ test: currentTestName, step: step + " (deck)", lightFile: `${base}__light.png`, darkFile: `${base}__dark.png`, description: description || step });
}

/** Capture a dual-theme screenshot of the inspector panel. */
export async function screenshotInspector(step: string, description: string = ""): Promise<void> {
  const base = safeName(step) + "__inspector";
  const orig = await getCurrentTheme();
  const panel = page.locator("#inspector-panel");
  const box = await panel.boundingBox();
  const clip = box ? { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 600) } : undefined;

  await applyThemeQuiet("light");
  await page.screenshot({ path: path.join(RESULTS_DIR, `${base}__light.png`), type: "png", clip });
  await applyThemeQuiet("dark");
  await page.screenshot({ path: path.join(RESULTS_DIR, `${base}__dark.png`), type: "png", clip });
  await restoreTheme(orig);
  galleryEntries.push({ test: currentTestName, step: step + " (inspector)", lightFile: `${base}__light.png`, darkFile: `${base}__dark.png`, description: description || step });
}

function safeName(step: string): string {
  const t = currentTestName.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").substring(0, 50);
  const s = step.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
  return `${t}__${s}`;
}

// ── Gallery generator (side-by-side light/dark) ────────────────────

function generateGallery(): void {
  if (galleryEntries.length === 0) return;

  const groups = new Map<string, typeof galleryEntries>();
  for (const e of galleryEntries) {
    if (!groups.has(e.test)) groups.set(e.test, []);
    groups.get(e.test)!.push(e);
  }

  let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>E2E Test Gallery</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f5; padding: 20px; max-width: 1600px; margin: 0 auto; }
  h1 { color: #333; border-bottom: 2px solid #ddd; padding-bottom: 8px; }
  h2 { color: #555; margin-top: 32px; background: #fff; padding: 8px 12px; border-radius: 6px; border-left: 4px solid #4cc9f0; }
  .pair { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
  .shot { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden; flex: 1; min-width: 300px; max-width: 700px; }
  .shot img { width: 100%; display: block; cursor: pointer; }
  .shot img:hover { opacity: 0.9; }
  .shot-label { padding: 4px 8px; font-size: 11px; font-family: monospace; border-top: 1px solid #eee; display: flex; justify-content: space-between; }
  .shot-label .theme { color: #999; }
  .shot-label .theme.light { color: #e8a820; }
  .shot-label .theme.dark { color: #6080c0; }
  .desc { padding: 2px 12px 6px; font-size: 11px; color: #888; }
  .meta { color: #999; font-size: 12px; margin-bottom: 20px; }
</style></head><body>
<h1>Hamilton STAR Digital Twin — E2E Test Gallery</h1>
<p class="meta">Generated: ${new Date().toISOString()} — ${galleryEntries.length} test steps, ${galleryEntries.length * 2} screenshots (light + dark) across ${groups.size} tests</p>
`;

  for (const [testName, entries] of groups) {
    html += `<h2>${esc(testName)}</h2>\n`;
    for (const e of entries) {
      html += `<div class="desc">${esc(e.description)}</div>\n`;
      html += `<div class="pair">\n`;
      html += `  <div class="shot"><a href="${e.lightFile}" target="_blank"><img src="${e.lightFile}"></a><div class="shot-label"><span>${esc(e.step)}</span><span class="theme light">LIGHT</span></div></div>\n`;
      html += `  <div class="shot"><a href="${e.darkFile}" target="_blank"><img src="${e.darkFile}"></a><div class="shot-label"><span>${esc(e.step)}</span><span class="theme dark">DARK</span></div></div>\n`;
      html += `</div>\n`;
    }
  }

  html += `</body></html>`;
  fs.writeFileSync(path.join(RESULTS_DIR, "gallery.html"), html);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Twin API helpers ───────────────────────────────────────────────

export async function resetAndReload(): Promise<void> {
  await fetch(`${BASE}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  for (const cmd of ["C0VIid0001", "C0DIid0002", "C0EIid0003", "C0FIid0004", "C0IIid0005"]) {
    await fetch(`${BASE}/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: cmd }) });
  }
  await new Promise(r => setTimeout(r, 2000));
  await page.reload();
  await page.waitForFunction("() => typeof window.Twin?.State?.ghostVisible !== 'undefined'", { timeout: 10000 });
  await page.waitForTimeout(500);
}

export async function fillPlate(carrierId: string, position: number, liquidType: string, volume: number): Promise<void> {
  await fetch(`${BASE}/liquid/fill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ carrierId, position, liquidType, volume }) });
  await page.evaluate("(() => Twin.refreshDeckTracking())()");
  await page.waitForTimeout(500);
}

export async function sendCmd(raw: string): Promise<any> {
  const r = await fetch(`${BASE}/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw }) });
  return r.json();
}

export async function sendCompletion(event: string): Promise<void> {
  await fetch(`${BASE}/completion`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }) });
  await new Promise(r => setTimeout(r, 300));
}

export async function evaluate<T = any>(fn: string): Promise<T> {
  const expr = fn.trim().startsWith("()") ? `(${fn})()` : fn;
  return page.evaluate(expr) as Promise<T>;
}

export async function clickFirst(selector: string): Promise<void> {
  await page.locator(selector).first().click({ force: true });
  await page.waitForTimeout(300);
}

/** Set theme (for tests that need a specific theme for assertions). */
export async function setTheme(theme: "light" | "dark"): Promise<void> {
  if (theme === "light") {
    await page.evaluate('(() => { document.body.setAttribute("data-theme","light"); Twin.DeckSVG.renderDeck(); })()');
  } else {
    await page.evaluate('(() => { document.body.removeAttribute("data-theme"); Twin.DeckSVG.renderDeck(); })()');
  }
  await page.waitForTimeout(500);
}
