/**
 * `projectPack` — pre-project a decoded pack's GeoJSON FeatureCollection into
 * EPSG:6677 screen-plane metres, compute axis-aligned bounds, and assign stable
 * synthetic feature ids for picking.
 *
 * The decoded pack comes from `@hwcharlton/geo-client`'s `decodePack`
 * ({@link DecodedPack}); its `collection.features` carry WGS84 `[lon, lat]`
 * coordinates. After `projectPack` every coordinate is in projected metres
 * (Y already negated by the {@link Projector}), ready to hand straight to
 * deck.gl over an `OrthographicView`.
 *
 * Source packs carry no feature ids (ADR-017), so each feature is assigned a
 * stable synthetic id `'<layer>:<index>'` for picking — unless it already has
 * one, which is preserved.
 *
 * DI convention: `(deps, target, options?)`.
 *   deps    — the injected {@link Projector}.
 *   target  — the {@link DecodedPack} to project.
 *   options — optional knobs ({@link ProjectPackOptions}); `idPrefix` overrides
 *             the synthetic-id prefix.
 */
import type { Feature, Geometry, Position } from "geojson";
import type { DecodedPack } from "@hwcharlton/geo-client";
import type { Projector } from "./projector.js";

/** A GeoJSON feature whose coordinates are already in projected metres. */
export type ProjectedFeature = Feature<Geometry, Record<string, unknown>>;

/** Axis-aligned bounds in projected screen-plane metres: `[minX, minY, maxX, maxY]`. */
export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

/** A pre-projected pack: projected features + their bounds + attribution. */
export interface ProjectedPack {
  /** The source pack ref (provenance pass-through / cache key). */
  ref: DecodedPack["ref"];
  /** Features with every coordinate pre-projected to EPSG:6677 metres. */
  features: ProjectedFeature[];
  /** Source attribution line, carried through from the decoded pack. */
  attribution: string;
  /** Axis-aligned bounds in projected metres: `[minX, minY, maxX, maxY]`. */
  bounds: Bounds;
}

/** Optional knobs for {@link projectPack} (currently the `idPrefix` override). */
export interface ProjectPackOptions {
  /** Override the synthetic-id prefix (defaults to the pack's `ref.layer`). */
  idPrefix?: string;
}

function projectPositions(coords: Position[], p: Projector): Position[] {
  return coords.map((c) => p.forward([c[0]!, c[1]!]));
}

/** Deep-project a GeoJSON geometry's coordinates into metre space (returns new). */
function projectGeometry(geom: Geometry, p: Projector): Geometry {
  switch (geom.type) {
    case "Point":
      return {
        ...geom,
        coordinates: p.forward(geom.coordinates as [number, number]),
      };
    case "LineString":
    case "MultiPoint":
      return {
        ...geom,
        coordinates: projectPositions(geom.coordinates as Position[], p),
      };
    case "Polygon":
    case "MultiLineString":
      return {
        ...geom,
        coordinates: (geom.coordinates as Position[][]).map((r) =>
          projectPositions(r, p),
        ),
      };
    case "MultiPolygon":
      return {
        ...geom,
        coordinates: (geom.coordinates as Position[][][]).map((poly) =>
          poly.map((r) => projectPositions(r, p)),
        ),
      };
    case "GeometryCollection":
      return {
        ...geom,
        geometries: geom.geometries.map((g) => projectGeometry(g, p)),
      };
    default:
      return geom;
  }
}

/**
 * Pre-project every coordinate of a decoded pack into EPSG:6677 metre space,
 * compute the bounds, and assign stable synthetic ids.
 */
export function projectPack(
  deps: { projector: Projector },
  target: DecodedPack,
  options: ProjectPackOptions = {},
): ProjectedPack {
  const prefix = options.idPrefix ?? target.ref.layer;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Walk every emitted coordinate to grow the bounds.
  const visit = (coords: unknown): void => {
    if (typeof (coords as number[])[0] === "number") {
      const [x, y] = coords as number[];
      if (x! < minX) minX = x!;
      if (y! < minY) minY = y!;
      if (x! > maxX) maxX = x!;
      if (y! > maxY) maxY = y!;
    } else {
      for (const c of coords as unknown[]) visit(c);
    }
  };

  const features: ProjectedFeature[] = target.collection.features.map((f, i) => {
    const geometry = projectGeometry(f.geometry, deps.projector);
    if (geometry && "coordinates" in geometry) visit(geometry.coordinates);
    else if (geometry && geometry.type === "GeometryCollection") {
      for (const g of geometry.geometries)
        if ("coordinates" in g) visit(g.coordinates);
    }
    return {
      ...f,
      // Stable synthetic id for picking when source packs lack feature ids.
      id: f.id ?? `${prefix}:${i}`,
      geometry,
    };
  });

  // Guard: a pack with no visitable coordinates would leave the bounds at their
  // ±Infinity seed values; fall back to a degenerate origin box so consumers
  // always receive finite numbers (the contract promises finite bounds).
  const bounds: Bounds = Number.isFinite(minX)
    ? [minX, minY, maxX, maxY]
    : [0, 0, 0, 0];

  return {
    ref: target.ref,
    features,
    attribution: target.attribution,
    bounds,
  };
}
