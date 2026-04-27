# Hamilton STAR Digital Twin — Portable

Unzip anywhere. No install required. The folder you unzipped into is referred to
below as `<APP>` — use its absolute path (with double backslashes in JSON).

## What's inside

```
<APP>/
  Hamilton STAR Digital Twin.exe      ← Electron UI
  README.md                           ← this file
  resources/
    app/                              ← twin payload (dist tree)
    mcp/                              ← MCP server (Node script + deps)
    launchers/
      run-mcp.bat                     ← launch MCP server (stdio or HTTP)
      run-editor.bat                  ← launch headless method-editor server
    runtime/
      node.exe                        ← bundled Node.js (no system install needed)
```

Everything is self-contained — **no system Node.js required**. The launchers
pick up `resources\runtime\node.exe` automatically; if you'd rather use a system
Node install on PATH, delete `resources\runtime\node.exe`.

## 1 · Run the UI

Double-click `Hamilton STAR Digital Twin.exe`.

## 2 · Run the MCP server standalone

```bat
resources\launchers\run-mcp.bat            :: stdio transport (default)
resources\launchers\run-mcp.bat --port 8100 :: HTTP transport
```

The UI does **not** need to be running — the MCP server is independent and
reads the twin payload from `resources\app\` directly.

## 3 · Run the headless method editor

```bat
resources\launchers\run-editor.bat
```

Opens `http://localhost:8222/protocol` in your default browser. Override the
port with `set PORT=9000` before running.

---

## Wiring MCP into LLM clients

Below, `<APP>` is the full path to your unzipped folder, e.g.
`C:\Tools\HamiltonStarTwin-0.2.0-x64`. In JSON configs, remember to escape
backslashes (`C:\\Tools\\...`).

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (create it if missing):

```json
{
  "mcpServers": {
    "hamilton-star": {
      "command": "<APP>\\resources\\launchers\\run-mcp.bat"
    }
  }
}
```

Restart Claude Desktop. A new tool icon appears in the compose bar when the
server connects.

### Claude Code (CLI)

One-shot add from any terminal:

```bat
claude mcp add hamilton-star "<APP>\resources\launchers\run-mcp.bat"
```

Or edit `.mcp.json` in the project root (project-scope) or `~/.claude.json`
(user-scope):

```json
{
  "mcpServers": {
    "hamilton-star": {
      "command": "<APP>\\resources\\launchers\\run-mcp.bat"
    }
  }
}
```

Verify with `claude mcp list`.

### LM Studio

1. Open **Settings → Developer → MCP Servers** (or edit
   `%USERPROFILE%\.lmstudio\mcp.json` directly).
2. Add:

   ```json
   {
     "mcpServers": {
       "hamilton-star": {
         "command": "<APP>\\resources\\launchers\\run-mcp.bat"
       }
     }
   }
   ```

3. Restart LM Studio; enable the server in the chat integrations panel.

### OpenAI Codex CLI

Edit `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.hamilton-star]
command = "<APP>\\resources\\launchers\\run-mcp.bat"
```

Codex picks up new MCP servers on its next invocation.

---

## What the MCP server exposes

- `twin.sendCommand` — send raw firmware-level commands (e.g. `C0AS...`)
- `twin.getState` — snapshot current deck + channel + liquid-tracker state
- `twin.saveSession` / `twin.loadSession` — snapshot + restore
- `docs.overview`, `docs.listFwCommands`, `docs.describeFwCommand` —
  self-describing catalog of the 216 FW commands and all modules
- `analysis.findIssues` — read the assessment stream (collisions, volume
  underflow, partial-mask violations, …)

Call `docs.overview` first — it lists every tool the server currently exposes.

---

## Troubleshooting

| Symptom                                     | Check                                                                          |
|---------------------------------------------|--------------------------------------------------------------------------------|
| Client says MCP server "failed to start"    | Run `resources\launchers\run-mcp.bat` from a terminal, read the stderr output. |
| `'node' is not recognized`                  | `resources\runtime\node.exe` is missing — re-extract the zip.                  |
| Editor server port in use                   | `set PORT=9001` then run `run-editor.bat`.                                     |
| Client doesn't see the server after edit    | Restart the client fully (tray icon too for Claude Desktop / LM Studio).       |
| Paths with spaces break JSON config         | Escape backslashes (`C:\\Program Files\\…`), quote the `command` value.        |

## Upgrading

Unzip the new release into a new folder. Update the `command` path in your
client configs. You can keep old releases side-by-side — nothing is shared
outside the unzipped folder.
