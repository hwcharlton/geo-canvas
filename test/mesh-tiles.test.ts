/**
 * Stage-2 PLATEAU render-budget tier (ADR-021): viewport culling
 * ({@link meshesInView}), LOD + poly budgeting ({@link pickLod}), worker-safe
 * decode+project ({@link decodeAndProjectMesh}), and the injected-ctor deck.gl
 * building layer factory ({@link buildPlateauBuildingTileLayer}).
 *
 * No browser, no GPU: the deck.gl ctors are FAKES that record their props
 * (ADR-017). The decode path is REAL — it runs the genuine `topojson-client`
 * `feature()` + `projectPack` + `flattenBuildings` over a topology BUILT FROM
 * the real PLATEAU sample on disk (`geo-spikes/plateau-stage2/sample/*.geojsonl`,
 * real lon/lat footprints + real `measuredHeight` metres), so the bake→decode
 * round-trip and height survival are exercised against authentic data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { feature as topoFeature } from "topojson-client";
import {
  meshesInView,
  pickLod,
  decodeAndProjectMesh,
  buildPlateauBuildingTileLayer,
  type PlateauMeshIndex,
  type MeshEntry,
  type MeshPackJson,
  type LngLatBBox,
  type ProjectedBuilding,
} from "../src/index.js";

const SAMPLE_DIR = "/home/ubuntu/dev/personal/geo-spikes/plateau-stage2/sample";

// --- real-sample → hand-built TopoJSON --------------------------------------

interface GeojsonlFeature {
  properties: { height: number | null; source: string; id: string };
  geometry: { type: "Polygon"; coordinates: number[][][] };
}

/** Read the first `n` features of a `<mesh>.geojsonl` sample file. */
function readSample(mesh: string, n: number): GeojsonlFeature[] {
  const text = readFileSync(`${SAMPLE_DIR}/${mesh}.geojsonl`, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .slice(0, n)
    .map((l) => JSON.parse(l) as GeojsonlFeature);
}

/**
 * Build a single-object TopoJSON `Topology` from real sample features — one arc
 * per outer ring (no shared-arc quantization; faithful enough to exercise the
 * decode pipeline against authentic PLATEAU coords + heights). Mirrors the
 * `<mesh>-building` single-object shape the baked packs ship.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTopology(mesh: string, feats: GeojsonlFeature[]): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arcs: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const geometries = feats.map((f) => {
    const outer = f.geometry.coordinates[0]!;
    const arcIndex = arcs.length;
    arcs.push(outer);
    return {
      type: "Polygon",
      arcs: [[arcIndex]],
      properties: f.properties,
    };
  });
  return {
    type: "Topology",
    arcs,
    objects: { [`${mesh}-building`]: { type: "GeometryCollection", geometries } },
  };
}

/** A {@link MeshPackJson} for `decodeAndProjectMesh` built from the real sample. */
function samplePackJson(mesh: string, n: number): MeshPackJson {
  const feats = readSample(mesh, n);
  return {
    topology: buildTopology(mesh, feats),
    mesh,
    attribution: "出典：国土交通省 PLATEAU（加工して作成）",
  };
}

// --- a small synthetic index (3 meshes, known bboxes + counts) --------------

/**
 * Three adjacent mesh cells on a row. Bboxes are deliberately simple so the
 * culling math is checkable by hand; counts drive the budget tests.
 */
const INDEX: PlateauMeshIndex = {
  tier: "plateau-building",
  meshes: [
    { mesh: "A", bbox: [139.0, 35.0, 139.1, 35.1], pack: "plateau/A/building/flat.topo.json.br", count: 30_000 },
    { mesh: "B", bbox: [139.1, 35.0, 139.2, 35.1], pack: "plateau/B/building/flat.topo.json.br", count: 50_000 },
    { mesh: "C", bbox: [139.2, 35.0, 139.3, 35.1], pack: "plateau/C/building/flat.topo.json.br", count: 40_000 },
  ],
};

// --- fake injected ctors ----------------------------------------------------

/** A fake `SolidPolygonLayer` that records constructed props. */
function fakeCtors(sink: Record<string, unknown>[]): {
  ctors: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SolidPolygonLayer: any;
  };
} {
  class SolidPolygonLayer {
    constructor(props: Record<string, unknown>) {
      sink.push({ type: "SolidPolygonLayer", ...props });
    }
  }
  return { ctors: { SolidPolygonLayer } };
}

// ===========================================================================
// 1. meshesInView — viewport culling
// ===========================================================================

test("meshesInView returns only meshes whose bbox intersects the view", () => {
  // A view over meshes A and B only (139.05..139.15) — C (139.2+) is off-view.
  const view: LngLatBBox = [139.05, 35.02, 139.15, 35.08];
  const got = meshesInView({}, INDEX, { viewBoundsLngLat: view });
  assert.deepEqual(
    got.map((m) => m.mesh),
    ["A", "B"],
  );
});

test("meshesInView excludes meshes fully off the view (no false positives)", () => {
  // A tight view inside mesh C only.
  const view: LngLatBBox = [139.22, 35.04, 139.28, 35.06];
  const got = meshesInView({}, INDEX, { viewBoundsLngLat: view });
  assert.deepEqual(
    got.map((m) => m.mesh),
    ["C"],
  );
  // A view entirely SOUTH of every mesh → empty.
  const south: LngLatBBox = [139.0, 34.0, 139.3, 34.5];
  assert.equal(meshesInView({}, INDEX, { viewBoundsLngLat: south }).length, 0);
});

test("meshesInView keeps an edge-touching mesh (inclusive AABB overlap)", () => {
  // View ends exactly on the A|B shared edge (139.1) → both touch it.
  const view: LngLatBBox = [139.05, 35.02, 139.1, 35.08];
  const got = meshesInView({}, INDEX, { viewBoundsLngLat: view });
  assert.deepEqual(
    got.map((m) => m.mesh),
    ["A", "B"],
  );
});

// ===========================================================================
// 2. pickLod — LOD + poly budget
// ===========================================================================

test("pickLod keeps meshes under the poly budget and skips the overflow", () => {
  // Budget 100k; A(30k)+B(50k)=80k fit, C(40k) would make 120k → skip C.
  const res = pickLod({}, INDEX.meshes, { polyBudget: 100_000 });
  assert.deepEqual(
    res.draws.map((d) => `${d.entry.mesh}:${d.lod}`),
    ["A:extrude", "B:extrude", "C:skip"],
  );
  assert.equal(res.budgetedPolys, 80_000);
  assert.ok(res.budgetedPolys <= res.polyBudget, "never exceeds the budget");
});

test("pickLod does NOT break early — a later smaller mesh can still fit", () => {
  // Big(70k), then Huge(60k) which OVERFLOWS (70+60=130k>100k) → skip, then
  // Small(20k) which STILL FITS (70+20=90k). A break-early bug would have
  // skipped Small too; assert it is kept.
  const meshes: MeshEntry[] = [
    { mesh: "Big", bbox: [0, 0, 1, 1], pack: "p", count: 70_000 },
    { mesh: "Huge", bbox: [0, 0, 1, 1], pack: "p", count: 60_000 },
    { mesh: "Small", bbox: [0, 0, 1, 1], pack: "p", count: 20_000 },
  ];
  const res = pickLod({}, meshes, { polyBudget: 100_000 });
  assert.deepEqual(
    res.draws.map((d) => `${d.entry.mesh}:${d.lod}`),
    ["Big:extrude", "Huge:skip", "Small:extrude"],
  );
  assert.equal(res.budgetedPolys, 90_000);
});

test("pickLod uses flat LOD below the extrude zoom threshold (still budgeted)", () => {
  const res = pickLod({}, INDEX.meshes, {
    polyBudget: 100_000,
    zoom: -2,
    extrudeMinZoom: 0,
  });
  // Below extrudeMinZoom → kept meshes are flat (cheaper), overflow still skips.
  assert.deepEqual(
    res.draws.map((d) => `${d.entry.mesh}:${d.lod}`),
    ["A:flat", "B:flat", "C:skip"],
  );
});

test("pickLod default budget is 100k and respects it on the real index scale", () => {
  // A single huge mesh over budget is skipped outright (count > cap).
  const big: MeshEntry[] = [
    { mesh: "X", bbox: [0, 0, 1, 1], pack: "p", count: 250_000 },
  ];
  const res = pickLod({}, big);
  assert.equal(res.polyBudget, 100_000);
  assert.equal(res.draws[0]!.lod, "skip");
  assert.equal(res.budgetedPolys, 0);
});

// ===========================================================================
// 3. decodeAndProjectMesh — worker-safe decode+project (REAL sample)
// ===========================================================================

test("decodeAndProjectMesh decodes a real PLATEAU mesh sample, projects to metres, keeps heights", async () => {
  const n = 25; // 53392547 is the small sample mesh (25 buildings)
  const packJson = samplePackJson("53392547", n);
  const projected = await decodeAndProjectMesh({ topoFeature }, packJson, {
    negateY: false,
  });

  // One building record per polygon (all sample features are single Polygons).
  assert.equal(projected.count, n);
  assert.equal(projected.buildings.length, n);
  assert.equal(projected.mesh, "53392547");
  assert.equal(projected.attribution, "出典：国土交通省 PLATEAU（加工して作成）");

  // Heights survive the round-trip: compare to the raw sample's measuredHeight.
  const raw = readSample("53392547", n);
  const rawHeights = raw.map((f) => f.properties.height!);
  for (let i = 0; i < n; i++) {
    // flattenBuildings reads `height`; for these single Polygons the order is
    // preserved, so elevation == the raw measuredHeight (PLATEAU metres).
    assert.equal(
      projected.buildings[i]!.elevation,
      rawHeights[i],
      `building ${i} height should survive decode (${rawHeights[i]} m)`,
    );
  }

  // Coordinates are projected metres (EPSG:6677), not lon/lat degrees.
  const [x, y] = projected.buildings[0]!.polygon[0]![0]!;
  assert.ok(
    Number.isFinite(x!) && Number.isFinite(y!),
    "projected coords are finite",
  );
  assert.ok(
    Math.abs(x!) > 100 || Math.abs(y!) > 100,
    `coord ${x},${y} looks like degrees, not metres`,
  );

  // Synthetic ids are mesh-prefixed for cross-mesh picking uniqueness.
  assert.equal(projected.buildings[0]!.id, "53392547:0");
});

test("decodeAndProjectMesh round-trips the largest sample mesh slice (real coords)", async () => {
  // The big meshes have thousands of buildings; take a healthy slice.
  const n = 400;
  const projected = await decodeAndProjectMesh(
    { topoFeature },
    samplePackJson("53392597", n),
  );
  assert.equal(projected.buildings.length, n);
  // Every elevation is the positive measuredHeight (no NaN, no 0-collapse).
  assert.ok(
    projected.buildings.every((b) => Number.isFinite(b.elevation) && b.elevation > 0),
    "all heights finite + positive",
  );
});

// ===========================================================================
// 4. buildPlateauBuildingTileLayer — factory over fake ctors
// ===========================================================================

test("buildPlateauBuildingTileLayer makes one SolidPolygonLayer per in-view, budgeted mesh", async () => {
  const sink: Record<string, unknown>[] = [];
  // Pre-decode the real sample as the per-mesh data (the panel does this in a
  // Worker via getTileData); here we just feed real ProjectedBuildings.
  const tileData = (
    await decodeAndProjectMesh({ topoFeature }, samplePackJson("53392547", 10))
  ).buildings;

  // View over A+B (excludes C). Budget 100k → A(30k)+B(50k) both fit.
  const view: LngLatBBox = [139.05, 35.02, 139.15, 35.08];
  const fetched: string[] = [];
  const layers = buildPlateauBuildingTileLayer(
    fakeCtors(sink),
    {
      index: INDEX,
      viewBoundsLngLat: view,
      getTileData: (entry: MeshEntry): ProjectedBuilding[] => {
        fetched.push(entry.mesh);
        return tileData;
      },
    },
    { pickable: true },
  );

  // One layer per kept mesh (A, B) — C is off-view, never fetched.
  assert.equal(layers.length, 2);
  assert.deepEqual(fetched, ["A", "B"]);
  const recs = sink.filter((r) => r.type === "SolidPolygonLayer");
  assert.equal(recs.length, 2);
  assert.deepEqual(
    recs.map((r) => r.id),
    ["plateau-building-A", "plateau-building-B"],
  );

  // Extruded building props mirror the Stage-1 kind.
  const rec = recs[0]!;
  assert.equal(rec.extruded, true);
  assert.equal(rec.filled, true);
  assert.equal(rec.pickable, true);
  assert.ok(rec.material, "a material is set for shading");
  // Accessors read the projected building records.
  const sample = (rec.data as ProjectedBuilding[])[0]!;
  assert.equal(
    (rec.getElevation as (d: ProjectedBuilding) => number)(sample),
    sample.elevation,
  );
  const color = (rec.getFillColor as (d: ProjectedBuilding) => number[])(sample);
  assert.ok(Array.isArray(color) && color.length === 4);
});

test("buildPlateauBuildingTileLayer skips over-budget meshes (never fetched, never drawn)", () => {
  const sink: Record<string, unknown>[] = [];
  // View over ALL three meshes; budget 100k → A(30k)+B(50k)=80k fit, C skipped.
  const view: LngLatBBox = [139.0, 35.0, 139.3, 35.1];
  const fetched: string[] = [];
  const layers = buildPlateauBuildingTileLayer(
    fakeCtors(sink),
    {
      index: INDEX,
      viewBoundsLngLat: view,
      getTileData: (entry: MeshEntry): ProjectedBuilding[] => {
        fetched.push(entry.mesh);
        return [];
      },
    },
    { polyBudget: 100_000 },
  );
  assert.equal(layers.length, 2);
  assert.deepEqual(fetched, ["A", "B"]); // C skipped → getTileData not called
});

test("buildPlateauBuildingTileLayer draws flat (no extrusion) below the zoom threshold", () => {
  const sink: Record<string, unknown>[] = [];
  const view: LngLatBBox = [139.05, 35.02, 139.08, 35.08]; // mesh A only
  buildPlateauBuildingTileLayer(
    fakeCtors(sink),
    { index: INDEX, viewBoundsLngLat: view, getTileData: () => [] },
    { zoom: -3, extrudeMinZoom: 0 },
  );
  const rec = sink.find((r) => r.type === "SolidPolygonLayer")!;
  assert.equal(rec.extruded, false, "flat LOD → not extruded");
  // getElevation returns 0 for flat footprints.
  assert.equal((rec.getElevation as (d: unknown) => number)({}), 0);
});

test("buildPlateauBuildingTileLayer throws a clear error without a SolidPolygonLayer ctor", () => {
  assert.throws(
    () =>
      buildPlateauBuildingTileLayer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ctors: {} as any },
        {
          index: INDEX,
          viewBoundsLngLat: [139.0, 35.0, 139.3, 35.1],
          getTileData: () => [],
        },
      ),
    /SolidPolygonLayer/,
  );
});
