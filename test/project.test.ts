/**
 * `makeProjector` / `projectPack` / `fitBounds` against a REAL decoded pack.
 *
 * Loads the raw baked Shibuya admin `.topo.json` from `geo-data-staging`,
 * decodes it through `@hwcharlton/geo-client`'s `decodePack` (injecting the real
 * `topojson-client` `feature()`), and exercises the projection + bounds + view
 * fit on the actual 渋谷区 polygon — no fixtures, no proj4.
 *
 * The projection comes from `@hwcharlton/geo-model` (`toPlanar`); these tests
 * also assert the round-trip-ish sanity of `makeProjector().forward` vs calling
 * `toPlanar` directly (Y negated).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { feature as topoFeature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { toPlanar } from "@hwcharlton/geo-model";
import { decodePack } from "@hwcharlton/geo-client";
import type {
  DecodedPack,
  PackManifest,
  PackRef,
} from "@hwcharlton/geo-client";
import { makeProjector, projectPack, fitBounds } from "../src/index.js";

const ADMIN_DIR =
  "/home/ubuntu/dev/personal/geo-data-staging/packs/shibuya/admin";

const SHIBUYA_ADMIN: PackRef = {
  ward: "shibuya",
  layer: "admin",
  detail: "high",
};

/** Decode the real Shibuya admin pack from disk into a DecodedPack. */
async function decodeShibuyaAdmin(): Promise<DecodedPack> {
  const [topoJson, manifestJson] = await Promise.all([
    readFile(`${ADMIN_DIR}/high.topo.json`, "utf8"),
    readFile(`${ADMIN_DIR}/high.manifest.json`, "utf8"),
  ]);
  const topology = JSON.parse(topoJson) as Topology;
  const manifest = JSON.parse(manifestJson) as PackManifest;
  return decodePack(
    { loadTopology: async () => ({ topology, manifest }), topoFeature },
    SHIBUYA_ADMIN,
  );
}

/** Recursively collect every `[x, y]` coordinate pair in a geometry. */
function eachCoord(coords: unknown, visit: (xy: number[]) => void): void {
  if (Array.isArray(coords) && typeof coords[0] === "number") {
    visit(coords as number[]);
  } else if (Array.isArray(coords)) {
    for (const c of coords) eachCoord(c, visit);
  }
}

test("makeProjector().forward projects [lon,lat] to EPSG:6677 metres with Y negated", () => {
  const projector = makeProjector();
  const lonlat: [number, number] = [139.7, 35.66];

  const [x, y] = projector.forward(lonlat);
  const [px, py] = toPlanar(lonlat);

  // forward === toPlanar but with Y negated (screen-up == north).
  assert.equal(x, px);
  assert.equal(y, -py);

  // Sane EPSG:6677 metres: west of the 139.8333° central meridian → easting
  // negative; south of lat0=36 → northing negative, so negated Y is positive.
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  assert.ok(x < 0, `easting should be west-of-CM negative, got ${x}`);
  assert.ok(py < 0, `raw northing should be south-of-lat0 negative, got ${py}`);
  assert.ok(y > 0, `negated northing should be positive, got ${y}`);
  // Shibuya is ~10–15 km west of the CM and ~35–40 km south of lat0 — metres,
  // not degrees (a proj4-free sanity band).
  assert.ok(Math.abs(x) > 5_000 && Math.abs(x) < 30_000);
  assert.ok(Math.abs(y) > 20_000 && Math.abs(y) < 60_000);
});

test("makeProjector accepts an (empty) deps bag for call-shape consistency", () => {
  const a = makeProjector();
  const b = makeProjector({});
  assert.deepEqual(a.forward([139.7, 35.66]), b.forward([139.7, 35.66]));
});

test("projectPack pre-projects the real Shibuya admin pack into metre space", async () => {
  const decoded = await decodeShibuyaAdmin();
  const projector = makeProjector();

  const projected = projectPack({ projector }, decoded);

  // The ref + attribution pass through.
  assert.deepEqual(projected.ref, SHIBUYA_ADMIN);
  assert.equal(projected.attribution, "© OpenStreetMap contributors");
  assert.equal(projected.features.length, decoded.collection.features.length);
  assert.ok(projected.features.length >= 1);

  // Bounds are finite and well-ordered.
  const [minX, minY, maxX, maxY] = projected.bounds;
  for (const v of [minX, minY, maxX, maxY]) assert.ok(Number.isFinite(v));
  assert.ok(minX < maxX);
  assert.ok(minY < maxY);

  // Every projected coordinate is in metres (not degrees) and within bounds.
  let coordCount = 0;
  for (const f of projected.features) {
    assert.ok("coordinates" in f.geometry);
    eachCoord(
      (f.geometry as { coordinates: unknown }).coordinates,
      ([x, y]) => {
        coordCount += 1;
        // Degrees would be ~[139, 35]; metres are thousands and (for Shibuya,
        // west+south of the origin) the easting is negative — definitely not
        // a lon/lat pair.
        assert.ok(Number.isFinite(x!) && Number.isFinite(y!));
        assert.ok(
          Math.abs(x!) > 100 || Math.abs(y!) > 100,
          `coord ${x},${y} looks like degrees, not metres`,
        );
        assert.ok(x! >= minX && x! <= maxX);
        assert.ok(y! >= minY && y! <= maxY);
      },
    );
  }
  assert.ok(coordCount > 10, "expected the ward polygon to have many vertices");

  // Stable synthetic ids `'<layer>:<index>'` assigned (source packs carry none).
  projected.features.forEach((f, i) => {
    assert.equal(f.id, `admin:${i}`);
  });
});

test("projectPack honours an idPrefix override", async () => {
  const decoded = await decodeShibuyaAdmin();
  const projected = projectPack({ projector: makeProjector() }, decoded, {
    idPrefix: "ward",
  });
  assert.equal(projected.features[0]!.id, "ward:0");
});

test("fitBounds maps the Shibuya bounds to a finite OrthographicView state", async () => {
  const decoded = await decodeShibuyaAdmin();
  const projected = projectPack({ projector: makeProjector() }, decoded);

  const view = fitBounds(projected.bounds, {
    width: 1280,
    height: 800,
    padding: 0.85,
  });

  const [tx, ty, tz] = view.target;
  assert.ok(Number.isFinite(tx) && Number.isFinite(ty));
  assert.equal(tz, 0);
  assert.ok(Number.isFinite(view.zoom));

  // target is the centre of the bounds.
  const [minX, minY, maxX, maxY] = projected.bounds;
  assert.ok(Math.abs(tx - (minX + maxX) / 2) < 1e-6);
  assert.ok(Math.abs(ty - (minY + maxY) / 2) < 1e-6);

  // A ward spanning a few km fit into ~1280px → a sensible negative-ish zoom
  // (world units per pixel = 2^-zoom, and one metre << one pixel here).
  assert.ok(view.zoom < 5 && view.zoom > -10);
});
