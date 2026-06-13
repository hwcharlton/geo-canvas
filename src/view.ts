/**
 * View helpers: fit projected bounds to an `OrthographicView` state, and build
 * the attribution overlay string.
 *
 * `fitBounds` maps projected EPSG:6677 metres → an `OrthographicView`
 * `{ target, zoom }`. In an `OrthographicView` the world-units-per-pixel is
 * `2^-zoom`, so we pick the zoom that makes the larger content span fit its
 * viewport dimension (with a padding fraction), and centre `target` on the
 * bounds' midpoint.
 *
 * `buildAttribution` returns the de-duplicated source line(s). Attribution is a
 * **DOM overlay the host renders** (pinned over the canvas), NOT a deck.gl layer
 * (ADR-008/017) — this function only produces the text.
 */
import type { Bounds } from "./project-pack.js";

/** Where/how big to fit: a viewport in CSS pixels, with optional padding. */
export interface FitTarget {
  width: number;
  height: number;
  /** Fraction of the viewport the content fills (default `0.9`). */
  padding?: number;
}

/** An `OrthographicView` view state. */
export interface ViewState {
  target: [number, number, number];
  zoom: number;
}

/**
 * Map projected `bounds` → an `OrthographicView` `{ target, zoom }` that fits
 * the content into a viewport of the given pixel size (with margin).
 */
export function fitBounds(bounds: Bounds, target: FitTarget): ViewState {
  const [minX, minY, maxX, maxY] = bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const pad = target.padding ?? 0.9; // fraction of viewport the content fills
  // OrthographicView zoom: world units per pixel = 2^-zoom. Pick the zoom so the
  // larger span fits the corresponding viewport dimension.
  const zoomX = Math.log2((target.width * pad) / spanX);
  const zoomY = Math.log2((target.height * pad) / spanY);
  return { target: [cx, cy, 0], zoom: Math.min(zoomX, zoomY) };
}

/**
 * Attribution overlay text, de-duplicated across packs. NOT a deck.gl layer —
 * the host pins this string as a DOM overlay over the canvas (ADR-008/017).
 *
 * Typically yields `"© OpenStreetMap contributors"`.
 */
export function buildAttribution(packs: { attribution: string }[]): string {
  return [...new Set(packs.map((p) => p.attribution).filter(Boolean))].join(
    " · ",
  );
}
