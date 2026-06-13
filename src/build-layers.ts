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
 * DI convention: `(deps, target, options?)`.
 *   deps    — `{ ctors: { GeoJsonLayer, PathLayer } }`.
 *   target  — `{ admin?, road?, water?, style? }` pre-projected packs + style.
 *   options — `{ pickable?, onClick?, onHover? }`.
 */
import type { Position } from "geojson";
import type { ProjectedFeature, ProjectedPack } from "./project-pack.js";

/** An RGBA colour, channels 0–255. */
export type RGBA = [number, number, number, number];

/** Per-layer style knobs (no labels — ADR-008). */
export interface LayerStyle {
  admin?: {
    fillColor?: RGBA;
    lineColor?: RGBA;
    lineWidthMeters?: number;
  };
  water?: {
    fillColor?: RGBA;
    lineColor?: RGBA;
    lineWidthMeters?: number;
  };
  road?: {
    /** Colour resolver by `highway` class; falls back to a default. */
    color?: (highway: string | undefined) => RGBA;
    widthMeters?: number;
  };
}

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

/** What to render: any of the projected packs plus an optional style. */
export interface BuildLayersTarget {
  admin?: ProjectedPack;
  road?: ProjectedPack;
  water?: ProjectedPack;
  style?: LayerStyle;
}

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
  style: { fillColor?: RGBA; lineColor?: RGBA; lineWidthMeters?: number },
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

/**
 * Turn pre-projected packs + a style into an ordered deck.gl layer array.
 *
 * Draw order (bottom → top): water fills, then roads, then admin outline — so
 * the ward boundary reads on top of everything.
 */
export function buildLayers(
  deps: { ctors: LayerCtors },
  target: BuildLayersTarget,
  options: BuildLayersOptions = {},
): unknown[] {
  const { GeoJsonLayer, PathLayer } = deps.ctors;
  const style = target.style ?? {};
  const layers: unknown[] = [];
  const pickable = options.pickable ?? true;

  // Water polygons at the bottom.
  if (target.water) {
    layers.push(
      polygonLayer(
        GeoJsonLayer,
        "water",
        target.water,
        style.water ?? {},
        DEFAULT_WATER_FILL,
        DEFAULT_WATER_LINE,
        options,
        pickable,
      ),
    );
  }

  // Roads in the middle (drawn under the admin stroke).
  if (target.road) {
    const roadStyle = style.road ?? {};
    const colorFor = roadStyle.color ?? (() => DEFAULT_ROAD_COLOR);
    // Flatten (Multi)LineString features into PathLayer paths, keeping a
    // back-reference to the source feature for picking.
    const paths: { path: Position[]; src: ProjectedFeature }[] = [];
    for (const f of target.road.features) {
      const g = f.geometry;
      if (g.type === "LineString")
        paths.push({ path: g.coordinates as Position[], src: f });
      else if (g.type === "MultiLineString")
        for (const line of g.coordinates as Position[][])
          paths.push({ path: line, src: f });
    }
    layers.push(
      new PathLayer({
        id: "road",
        data: paths,
        pickable,
        getPath: (d: { path: Position[] }) => d.path,
        getColor: (d: { src: ProjectedFeature }) =>
          colorFor(d.src.properties.highway as string | undefined),
        getWidth: roadStyle.widthMeters ?? 6,
        widthUnits: "meters",
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        onClick: options.onClick,
        onHover: options.onHover,
      }),
    );
  }

  // Admin polygon fill + stroke on top.
  if (target.admin) {
    layers.push(
      polygonLayer(
        GeoJsonLayer,
        "admin",
        target.admin,
        style.admin ?? {},
        DEFAULT_ADMIN_FILL,
        DEFAULT_ADMIN_LINE,
        options,
        pickable,
      ),
    );
  }

  return layers;
}
