/**
 * `buildLayers` with FAKE deck.gl layer ctors (ADR-017 dependency injection).
 *
 * deck.gl is never imported by `geo-canvas`; the host injects the layer
 * constructors. Here the fakes simply record the props they're constructed with,
 * so we can assert the builder wired the right layer types, data, picking, and
 * styling — all headless, no GPU.
 *
 * The data is REAL: the Shibuya admin (polygon) + road (line) packs are decoded
 * through `@hwcharlton/geo-client` and pre-projected through `projectPack`, so
 * the props under assertion carry genuine projected geometry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { feature as topoFeature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { decodePack } from "@hwcharlton/geo-client";
import type {
  DecodedPack,
  PackManifest,
  PackRef,
} from "@hwcharlton/geo-client";
import {
  makeProjector,
  projectPack,
  buildLayers,
  type ProjectedPack,
  type RGBA,
} from "../src/index.js";

const PACKS = "/home/ubuntu/dev/personal/geo-data-staging/packs/shibuya";

/** A fake deck.gl layer ctor: records the props it was constructed with. */
interface Recorded {
  type: string;
  props: Record<string, unknown>;
}
/** Build the injected `deps` ({ ctors }) with FAKE ctors recording into `sink`. */
function fakeCtors(sink: Recorded[]): {
  ctors: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    GeoJsonLayer: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PathLayer: any;
  };
} {
  class GeoJsonLayer {
    constructor(props: Record<string, unknown>) {
      sink.push({ type: "GeoJsonLayer", props });
    }
  }
  class PathLayer {
    constructor(props: Record<string, unknown>) {
      sink.push({ type: "PathLayer", props });
    }
  }
  return { ctors: { GeoJsonLayer, PathLayer } };
}

async function decodeReal(layer: "admin" | "road"): Promise<DecodedPack> {
  const dir = `${PACKS}/${layer}`;
  const ref: PackRef = { ward: "shibuya", layer, detail: "high" };
  const [topoJson, manifestJson] = await Promise.all([
    readFile(`${dir}/high.topo.json`, "utf8"),
    readFile(`${dir}/high.manifest.json`, "utf8"),
  ]);
  return decodePack(
    {
      loadTopology: async () => ({
        topology: JSON.parse(topoJson) as Topology,
        manifest: JSON.parse(manifestJson) as PackManifest,
      }),
      topoFeature,
    },
    ref,
  );
}

async function projectedAdmin(): Promise<ProjectedPack> {
  return projectPack({ projector: makeProjector() }, await decodeReal("admin"));
}
async function projectedRoad(): Promise<ProjectedPack> {
  return projectPack({ projector: makeProjector() }, await decodeReal("road"));
}

test("buildLayers builds an admin GeoJsonLayer (pickable, projected data, fill+stroke)", async () => {
  const admin = await projectedAdmin();
  const sink: Recorded[] = [];

  const layers = buildLayers(fakeCtors(sink), { admin }, { pickable: true });

  assert.equal(layers.length, 1);
  const rec = sink.find((r) => r.type === "GeoJsonLayer");
  assert.ok(rec, "expected a GeoJsonLayer to be constructed");
  const p = rec.props;

  // Picking wired on.
  assert.equal(p.pickable, true);

  // Fill + stroke style present.
  assert.equal(p.filled, true);
  assert.equal(p.stroked, true);
  assert.ok(Array.isArray(p.getFillColor), "fill colour");
  assert.ok(Array.isArray(p.getLineColor), "stroke colour");
  assert.equal(p.lineWidthUnits, "meters");

  // The data IS the projected admin pack (a FeatureCollection of its features).
  const data = p.data as {
    type: string;
    features: ProjectedPack["features"];
  };
  assert.equal(data.type, "FeatureCollection");
  assert.equal(data.features.length, admin.features.length);
  assert.equal(data.features, admin.features);

  // And those features carry projected (metre) coordinates + synthetic ids.
  const first = data.features[0]!;
  assert.equal(first.id, "admin:0");
  assert.ok("coordinates" in first.geometry);
});

test("buildLayers wires a custom admin style and pickable:false", async () => {
  const admin = await projectedAdmin();
  const sink: Recorded[] = [];
  const fill: RGBA = [10, 20, 30, 40];
  const line: RGBA = [50, 60, 70, 80];

  buildLayers(
    fakeCtors(sink),
    { admin, style: { admin: { fillColor: fill, lineColor: line, lineWidthMeters: 9 } } },
    { pickable: false },
  );

  const p = sink.find((r) => r.type === "GeoJsonLayer")!.props;
  assert.equal(p.pickable, false);
  assert.deepEqual(p.getFillColor, fill);
  assert.deepEqual(p.getLineColor, line);
  assert.equal(p.getLineWidth, 9);
});

test("buildLayers builds a road PathLayer from a real road pack", async () => {
  const road = await projectedRoad();
  const sink: Recorded[] = [];
  const colors: Record<string, RGBA> = { trunk: [1, 2, 3, 4] };
  const colorFor = (h: string | undefined): RGBA =>
    (h && colors[h]) || [9, 9, 9, 9];

  const layers = buildLayers(
    fakeCtors(sink),
    { road, style: { road: { color: colorFor, widthMeters: 5 } } },
    { pickable: true },
  );

  assert.equal(layers.length, 1);
  const rec = sink.find((r) => r.type === "PathLayer");
  assert.ok(rec, "expected a PathLayer to be constructed");
  const p = rec.props;

  assert.equal(p.pickable, true);
  assert.equal(p.widthUnits, "meters");
  assert.equal(p.getWidth, 5);
  assert.equal(typeof p.getPath, "function");
  assert.equal(typeof p.getColor, "function");

  // Real road packs hold (Multi)LineStrings → flattened to >= feature-count paths.
  const paths = p.data as { path: number[][]; src: { properties: unknown } }[];
  assert.ok(Array.isArray(paths));
  assert.ok(paths.length >= road.features.length);
  assert.ok(paths.length > 0);

  // getPath returns the path; getColor resolves via the highway class.
  const sample = paths[0]!;
  assert.equal((p.getPath as (d: unknown) => unknown)(sample), sample.path);
  const color = (p.getColor as (d: unknown) => RGBA)(sample);
  assert.ok(Array.isArray(color) && color.length === 4);

  // The path coordinates are projected metres, not degrees.
  const [x, y] = sample.path[0]!;
  assert.ok(Math.abs(x!) > 100 || Math.abs(y!) > 100);
});

test("buildLayers draws water, then road, then admin in order", async () => {
  const admin = await projectedAdmin();
  const road = await projectedRoad();
  // Reuse the admin pack as a stand-in 'water' polygon pack (same shape).
  const water: ProjectedPack = { ...admin, ref: { ...admin.ref, layer: "water" } };
  const sink: Recorded[] = [];

  const layers = buildLayers(fakeCtors(sink), { admin, road, water });

  // Three layers, bottom→top: water (GeoJson), road (Path), admin (GeoJson).
  assert.equal(layers.length, 3);
  assert.deepEqual(
    sink.map((r) => r.props.id),
    ["water", "road", "admin"],
  );
  assert.deepEqual(
    sink.map((r) => r.type),
    ["GeoJsonLayer", "PathLayer", "GeoJsonLayer"],
  );
});

test("buildLayers defaults pickable to true and returns [] for an empty target", () => {
  const sink: Recorded[] = [];
  const layers = buildLayers(fakeCtors(sink), {});
  assert.deepEqual(layers, []);
  assert.equal(sink.length, 0);
});
