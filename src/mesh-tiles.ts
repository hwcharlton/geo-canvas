/**
 * Stage-2 PLATEAU render-budget tier (ADR-021) — the headline geo-canvas
 * deliverable for the authoritative building layer.
 *
 * The full 23-ku is ~1.7M PLATEAU buildings, far over deck.gl's ~100k-polygon
 * per-frame ceiling. The pack producer (`geo-build`) therefore tiles by
 * **Japanese 3rd-level mesh** (~1 km, 8-digit code, e.g. `53393596`) — one pack
 * per mesh — and ships a `packs/plateau/index.json` listing every mesh's bbox +
 * building count. This module is the render-budget machinery that turns that
 * index into a bounded, worker-safe draw set:
 *
 *   1. {@link meshesInView} — **viewport culling**: keep only the meshes whose
 *      lon/lat bbox intersects the current view bounds (only those packs get
 *      fetched).
 *   2. {@link pickLod} — **LOD + poly budget**: per visible mesh decide
 *      `extrude` (3D massing) vs `flat` (footprints only) vs `skip`, using the
 *      index's per-mesh `count` so the selected draw set stays under a
 *      ~100k-polygon cap per frame.
 *   3. {@link decodeAndProjectMesh} — **worker-safe decode+project**: take one
 *      mesh's decompressed TopoJSON pack and return projected building records,
 *      reusing the existing TopoJSON decode + {@link projectPack} +
 *      {@link flattenBuildings}. NO DOM / deck.gl imports, so the panel can run
 *      it inside a Web Worker.
 *   4. {@link buildPlateauBuildingTileLayer} — the deck.gl layer factory: one
 *      extruded `SolidPolygonLayer` per visible mesh (reusing the Stage-1
 *      extruded kind + {@link heightColor}), with `getTileData` INJECTED so the
 *      panel runs the decode+project of (3) in its Worker.
 *
 * ### Approach: explicit mesh-culling composite, NOT a deck.gl `TileLayer`
 *
 * The contract permits either a `@deck.gl/geo-layers` `TileLayer` OR an explicit
 * mesh-culling composite. We deliberately chose the **explicit composite**:
 *
 *   - `TileLayer` lives in `@deck.gl/geo-layers`, which is **not** a dependency
 *     or peer of this package (only `@deck.gl/core` + `@deck.gl/layers` are).
 *     Pulling it in would break the "additive, deck.gl-ctors-injected, never
 *     imported" house rule (ADR-017).
 *   - `TileLayer`'s quadtree indexes a continuous z/x/y pyramid. The Japanese
 *     3rd-level mesh grid is a **discrete, lat-dependent** grid (mesh cells are
 *     not power-of-two subdivisions of a square), so it does not map cleanly
 *     onto a quadtree — exactly the escape hatch the contract calls out.
 *
 * The composite gives the **same three guarantees** as a `TileLayer` would:
 *   (1) only in-view meshes are fetched — {@link meshesInView} culls the index
 *       before any `getTileData`/decode runs;
 *   (2) decode runs in a Worker — `getTileData` is injected and the panel routes
 *       it to a Worker that calls {@link decodeAndProjectMesh};
 *   (3) <100k polys/frame — {@link pickLod} budgets the visible set by the
 *       index's per-mesh counts and skips the overflow.
 *
 * DI convention throughout: `(deps, target, options?)`.
 */
import type { DecodedPack, PackRef } from "@hwcharlton/geo-client";
import { decodePack } from "@hwcharlton/geo-client";
import { makeProjector } from "./projector.js";
import { projectPack } from "./project-pack.js";
import {
  flattenBuildings,
  heightColor,
  type LayerCtors,
  type ProjectedBuilding,
  type BuildingLayerStyle,
} from "./build-layers.js";

// ---------------------------------------------------------------------------
// Local mesh-index types (HARD RULE: the cross-package JSON shape is defined
// LOCALLY here, NOT imported from an unpublished geo-* change).
// ---------------------------------------------------------------------------

/** A lon/lat axis-aligned bbox: `[minLon, minLat, maxLon, maxLat]` (EPSG:4326). */
export type LngLatBBox = [
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
];

/**
 * One mesh's entry in `packs/plateau/index.json` (the cross-package JSON
 * contract, mirrored as a LOCAL type so this package depends only on PUBLISHED
 * deps + the JSON shape). `count`/`height_max` drive the render budget; `pack`
 * is the artifact path the panel resolves to a URL.
 */
export interface MeshEntry {
  /** 8-digit Japanese 3rd-level mesh code, e.g. `"53393596"`. */
  mesh: string;
  /** Mesh bbox in lon/lat: `[minLon, minLat, maxLon, maxLat]`. */
  bbox: LngLatBBox;
  /** Repo-relative pack path, e.g. `"plateau/53393596/building/flat.<hash>.topo.json.br"`. */
  pack: string;
  /** Building (feature) count in this mesh — the per-mesh poly-budget weight. */
  count: number;
  /** Tallest building in metres (optional; for styling/LOD hints). */
  height_max?: number;
}

/**
 * The Stage-2 PLATEAU mesh index (`packs/plateau/index.json`), mirrored LOCALLY.
 * Only the fields this package reads are required; provenance fields are carried
 * opaquely so the panel can surface attribution without this package re-deriving
 * the contract.
 */
export interface PlateauMeshIndex {
  /** Always `"plateau-building"` for this tier. */
  tier: string;
  /** Source CRS of pack coordinates (lon/lat), e.g. `"urn:ogc:def:crs:EPSG::4326"`. */
  crs?: string;
  /** Render CRS this package projects to, e.g. `"EPSG:6677"`. */
  render_crs?: string;
  /** Attribution line(s) from the index (PLATEAU). */
  attribution?: string[];
  /** Pack license id, e.g. `"ODbL-1.0"`. */
  license?: string;
  /** Every baked mesh in the tier. */
  meshes: MeshEntry[];
}

// ---------------------------------------------------------------------------
// 1. Viewport culling — meshesInView
// ---------------------------------------------------------------------------

/**
 * Return only the meshes whose lon/lat bbox INTERSECTS the view bounds — the
 * viewport-cull that bounds how many packs are ever fetched. Inclusive-edge
 * AABB overlap (a mesh touching the view edge is kept). The view bounds are in
 * the SAME lon/lat space as the index bboxes (the panel inverse-projects the
 * deck.gl viewport corners back to lon/lat before calling this).
 *
 * `(deps, target, options?)`: `deps` is an empty bag for call-shape consistency
 * (the cull is pure); `target` is the index; the view bounds are the option.
 */
export function meshesInView(
  _deps: Record<never, never>,
  index: PlateauMeshIndex,
  options: { viewBoundsLngLat: LngLatBBox },
): MeshEntry[] {
  const [vMinLon, vMinLat, vMaxLon, vMaxLat] = options.viewBoundsLngLat;
  return index.meshes.filter((m) => {
    const [minLon, minLat, maxLon, maxLat] = m.bbox;
    // AABB overlap on both axes (inclusive edges) → the mesh is at least
    // partly in view, so its pack must be drawn.
    return (
      minLon <= vMaxLon &&
      maxLon >= vMinLon &&
      minLat <= vMaxLat &&
      maxLat >= vMinLat
    );
  });
}

// ---------------------------------------------------------------------------
// 2. LOD + poly budget — pickLod
// ---------------------------------------------------------------------------

/** What the panel should do with a single visible mesh this frame. */
export type MeshLod = "extrude" | "flat" | "skip";

/** A mesh + the LOD chosen for it this frame (+ the budget weight used). */
export interface MeshDraw {
  /** The index entry to draw. */
  entry: MeshEntry;
  /** Render treatment: extruded 3D massing, flat footprints, or skip. */
  lod: MeshLod;
}

/** View-span info {@link pickLod} budgets against (drives the extrude→flat cut). */
export interface ViewSpanInfo {
  /**
   * Optional zoom hint (deck.gl Orbit/Orthographic `zoom`: world-units-per-pixel
   * = `2^-zoom`, so HIGHER zoom == closer). When omitted, LOD is decided purely
   * by the polygon budget.
   */
  zoom?: number;
  /**
   * Zoom at/above which meshes extrude (3D massing); below it they fall back to
   * flat footprints (cheaper) before the budget even applies. Default `0`.
   */
  extrudeMinZoom?: number;
}

/** Options for {@link pickLod}: the per-frame polygon cap + LOD thresholds. */
export interface PickLodOptions extends ViewSpanInfo {
  /** Max polygons drawn per frame across all kept meshes. Default `100_000`. */
  polyBudget?: number;
}

/** The drawn-this-frame set plus the budget accounting {@link pickLod} produced. */
export interface PickLodResult {
  /** Per-mesh LOD decisions (input order); `skip` entries are NOT fetched. */
  draws: MeshDraw[];
  /** Sum of `count` over the kept (non-skip) meshes — the budgeted poly total. */
  budgetedPolys: number;
  /** The polygon cap that was enforced. */
  polyBudget: number;
}

/** Default per-frame polygon cap (ADR-021: stay under deck.gl's ~100k ceiling). */
const DEFAULT_POLY_BUDGET = 100_000;

/**
 * Decide a per-mesh LOD (`extrude` / `flat` / `skip`) over the IN-VIEW meshes so
 * the drawn polygon total stays under {@link PickLodOptions.polyBudget}.
 *
 * Greedy budget in INPUT ORDER (deterministic): meshes are taken in the order
 * given — the caller may pre-sort by view-centre distance for nearest-first
 * priority. Each kept mesh spends its `count` from the budget; once the budget
 * is exhausted the rest are `skip`. Below `extrudeMinZoom` kept meshes are
 * `flat` (footprints only, no
 * extrusion) — cheaper to draw and still budgeted by `count` (one polygon per
 * footprint either way).
 *
 * `(deps, target, options?)`: `deps` empty (pure); `target` is the in-view mesh
 * list (typically the output of {@link meshesInView}); `options` the budget +
 * zoom thresholds.
 */
export function pickLod(
  _deps: Record<never, never>,
  meshesInViewList: MeshEntry[],
  options: PickLodOptions = {},
): PickLodResult {
  const polyBudget = options.polyBudget ?? DEFAULT_POLY_BUDGET;
  const extrudeMinZoom = options.extrudeMinZoom ?? 0;
  // Extrude only when zoomed in enough; if no zoom hint, default to extrude.
  const extrude =
    options.zoom === undefined ? true : options.zoom >= extrudeMinZoom;

  let spent = 0;
  const draws: MeshDraw[] = meshesInViewList.map((entry) => {
    const weight = Math.max(0, entry.count | 0);
    if (spent + weight > polyBudget) {
      // Taking this mesh would blow the budget → skip it (and it won't be
      // fetched). We do NOT break: a later, smaller mesh might still fit.
      return { entry, lod: "skip" as const };
    }
    spent += weight;
    return { entry, lod: extrude ? ("extrude" as const) : ("flat" as const) };
  });

  return { draws, budgetedPolys: spent, polyBudget };
}

// ---------------------------------------------------------------------------
// 3. Worker-safe decode + project — decodeAndProjectMesh
// ---------------------------------------------------------------------------

/**
 * The injected pieces {@link decodeAndProjectMesh} needs. NONE touch the DOM or
 * deck.gl, so the panel can call this inside a Web Worker. `topoFeature` is the
 * `topojson-client` `feature()` (defaulted by `geo-client` when omitted);
 * supplying it explicitly keeps the worker bundle's import graph obvious.
 */
export interface DecodeMeshDeps {
  /**
   * The `topojson-client` `feature()` that expands a TopoJSON object into
   * GeoJSON. Optional — `decodePack` defaults to its bundled copy.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topoFeature?: any;
}

/** A mesh's decompressed pack JSON + the metadata to decode it (worker input). */
export interface MeshPackJson {
  /** The decompressed TopoJSON topology (the panel brotli-decoded the `.br`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topology: any;
  /** This mesh's 8-digit code (becomes the synthetic id prefix). */
  mesh: string;
  /** Attribution line surfaced with the projected records (from the index/manifest). */
  attribution?: string;
}

/** Options for {@link decodeAndProjectMesh}: the projector axis convention. */
export interface DecodeMeshOptions {
  /**
   * `false` (the 3D `OrbitView` path) keeps north +Y on the ground plane so
   * extrusion carries as +Z — the only sane setting for the building tier.
   * Defaults to `false`. `true` is accepted only for symmetry with
   * {@link makeProjector}.
   */
  negateY?: boolean;
}

/** A decoded+projected mesh: the projected building records + carried metadata. */
export interface ProjectedMesh {
  /** This mesh's 8-digit code. */
  mesh: string;
  /** One {@link ProjectedBuilding} per polygon, ready for `SolidPolygonLayer`. */
  buildings: ProjectedBuilding[];
  /** Attribution carried through for the host's overlay. */
  attribution: string;
  /** Polygon count == `buildings.length` (the per-mesh draw count). */
  count: number;
}

/**
 * Decode one mesh's decompressed TopoJSON pack and PROJECT it to EPSG:6677
 * metres, returning flattened building records — worker-safe (no DOM, no deck).
 *
 * Reuses the existing pipeline end-to-end: `decodePack` (TopoJSON→GeoJSON,
 * single-object packs) → {@link projectPack} (lon/lat→metres, ids, bounds) →
 * {@link flattenBuildings} (one record per polygon, height→Z). The decompressed
 * topology is handed straight to `decodePack` via an in-memory `loadTopology`,
 * so no network or codec runs here.
 *
 * `(deps, target, options?)`.
 */
export async function decodeAndProjectMesh(
  deps: DecodeMeshDeps,
  packJson: MeshPackJson,
  options: DecodeMeshOptions = {},
): Promise<ProjectedMesh> {
  const negateY = options.negateY ?? false;
  const attribution = packJson.attribution ?? "";

  // A PackRef addressing this mesh's single `flat` building pack. The mesh code
  // stands in for the `ward` slug so synthetic ids read `<mesh>:<i>` (mirroring
  // `<ward>:<i>` for area packs) and picking stays unique across meshes.
  const ref: PackRef = {
    ward: packJson.mesh,
    layer: "building",
    detail: "flat",
  };

  // Build a synthetic manifest so `decodePack`'s attribution surfaces our line
  // without re-deriving the provenance contract here (source separation is
  // enforced upstream in the bake — packs are pure PLATEAU).
  const decoded: DecodedPack = await decodePack(
    {
      loadTopology: async () => ({
        topology: packJson.topology,
        // Only `source.attribution` is read by decodePack; the rest of the
        // manifest shape is the producer's concern and not needed to render.
        manifest: {
          source: { attribution },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
      topoFeature: deps.topoFeature,
    },
    ref,
  );

  const projector = makeProjector({}, { negateY });
  const projected = projectPack({ projector }, decoded, {
    idPrefix: packJson.mesh,
  });
  const buildings = flattenBuildings(projected);

  return {
    mesh: packJson.mesh,
    buildings,
    attribution: decoded.attribution,
    count: buildings.length,
  };
}

// ---------------------------------------------------------------------------
// 4. deck.gl layer factory — buildPlateauBuildingTileLayer
// ---------------------------------------------------------------------------

/**
 * The deck.gl ctors the factory injects. `SolidPolygonLayer` is REQUIRED (the
 * extruded building kind). A `@deck.gl/geo-layers` `TileLayer` is deliberately
 * NOT used: its quadtree indexes a continuous z/x/y pyramid, whereas the
 * Japanese mesh grid is a discrete lat-dependent grid under an `OrbitView` in
 * EPSG:6677 metres (see the module header) — the explicit mesh-culling composite
 * gives the same three guarantees and is the shipped mechanism.
 */
export interface PlateauTileLayerCtors extends Pick<LayerCtors, "SolidPolygonLayer"> {
  /** Required: the extruded building layer ctor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SolidPolygonLayer: any;
}

/**
 * What the factory draws: the index to cull, the current view bounds (lon/lat),
 * the per-mesh data fetcher (INJECTED — the panel runs decode+project in a
 * Worker), and styling/budget knobs.
 */
export interface PlateauTileLayerTarget {
  /** The Stage-2 PLATEAU mesh index. */
  index: PlateauMeshIndex;
  /** Current view bounds in lon/lat (panel inverse-projects the viewport). */
  viewBoundsLngLat: LngLatBBox;
  /**
   * Fetch+decode+project ONE mesh's buildings — INJECTED so the panel routes it
   * to a Web Worker calling {@link decodeAndProjectMesh}. Returns the flattened
   * building records (or a promise of them) for the given mesh entry.
   */
  getTileData: (
    entry: MeshEntry,
  ) => ProjectedBuilding[] | Promise<ProjectedBuilding[]>;
}

/** Styling + budget options for {@link buildPlateauBuildingTileLayer}. */
export interface PlateauTileLayerOptions extends PickLodOptions {
  /** Building style (height ramp, elevationScale, wireframe). */
  style?: BuildingLayerStyle;
  /** Pickable layers (default `true`). */
  pickable?: boolean;
  onClick?: (info: unknown) => void;
  onHover?: (info: unknown) => void;
}

/**
 * Build the PLATEAU building render set for the current frame.
 *
 * Pipeline: {@link meshesInView} (cull the index by the view) → {@link pickLod}
 * (budget the kept meshes to <100k polys, decide extrude/flat/skip) → one
 * extruded `SolidPolygonLayer` per kept mesh, its `data` produced by the
 * injected `getTileData` (so the panel's Worker runs the decode). Skipped meshes
 * are neither fetched nor drawn. The `SolidPolygonLayer` props mirror the
 * Stage-1 extruded kind (`extruded`/`getElevation`/`getPolygon`/`getFillColor`
 * via {@link heightColor}) so the two building tiers render identically.
 *
 * Returns one extruded `SolidPolygonLayer` per kept mesh (the explicit
 * mesh-culling composite). Skipped meshes are neither fetched nor drawn.
 *
 * `(deps, target, options?)`.
 */
export function buildPlateauBuildingTileLayer(
  deps: { ctors: PlateauTileLayerCtors },
  target: PlateauTileLayerTarget,
  options: PlateauTileLayerOptions = {},
): unknown[] {
  const { SolidPolygonLayer } = deps.ctors;
  if (!SolidPolygonLayer) {
    throw new Error(
      `geo-canvas: buildPlateauBuildingTileLayer needs a SolidPolygonLayer ` +
        `ctor — inject one via deps.ctors.SolidPolygonLayer`,
    );
  }

  const style = options.style ?? {};
  const colorFor = style.color ?? heightColor;
  const pickable = options.pickable ?? true;

  // (1) Cull to in-view meshes, (2) budget them to <100k polys + pick LOD.
  const inView = meshesInView({}, target.index, {
    viewBoundsLngLat: target.viewBoundsLngLat,
  });
  const { draws } = pickLod({}, inView, options);

  // One extruded SolidPolygonLayer per kept (non-skip) mesh. `data` is the
  // injected getTileData(entry) — the panel runs that decode in a Worker, so
  // only in-view, budgeted meshes are ever fetched.
  const buildMeshLayer = (entry: MeshEntry, lod: MeshLod): unknown =>
    new SolidPolygonLayer({
      id: `plateau-building-${entry.mesh}`,
      data: target.getTileData(entry),
      pickable,
      extruded: lod === "extrude",
      filled: true,
      wireframe: style.wireframe ?? false,
      elevationScale: style.elevationScale ?? 1,
      getPolygon: (d: ProjectedBuilding) => d.polygon,
      // `flat` LOD draws footprints with no height; `extrude` carries metres.
      getElevation:
        lod === "extrude" ? (d: ProjectedBuilding) => d.elevation : () => 0,
      getFillColor: (d: ProjectedBuilding) => colorFor(d.elevation),
      material: { ambient: 0.6, diffuse: 0.6, shininess: 32 },
      onClick: options.onClick,
      onHover: options.onHover,
    });

  // The explicit mesh-culling composite: one extruded layer per kept mesh.
  return draws
    .filter((d) => d.lod !== "skip")
    .map((d) => buildMeshLayer(d.entry, d.lod));
}
