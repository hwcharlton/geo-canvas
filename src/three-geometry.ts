import earcut from "earcut";
import type { Position } from "geojson";
import type { ProjectedBuilding } from "./build-layers.js";

export type ThreeGeometryRGBA = [r: number, g: number, b: number, a?: number];

export interface ThreeGeometryBuildingRecord {
  id: string;
  mesh: string;
  heightMeters: number | null;
  source?: string;
  properties?: Record<string, unknown>;
}

export interface ThreeGeometryCounts {
  buildingFeatures: number;
  polygonsDrawn: number;
  trianglesDrawn: number;
  vertices: number;
  skippedBuildings: number;
  skippedRings: number;
  degenerateRings: number;
  clampedHeights: number;
}

export interface ThreeMeshGeometryPayload {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  colors: Uint8Array;
  faceToBuilding: Uint32Array;
  vertexToBuilding: Uint32Array;
  buildingTable: readonly ThreeGeometryBuildingRecord[];
  bounds: readonly [
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ];
  origin: readonly [x: number, y: number, z: number];
  counts: ThreeGeometryCounts;
}

export interface BuildThreeMeshGeometryTarget {
  mesh: string;
  buildings: readonly ProjectedBuilding[];
}

export interface BuildThreeMeshGeometryOptions {
  minHeightMeters?: number;
  maxHeightMeters?: number;
  colorForHeight?: (
    heightMeters: number,
    building: ProjectedBuilding,
    buildingIndex: number,
  ) => ThreeGeometryRGBA;
}

interface CleanRing {
  points: readonly [number, number][];
  area: number;
}

export function buildThreeMeshGeometry(
  _deps: Record<never, never>,
  target: BuildThreeMeshGeometryTarget,
  options: BuildThreeMeshGeometryOptions = {},
): ThreeMeshGeometryPayload {
  const stats: ThreeGeometryCounts = {
    buildingFeatures: target.buildings.length,
    polygonsDrawn: 0,
    trianglesDrawn: 0,
    vertices: 0,
    skippedBuildings: 0,
    skippedRings: 0,
    degenerateRings: 0,
    clampedHeights: 0,
  };
  const bounds = inputBounds(target.buildings);
  const origin: [number, number, number] = [
    (bounds[0] + bounds[3]) / 2,
    (bounds[1] + bounds[4]) / 2,
    0,
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const faceToBuilding: number[] = [];
  const vertexToBuilding: number[] = [];
  const buildingTable: ThreeGeometryBuildingRecord[] = [];
  const colorForHeight = options.colorForHeight ?? defaultThreeHeightColor;

  target.buildings.forEach((building) => {
    const tableIndex = buildingTable.length;
    const height = normalizedHeight(building.elevation, options, stats);
    const rings = normalizeRings(building.polygon, stats);
    if (height <= 0 || rings.length === 0) {
      stats.skippedBuildings += 1;
      return;
    }

    const flat: number[] = [];
    const holes: number[] = [];
    const points: [number, number][] = [];
    for (const [ringIndex, ring] of rings.entries()) {
      if (ringIndex > 0) holes.push(points.length);
      for (const point of ring.points) {
        points.push(point);
        flat.push(point[0], point[1]);
      }
    }

    const roofTriangles = earcut(flat, holes, 2);
    if (roofTriangles.length === 0) {
      stats.skippedBuildings += 1;
      return;
    }

    buildingTable.push(recordForBuilding(target.mesh, building, height));
    const color = normalizeColor(colorForHeight(height, building, tableIndex));
    const roofOffset = addPointSet(
      points,
      height,
      [0, 0, 1],
      color,
      tableIndex,
      positions,
      normals,
      colors,
      vertexToBuilding,
      origin,
    );
    for (let i = 0; i < roofTriangles.length; i += 3) {
      pushTriangle(
        indices,
        faceToBuilding,
        tableIndex,
        roofOffset + roofTriangles[i]!,
        roofOffset + roofTriangles[i + 1]!,
        roofOffset + roofTriangles[i + 2]!,
      );
    }

    const baseOffset = addPointSet(
      points,
      0,
      [0, 0, -1],
      color,
      tableIndex,
      positions,
      normals,
      colors,
      vertexToBuilding,
      origin,
    );
    for (let i = 0; i < roofTriangles.length; i += 3) {
      pushTriangle(
        indices,
        faceToBuilding,
        tableIndex,
        baseOffset + roofTriangles[i + 2]!,
        baseOffset + roofTriangles[i + 1]!,
        baseOffset + roofTriangles[i]!,
      );
    }

    for (const ring of rings) {
      addSideWalls(
        ring.points,
        height,
        color,
        tableIndex,
        positions,
        normals,
        colors,
        vertexToBuilding,
        indices,
        faceToBuilding,
        origin,
      );
    }

    stats.polygonsDrawn += 1;
  });

  stats.vertices = positions.length / 3;
  stats.trianglesDrawn = indices.length / 3;
  const outputBounds: ThreeMeshGeometryPayload["bounds"] =
    stats.vertices === 0 ? [0, 0, 0, 0, 0, 0] : bounds;

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    colors: new Uint8Array(colors),
    faceToBuilding: new Uint32Array(faceToBuilding),
    vertexToBuilding: new Uint32Array(vertexToBuilding),
    buildingTable,
    bounds: outputBounds,
    origin,
    counts: stats,
  };
}

export function defaultThreeHeightColor(
  heightMeters: number,
): ThreeGeometryRGBA {
  const t = Math.max(0, Math.min(1, heightMeters / 160));
  if (t < 0.33) {
    const k = t / 0.33;
    return [
      Math.round(50 + k * 38),
      Math.round(121 + k * 58),
      Math.round(166 - k * 52),
      255,
    ];
  }
  if (t < 0.72) {
    const k = (t - 0.33) / 0.39;
    return [
      Math.round(88 + k * 150),
      Math.round(179 + k * 4),
      Math.round(114 - k * 48),
      255,
    ];
  }
  const k = (t - 0.72) / 0.28;
  return [
    Math.round(238 - k * 20),
    Math.round(183 - k * 88),
    Math.round(66 + k * 8),
    255,
  ];
}

function normalizeRings(
  polygon: readonly Position[][],
  stats: ThreeGeometryCounts,
): CleanRing[] {
  const rings: CleanRing[] = [];
  polygon.forEach((rawRing, index) => {
    const ring = cleanRing(rawRing);
    if (ring.length < 3) {
      stats.skippedRings += 1;
      stats.degenerateRings += 1;
      return;
    }
    const area = ringArea(ring);
    if (Math.abs(area) < 1e-6) {
      stats.skippedRings += 1;
      stats.degenerateRings += 1;
      return;
    }
    const shouldBeClockwise = index > 0;
    const isClockwise = area < 0;
    const points =
      shouldBeClockwise === isClockwise ? ring : [...ring].reverse();
    rings.push({ points, area: ringArea(points) });
  });
  return rings.length === 0 ? [] : rings;
}

function cleanRing(rawRing: readonly Position[]): [number, number][] {
  const ring: [number, number][] = [];
  for (const point of rawRing) {
    const x = point[0];
    const y = point[1];
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      continue;
    }
    const previous = ring[ring.length - 1];
    if (
      previous &&
      nearlyEqual(previous[0], x) &&
      nearlyEqual(previous[1], y)
    ) {
      continue;
    }
    ring.push([x, y]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (
    first &&
    last &&
    nearlyEqual(first[0], last[0]) &&
    nearlyEqual(first[1], last[1])
  ) {
    ring.pop();
  }
  return ring;
}

function addPointSet(
  points: readonly [number, number][],
  z: number,
  normal: readonly [number, number, number],
  color: readonly [number, number, number],
  buildingIndex: number,
  positions: number[],
  normals: number[],
  colors: number[],
  vertexToBuilding: number[],
  origin: readonly [number, number, number],
): number {
  const offset = positions.length / 3;
  for (const [x, y] of points) {
    positions.push(x - origin[0], y - origin[1], z - origin[2]);
    normals.push(normal[0], normal[1], normal[2]);
    colors.push(color[0], color[1], color[2]);
    vertexToBuilding.push(buildingIndex);
  }
  return offset;
}

function addSideWalls(
  ring: readonly [number, number][],
  height: number,
  color: readonly [number, number, number],
  buildingIndex: number,
  positions: number[],
  normals: number[],
  colors: number[],
  vertexToBuilding: number[],
  indices: number[],
  faceToBuilding: number[],
  origin: readonly [number, number, number],
): void {
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const normal: [number, number, number] = [dy / length, -dx / length, 0];
    const offset = positions.length / 3;
    for (const [x, y, z] of [
      [a[0], a[1], 0],
      [b[0], b[1], 0],
      [b[0], b[1], height],
      [a[0], a[1], height],
    ] as const) {
      positions.push(x - origin[0], y - origin[1], z - origin[2]);
      normals.push(normal[0], normal[1], normal[2]);
      colors.push(color[0], color[1], color[2]);
      vertexToBuilding.push(buildingIndex);
    }
    pushTriangle(
      indices,
      faceToBuilding,
      buildingIndex,
      offset,
      offset + 1,
      offset + 2,
    );
    pushTriangle(
      indices,
      faceToBuilding,
      buildingIndex,
      offset,
      offset + 2,
      offset + 3,
    );
  }
}

function pushTriangle(
  indices: number[],
  faceToBuilding: number[],
  buildingIndex: number,
  a: number,
  b: number,
  c: number,
): void {
  indices.push(a, b, c);
  faceToBuilding.push(buildingIndex);
}

function normalizedHeight(
  raw: number,
  options: BuildThreeMeshGeometryOptions,
  stats: ThreeGeometryCounts,
): number {
  const min = options.minHeightMeters ?? 0;
  const max = options.maxHeightMeters ?? 500;
  const finite = Number.isFinite(raw) ? raw : 0;
  const clamped = Math.max(min, Math.min(max, finite));
  if (clamped !== finite) stats.clampedHeights += 1;
  return clamped;
}

function inputBounds(
  buildings: readonly ProjectedBuilding[],
): ThreeMeshGeometryPayload["bounds"] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = 0;
  for (const building of buildings) {
    const height = Number.isFinite(building.elevation)
      ? Math.max(0, building.elevation)
      : 0;
    maxZ = Math.max(maxZ, height);
    for (const ring of building.polygon) {
      for (const point of ring) {
        const x = point[0];
        const y = point[1];
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        ) {
          continue;
        }
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return Number.isFinite(minX)
    ? [minX, minY, 0, maxX, maxY, maxZ]
    : [0, 0, 0, 0, 0, 0];
}

function recordForBuilding(
  mesh: string,
  building: ProjectedBuilding,
  heightMeters: number,
): ThreeGeometryBuildingRecord {
  const properties = building.src.properties ?? {};
  const source = properties.source;
  return {
    id: String(building.id),
    mesh,
    heightMeters,
    ...(typeof source === "string" ? { source } : {}),
    properties,
  };
}

function normalizeColor(color: ThreeGeometryRGBA): [number, number, number] {
  return [clampByte(color[0]), clampByte(color[1]), clampByte(color[2])];
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function ringArea(points: readonly [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}
