/**
 * DeckSnapshot.dimensions — renderer-facing physical dimensions.
 *
 * Historically the SVG renderer hardcoded `Y_FRONT = 630`, `CARRIER_Y_DIM
 * = 4970`, `TRACK_PITCH = 225` (#55 part B). Those constants diverged from
 * the values deck.ts actually uses for position math (Y_REAR = 5600 vs
 * deck-tracker's 4530, etc.), so a STARlet or custom platform silently
 * rendered wrong. The fix: server-side `Deck.getSnapshot()` emits a
 * `dimensions` record that the renderer reads at render time.
 *
 * This test pins that contract: the snapshot ships the dimensions, they
 * match the values position math relies on, and STAR vs STARlet produce
 * platform-specific values rather than a shared fallback.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Deck } = require("../../dist/twin/deck");

describe("DeckSnapshot.dimensions", () => {
  it("STAR deck snapshot carries STAR-scale physical bounds", () => {
    const deck = new Deck("STAR");
    const snap = deck.getSnapshot();
    expect(snap.dimensions).toBeDefined();
    expect(snap.dimensions.yFrontEdge).toBe(630);
    expect(snap.dimensions.yRearEdge).toBe(5600);
    expect(snap.dimensions.trackPitch).toBe(225);
    expect(snap.dimensions.deckWidth).toBe(12150);
    expect(snap.dimensions.xOffset).toBeGreaterThan(0);
  });

  it("STARlet snapshot carries STARlet-scale bounds, not STAR defaults", () => {
    const deck = new Deck("STARlet");
    const snap = deck.getSnapshot();
    expect(snap.dimensions.deckWidth).toBe(6750);   // STARlet is narrower
    expect(snap.dimensions.trackPitch).toBe(225);   // same track pitch
    expect(snap.totalTracks).toBe(30);              // but half the tracks
  });

  it("dimensions values match the deck's own position math — renderer and server agree", () => {
    const deck = new Deck("STAR");
    const snap = deck.getSnapshot();
    // trackToX(1) == xOffset by definition; getSnapshot must expose the
    // same xOffset. If these drift, wellToPosition and renderer-side
    // carrier placement disagree.
    expect(snap.dimensions.xOffset).toBe(deck.xOffset);
    // totalTracks in the top-level field must match the PLATFORM entry.
    expect(snap.totalTracks).toBe(54);
  });
});
