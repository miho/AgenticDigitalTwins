/**
 * ReportGenerator (Step 4.A)
 *
 * Stateless, pure reports computed from a recorded `TwinTrace`. Every
 * output is a deterministic function of the input trace, so golden-file
 * tests can diff byte-identical results across runs.
 *
 * Design notes
 * ------------
 *   - No I/O. The service never reads from disk or touches the live
 *     twin — callers hand it a parsed TwinTrace.
 *   - No wall-clock reads. Durations come from `metadata.startTime` /
 *     `metadata.endTime` (or timeline timestamps) so reports generated
 *     twice from the same trace are byte-identical.
 *   - Text and HTML renders are offered alongside the structured object
 *     so callers can pick the right shape for their channel (MCP / REST
 *     download / UI).
 *
 * Report catalogue
 * ----------------
 *   - `protocolSummary(trace)`       high-level run summary
 *   - `wellReport(trace, wellKey)`   per-well history + final state
 *   - `assessmentCsv(trace)`         every assessment in CSV form
 *   - `timingReport(trace)`          estimated time per command / step
 *   - `diffReport(original, fork)`   structured what-if diff summary
 *
 * Each entry point returns a structured object; helper renderers convert
 * to text, HTML or CSV as needed.
 */

import type { TwinTrace } from "../twin/trace-format";
import type { TwinTimelineEvent } from "../twin/timeline";
import type { CommandResult } from "../twin/digital-twin";
import type { AssessmentEvent, AssessmentCategory, AssessmentSeverity } from "../twin/assessment";
import type { DeckInteraction } from "../twin/deck-tracker";
import type { ForkDiff } from "./trace-replay-service";
import { parseFwCommand } from "../twin/fw-protocol";
import { estimateCommandTime } from "../twin/command-timing";

// ============================================================================
// ProtocolSummary
// ============================================================================

export interface ProtocolSummaryReport {
  label: string | null;
  deviceName: string;
  platform: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  commandCount: number;
  stepCount: number;
  eventCount: number;
  assessmentCounts: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<AssessmentSeverity, number>;
  };
  flaggedCount: number;
  errorCount: number;
  acceptedCommandCount: number;
  rejectedCommandCount: number;
}

export function protocolSummary(trace: TwinTrace): ProtocolSummaryReport {
  const meta = trace.metadata;
  const timeline = trace.timeline;

  const byCategory: Record<string, number> = {};
  const bySeverity: Record<AssessmentSeverity, number> = { info: 0, warning: 0, error: 0 };
  let assessmentTotal = 0;
  let stepStartCount = 0;
  let flagged = 0;
  let errorEvents = 0;
  let accepted = 0;
  let rejected = 0;

  for (const evt of timeline) {
    if (evt.lifecycle === "flagged") flagged++;
    if (evt.severity === "error") errorEvents++;

    if (evt.kind === "assessment") {
      const a = evt.payload as AssessmentEvent;
      assessmentTotal++;
      byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
    } else if (evt.kind === "step") {
      const p = evt.payload as { phase: "start" | "end" };
      if (p.phase === "start") stepStartCount++;
    } else if (evt.kind === "command") {
      const c = evt.payload as CommandResult;
      if (c.accepted) accepted++;
      else rejected++;
    }
  }

  return {
    label: meta.label ?? null,
    deviceName: meta.deviceName,
    platform: meta.platform,
    startTime: meta.startTime,
    endTime: meta.endTime,
    durationMs: Math.max(0, meta.endTime - meta.startTime),
    commandCount: meta.commandCount,
    stepCount: stepStartCount,
    eventCount: meta.eventCount,
    assessmentCounts: {
      total: assessmentTotal,
      byCategory,
      bySeverity,
    },
    flaggedCount: flagged,
    errorCount: errorEvents,
    acceptedCommandCount: accepted,
    rejectedCommandCount: rejected,
  };
}

/** Render a ProtocolSummary as plain text. */
export function renderProtocolSummaryText(r: ProtocolSummaryReport): string {
  const lines: string[] = [];
  lines.push(`Protocol Summary — ${r.label ?? "(unlabelled)"}`);
  lines.push(`Device:        ${r.deviceName} (${r.platform})`);
  lines.push(`Duration:      ${(r.durationMs / 1000).toFixed(2)} s`);
  lines.push(`Events:        ${r.eventCount}  (commands: ${r.commandCount}, steps: ${r.stepCount})`);
  lines.push(`Commands:      accepted ${r.acceptedCommandCount}, rejected ${r.rejectedCommandCount}`);
  lines.push(`Assessments:   ${r.assessmentCounts.total}`);
  for (const [cat, n] of Object.entries(r.assessmentCounts.byCategory)) {
    lines.push(`  ${cat}: ${n}`);
  }
  lines.push(`Severity:      info ${r.assessmentCounts.bySeverity.info}, warning ${r.assessmentCounts.bySeverity.warning}, error ${r.assessmentCounts.bySeverity.error}`);
  lines.push(`Flagged:       ${r.flaggedCount}`);
  return lines.join("\n");
}

/** Render a ProtocolSummary as minimal HTML. No CSS — callers add styling. */
export function renderProtocolSummaryHtml(r: ProtocolSummaryReport): string {
  const esc = escapeHtml;
  const catRows = Object.entries(r.assessmentCounts.byCategory)
    .map(([cat, n]) => `<tr><td>${esc(cat)}</td><td>${n}</td></tr>`)
    .join("");
  return [
    `<section class="protocol-summary">`,
    `<h2>Protocol Summary — ${esc(r.label ?? "(unlabelled)")}</h2>`,
    `<dl>`,
    `<dt>Device</dt><dd>${esc(r.deviceName)} (${esc(r.platform)})</dd>`,
    `<dt>Duration</dt><dd>${(r.durationMs / 1000).toFixed(2)} s</dd>`,
    `<dt>Events</dt><dd>${r.eventCount} (commands ${r.commandCount}, steps ${r.stepCount})</dd>`,
    `<dt>Commands</dt><dd>accepted ${r.acceptedCommandCount}, rejected ${r.rejectedCommandCount}</dd>`,
    `<dt>Flagged</dt><dd>${r.flaggedCount}</dd>`,
    `</dl>`,
    `<table class="assessment-by-category"><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${catRows}</tbody></table>`,
    `</section>`,
  ].join("");
}

// ============================================================================
// Well-level report
// ============================================================================

export interface WellOperation {
  eventId: number;
  timestamp: number;
  kind: TwinTimelineEvent["kind"];
  command?: string;
  description: string;
  correlationId?: number;
  stepId?: number;
  /** Volume delta at this step if derivable (positive = added, negative = removed). */
  deltaVolume?: number;
  /** Volume after this operation, if derivable. */
  volumeAfter?: number;
  severity?: AssessmentSeverity;
}

export interface WellReport {
  wellKey: string;
  carrierId: string;
  position: number;
  wellIndex: number;
  finalVolume: number;
  finalLiquid: {
    liquidType: string;
    liquidClass?: string;
    volume: number;
  } | null;
  operations: WellOperation[];
}

/**
 * Per-well history. The final state is read from `trace.finalState`; the
 * operations list is derived from timeline events that touch the well. We
 * do NOT re-execute the trace here — delta volumes come from deck
 * interactions when they carry a delta, or are omitted when ambiguous.
 */
export function wellReport(trace: TwinTrace, wellKey: string): WellReport {
  const [carrierId, positionStr, wellIndexStr] = wellKey.split(":");
  const position = Number(positionStr);
  const wellIndex = Number(wellIndexStr);

  const operations: WellOperation[] = [];
  let runningVolume = trace.initialState.tracking.wellVolumes?.[wellKey] ?? 0;

  for (const evt of trace.timeline) {
    if (!eventTouchesWell(evt, wellKey)) continue;

    const op: WellOperation = {
      eventId: evt.id,
      timestamp: evt.timestamp,
      kind: evt.kind,
      description: describeEvent(evt),
      correlationId: evt.correlationId,
      stepId: evt.stepId,
      severity: evt.severity,
    };

    if (evt.kind === "command") {
      const c = evt.payload as CommandResult;
      op.command = c.rawCommand;
      const delta = volumeDeltaFromCommand(c);
      if (delta !== null) {
        op.deltaVolume = delta;
        runningVolume += delta;
        op.volumeAfter = runningVolume;
      }
    } else if (evt.kind === "deck_interaction") {
      const d = evt.payload as DeckInteraction;
      op.command = d.command;
    }

    operations.push(op);
  }

  // Final volume + liquid from the post-run snapshot (authoritative).
  const finalVolume = trace.finalState.tracking.wellVolumes?.[wellKey] ?? 0;
  const liq = trace.finalState.liquid?.wellContents?.[wellKey] ?? null;

  return {
    wellKey,
    carrierId,
    position,
    wellIndex,
    finalVolume,
    finalLiquid: liq
      ? { liquidType: liq.liquidType, liquidClass: (liq as any).liquidClass, volume: liq.volume }
      : null,
    operations,
  };
}

function volumeDeltaFromCommand(c: CommandResult): number | null {
  if (!c.deckInteraction) return null;
  // Infer the delta from the command parameters. `av` is 0.1 µL — the same
  // unit used for tracked well volumes, so no conversion needed.
  const raw = c.rawCommand ?? "";
  try {
    const parsed = parseFwCommand(raw);
    const ev = parsed.event;
    const av = parsed.params?.av;
    if (typeof av !== "number" || !Number.isFinite(av) || av === 0) return null;
    if (ev === "C0AS") return -av;   // aspirate removes from the source
    if (ev === "C0DS") return +av;   // dispense adds to the target
  } catch {
    return null;
  }
  return null;
}

function describeEvent(evt: TwinTimelineEvent): string {
  switch (evt.kind) {
    case "command": {
      const c = evt.payload as CommandResult;
      return c.accepted ? `${eventNameFromRaw(c.rawCommand)} (accepted)` : `${eventNameFromRaw(c.rawCommand)} — rejected: ${c.errorDescription}`;
    }
    case "deck_interaction": {
      const d = evt.payload as DeckInteraction;
      return `deck: ${d.command}`;
    }
    case "assessment": {
      const a = evt.payload as AssessmentEvent;
      return `assessment ${a.category}/${a.severity}: ${a.description}`;
    }
    case "device_event":
      return `device_event`;
    case "step":
      return `step_boundary`;
    case "completion":
      return `completion`;
    default:
      return String(evt.kind);
  }
}

function eventNameFromRaw(raw: string | undefined): string {
  if (!raw) return "?";
  try {
    return parseFwCommand(raw).event;
  } catch {
    return raw.slice(0, 4);
  }
}

function eventTouchesWell(e: TwinTimelineEvent, wellKey: string): boolean {
  if (e.kind === "deck_interaction") {
    const r = (e.payload as DeckInteraction).resolution;
    return !!(r?.matched && `${r.carrierId}:${r.position}:${r.wellIndex}` === wellKey);
  }
  if (e.kind === "command") {
    const r = (e.payload as CommandResult).deckInteraction?.resolution;
    return !!(r?.matched && `${r.carrierId}:${r.position}:${r.wellIndex}` === wellKey);
  }
  if (e.kind === "assessment") {
    const d = (e.payload as AssessmentEvent).data;
    return !!(d && `${d.carrierId}:${d.position}:${d.wellIndex}` === wellKey);
  }
  return false;
}

// ============================================================================
// Assessment CSV
// ============================================================================

/** Stable header order — tests depend on this. */
export const ASSESSMENT_CSV_HEADER = [
  "id",
  "timestamp",
  "category",
  "severity",
  "module",
  "command",
  "channel",
  "description",
  "correlationId",
  "stepId",
  "carrierId",
  "position",
  "wellIndex",
  "lifecycle",
] as const;

export function assessmentCsv(trace: TwinTrace): string {
  const rows: string[] = [ASSESSMENT_CSV_HEADER.join(",") ];
  for (const evt of trace.timeline) {
    if (evt.kind !== "assessment") continue;
    const a = evt.payload as AssessmentEvent;
    const d = a.data ?? {};
    rows.push([
      a.id,
      a.timestamp,
      a.category,
      a.severity,
      a.module,
      a.command,
      a.channel ?? "",
      csvEscape(a.description),
      a.correlationId ?? "",
      a.stepId ?? "",
      csvEscape(d.carrierId ?? ""),
      d.position ?? "",
      d.wellIndex ?? "",
      evt.lifecycle ?? "active",
    ].join(","));
  }
  return rows.join("\n");
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ============================================================================
// Timing report
// ============================================================================

export interface CommandTimingRow {
  eventId: number;
  event: string;
  estimatedMs: number;
  correlationId?: number;
  stepId?: number;
}

export interface StepTimingRow {
  stepId: number;
  stepType: string;
  startedAt: number;
  endedAt: number | null;
  wallClockMs: number | null;
  estimatedMs: number;
  success: boolean | null;
  commandCount: number;
}

export interface TimingReport {
  totalEstimatedMs: number;
  totalWallClockMs: number;
  commandBreakdown: Record<string, { count: number; estimatedMs: number }>;
  commands: CommandTimingRow[];
  steps: StepTimingRow[];
}

/**
 * Timing breakdown. `estimatedMs` comes from `estimateCommandTime()` —
 * a static function of command/params, so results are deterministic.
 * `wallClockMs` uses recorded event timestamps — these vary run-to-run
 * but are still reproducible from a given trace.
 */
export function timingReport(trace: TwinTrace): TimingReport {
  const commands: CommandTimingRow[] = [];
  const breakdown: Record<string, { count: number; estimatedMs: number }> = {};
  const stepMap = new Map<number, StepTimingRow>();
  let totalEstimated = 0;

  for (const evt of trace.timeline) {
    if (evt.kind === "command") {
      const c = evt.payload as CommandResult;
      let eventName = "?";
      let estimatedMs = 0;
      try {
        const parsed = parseFwCommand(c.rawCommand);
        eventName = parsed.event;
        estimatedMs = estimateCommandTime(parsed.event, parsed.params);
      } catch {
        // Unparseable raw — still record row with unknown timing.
      }
      totalEstimated += estimatedMs;
      const slot = breakdown[eventName] ?? { count: 0, estimatedMs: 0 };
      slot.count++;
      slot.estimatedMs += estimatedMs;
      breakdown[eventName] = slot;
      commands.push({
        eventId: evt.id,
        event: eventName,
        estimatedMs,
        correlationId: evt.correlationId,
        stepId: c.stepId,
      });
    } else if (evt.kind === "step") {
      const p = evt.payload as { stepId: number; phase: "start" | "end"; stepType: string; success?: boolean };
      if (p.phase === "start") {
        stepMap.set(p.stepId, {
          stepId: p.stepId,
          stepType: p.stepType,
          startedAt: evt.timestamp,
          endedAt: null,
          wallClockMs: null,
          estimatedMs: 0,
          success: null,
          commandCount: 0,
        });
      } else {
        const row = stepMap.get(p.stepId);
        if (row) {
          row.endedAt = evt.timestamp;
          row.wallClockMs = Math.max(0, evt.timestamp - row.startedAt);
          row.success = p.success ?? null;
        }
      }
    }
  }

  // Second pass — attribute each command to its step for commandCount /
  // estimatedMs rollups. Done after step rows exist so out-of-order
  // timeline wouldn't break the roll-up.
  for (const cmd of commands) {
    if (cmd.stepId === undefined) continue;
    const row = stepMap.get(cmd.stepId);
    if (!row) continue;
    row.commandCount++;
    row.estimatedMs += cmd.estimatedMs;
  }

  const steps = [...stepMap.values()].sort((a, b) => a.stepId - b.stepId);
  const totalWall = Math.max(0, trace.metadata.endTime - trace.metadata.startTime);

  return {
    totalEstimatedMs: totalEstimated,
    totalWallClockMs: totalWall,
    commandBreakdown: breakdown,
    commands,
    steps,
  };
}

// ============================================================================
// What-if diff report
// ============================================================================

export interface DiffReportRow {
  label: string;
  original: string;
  fork: string;
}

export interface DiffReport {
  forkId: string;
  branchedAtIndex: number;
  summary: {
    wellsChanged: number;
    modulesChanged: number;
    tipsAdded: number;
    tipsRemoved: number;
    forkCommandCount: number;
  };
  rows: DiffReportRow[];
}

export function diffReport(diff: ForkDiff): DiffReport {
  const rows: DiffReportRow[] = [];
  for (const w of diff.wellVolumes) {
    rows.push({
      label: `well ${w.wellKey}`,
      original: formatVolume(w.originalVolume),
      fork: `${formatVolume(w.forkVolume)} (${w.delta >= 0 ? "+" : ""}${formatVolume(w.delta)})`,
    });
  }
  for (const m of diff.moduleStates) {
    rows.push({
      label: `module ${m.moduleId}`,
      original: m.original.join(",") || "(none)",
      fork: m.fork.join(",") || "(none)",
    });
  }
  for (const k of diff.tipUsage.addedInFork) {
    rows.push({ label: `tip added`, original: "", fork: k });
  }
  for (const k of diff.tipUsage.removedInFork) {
    rows.push({ label: `tip removed`, original: k, fork: "" });
  }

  return {
    forkId: diff.forkId,
    branchedAtIndex: diff.branchedAtIndex,
    summary: {
      wellsChanged: diff.wellVolumes.length,
      modulesChanged: diff.moduleStates.length,
      tipsAdded: diff.tipUsage.addedInFork.length,
      tipsRemoved: diff.tipUsage.removedInFork.length,
      forkCommandCount: diff.forkCommandCount,
    },
    rows,
  };
}

function formatVolume(v: number): string {
  // volumes are stored in 0.1 µL units; present µL with 1 decimal for readability
  return (v / 10).toFixed(1);
}

// ============================================================================
// Helpers
// ============================================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Discriminator used by REST layer to pick a render format. */
export type ReportFormat = "json" | "text" | "html" | "csv";

/** Narrow helper so TypeScript doesn't moan about unused imports. */
export type _Unused = AssessmentCategory;
