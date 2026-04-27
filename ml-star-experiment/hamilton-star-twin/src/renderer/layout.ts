/**
 * Layout — split-pane resizable panels with localStorage persistence.
 *
 * Each `.resize-handle` sits between two flex siblings; dragging it assigns
 * fixed pixel sizes to both. The budget math accounts for the parent's CSS
 * `gap` (previously ignored — the resulting 24 px overflow silently clipped
 * the bottom of the page under `main { overflow: hidden }`), clamps restored
 * sizes against the current viewport, and re-clamps on window resize so a
 * layout stored at one window size can't overrun a smaller one.
 */
/// <reference path="state.ts" />
/// <reference path="deck-svg.ts" />

namespace Twin {
  export namespace Layout {

    interface Pair {
      el: HTMLElement;         // the resize-handle itself
      prev: HTMLElement;       // sibling before the handle
      next: HTMLElement;       // sibling after the handle
      parent: HTMLElement;     // flex container both belong to
      isHorizontal: boolean;   // resize-h → column widths; resize-v → row heights
      minSize: number;         // minimum px per side after a drag
      /** True once this pair has been pinned to fixed-px sizes (from a drag
       *  or a restore). Until then we leave the default flex ratios alone so
       *  untouched panels still flow naturally on window resize. */
      pinned: boolean;
    }

    const pairs: Pair[] = [];

    /** Sum the gaps declared by the parent (column-gap / row-gap) across N
     *  flex children — gaps aren't part of any child's offsetWidth/Height,
     *  so the pixel budget has to subtract them explicitly. */
    function totalGap(parent: HTMLElement, isHorizontal: boolean): number {
      const cs = getComputedStyle(parent);
      const raw = isHorizontal ? cs.columnGap : cs.rowGap;
      const gap = parseFloat(raw) || 0;
      const n = parent.children.length;
      return n > 1 ? (n - 1) * gap : 0;
    }

    /** Content-area size of the parent along the split axis. `clientWidth`/
     *  `clientHeight` include the parent's padding, but flex children are
     *  laid out inside the padding box — using the raw clientSize overcounts
     *  by the padding (which showed up as a constant bottom clip). */
    function parentSize(p: Pair): number {
      const cs = getComputedStyle(p.parent);
      if (p.isHorizontal) {
        return p.parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      }
      return p.parent.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    }

    function sizeOf(el: HTMLElement, isHorizontal: boolean): number {
      return isHorizontal ? el.offsetWidth : el.offsetHeight;
    }

    /** Available space for prev+next after subtracting every other child,
     *  the handle itself, and the parent's CSS gap. */
    function budgetFor(p: Pair): number {
      const total = parentSize(p);
      let others = 0;
      for (const child of Array.from(p.parent.children) as HTMLElement[]) {
        if (child === p.prev || child === p.next || child === p.el) continue;
        others += sizeOf(child, p.isHorizontal);
      }
      const handle = sizeOf(p.el, p.isHorizontal);
      const gap = totalGap(p.parent, p.isHorizontal);
      return Math.max(2 * p.minSize, total - others - handle - gap);
    }

    /** Pin the pair to a pair of fixed flex-basis sizes, clamped to the
     *  current budget. `prevPx` is the desired size of the prev sibling;
     *  next is derived so the two always sum to the budget. */
    function applyPair(p: Pair, prevPx: number): void {
      const budget = budgetFor(p);
      const min = p.minSize;
      let newPrev = Math.max(min, Math.min(budget - min, prevPx));
      let newNext = budget - newPrev;
      if (newNext < min) {
        newNext = min;
        newPrev = budget - min;
      }
      p.prev.style.flex = `0 0 ${newPrev}px`;
      p.next.style.flex = `0 0 ${newNext}px`;
      p.pinned = true;
    }

    export function setupResizeHandles(): void {
      document.querySelectorAll(".resize-handle").forEach((handle) => {
        const el = handle as HTMLElement;
        const isHorizontal = el.classList.contains("resize-h");
        const prev = el.previousElementSibling as HTMLElement | null;
        const next = el.nextElementSibling as HTMLElement | null;
        const parent = el.parentElement as HTMLElement | null;
        if (!prev || !next || !parent) return;

        const pair: Pair = {
          el, prev, next, parent, isHorizontal,
          // Vertical dividers need room for a toolbar + run-bar + some list;
          // horizontal splits can go tighter.
          minSize: isHorizontal ? 80 : 120,
          pinned: false,
        };
        pairs.push(pair);

        el.addEventListener("mousedown", (e: Event) => {
          const me = e as MouseEvent;
          // Only respond to primary-button drags on the handle itself.
          // A right-click or a middle-click on the divider used to
          // trigger a phantom drag because `mouseup` never arrived from
          // the browser's context menu — #62 audit 2026-04-19.
          if (me.button !== 0) return;
          me.preventDefault();
          me.stopPropagation();
          el.classList.add("dragging");
          // Force the matching resize cursor across the whole viewport
          // while dragging so the user doesn't lose the "I'm resizing"
          // feedback when the cursor wanders off the 6 px band onto
          // panel content.
          const bodyClass = isHorizontal ? "dragging-resize-h" : "dragging-resize-v";
          document.body.classList.add(bodyClass);

          const startPos = isHorizontal ? me.clientX : me.clientY;
          const prevSize = sizeOf(prev, isHorizontal);
          let rafId = 0;
          let pendingPrev = prevSize;

          const commit = () => {
            rafId = 0;
            const budget = budgetFor(pair);
            const newPrev = Math.max(pair.minSize, Math.min(budget - pair.minSize, pendingPrev));
            const newNext = budget - newPrev;
            prev.style.flex = `0 0 ${newPrev}px`;
            next.style.flex = `0 0 ${newNext}px`;
            pair.pinned = true;
            DeckSVG.renderDeck();
          };

          const onMove = (moveEvt: MouseEvent) => {
            const delta = (isHorizontal ? moveEvt.clientX : moveEvt.clientY) - startPos;
            pendingPrev = prevSize + delta;
            // Coalesce to one layout per animation frame — the full
            // `renderDeck()` rebuild was ~8 ms on the PLT_CAR + iSWAP
            // scene, so firing it on every raw mousemove at ~240 Hz
            // stalled the drag.
            if (!rafId) rafId = requestAnimationFrame(commit);
          };

          const onUp = () => {
            if (rafId) { cancelAnimationFrame(rafId); commit(); }
            el.classList.remove("dragging");
            document.body.classList.remove(bodyClass);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            const key = el.dataset.split;
            if (key) {
              localStorage.setItem(`split-${key}`, JSON.stringify({
                prev: sizeOf(prev, isHorizontal),
                next: sizeOf(next, isHorizontal),
              }));
            }
          };

          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        });

        // Restore persisted sizes, clamped into the current budget. Earlier
        // versions would dump saved values straight into flex basis — if the
        // window was smaller than when the value was saved, that overflowed
        // the parent and the overflow:hidden on `main` silently clipped
        // whatever didn't fit (usually the bottom toolbar/log panel).
        const key = el.dataset.split;
        if (key) {
          const saved = localStorage.getItem(`split-${key}`);
          if (saved) {
            try {
              const { prev: sp } = JSON.parse(saved);
              applyPair(pair, Number(sp) || 0);
            } catch { /* ignore corrupt entry */ }
          }
        }
      });

      // Re-clamp every tracked pair on window resize so panels can't stay
      // oversized after the viewport shrinks (Electron window drag, DPI
      // change, etc.).
      window.addEventListener("resize", reflow);
    }

    /** Re-apply current sizes through the clamp so they fit the current
     *  parent. Only touches pairs that have already been pinned to fixed-px
     *  (dragged or restored) — never-touched pairs keep their default flex
     *  ratios and reflow naturally via the browser. */
    export function reflow(): void {
      for (const p of pairs) {
        if (!p.pinned) continue;
        applyPair(p, sizeOf(p.prev, p.isHorizontal));
      }
      DeckSVG.renderDeck();
    }
  }
}
