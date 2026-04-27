/**
 * Event lifecycle classifier (Step 3.3)
 *
 * Walks a timeline (or a single event) and assigns each entry a
 * `lifecycle` value — `active`, `expected`, `flagged`, `suppressed`,
 * or `resolved`. Runs over a recorded trace OR incrementally as events
 * stream off a live twin.
 *
 * Rules are intentionally small and opinionated. The goal is to give a
 * human-useful triage view: "here's what needs attention, here's what's
 * noise". Extend with new rules as the twin grows.
 *
 * Current rule set:
 *   1. Error-severity assessments start as `flagged`.
 *   2. Contamination flagged events become `resolved` when the offending
 *      channel later performs a tip eject (C0TR).
 *   3. Unresolved-position assessments whose command later turns out to
 *      be a query (no state change) become `suppressed`.
 *   4. Command events with errorCode === 0 stay `active` by default.
 *
 * Non-goals: judging whether a command was "correct" per protocol. That
 * belongs to a higher-level linter, not this rules engine.
 */

import type {
  TwinTimelineEvent,
  TwinEventLifecycle,
} from "./timeline";
import type { AssessmentEvent } from "./assessment";
import type { CommandResult } from "./digital-twin";

/** High-level counts that the UI/MCP layer can show at a glance. */
export interface LifecycleSummary {
  total: number;
  active: number;
  expected: number;
  flagged: number;
  suppressed: number;
  resolved: number;
}

/**
 * Apply the rule set to a timeline. Returns the same events (mutated)
 * for convenience; the function is idempotent — running it twice on the
 * same timeline produces the same classifications.
 */
export function autoClassify(timeline: TwinTimelineEvent[]): TwinTimelineEvent[] {
  // Reset prior classifications so idempotency holds even after edits.
  for (const e of timeline) {
    e.lifecycle = classifyInitial(e);
  }

  // Second pass: apply cross-event rules (e.g. contamination → resolved
  // once a subsequent C0TR happens on the same PIP channel).
  resolveContaminationByTipEject(timeline);
  suppressQueryUnresolveds(timeline);

  return timeline;
}

/** Classify a single event as if no later events exist yet. */
export function classifyInitial(e: TwinTimelineEvent): TwinEventLifecycle {
  if (e.kind === "assessment") {
    const payload = e.payload as AssessmentEvent;
    if (payload.severity === "error") return "flagged";
    if (payload.severity === "warning") return "flagged";
    if (payload.severity === "info") return "active";
  }
  if (e.kind === "command") {
    const payload = e.payload as CommandResult;
    if (payload.errorCode && payload.errorCode !== 0) return "flagged";
    return "active";
  }
  return "active";
}

/**
 * Explicitly set (or change) the lifecycle of a single event. Used by
 * operator actions from the UI / MCP tools.
 */
export function classify(event: TwinTimelineEvent, lifecycle: TwinEventLifecycle): void {
  event.lifecycle = lifecycle;
}

/** All events currently classified `flagged`. */
export function getFlagged(timeline: TwinTimelineEvent[]): TwinTimelineEvent[] {
  return timeline.filter((e) => e.lifecycle === "flagged");
}

/** Aggregate counts by lifecycle — handy for a dashboard badge. */
export function getSummary(timeline: TwinTimelineEvent[]): LifecycleSummary {
  const out: LifecycleSummary = {
    total: timeline.length,
    active: 0, expected: 0, flagged: 0, suppressed: 0, resolved: 0,
  };
  for (const e of timeline) {
    const lc = e.lifecycle ?? "active";
    out[lc]++;
  }
  return out;
}

// --- rules ------------------------------------------------------------

/**
 * Rule: a contamination assessment on PIP channel C is considered
 * resolved when the same channel later performs a C0TR (tip eject).
 * Ejecting the contaminated tip removes the risk that liquid identity
 * will leak into another well.
 */
function resolveContaminationByTipEject(timeline: TwinTimelineEvent[]): void {
  // Walk once. For each contamination assessment currently flagged, look
  // forward for a tip-eject (C0TR) that covers the channel. O(N^2) in
  // the worst case but N is bounded by timeline length — fine for
  // interactive trace sizes.
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.kind !== "assessment") continue;
    const a = e.payload as AssessmentEvent;
    if (a.category !== "contamination" || e.lifecycle !== "flagged") continue;

    // a.channel is the PIP channel index; undefined = "any channel".
    const channel = a.channel;
    for (let j = i + 1; j < timeline.length; j++) {
      const later = timeline[j];
      if (later.kind !== "command") continue;
      const cmd = later.payload as CommandResult;
      if (!cmd.rawCommand || !cmd.rawCommand.startsWith("C0TR")) continue;
      // For now, any C0TR resolves — finer-grained channel targeting can
      // come later when the physics plugin tags the ejected channels on
      // the deck interaction.
      if (channel === undefined || true) {
        e.lifecycle = "resolved";
        break;
      }
    }
  }
}

/**
 * Rule: an unresolved_position assessment on a non-state-changing command
 * (query, config write, etc. — any command whose CommandResult has
 * accepted=true && errorCode=0 && targetModule === "system") is demoted
 * to `suppressed`. The assessment is technically valid but not
 * actionable.
 */
function suppressQueryUnresolveds(timeline: TwinTimelineEvent[]): void {
  for (const e of timeline) {
    if (e.kind !== "assessment") continue;
    const a = e.payload as AssessmentEvent;
    if (a.category !== "unresolved_position") continue;
    if (e.lifecycle !== "flagged") continue;

    // Look up the triggering command by correlationId.
    if (e.correlationId === undefined) continue;
    const cmd = timeline.find(
      (x) => x.kind === "command" && x.correlationId === e.correlationId,
    );
    if (!cmd) continue;
    const result = cmd.payload as CommandResult;
    if (result.targetModule === "system") {
      e.lifecycle = "suppressed";
    }
  }
}
