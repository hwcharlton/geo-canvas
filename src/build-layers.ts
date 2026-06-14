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
 *   - line packs (road) → one `PathLayer`, (Multi)LineStrings flattened to paths;
 *   - building packs (3D, Phase 2) → one extruded `SolidPolygonLayer`, polygons
 *     flattened one-record-per-polygon, extruded by each feature's numeric
 *     `height` property (metres) over an `OrbitView` (`orbitAxis:"Z"`).
 *
 * The target/style maps are keyed by geo-model's {@link LayerKind} so that
 * adding a renderable layer kind is a *data* change (a new entry in the
 * per-kind treatment table below), not a change to the public API shape. The
 * kinds renderable today are admin, water, road, and `building`. The remaining
 * `LayerKind` members (coastline, rail, landuse) are typed-but-not-renderable
 * and throw a clear error if passed; they get baked + wired in Phase 2/3 when
 * those packs land.
 *
 * DI convention: `(deps, target, options?)`.
 *   deps    — `{ ctors: { GeoJsonLayer, PathLayer, SolidPolygonLayer? } }`.
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
 * Style knobs for the extruded `building` kind (3D, Phase 2). The colour ramps
 * by height for readable massing; `elevationScale` is a draw-time vertical
 * exaggeration (`1` = true metres); `wireframe` overlays edges.
 */
export interface BuildingLayerStyle {
  /** Elevation (metres) → RGBA; defaults to {@link heightColor} (a height ramp). */
  color?: (elevationMeters: number) => RGBA;
  /** Draw-time vertical exaggeration (default `1` = true metres). */
  elevationScale?: number;
  /** Overlay polygon edges (default `false`). */
  wireframe?: boolean;
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
  building: BuildingLayerStyle;
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
 *
 * `SolidPolygonLayer` is **optional**: only the 3D `building` path needs it, so
 * a host that renders only the 2D kinds (admin/water/road) need not supply it.
 * Building a `building` layer without it throws a clear error.
 */
export interface LayerCtors {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GeoJsonLayer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PathLayer: any;
  /** Required only for the extruded `building` kind (3D, Phase 2). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SolidPolygonLayer?: any;
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

/**
 * Default building height ramp (metres → RGBA): low buildings read teal, tall
 * ones warm, so a top-down or pitched view shows massing by colour. Ported from
 * the render-buildings spike (clamped at 120 m). Exported so hosts can reuse or
 * compose it; override via {@link BuildingLayerStyle.color}.
 */
export function heightColor(elevationMeters: number): RGBA {
  const t = Math.max(0, Math.min(1, elevationMeters / 120));
  const r = Math.round(60 + t * 180);
  const g = Math.round(170 - t * 90);
  const b = Math.round(150 - t * 60);
  return [r, g, b, 230];
}

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
 * A building flattened for the extruded `SolidPolygonLayer`: one record per
 * polygon (`SolidPolygonLayer` takes one ring-set per datum, so the record
 * COUNT == the layer's draw count), the projected outer ring (+ holes) in metre
 * space, the numeric height (metres) read off the source feature, and a
 * back-reference to the source feature for picking payloads.
 */
export interface ProjectedBuilding {
  /** Stable id for picking; MultiPolygon parts are suffixed `#<j>`. */
  id: string | number;
  /** Outer ring (+ optional holes) in projected metres: `Position[][]`. */
  polygon: Position[][];
  /** Extrusion height in metres (from the feature's `height` property). */
  elevation: number;
  /** The source projected feature (its `properties` carry the OSM tags). */
  src: ProjectedFeature;
}

/** Default extrusion height (metres) for a building feature missing `height`. */
const DEFAULT_BUILDING_HEIGHT = 9;

/** Read a feature's numeric `height` (metres), coercing strings; fallback 9 m. */
function featureHeight(f: ProjectedFeature): number {
  const h = f.properties.height;
  const v = typeof h === "number" ? h : Number.parseFloat(String(h));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_BUILDING_HEIGHT;
}

/**
 * Flatten a projected building pack into one {@link ProjectedBuilding} per
 * polygon (Polygon → 1; MultiPolygon → 1 per polygon, ids suffixed `#<j>` so
 * picking stays unique), each carrying its height (metres) from the feature's
 * `height` property.
 */
export function flattenBuildings(pack: ProjectedPack): ProjectedBuilding[] {
  const out: ProjectedBuilding[] = [];
  for (const f of pack.features) {
    const g = f.geometry;
    const elevation = featureHeight(f);
    const baseId = f.id ?? "building";
    if (g.type === "Polygon") {
      out.push({ id: baseId, polygon: g.coordinates as Position[][], elevation, src: f });
    } else if (g.type === "MultiPolygon") {
      const polys = g.coordinates as Position[][][];
      polys.forEach((poly, j) => {
        out.push({
          id: polys.length > 1 ? `${baseId}#${j}` : baseId,
          polygon: poly,
          elevation,
          src: f,
        });
      });
    }
  }
  return out;
}

/**
 * Flatten a building pack into an extruded `SolidPolygonLayer` (3D, Phase 2).
 *
 * Accessor shape (ported from the render-buildings spike):
 *   - `getPolygon: (d) => d.polygon`      // `Position[][]` outer+holes, metres
 *   - `getElevation: (d) => d.elevation`  // metres (the feature's `height`)
 *   - `getFillColor: (d) => color(d.elevation)`  // height ramp for massing
 *   - `extruded: true`, `filled: true`, plus a `material` for visible shading.
 *
 * Renders over an `OrbitView` (`orbitAxis:"Z"`) where Z is up; the building pack
 * must be projected with a `negateY:false` {@link Projector} (north stays +Y).
 */
function buildingLayer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SolidPolygonLayer: any,
  id: string,
  pack: ProjectedPack,
  style: BuildingLayerStyle,
  options: BuildLayersOptions,
  pickable: boolean,
): unknown {
  const colorFor = style.color ?? heightColor;
  return new SolidPolygonLayer({
    id,
    data: flattenBuildings(pack),
    pickable,
    extruded: true,
    filled: true,
    wireframe: style.wireframe ?? false,
    elevationScale: style.elevationScale ?? 1,
    getPolygon: (d: ProjectedBuilding) => d.polygon,
    getElevation: (d: ProjectedBuilding) => d.elevation,
    getFillColor: (d: ProjectedBuilding) => colorFor(d.elevation),
    material: { ambient: 0.6, diffuse: 0.6, shininess: 32 },
    onClick: options.onClick,
    onHover: options.onHover,
  });
}

/**
 * Builds the deck.gl layer for a single present {@link LayerKind}. The render
 * treatment per kind lives here so the taxonomy is data-driven: admin/water →
 * polygon GeoJsonLayer (their distinct default palettes); road → line PathLayer
 * with line flattening; building → extruded `SolidPolygonLayer` (3D). The
 * remaining kinds (coastline, rail, landuse) are typed by geo-model but not
 * baked yet — they throw a clear error rather than guess a treatment, and get
 * wired in Phase 2/3 when those packs land.
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
    case "building": {
      if (!ctors.SolidPolygonLayer)
        throw new Error(
          `geo-canvas: the "building" layer kind needs a SolidPolygonLayer ` +
            `ctor — inject one via deps.ctors.SolidPolygonLayer`,
        );
      return buildingLayer(
        ctors.SolidPolygonLayer,
        "building",
        pack,
        style.building ?? {},
        options,
        pickable,
      );
    }
    default:
      throw new Error(
        `geo-canvas: layer kind "${kind}" is typed but not yet renderable — ` +
          `bake + wire it in the phase that introduces it`,
      );
  }
}

/**
 * Draw order (bottom → top): water fills, then roads, then admin outline, then
 * extruded buildings on top — so the ward boundary reads over the 2D ground and
 * the 3D massing sits above it all. Iterating this fixed order (rather than the
 * map's key-insertion order) keeps the emitted layer sequence stable. Kinds not
 * listed here are not yet renderable; passing one throws via
 * {@link buildLayerForKind}.
 *
 * When coastline/rail/landuse land (Phase 2/3), insert them at the right
 * z-position here and add their treatment to {@link buildLayerForKind}.
 */
const RENDER_ORDER: readonly LayerKind[] = [
  "water",
  "road",
  "admin",
  "building",
];

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
