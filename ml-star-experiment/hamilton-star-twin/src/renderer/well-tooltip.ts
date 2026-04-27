/**
 * Shared hover-tooltip for well / tip / trough elements.
 *
 * Both the main deck SVG (deck-interact.ts) and the Inspector mini-SVG
 * (inspector.ts) feed the same tooltip experience through this namespace.
 *
 * Elements opt in by exposing `data-well-key` (format `carrierId:position:wellIdx`)
 * and either `class="well"` / `class="tip"`. Troughs use the well classes too;
 * classification is inferred from labware metadata in State.deckData.
 *
 * The tooltip element (#deck-tooltip) has CSS `position: fixed` so it follows
 * the cursor via viewport-space clientX/Y regardless of which SVG dispatched
 * the mousemove.
 */
/// <reference path="state.ts" />

namespace Twin {
  export namespace WellTooltip {

    function lookupLabware(carrierId: string, position: number): any {
      const carrier = State.deckData?.carriers?.find((c: any) => c.id === carrierId);
      return carrier?.labware?.[position] || null;
    }

    /** Build tooltip HTML for a hovered well/tip element. Returns null if the
     *  element is not a well (caller should hide the tooltip). */
    export function buildHtml(wellEl: SVGElement): string | null {
      const key = wellEl.dataset.wellKey;
      if (!key) return null;
      const keyParts = key.split(":");
      const carrierId = wellEl.dataset.carrierId || keyParts[0] || "?";
      const position = wellEl.dataset.position !== undefined
        ? Number(wellEl.dataset.position)
        : Number(keyParts[1] || 0);
      const wellIdx = wellEl.dataset.wellIdx !== undefined
        ? Number(wellEl.dataset.wellIdx)
        : Number(keyParts[2] || 0);
      const isTip = wellEl.classList.contains("tip");
      const lw = lookupLabware(carrierId, position);

      const isTrough = lw?.type?.includes("Trough") || lw?.type?.includes("Rgt") || (lw?.wellCount === 1 && !lw?.type?.includes("Tip"));
      const isWash = lw?.type?.includes("Wash");
      const cols = lw?.columns ?? (lw?.wellCount > 96 ? 24 : 12);
      const row = Math.floor(wellIdx / cols);
      const col = wellIdx % cols;
      const wn = String.fromCharCode(65 + row) + (col + 1);

      if (isTip) {
        const used = wellEl.classList.contains("tip--used");
        return `<span class="tt-well">${wn}</span> <span class="${used ? "tt-used" : "tt-tip"}">${used ? "used" : "available"}</span>`;
      }

      const vol = State.deckTracking.wellVolumes?.[key];
      const contents = State.deckTracking.wellContents?.[key];

      if (isTrough || isWash) {
        const label = isWash ? `Wash ${position + 1}` : `Trough ${position + 1}`;
        if (vol !== undefined && vol > 0) {
          const unit = vol >= 10000 ? `${(vol / 10000).toFixed(2)} mL` : `${(vol / 10).toFixed(2)} µL`;
          let html = `<span class="tt-well">${label}</span> <span class="tt-vol">${unit}</span>`;
          if (contents?.liquidType) html += ` <span class="tt-liq">${contents.liquidType}</span>`;
          return html;
        }
        if (vol !== undefined && vol < 0) {
          return `<span class="tt-well">${label}</span> <span class="tt-underflow">${(vol / 10).toFixed(2)} µL (UNDERFLOW)</span>`;
        }
        return `<span class="tt-well">${label}</span> <span class="tt-empty">empty</span>`;
      }

      // Standard plate well
      if (vol === undefined || vol === 0) {
        return `<span class="tt-well">${wn}</span> <span class="tt-empty">empty</span>`;
      }
      if (vol < 0) {
        return `<span class="tt-well">${wn}</span> <span class="tt-underflow">${(vol / 10).toFixed(2)} µL (UNDERFLOW)</span>`;
      }
      let html = `<span class="tt-well">${wn}</span> <span class="tt-vol">${(vol / 10).toFixed(2)} µL</span>`;
      // If the well has a component breakdown (mixture), show each liquid's
      // volume. Otherwise fall back to the single liquidType label.
      const components = (contents as any)?.components;
      if (components) {
        // Components may arrive as a Map (same-origin) or as a serialized
        // [[k,v],...] / {k:v} after state round-trip — handle all shapes.
        const entries: Array<[string, number]> = components instanceof Map
          ? [...components.entries()] as Array<[string, number]>
          : Array.isArray(components) ? components as Array<[string, number]>
          : Object.entries(components as Record<string, number>);
        if (entries.length > 1) {
          const parts = entries
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([name, v]) => `${name} ${(v / 10).toFixed(2)}`);
          html += ` <span class="tt-liq">${parts.join(" + ")} µL</span>`;
          return html;
        }
      }
      if (contents?.liquidType) html += ` <span class="tt-liq">${contents.liquidType}</span>`;
      return html;
    }

    /** Attach well-hover tooltip behavior to an SVG root. Returns an unbind fn. */
    export function attach(root: Element): () => void {
      const tooltip = document.getElementById("deck-tooltip");
      if (!tooltip) return () => { /* no tooltip element — noop */ };

      const onMove = (e: Event) => {
        const me = e as MouseEvent;
        const target = me.target as Element | null;
        if (!target) { tooltip.style.display = "none"; return; }
        const wellEl = target.closest("[data-well-key]") as SVGElement | null;
        if (!wellEl) { tooltip.style.display = "none"; return; }
        const html = buildHtml(wellEl);
        if (!html) { tooltip.style.display = "none"; return; }
        tooltip.innerHTML = html;
        tooltip.style.display = "block";
        // Keep the tooltip inside the viewport even when the breakdown is
        // wider than the cursor's right-side gutter (flip to the left).
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        const padR = 12;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = me.clientX + padR + tw + 8 > vw ? Math.max(4, me.clientX - padR - tw) : me.clientX + padR;
        const top  = Math.max(4, Math.min(vh - th - 4, me.clientY - 28));
        tooltip.style.left = left + "px";
        tooltip.style.top  = top + "px";
      };
      const onLeave = () => { tooltip.style.display = "none"; };

      root.addEventListener("mousemove", onMove);
      root.addEventListener("mouseleave", onLeave);
      return () => {
        root.removeEventListener("mousemove", onMove);
        root.removeEventListener("mouseleave", onLeave);
      };
    }
  }
}
