/**
 * Electron main process (Step 2.4 slim shell)
 *
 * Wires the shared setupServer() composition into an HTTP listener, then
 * opens a BrowserWindow that loads the same URL a real browser or
 * Playwright would. The HTTP API is the only communication channel — no
 * ipcRenderer, no nodeIntegration — so the exact same UI runs in Electron,
 * in a browser, and under Playwright.
 *
 * Target: under 100 lines. Everything else lives in src/api/* and
 * src/services/*.
 */

import { app, BrowserWindow, Menu, dialog } from "electron";
import * as path from "path";
import * as http from "http";
import { setupServer, startHttpServer, VenusBridgeOptions } from "../api/server-setup";

let mainWindow: BrowserWindow | null = null;
let threeDWindow: BrowserWindow | null = null;
let httpPort = 8222;

interface CliArgs {
  layoutPath: string | null;
  tracePath: string | null;
  venusRoot: string | null;
  venusCfgPath: string | null;
  venusBridge: VenusBridgeOptions | null;
}

function parseCli(argv: string[]): CliArgs {
  const args = argv.slice(1);
  let layoutPath: string | null = null;
  let tracePath: string | null = null;
  let venusRoot: string | null = null;
  let venusCfgPath: string | null = null;

  // Electron default: bridge is ON so a fresh launch is immediately
  // discoverable by VENUS. `--no-bridge` opts out for tests / when the
  // well-known ports are already claimed by a real instrument driver.
  let bridgeEnabled = true;
  const bridge: VenusBridgeOptions = {};
  const identity: NonNullable<VenusBridgeOptions["identity"]> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--layout" && args[i + 1]) { layoutPath = args[++i]; continue; }
    if (a === "--trace" && args[i + 1]) { tracePath = args[++i]; continue; }
    if (a === "--venus-root" && args[i + 1]) { venusRoot = args[++i]; continue; }
    if (a === "--venus-cfg" && args[i + 1]) { venusCfgPath = args[++i]; continue; }
    if (a === "--no-bridge") { bridgeEnabled = false; continue; }
    if (a === "--no-discovery") { bridge.discovery = false; continue; }
    if ((a === "--fw-port" || a === "--fdx-port") && args[i + 1]) { bridge.fwPort = Number(args[++i]); continue; }
    if (a === "--bridge-host" && args[i + 1]) { bridge.host = args[++i]; continue; }
    if (a === "--sim-speed" && args[i + 1]) { bridge.simSpeed = Number(args[++i]); continue; }
    if (a === "--discovery-port" && args[i + 1]) { bridge.discoveryPort = Number(args[++i]); continue; }
    if (a === "--hamsmart-port" && args[i + 1]) { bridge.hamSmartPort = Number(args[++i]); continue; }
    if (a === "--instrument" && args[i + 1]) { identity.instrumentId = args[++i]; continue; }
    if (a === "--serial" && args[i + 1]) { identity.moduleId = args[++i]; continue; }
    if (a === "--twin-ip" && args[i + 1]) { identity.ipAddress = args[++i]; continue; }
  }
  if (Object.keys(identity).length > 0) bridge.identity = identity;
  return {
    layoutPath,
    tracePath,
    venusRoot,
    venusCfgPath,
    venusBridge: bridgeEnabled ? bridge : null,
  };
}

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Hamilton STAR Digital Twin",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  mainWindow.loadURL(`http://localhost:${port}/`);
  mainWindow.on("closed", () => { mainWindow = null; });

  // Route `window.open('/3d')` from the header button through our
  // managed 3D BrowserWindow creator so the menu item and the button
  // both produce one reusable, identically-configured window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === "/3d") {
        open3dWindow(port);
        return { action: "deny" };
      }
    } catch { /* fall through to default */ }
    return { action: "allow" };
  });
}

/** Open (or focus) the 3D view in a separate BrowserWindow so it runs
 *  alongside the 2D UI without stealing its layout. The 3D page loads
 *  from the same HTTP server, bootstraps via /api/state and subscribes
 *  to /events SSE — no IPC. */
function open3dWindow(port: number): void {
  if (threeDWindow && !threeDWindow.isDestroyed()) {
    threeDWindow.focus();
    return;
  }
  threeDWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Hamilton STAR — 3D view",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  threeDWindow.loadURL(`http://localhost:${port}/3d`);
  threeDWindow.on("closed", () => { threeDWindow = null; });
}

/** POST a JSON body to the local twin REST API and resolve with the
 *  response body as a string. Kept tiny — one use, one caller. */
function postLocal(port: number, route: string, body: unknown): Promise<string> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => resolve(chunks));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Build the application menu with File → Load deck layout… + the
 *  standard Edit/View/Window entries. Called once at startup after the
 *  HTTP port is known so the menu handler can route to /api/deck/load. */
function installApplicationMenu(getPort: () => number): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Load deck layout…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            if (!mainWindow) return;
            const result = await dialog.showOpenDialog(mainWindow, {
              title: "Load VENUS deck layout",
              filters: [
                { name: "VENUS layouts (*.lay)", extensions: ["lay"] },
                { name: "All files", extensions: ["*"] },
              ],
              properties: ["openFile"],
            });
            if (result.canceled || result.filePaths.length === 0) return;
            const filePath = result.filePaths[0];
            try {
              const raw = await postLocal(getPort(), "/api/deck/load", { path: filePath });
              const json = JSON.parse(raw || "{}");
              if (json.error) throw new Error(json.error);
              const placedCount = Array.isArray(json.placements) ? json.placements.length : 0;
              const warningText = Array.isArray(json.warnings) && json.warnings.length > 0
                ? `Warnings:\n${json.warnings.slice(0, 10).join("\n")}`
                : undefined;
              await dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "Deck loaded",
                message: `Loaded ${placedCount} labware placement${placedCount === 1 ? "" : "s"} from ${path.basename(filePath)}`,
                detail: warningText,
              });
            } catch (err: any) {
              dialog.showErrorBox("Deck load failed", String(err?.message ?? err));
            }
          },
        },
        {
          label: "Load VENUS config…",
          click: async () => {
            if (!mainWindow) return;
            const result = await dialog.showOpenDialog(mainWindow, {
              title: "Load VENUS instrument configuration (ML_STAR.cfg)",
              filters: [
                { name: "VENUS config (*.cfg)", extensions: ["cfg"] },
                { name: "All files", extensions: ["*"] },
              ],
              properties: ["openFile"],
            });
            if (result.canceled || result.filePaths.length === 0) return;
            const filePath = result.filePaths[0];
            try {
              const raw = await postLocal(getPort(), "/api/venus-config/load", { path: filePath });
              const json = JSON.parse(raw || "{}");
              if (json.error) throw new Error(json.error);
              await dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "VENUS config loaded",
                message: `Loaded ${path.basename(filePath)} — ka=0x${json.moduleBitsHex}, xt=${json.totalTracks}, sn=${json.serial}`,
                detail: "The twin's C0QM / C0RM / C0RI / C0RF / C0RU will now match this config. If VENUS is already connected, disconnect and reconnect to re-query.",
              });
            } catch (err: any) {
              dialog.showErrorBox("VENUS config load failed", String(err?.message ?? err));
            }
          },
        },
        { type: "separator" },
        {
          label: "Open 3D view",
          accelerator: "CmdOrCtrl+3",
          click: () => open3dWindow(getPort()),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Enable Playwright CDP access
app.commandLine.appendSwitch("remote-debugging-port", "9222");

app.whenReady().then(async () => {
  const { layoutPath, tracePath, venusRoot, venusCfgPath, venusBridge } = parseCli(process.argv);
  const staticDir = path.join(__dirname, "../renderer");

  const setup = setupServer({ layoutPath, venusRoot, venusCfgPath, tracePath, staticDir, venusBridge });
  const { port } = await startHttpServer(setup.handler, httpPort, (resolved) => {
    httpPort = resolved;
    console.log(`Hamilton STAR Digital Twin: http://localhost:${resolved}/`);
  });

  // Let the VENUS bridge finish binding before opening the UI so
  // the first thing the user sees is a ready-to-discover twin.
  if (setup.venusBridgeReady) await setup.venusBridgeReady;

  installApplicationMenu(() => httpPort);

  // Delay window creation briefly so the HTTP server has a beat to settle.
  setTimeout(() => createWindow(port), 200);
});

app.on("window-all-closed", () => { app.quit(); });
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(httpPort);
});
