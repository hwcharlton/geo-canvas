/**
 * View helpers: fit projected bounds to an `OrthographicView` state (2D) or an
 * `OrbitView` state (3D buildings), and build the attribution overlay string.
 *
 * `fitBounds` maps projected EPSG:6677 metres → an `OrthographicView`
 * `{ target, zoom }`. In an `OrthographicView` the world-units-per-pixel is
 * `2^-zoom`, so we pick the zoom that makes the larger content span fit its
 * viewport dimension (with a padding fraction), and centre `target` on the
 * bounds' midpoint.
 *
 * `fitBoundsOrbit` maps the same projected metres → an `OrbitView` state
 * (`{ target, zoom, rotationX, rotationOrbit, minZoom, maxZoom }`). It reuses the
 * Ortho `2^zoom` px-per-metre scale, then tilts the camera (`rotationX`) so
 * building extrusion reads as 3D massing over the ground plane (north +Y).
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

/** Extra `fitBoundsOrbit` knobs: the pitch/yaw used to reveal extrusion. */
export interface OrbitFitOptions {
  /** Pitch in degrees up from the ground plane (default `50`). */
  rotationX?: number;
  /** Yaw in degrees around the up-axis (default `0`). */
  rotationOrbit?: number;
}

/**
 * An `OrbitView` view state (`orbitAxis:"Z"`) for the 3D building path. `target`
 * is a ground point (z = 0); `zoom` reuses the Ortho `2^zoom` px-per-metre scale;
 * `rotationX`/`rotationOrbit` are the pitch/yaw that make extrusion visible.
 */
export interface OrbitViewState {
  target: [number, number, number];
  zoom: number;
  /** Pitch (degrees up from the ground plane). */
  rotationX: number;
  /** Yaw (degrees around the up-axis). */
  rotationOrbit: number;
  minZoom: number;
  maxZoom: number;
}

/**
 * Map projected ground `bounds` → an `OrbitView` state that fits the content
 * with a pitch so building extrusion reads as 3D massing.
 *
 * Sibling to {@link fitBounds}: it reuses the same `2^zoom` px-per-metre scale
 * (so the ground footprint fits the viewport exactly as the 2D fit would), then
 * adds the orbit camera angles. The pack must be projected with a
 * `negateY:false` `Projector` so north is +Y on the ground plane (Z is up =
 * building height). `target` sits on the ground (z = 0); `rotationX` defaults to
 * a ~50° tilt (enough to read massing) and `rotationOrbit` to 0 (north away from
 * the viewer). `minZoom`/`maxZoom` bracket the fit zoom for the host controller.
 */
export function fitBoundsOrbit(
  bounds: Bounds,
  target: FitTarget,
  options: OrbitFitOptions = {},
): OrbitViewState {
  const [minX, minY, maxX, maxY] = bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const pad = target.padding ?? 0.9; // fraction of viewport the content fills
  // Reuse the OrthographicView scale: world units per pixel = 2^-zoom.
  const zoomX = Math.log2((target.width * pad) / spanX);
  const zoomY = Math.log2((target.height * pad) / spanY);
  const zoom = Math.min(zoomX, zoomY);
  return {
    target: [cx, cy, 0],
    zoom,
    rotationX: options.rotationX ?? 50,
    rotationOrbit: options.rotationOrbit ?? 0,
    minZoom: zoom - 4,
    maxZoom: zoom + 8,
  };
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
