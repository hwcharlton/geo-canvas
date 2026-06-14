/**
 * Layer builders — turn pre-projected packs + a style into an ordered deck.gl
 * layer array.
 *
 * The deck.gl layer constructors are **injected** (ADR-017): this module has no
 * hard import of `@deck.gl/layers`, so the host wires the concrete classes. That
 * keeps `geo-canvas` headless-testable (tests pass FAKE ctors that just record
 * their props) and lets the host bundle tree-shake the layers it doesn't use.
 * deck.gl is therefore a *peer* the host supplies, never a runtime dependency of
 * this package.
 *
 * Layer mapping (ADR-005/008, stylized, no labels):
 *   - polygon packs (admin, water) → one `GeoJsonLayer` each, filled + stroked;
 *   - line packs (road) → one `PathLayer`, (Multi)LineStrings flattened to paths.
 *
 * The target/style maps are keyed by geo-model's {@link LayerKind} so that
 * adding a renderable layer kind is a *data* change (a new entry in the
 * per-kind treatment table below), not a change to the public API shape. Only
 * the kinds baked today are renderable — admin, water, road. The remaining
 * `LayerKind` members (coastline, rail, landuse) are typed-but-not-renderable
 * and throw a clear error if passed; they get baked + wired in Phase 2/3 when
 * those packs land.
 *
 * DI convention: `(deps, target, options?)`.
 *   deps    — `{ ctors: { GeoJsonLayer, PathLayer } }`.
 *   target  — `Partial<Record<LayerKind, ProjectedPack>>` + optional `style`.
 *   options — `{ pickable?, onClick?, onHover? }`.
 */
import type { Position } from "geojson";
import type { LayerKind } from "@hwcharlton/geo-model";
import type { ProjectedFeature, ProjectedPack } from "./project-pack.js";

/** An RGBA colour, channels 0–255. */
export type RGBA = [number, number, number, number];

/** Style knobs for a filled+stroked polygon kind (admin, water). */
export interface PolygonLayerStyle {
  fillColor?: RGBA;
  lineColor?: RGBA;
  lineWidthMeters?: number;
}

/** Style knobs for a line kind (road). */
export interface RoadLayerStyle {
  /** Colour resolver by `highway` class; falls back to a default. */
  color?: (highway: string | undefined) => RGBA;
  widthMeters?: number;
}

/**
 * Maps each {@link LayerKind} to the shape of style knobs it accepts. Polygon
 * kinds take {@link PolygonLayerStyle}; `road` takes {@link RoadLayerStyle}.
 * Kinds not yet renderable still carry a style slot so the map stays uniform.
 */
interface LayerStyleByKind {
  admin: PolygonLayerStyle;
  water: PolygonLayerStyle;
  road: RoadLayerStyle;
  coastline: PolygonLayerStyle;
  rail: RoadLayerStyle;
  landuse: PolygonLayerStyle;
}

/**
 * Per-layer style knobs (no labels — ADR-008), keyed by {@link LayerKind}.
 *
 * Backward-compatible with the previous hard-coded shape: `style.admin` /
 * `style.water` are {@link PolygonLayerStyle}, `style.road` is
 * {@link RoadLayerStyle}.
 */
export type LayerStyle = Partial<LayerStyleByKind>;

/**
 * The deck.gl layer constructors the host injects. Typed as `any` because the
 * concrete deck.gl classes are a host concern and are never imported here; the
 * tests substitute fakes with the same call shape.
 */
export interface LayerCtors {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GeoJsonLayer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PathLayer: any;
}

/**
 * What to render: a {@link LayerKind}-keyed map of projected packs plus an
 * optional style. Adding a kind is a data change, not an API-shape change.
 *
 * Backward-compatible with the previous hard-coded shape: a caller passing
 * `{ admin, road, water }` still typechecks and renders identically.
 */
export type BuildLayersTarget = Partial<Record<LayerKind, ProjectedPack>> & {
  style?: LayerStyle;
};

/** View/picking options for {@link buildLayers}. */
export interface BuildLayersOptions {
  pickable?: boolean;
  onClick?: (info: unknown) => void;
  onHover?: (info: unknown) => void;
}

// Default styling — stylized, label-free (ADR-008).
const DEFAULT_ADMIN_FILL: RGBA = [38, 139, 210, 36];
const DEFAULT_ADMIN_LINE: RGBA = [38, 139, 210, 235];
const DEFAULT_WATER_FILL: RGBA = [40, 110, 160, 90];
const DEFAULT_WATER_LINE: RGBA = [40, 110, 160, 180];
const DEFAULT_ROAD_COLOR: RGBA = [120, 120, 130, 200];

/** Flatten a polygon pack into a GeoJsonLayer (filled + stroked). */
function polygonLayer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GeoJsonLayer: any,
  id: string,
  pack: ProjectedPack,
  style: PolygonLayerStyle,
  fill: RGBA,
  line: RGBA,
  options: BuildLayersOptions,
  pickable: boolean,
): unknown {
  return new GeoJsonLayer({
    id,
    data: { type: "FeatureCollection", features: pack.features },
    pickable,
    filled: true,
    stroked: true,
    getFillColor: style.fillColor ?? fill,
    getLineColor: style.lineColor ?? line,
    getLineWidth: style.lineWidthMeters ?? 12,
    lineWidthUnits: "meters",
    lineWidthMinPixels: 2,
    onClick: options.onClick,
    onHover: options.onHover,
  });
}

/** Flatten a line pack into a PathLayer ((Multi)LineStrings → paths). */
function roadLayer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PathLayer: any,
  id: string,
  pack: ProjectedPack,
  style: RoadLayerStyle,
  options: BuildLayersOptions,
  pickable: boolean,
): unknown {
  const colorFor = style.color ?? (() => DEFAULT_ROAD_COLOR);
  // Flatten (Multi)LineString features into PathLayer paths, keeping a
  // back-reference to the source feature for picking.
  const paths: { path: Position[]; src: ProjectedFeature }[] = [];
  for (const f of pack.features) {
    const g = f.geometry;
    if (g.type === "LineString")
      paths.push({ path: g.coordinates as Position[], src: f });
    else if (g.type === "MultiLineString")
      for (const line of g.coordinates as Position[][])
        paths.push({ path: line, src: f });
  }
  return new PathLayer({
    id,
    data: paths,
    pickable,
    getPath: (d: { path: Position[] }) => d.path,
    getColor: (d: { src: ProjectedFeature }) =>
      colorFor(d.src.properties.highway as string | undefined),
    getWidth: style.widthMeters ?? 6,
    widthUnits: "meters",
    widthMinPixels: 1,
    capRounded: true,
    jointRounded: true,
    onClick: options.onClick,
    onHover: options.onHover,
  });
}

/**
 * Builds the deck.gl layer for a single present {@link LayerKind}. The render
 * treatment per kind lives here so the taxonomy is data-driven: admin/water →
 * polygon GeoJsonLayer (their distinct default palettes); road → line PathLayer
 * with line flattening. The remaining kinds (coastline, rail, landuse) are
 * typed by geo-model but not baked yet — they throw a clear error rather than
 * guess a treatment, and get wired in Phase 2/3 when those packs land.
 */
function buildLayerForKind(
  kind: LayerKind,
  pack: ProjectedPack,
  ctors: LayerCtors,
  style: LayerStyle,
  options: BuildLayersOptions,
  pickable: boolean,
): unknown {
  switch (kind) {
    case "admin":
      return polygonLayer(
        ctors.GeoJsonLayer,
        "admin",
        pack,
        style.admin ?? {},
        DEFAULT_ADMIN_FILL,
        DEFAULT_ADMIN_LINE,
        options,
        pickable,
      );
    case "water":
      return polygonLayer(
        ctors.GeoJsonLayer,
        "water",
        pack,
        style.water ?? {},
        DEFAULT_WATER_FILL,
        DEFAULT_WATER_LINE,
        options,
        pickable,
      );
    case "road":
      return roadLayer(
        ctors.PathLayer,
        "road",
        pack,
        style.road ?? {},
        options,
        pickable,
      );
    default:
      throw new Error(
        `geo-canvas: layer kind "${kind}" is typed but not yet renderable — ` +
          `bake + wire it in the phase that introduces it`,
      );
  }
}

/**
 * Draw order (bottom → top): water fills, then roads, then admin outline — so
 * the ward boundary reads on top of everything. Iterating this fixed order
 * (rather than the map's key-insertion order) keeps the emitted layer sequence
 * stable. Kinds not listed here are not yet renderable; passing one throws via
 * {@link buildLayerForKind}.
 *
 * When coastline/rail/landuse land (Phase 2/3), insert them at the right
 * z-position here and add their treatment to {@link buildLayerForKind}.
 */
const RENDER_ORDER: readonly LayerKind[] = ["water", "road", "admin"];

/**
 * Turn pre-projected packs + a style into an ordered deck.gl layer array.
 *
 * Data-driven: iterates the layer kinds PRESENT in `target` (in the fixed
 * {@link RENDER_ORDER} z-order) and builds each via {@link buildLayerForKind}.
 */
export function buildLayers(
  deps: { ctors: LayerCtors },
  target: BuildLayersTarget,
  options: BuildLayersOptions = {},
): unknown[] {
  const style = target.style ?? {};
  const layers: unknown[] = [];
  const pickable = options.pickable ?? true;

  // Render kinds known to RENDER_ORDER first, in z-order.
  for (const kind of RENDER_ORDER) {
    const pack = target[kind];
    if (pack)
      layers.push(
        buildLayerForKind(kind, pack, deps.ctors, style, options, pickable),
      );
  }

  // Any other PRESENT layer kind (e.g. a kind added to geo-model but not yet
  // placed in RENDER_ORDER) is data-driven too: build it via the treatment
  // table, which throws for not-yet-renderable kinds rather than dropping them.
  for (const key of Object.keys(target) as (keyof BuildLayersTarget)[]) {
    if (key === "style") continue;
    const kind = key as LayerKind;
    if (RENDER_ORDER.includes(kind)) continue;
    const pack = target[kind];
    if (pack)
      layers.push(
        buildLayerForKind(kind, pack, deps.ctors, style, options, pickable),
      );
  }

  return layers;
}
