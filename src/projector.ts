/**
 * The projection seam for `geo-canvas`.
 *
 * Every coordinate is PRE-PROJECTED from WGS84 `[lon, lat]` to EPSG:6677
 * (JGD2011 / Japan Plane Rectangular CS IX) **metres** before it reaches
 * deck.gl, so the deck.gl view is a plain `OrthographicView` in projected-metre
 * space — no geo basemap, no `MapView`, no labels (ADR-005/008).
 *
 * The projection itself comes from `@hwcharlton/geo-model` ({@link toPlanar}),
 * which implements EPSG:6677 closed-form with **zero runtime dependencies**.
 * `geo-canvas` does NOT depend on proj4: geo-model owns the projection. The one
 * thing this module adds is the **Y negation** — EPSG:6677 northing increases
 * north, but an `OrthographicView`'s y grows DOWN, so we emit `[x, -y]` to make
 * screen-up == north. Picking and render then share one coordinate space.
 *
 * DI convention: `(deps, ...)`. `makeProjector` takes an (empty) deps bag for
 * call-shape consistency with the rest of the API — geo-model's projection is
 * pure, so there is nothing to inject.
 */
import { toPlanar } from "@hwcharlton/geo-model";

/** A pre-projector from WGS84 lon/lat to EPSG:6677 screen-plane metres. */
export interface Projector {
  /**
   * `[lon, lat]` (EPSG:4326, degrees) → `[x_east_m, -y_north_m]` (EPSG:6677
   * metres, Y negated so screen-up == north under an `OrthographicView`).
   */
  forward: (lonlat: [number, number]) => [number, number];
}

/**
 * Build a {@link Projector} backed by geo-model's EPSG:6677 projection.
 *
 * `deps` is an empty bag (the projection is pure and dependency-free); it exists
 * only to keep the `(deps, ...)` call shape consistent across the package and to
 * leave room for a future injected projection oracle without an API break.
 */
export function makeProjector(_deps: Record<never, never> = {}): Projector {
  return {
    forward: (lonlat) => {
      const [x, y] = toPlanar(lonlat);
      // Negate Y so screen-up == north under OrthographicView (y grows down).
      return [x, -y];
    },
  };
}
