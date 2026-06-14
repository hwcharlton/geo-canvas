/**
 * 3D building-extrusion path (Phase 2): the `negateY:false` orbit projector, the
 * extruded `building` layer built via an INJECTED fake `SolidPolygonLayer` ctor,
 * and `fitBoundsOrbit`.
 *
 * deck.gl is never imported by `geo-canvas`; the host injects the layer ctors
 * (ADR-017). Here the fake `SolidPolygonLayer` records the props it is
 * constructed with, so we can assert the extruded accessor shape
 * (`extruded`/`getElevation`/`getPolygon`/`getFillColor`) headless — no GPU.
 *
 * The projection is REAL (`@hwcharlton/geo-model`'s `toPlanar`); building
 * geometry is a small synthetic WGS84 FeatureCollection carrying numeric
 * `height` props (no baked building pack ships yet), decoded straight into the
 * `DecodedPack` shape so the assertions run through the genuine `projectPack` +
 * `buildLayers` pipeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlanar } from "@hwcharlton/geo-model";
import type { DecodedPack, PackRef } from "@hwcharlton/geo-client";
import {
  makeProjector,
  projectPack,
  buildLayers,
  fitBoundsOrbit,
  flattenBuildings,
  heightColor,
  type ProjectedBuilding,
  type ProjectedPack,
  type RGBA,
} from "../src/index.js";

const BUILDINGS_REF: PackRef = {
  ward: "shibuya",
  layer: "building",
  detail: "high",
};

/** Two WGS84 buildings near Shibuya: a Polygon (h=40) + a MultiPolygon (h=120). */
function syntheticBuildingPack(): DecodedPack {
  const collection: DecodedPack["collection"] = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { building: "yes", height: 40, name: "Tower A" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [139.7, 35.66],
              [139.7008, 35.66],
              [139.7008, 35.6606],
              [139.7, 35.6606],
              [139.7, 35.66],
            ],
          ],
        },
      },
      {
        type: "Feature",
        // height as a STRING (OSM tags are strings) → coerced to 120.
        properties: { building: "office", height: "120" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [139.702, 35.661],
                [139.7026, 35.661],
                [139.7026, 35.6615],
                [139.702, 35.6615],
                [139.702, 35.661],
              ],
            ],
            [
              [
                [139.703, 35.662],
                [139.7034, 35.662],
                [139.7034, 35.6623],
                [139.703, 35.6623],
                [139.703, 35.662],
              ],
            ],
          ],
        },
      },
      {
        type: "Feature",
        // No height tag → default fallback (9 m).
        properties: { building: "house" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [139.704, 35.663],
              [139.7043, 35.663],
              [139.7043, 35.6632],
              [139.704, 35.6632],
              [139.704, 35.663],
            ],
          ],
        },
      },
    ],
  };
  return {
    ref: BUILDINGS_REF,
    collection,
    attribution: "© OpenStreetMap contributors",
    objectName: "shibuya-building",
    featureCount: collection.features.length,
  };
}

/** Project the synthetic pack with the ORBIT projector (north +Y, no negation). */
function projectedOrbitBuildings(): ProjectedPack {
  const projector = makeProjector({}, { negateY: false });
  return projectPack({ projector }, syntheticBuildingPack());
}

/** A fake injected `SolidPolygonLayer` ctor that records its props. */
function fakeBuildingCtors(sink: Record<string, unknown>[]): {
  ctors: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    GeoJsonLayer: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PathLayer: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SolidPolygonLayer: any;
  };
} {
  class GeoJsonLayer {
    constructor(props: Record<string, unknown>) {
      sink.push({ type: "GeoJsonLayer", ...props });
    }
  }
  class PathLayer {
    constructor(props: Record<string, unknown>) {
      sink.push({ type: "PathLayer", ...props });
    }
  }
  class SolidPolygonLayer {
    constructor(props: Record<string, unknown>) {
      sink.push({ type: "SolidPolygonLayer", ...props });
    }
  }
  return { ctors: { GeoJsonLayer, PathLayer, SolidPolygonLayer } };
}

// --- projector axis ---------------------------------------------------------

test("makeProjector({ negateY:false }) keeps north +Y on the ground plane", () => {
  const orbit = makeProjector({}, { negateY: false });
  const ortho = makeProjector(); // default negateY:true
  const lonlat: [number, number] = [139.7, 35.66];

  const [ox, oy] = orbit.forward(lonlat);
  const [px, py] = toPlanar(lonlat);

  // Orbit projector === toPlanar, NO Y negation (north stays +Y).
  assert.equal(ox, px);
  assert.equal(oy, py);

  // Default (ortho) projector negates Y, so the two disagree on the Y sign.
  const [, ty] = ortho.forward(lonlat);
  assert.equal(ty, -py);
  assert.equal(oy, -ty);

  // Going further north must INCREASE the orbit Y (north = +Y on the ground).
  const [, oyNorth] = orbit.forward([139.7, 35.67]);
  assert.ok(oyNorth > oy, "more-northern point should have larger +Y");
});

// --- height carried to Z (elevation) ---------------------------------------

test("flattenBuildings carries each feature's height → Z and flattens MultiPolygon", () => {
  const projected = projectedOrbitBuildings();
  const buildings = flattenBuildings(projected);

  // Polygon → 1 record; MultiPolygon(2) → 2 records; Polygon → 1 record = 4.
  assert.equal(buildings.length, 4);

  // Heights carried through (number, coerced string, and default fallback).
  const elevations = buildings.map((b) => b.elevation);
  assert.ok(elevations.includes(40), "numeric height 40 carried");
  assert.equal(
    elevations.filter((e) => e === 120).length,
    2,
    "string height '120' coerced + applied to both MultiPolygon parts",
  );
  assert.ok(elevations.includes(9), "missing height → 9 m default");

  // MultiPolygon parts get suffixed ids so picking stays unique.
  const mp = buildings.filter((b) => b.elevation === 120);
  assert.equal(mp[0]!.id, "building:1#0");
  assert.equal(mp[1]!.id, "building:1#1");

  // Polygons are projected metres (not degrees) and carry the source feature.
  const first = buildings[0]!;
  const [x, y] = first.polygon[0]![0]!;
  assert.ok(Math.abs(x!) > 100 || Math.abs(y!) > 100, "metres, not degrees");
  assert.equal(first.src.properties.building, "yes");
});

// --- extruded layer via injected fake ctor ---------------------------------

test("buildLayers builds an extruded SolidPolygonLayer from a building pack", () => {
  const building = projectedOrbitBuildings();
  const sink: Record<string, unknown>[] = [];

  const layers = buildLayers(
    fakeBuildingCtors(sink),
    { building },
    { pickable: true },
  );

  assert.equal(layers.length, 1);
  const rec = sink.find((r) => r.type === "SolidPolygonLayer");
  assert.ok(rec, "expected a SolidPolygonLayer to be constructed");

  // The extruded massing props the spike proved.
  assert.equal(rec.id, "building");
  assert.equal(rec.pickable, true);
  assert.equal(rec.extruded, true);
  assert.equal(rec.filled, true);
  assert.equal(rec.elevationScale, 1);
  assert.ok(rec.material, "a material is set for visible shading");

  // Accessors: getPolygon → the ring-set, getElevation → metres, getFillColor →
  // a height-ramp RGBA.
  const data = rec.data as ProjectedBuilding[];
  assert.equal(data.length, 4);
  const sample = data.find((d) => d.elevation === 40)!;
  assert.equal(
    (rec.getPolygon as (d: ProjectedBuilding) => unknown)(sample),
    sample.polygon,
  );
  assert.equal(
    (rec.getElevation as (d: ProjectedBuilding) => number)(sample),
    40,
  );
  const color = (rec.getFillColor as (d: ProjectedBuilding) => RGBA)(sample);
  assert.ok(Array.isArray(color) && color.length === 4);
  assert.deepEqual(color, heightColor(40));
});

test("buildLayers honours a custom building style + pickable:false", () => {
  const building = projectedOrbitBuildings();
  const sink: Record<string, unknown>[] = [];
  const color = (h: number): RGBA => [h, 0, 0, 255];

  buildLayers(
    fakeBuildingCtors(sink),
    {
      building,
      style: { building: { color, elevationScale: 2, wireframe: true } },
    },
    { pickable: false },
  );

  const rec = sink.find((r) => r.type === "SolidPolygonLayer")!;
  assert.equal(rec.pickable, false);
  assert.equal(rec.elevationScale, 2);
  assert.equal(rec.wireframe, true);
  const sample = (rec.data as ProjectedBuilding[]).find(
    (d) => d.elevation === 40,
  )!;
  assert.deepEqual(
    (rec.getFillColor as (d: ProjectedBuilding) => RGBA)(sample),
    [40, 0, 0, 255],
  );
});

test("buildLayers throws a clear error when no SolidPolygonLayer ctor is injected", () => {
  const building = projectedOrbitBuildings();
  // Ctors WITHOUT a SolidPolygonLayer (the 2D-only host case).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctors = { ctors: { GeoJsonLayer: class {}, PathLayer: class {} } as any };
  assert.throws(
    () => buildLayers(ctors, { building }),
    /SolidPolygonLayer/,
    "should name the missing ctor",
  );
});

// --- orbit view fit ---------------------------------------------------------

test("fitBoundsOrbit returns a sane OrbitView state with default pitch", () => {
  const building = projectedOrbitBuildings();
  const view = fitBoundsOrbit(building.bounds, {
    width: 1280,
    height: 800,
    padding: 0.85,
  });

  // target sits on the ground plane (z = 0) at the bounds centre.
  const [tx, ty, tz] = view.target;
  const [minX, minY, maxX, maxY] = building.bounds;
  assert.ok(Math.abs(tx - (minX + maxX) / 2) < 1e-6);
  assert.ok(Math.abs(ty - (minY + maxY) / 2) < 1e-6);
  assert.equal(tz, 0);

  // Finite zoom + the camera angles that reveal extrusion.
  assert.ok(Number.isFinite(view.zoom));
  assert.equal(view.rotationX, 50); // default ~50° pitch
  assert.equal(view.rotationOrbit, 0);
  assert.equal(view.minZoom, view.zoom - 4);
  assert.equal(view.maxZoom, view.zoom + 8);
});

test("fitBoundsOrbit honours custom pitch/yaw", () => {
  const view = fitBoundsOrbit(
    [0, 0, 1000, 1000],
    { width: 800, height: 800 },
    { rotationX: 35, rotationOrbit: 90 },
  );
  assert.equal(view.rotationX, 35);
  assert.equal(view.rotationOrbit, 90);
  assert.equal(view.target[0], 500);
  assert.equal(view.target[1], 500);
});
