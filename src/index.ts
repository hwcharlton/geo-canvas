/**
 * `@hwcharlton/geo-canvas` — browser-facing deck.gl layer builders for the
 * @hwcharlton geo-data ecosystem.
 *
 * Responsibility (ADR-005/008/011/017): take a decoded TopoJSON area pack from
 * `@hwcharlton/geo-client`, **pre-project** every coordinate to EPSG:6677
 * (JGD2011 Japan Plane Rectangular CS IX) metres using `@hwcharlton/geo-model`'s
 * projection (Y negated for north-up), and build the deck.gl layers to draw it
 * over a plain `OrthographicView` in projected-metre space — no geo basemap, no
 * `MapView`, no labels.
 *
 * Two deliberate seams keep this package pure and headless-testable:
 *   1. The **projection** comes from geo-model (closed-form, deps-free) — there
 *      is **no proj4 dependency**. `makeProjector` wraps `toPlanar`; by default
 *      it negates Y so screen-up == north under an `OrthographicView`, and with
 *      `{ negateY: false }` it leaves north at +Y for the 3D `OrbitView` ground
 *      plane (Z = building height).
 *   2. The **deck.gl layer constructors are injected** (ADR-017) — `geo-canvas`
 *      never imports `@deck.gl/layers`, so deck.gl is a host-supplied peer, not
 *      a runtime dependency. Tests pass fake ctors that record their props.
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
