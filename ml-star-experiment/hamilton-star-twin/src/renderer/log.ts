/**
 * Event log — append entries with type-based coloring, HTML escaping.
 */
/// <reference path="state.ts" />

namespace Twin {
  export function escapeHtml(t: string): string {
    return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Detect if a log message is (or belongs to) a `C0TT` tip-type command.
   *  Real VENUS init floods the panel with ~68 of these per method load.
   *  `\b` boundary doesn't fire between "C0TT" and a trailing "id…" token
   *  (both are word chars), so we look for the raw 4-char prefix. */
  function isC0ttEntry(message: string): boolean {
    return /C0TT/.test(message);
  }

  export function addLogEntry(type: string, message: string): void {
    const c = document.getElementById("log-entries");
    if (!c) return;
    const e = document.createElement("div");
    e.className = "log-entry";
    if (isC0ttEntry(message)) e.dataset.cmd = "C0TT";
    const t = new Date().toLocaleTimeString("en-US", { hour12: false });
    const cls: Record<string, string> = {
      cmd: "log-cmd", ok: "log-ok", err: "log-err",
      warn: "log-warn", info: "log-info", state: "log-state",
    };
    e.innerHTML = `<span class="log-time">${t}</span> <span class="${cls[type] || "log-info"}">${escapeHtml(message)}</span>`;
    // Respect the hide-C0TT toggle for freshly-arriving entries too.
    const hideC0tt = (document.getElementById("log-hide-c0tt") as HTMLInputElement | null)?.checked;
    if (hideC0tt && e.dataset.cmd === "C0TT") e.style.display = "none";
    c.appendChild(e);
    c.scrollTop = c.scrollHeight;
  }
}
