import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildThreeMeshGeometry,
  defaultThreeHeightColor,
  type ProjectedBuilding,
} from "../src/index.js";

function building(
  id: string,
  elevation: number,
  polygon: ProjectedBuilding["polygon"],
): ProjectedBuilding {
  return {
    id,
    elevation,
    polygon,
    src: {
      type: "Feature",
      id,
      properties: { id, height: elevation, source: "test" },
      geometry: { type: "Polygon", coordinates: polygon },
    },
  };
}

const OUTER = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
] satisfies ProjectedBuilding["polygon"][number];

test("buildThreeMeshGeometry emits typed arrays for a simple building", () => {
  const payload = buildThreeMeshGeometry(
    {},
    { mesh: "mesh-a", buildings: [building("a", 20, [OUTER])] },
    { colorForHeight: () => [10, 20, 30, 255] },
  );

  assert.equal(payload.buildingTable.length, 1);
  assert.equal(payload.buildingTable[0]!.id, "a");
  assert.equal(payload.buildingTable[0]!.mesh, "mesh-a");
  assert.equal(payload.buildingTable[0]!.heightMeters, 20);
  assert.ok(payload.positions instanceof Float32Array);
  assert.ok(payload.normals instanceof Float32Array);
  assert.ok(payload.indices instanceof Uint32Array);
  assert.ok(payload.colors instanceof Uint8Array);
  assert.ok(payload.faceToBuilding instanceof Uint32Array);
  assert.ok(payload.vertexToBuilding instanceof Uint32Array);
  assert.equal(payload.positions.length % 3, 0);
  assert.equal(payload.normals.length, payload.positions.length);
  assert.equal(payload.colors.length, payload.positions.length);
  assert.equal(payload.indices.length / 3, payload.faceToBuilding.length);
  assert.ok(payload.counts.trianglesDrawn > 0);
  assert.ok(payload.counts.vertices > 0);
  assert.deepEqual([...payload.colors.slice(0, 3)], [10, 20, 30]);
});

test("buildThreeMeshGeometry supports holes through earcut", () => {
  const hole = [
    [3, 3],
    [3, 7],
    [7, 7],
    [7, 3],
    [3, 3],
  ] satisfies ProjectedBuilding["polygon"][number];
  const payload = buildThreeMeshGeometry(
    {},
    {
      mesh: "mesh-hole",
      buildings: [building("with-hole", 30, [OUTER, hole])],
    },
  );

  assert.equal(payload.counts.polygonsDrawn, 1);
  assert.ok(payload.counts.trianglesDrawn > 12);
  assert.equal(payload.counts.degenerateRings, 0);
  assert.equal(
    payload.faceToBuilding.every((index) => index === 0),
    true,
  );
});

test("buildThreeMeshGeometry skips degenerate rings and records counters", () => {
  const line = [
    [0, 0],
    [1, 1],
    [2, 2],
    [0, 0],
  ] satisfies ProjectedBuilding["polygon"][number];
  const payload = buildThreeMeshGeometry(
    {},
    { mesh: "mesh-degenerate", buildings: [building("bad", 20, [line])] },
  );

  assert.equal(payload.counts.polygonsDrawn, 0);
  assert.equal(payload.counts.skippedBuildings, 1);
  assert.equal(payload.counts.degenerateRings, 1);
  assert.equal(payload.indices.length, 0);
});

test("buildThreeMeshGeometry clamps heights and maps faces to buildings", () => {
  const payload = buildThreeMeshGeometry(
    {},
    {
      mesh: "mesh-clamp",
      buildings: [
        building("low", -5, [OUTER]),
        building("high", 1200, [
          [
            [20, 0],
            [25, 0],
            [25, 5],
            [20, 5],
            [20, 0],
          ],
        ]),
      ],
    },
    { minHeightMeters: 1, maxHeightMeters: 80 },
  );

  assert.equal(payload.counts.clampedHeights, 2);
  assert.deepEqual(
    payload.buildingTable.map((record) => record.heightMeters),
    [1, 80],
  );
  assert.ok(payload.faceToBuilding.includes(0));
  assert.ok(payload.faceToBuilding.includes(1));
  assert.equal(payload.faceToBuilding.length, payload.indices.length / 3);
  assert.equal(payload.vertexToBuilding.length, payload.positions.length / 3);
});

test("defaultThreeHeightColor returns clamped RGB values", () => {
  for (const height of [-1, 0, 50, 160, 999]) {
    const color = defaultThreeHeightColor(height);
    assert.equal(color.length, 4);
    assert.equal(
      color.every((channel) => channel >= 0 && channel <= 255),
      true,
    );
  }
  assert.notDeepEqual(defaultThreeHeightColor(0), defaultThreeHeightColor(160));
});
