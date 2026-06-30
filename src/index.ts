/**
 * `@hwcharlton/geo-canvas` — renderer-neutral projection, PLATEAU planning, and
 * browser geometry helpers for the @hwcharlton geo-data ecosystem.
 *
 * Responsibility (ADR-005/008/011/017/021): take decoded geo-data packs from
 * `@hwcharlton/geo-client`, **pre-project** coordinates to EPSG:6677
 * (JGD2011 Japan Plane Rectangular CS IX) metres using `@hwcharlton/geo-model`'s
 * projection, plan bounded PLATEAU mesh draw sets, and expose host-injected
 * browser render helpers. The package owns the shared coordinate and geometry
 * contracts; host apps own renderer lifecycles, workers, cache policy, and UI.
 *
 * Three deliberate seams keep this package pure and headless-testable:
 *   1. The **projection** comes from geo-model (closed-form, deps-free) — there
 *      is **no proj4 dependency**. `makeProjector` wraps `toPlanar`; by default
 *      it negates Y so screen-up == north under an `OrthographicView`, and with
 *      `{ negateY: false }` it leaves north at +Y for the 3D `OrbitView` ground
 *      plane (Z = building height).
 *   2. The **deck.gl layer constructors are injected** (ADR-017) — `geo-canvas`
 *      never imports `@deck.gl/layers`, so deck.gl is a host-supplied peer, not
 *      a runtime dependency. Tests pass fake ctors that record their props.
 *   3. The **Three.js path exports typed-array payloads**, not Three objects.
 *      Hosts build/dispose `BufferGeometry`, materials, cameras, and renderers.
 *
 * Two render paths share this one coordinate space:
 *   - **2D** (Phase 1): admin/water → `GeoJsonLayer`, road → `PathLayer`, over an
 *     `OrthographicView` fit by {@link fitBounds} (`negateY:true`).
 *   - **3D** (Phase 2): `building` → an extruded `SolidPolygonLayer` (height ramp
 *     + material), over an `OrbitView` (`orbitAxis:"Z"`) fit by
 *     {@link fitBoundsOrbit}, with the pack projected `negateY:false`.
 *
 * Attribution is a **DOM overlay** the host renders, NOT a deck.gl layer;
 * `buildAttribution` only produces the de-duplicated text.
 *
 *   - {@link makeProjector} — `(deps?, options?)` → `Projector`
 *     (`forward([lon,lat]) → [x,-y]` by default; `[x,y]` with `negateY:false`).
 *   - {@link projectPack} — `(deps, decodedPack, options?)` → `ProjectedPack`.
 *   - {@link buildLayers} — `(deps, target, options?)` → deck.gl `Layer[]`.
 *   - {@link fitBounds} — `(bounds, target)` → `OrthographicView` `{ target, zoom }`.
 *   - {@link fitBoundsOrbit} — `(bounds, target, options?)` → `OrbitView` state.
 *   - {@link buildAttribution} — `(packs)` → de-duplicated attribution string.
 *
 * PLATEAU render-budget tier (ADR-021): per-mesh viewport culling +
 * nearest-first sorting + LOD/poly-budget + worker-safe decode +
 * Three.js-ready typed-array geometry. The older injected-ctor deck.gl building
 * factory remains exported for compatibility, but host apps with their own
 * cache/lifecycle policy should plan draws explicitly and adapt them locally.
 *
 *   - {@link meshesInView} — `(deps, index, {viewBoundsLngLat})` → in-view meshes.
 *   - {@link pickLod} — `(deps, inViewMeshes, options?)` → per-mesh LOD + budget.
 *   - {@link decodeAndProjectMesh} — `(deps, packJson, options?)` → projected
 *     building records (worker-safe; no DOM/deck).
 *   - {@link buildThreeMeshGeometry} — `(deps, target, options?)` → typed-array
 *     payload for host-owned Three.js `BufferGeometry`.
 */
export {
  makeProjector,
  type Projector,
  type MakeProjectorOptions,
} from "./projector.js";

export {
  projectPack,
  type ProjectedPack,
  type ProjectedFeature,
  type Bounds,
  type ProjectPackOptions,
} from "./project-pack.js";

export {
  buildLayers,
  flattenBuildings,
  heightColor,
  type LayerStyle,
  type PolygonLayerStyle,
  type RoadLayerStyle,
  type BuildingLayerStyle,
  type LayerCtors,
  type RGBA,
  type BuildLayersTarget,
  type BuildLayersOptions,
  type ProjectedBuilding,
} from "./build-layers.js";

export {
  fitBounds,
  fitBoundsOrbit,
  buildAttribution,
  type FitTarget,
  type ViewState,
  type OrbitViewState,
  type OrbitFitOptions,
} from "./view.js";

export {
  meshesInView,
  sortMeshesNearestFirst,
  pickLod,
  decodeAndProjectMesh,
  buildPlateauBuildingTileLayer,
  type LngLatBBox,
  type MeshEntry,
  type SortMeshesNearestFirstOptions,
  type PlateauMeshIndex,
  type MeshLod,
  type MeshDraw,
  type ViewSpanInfo,
  type PickLodOptions,
  type PickLodResult,
  type DecodeMeshDeps,
  type MeshPackJson,
  type DecodeMeshOptions,
  type ProjectedMesh,
  type PlateauTileLayerCtors,
  type PlateauTileLayerTarget,
  type PlateauTileLayerOptions,
} from "./mesh-tiles.js";

export {
  buildThreeMeshGeometry,
  defaultThreeHeightColor,
  type BuildThreeMeshGeometryOptions,
  type BuildThreeMeshGeometryTarget,
  type ThreeGeometryBuildingRecord,
  type ThreeGeometryCounts,
  type ThreeGeometryRGBA,
  type ThreeMeshGeometryPayload,
} from "./three-geometry.js";
