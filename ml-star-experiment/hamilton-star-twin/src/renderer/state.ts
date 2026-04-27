/**
 * Shared state — all global variables that multiple modules read/write.
 *
 * Using a namespace so tsc --outFile concatenates everything into one JS file.
 * Every other renderer module references Twin.State.* for shared data.
 */
namespace Twin {
  // ── Interfaces ──────────────────────────────────────────────────────────

  export interface HitRegion {
    x: number; y: number; w: number; h: number;
    carrierId: string;
    carrierType: string;
    carrierIdx: number;       // index into deckData.carriers
    position?: number;        // labware position (0-based), undefined = carrier-level
    labware?: any;            // labware snapshot at this position (if any)
  }

  export interface DeckGlow {
    key: string;       // carrier:pos:wellIdx
    type: "tip" | "well";
    startTime: number;
    duration: number;  // ms
  }

  export interface ChannelLiquidInfo {
    hasTip: boolean;
    tipType: string | null;
    tipMaxVolume: number;
    contents: { liquidType: string; volume: number; liquidClass: string } | null;
    contactHistory: string[];
    contaminated: boolean;
  }

  export interface DeckTrackingData {
    tipUsage: Record<string, boolean>;
    wellVolumes: Record<string, number>;
    wellContents?: Record<string, { liquidType: string; volume: number; liquidClass: string }>;
    channels?: ChannelLiquidInfo[];
    unresolved: any[];
    unresolvedCount: number;
    hasContamination?: boolean;
  }

  // ── Shared mutable state ────────────────────────────────────────────────

  export namespace State {
    // Variables snapshot (previous frame, for change detection)
    export let previousVariables: Record<string, Record<string, unknown>> = {};

    // Deck data from server
    export let deckData: any = null;

    // Deck canvas coordinate mapping (written by DeckDraw, read by interactions/arm)
    export let deckScale = 0;
    export let deckScaleY = 0;      // Y-axis scale (may differ from X in fill mode)
    export let deckOffsetX = 20;
    export let deckOffsetY = 20;
    export let deckMaxX = 13000;

    // Deck zoom and pan
    export let deckZoom = 1.0;
    export let deckPanX = 0;
    export let deckPanY = 0;
    export let deckDragging = false;
    export let deckDragStartX = 0;
    export let deckDragStartY = 0;
    export let deckPanStartX = 0;
    export let deckPanStartY = 0;

    // Display mode
    export let deckMode: "fit" | "fill" = "fit";

    // Hit regions for click detection (rebuilt during drawDeck)
    export let hitRegions: HitRegion[] = [];

    // Deck tracking (tip usage + well volumes)
    export let deckTracking: DeckTrackingData = {
      tipUsage: {}, wellVolumes: {}, unresolved: [], unresolvedCount: 0,
    };
    export let prevDeckTracking: DeckTrackingData = {
      tipUsage: {}, wellVolumes: {}, unresolved: [], unresolvedCount: 0,
    };

    // Glow effects
    export let deckGlows: DeckGlow[] = [];

    // Arm animation
    export let animPipX = 0;
    export let animPipY = 0;
    export let animIswapX = 0;
    export let animIswapY = 0;
    export let targetPipX = 0;
    export let targetPipY = 1500;
    export let targetIswapX = 0;
    export let targetIswapY = 0;
    export let animActive = false;
    export let armOpacity = 0.7;

    // Arm overlay coordinates (written by DeckDraw, read by arm overlay)
    export let deckBaseYScale = 0;
    export let deckYminStored = 400;
    export let armOverlayOffsetY = 0;
    export let armOverlayDrawH = 0;

    // 96-head and 384-head positions
    export let animH96X = 0;
    export let animH96Y = 0;
    export let animH96Z = 0;
    export let targetH96X = 0;
    export let targetH96Y = 0;
    export let targetH96Z = 0;
    export let animH384X = 0;
    export let animH384Y = 0;
    export let animH384Z = 0;
    export let targetH384X = 0;
    export let targetH384Y = 0;
    export let targetH384Z = 0;

    // PIP head Z — derived from the per-channel `pos_z` array; we use
    // a single scalar for the ghost-arm elevation (channel 0 if any
    // channel is engaged, else the max Z across all 16). The per-channel
    // depth bars in the channel panel read straight from the array.
    export let animPipZ = 0;
    export let targetPipZ = 0;

    /**
     * Live per-channel PIP Y and Z during an envelope animation.
     * Populated by Arm.sampleEnvelope when the envelope carries the
     * per-channel arrays. The 2D arm render reads these to draw each
     * of the 16 channels at its own Y coordinate (channel-spread
     * visualisation) and the per-channel Z-depth bars. 3D reads them
     * to place the individual pin meshes.
     *
     * Empty array when no envelope is active — readers should fall
     * back to arm-wide animPipY / animPipZ in that case.
     */
    export let animPipY_ch: number[] = [];
    export let animPipZ_ch: number[] = [];

    // iSWAP Z / rotation / gripper width. The iSWAP moves through all
    // five axes; the legacy renderer only drew X, so Z/rotation/grip
    // were invisible until a proper envelope carried them.
    export let animIswapZ = 0;
    export let targetIswapZ = 0;
    export let animIswapRotationDeg = 0;
    export let targetIswapRotationDeg = 0;
    export let animIswapGripWidth = 0;   // 0.1 mm jaw-to-jaw distance
    export let targetIswapGripWidth = 0;
    // Held-plate footprint (0.1 mm). Resolved from the labware under the
    // iSWAP at C0PP time; SBS-plate defaults (1278 × 855 = ANSI/SLAS-1-2004
    // microplate) are used when no labware is resolvable so the renderer
    // still draws something sensible on bare-deck test decks.
    export let animIswapPlateWidth = 1278;
    export let animIswapPlateHeight = 855;

    // AutoLoad carriage — runs along the front rail of the deck. X is the
    // deck X of the currently-aligned track (0 = parked at tray / not
    // visible). The animation state mirrors animH384X's single-axis pattern.
    export let animAutoloadX = 0;
    export let targetAutoloadX = 0;
    export let autoloadParked = true;   // true when pos_track === 0

    // Log counter
    export let logCounter = 0;

    // Assessment events
    export let assessmentEvents: any[] = [];

    // Ghost head — hidden by default; appears when the user clicks a well
    // (snapped mode) or an empty deck position (free mode). ESC hides it.
    // Keeps the initial deck uncluttered and lets the real arm be the
    // primary visual indicator.
    export let ghostX = 5000;         // deck X (0.1mm) — ~track 23, roughly mid-deck
    export let ghostY = 1460;         // deck Y of Row A (0.1mm) — matches SMP row A
    export let ghostPitch = 90;       // channel Y-pitch (0.1mm) — auto-set from labware
    export let ghostVisible = false;
    export let ghostChannelMask = 255; // bitmask 0-255
    export let ghostSnap: {
      carrierId: string; position: number; col: number;
      labware: any; carrier: any; isTip: boolean;
    } | null = null;
    /** True while the user is dragging the ghost head. Disables other deck
     *  mouse handlers (pan, click) so they don't fire simultaneously. */
    export let ghostDragging = false;
    /** True if the ghost's current X/Y is arbitrary (off-deck or Shift-drop). */
    export let ghostFree = true;
    /** Ghost-placement tool mode. When true, the ghost follows the cursor and
     *  a click places it; when false, clicks go straight to the inspector and
     *  the ghost stays pointer-transparent. Default off so the inspector is
     *  reachable out of the box. */
    export let ghostTool = false;

    /** Space-held for Affinity/Figma-style pan mode (#61). While true,
     *  left-click-drag pans the deck regardless of what's under the
     *  cursor (carriers, ghost handle, labware). Released on keyup. */
    export let spaceHeldForPan = false;
  }
}
