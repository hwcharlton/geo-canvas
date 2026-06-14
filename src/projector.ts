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
 * ### Two axis conventions (2D Ortho vs 3D Orbit)
 *
 * The default (`negateY: true`) emits `[x, -y]` for the Phase-1 2D
 * `OrthographicView` path (screen-up == north, y grows down).
 *
 * The 3D building-extrusion path (Phase 2) renders over an `OrbitView` with
 * `orbitAxis: "Z"`, which treats **Z as up** and X/Y as the ground plane. There,
 * negating Y would flip north below the horizon, so the orbit projector is built
 * with `negateY: false`: north stays **+Y** on the ground plane and building
 * height is carried as +Z (positive-up). One coordinate space still serves both
 * render and `pickObject`; only the Y sign differs per view. See `fitBoundsOrbit`
 * and the `building` layer in `build-layers.ts`.
 *
 * DI convention: `(deps, target?, options?)`. `makeProjector` takes an (empty)
 * deps bag for call-shape consistency with the rest of the API — geo-model's
 * projection is pure, so there is nothing to inject — and an options bag carrying
 * the {@link MakeProjectorOptions.negateY} axis choice.
 */
import { toPlanar } from "@hwcharlton/geo-model";

/** A pre-projector from WGS84 lon/lat to EPSG:6677 screen-plane metres. */
export interface Projector {
  /**
   * `[lon, lat]` (EPSG:4326, degrees) → `[x_east_m, y_m]` (EPSG:6677 metres).
   *
   * With `negateY: true` (the default, for `OrthographicView`) the northing is
   * negated to `[x, -y]` so screen-up == north. With `negateY: false` (for
   * `OrbitView`, `orbitAxis:"Z"`) the northing is passed through as `[x, y]` so
   * north is +Y on the ground plane.
   */
  forward: (lonlat: [number, number]) => [number, number];
}

/** Options for {@link makeProjector} — currently the Y-axis convention. */
export interface MakeProjectorOptions {
  /**
   * Negate the projected northing so screen-up == north under an
   * `OrthographicView` (`[x, -y]`). Defaults to `true` (the Phase-1 2D path).
   *
   * Set `false` for the 3D `OrbitView` (`orbitAxis:"Z"`) building-extrusion
   * path, where Z is up and north must stay +Y on the ground plane (`[x, y]`).
   */
  negateY?: boolean;
}

/**
 * Build a {@link Projector} backed by geo-model's EPSG:6677 projection.
 *
 * `deps` is an empty bag (the projection is pure and dependency-free); it exists
 * only to keep the `(deps, ...)` call shape consistent across the package and to
 * leave room for a future injected projection oracle without an API break.
 *
 * `options.negateY` selects the axis convention: `true` (default) for the 2D
 * `OrthographicView` path, `false` for the 3D `OrbitView` ground plane (north
 * stays +Y, height carried as +Z by the extruded layer).
 */
export function makeProjector(
  _deps: Record<never, never> = {},
  options: MakeProjectorOptions = {},
): Projector {
  const negateY = options.negateY ?? true;
  return {
    forward: (lonlat) => {
      const [x, y] = toPlanar(lonlat);
      // negateY:true → screen-up == north under OrthographicView (y grows down).
      // negateY:false → north stays +Y on the OrbitView (orbitAxis:"Z") ground
      // plane, leaving +Z free for building height.
      return [x, negateY ? -y : y];
    },
  };
}
