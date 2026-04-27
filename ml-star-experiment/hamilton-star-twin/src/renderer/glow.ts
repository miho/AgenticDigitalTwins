/**
 * Deck glow effects — tip pickup flash, well fill pulse.
 */
/// <reference path="state.ts" />

namespace Twin {
  export namespace Glow {
    export function add(key: string, type: "tip" | "well"): void {
      State.deckGlows.push({
        key, type,
        startTime: performance.now(),
        duration: type === "tip" ? 800 : 600,
      });
      if (!State.animActive) {
        State.animActive = true;
        requestAnimationFrame(Arm.animate);
      }
    }

    export function getIntensity(glow: DeckGlow): number {
      const elapsed = performance.now() - glow.startTime;
      if (elapsed >= glow.duration) return 0;
      const t = elapsed / glow.duration;
      return t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
    }

    /** Compare current vs previous tracking to trigger glow on changes. */
    export function detectTrackingChanges(): void {
      for (const [key, used] of Object.entries(State.deckTracking.tipUsage)) {
        if (used && !State.prevDeckTracking.tipUsage[key]) {
          add(key, "tip");
        }
      }
      for (const [key, vol] of Object.entries(State.deckTracking.wellVolumes)) {
        const prevVol = State.prevDeckTracking.wellVolumes[key] || 0;
        if (vol !== prevVol && vol > 0) {
          add(key, "well");
        }
      }
      State.prevDeckTracking = JSON.parse(JSON.stringify(State.deckTracking));
    }
  }
}
