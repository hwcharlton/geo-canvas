/**
 * `buildAttribution` — the de-duplicated DOM-overlay attribution string.
 *
 * Uses the real attribution carried through a decoded + projected Shibuya pack
 * (`© OpenStreetMap contributors`) plus synthetic duplicates to prove the
 * de-duplication. Attribution is NOT a deck.gl layer — it is a DOM overlay the
 * host renders (ADR-008/017); this only produces the text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { feature as topoFeature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { decodePack } from "@hwcharlton/geo-client";
import type { PackManifest, PackRef } from "@hwcharlton/geo-client";
import { makeProjector, projectPack, buildAttribution } from "../src/index.js";

const ADMIN_DIR =
  "/home/ubuntu/dev/personal/geo-data-staging/packs/shibuya/admin";

test("buildAttribution de-dupes the OSM line from real packs", async () => {
  const ref: PackRef = { ward: "shibuya", layer: "admin", detail: "high" };
  const [topoJson, manifestJson] = await Promise.all([
    readFile(`${ADMIN_DIR}/high.topo.json`, "utf8"),
    readFile(`${ADMIN_DIR}/high.manifest.json`, "utf8"),
  ]);
  const decoded = await decodePack(
    {
      loadTopology: async () => ({
        topology: JSON.parse(topoJson) as Topology,
        manifest: JSON.parse(manifestJson) as PackManifest,
      }),
      topoFeature,
    },
    ref,
  );
  const projected = projectPack({ projector: makeProjector() }, decoded);

  // The real pack carries the OSM line; two packs from the same source collapse.
  assert.equal(projected.attribution, "© OpenStreetMap contributors");
  assert.equal(
    buildAttribution([projected, projected]),
    "© OpenStreetMap contributors",
  );
});

test("buildAttribution joins distinct sources and drops empties", () => {
  assert.equal(
    buildAttribution([
      { attribution: "© OpenStreetMap contributors" },
      { attribution: "" },
      { attribution: "© Foo" },
      { attribution: "© OpenStreetMap contributors" },
    ]),
    "© OpenStreetMap contributors · © Foo",
  );
  assert.equal(buildAttribution([]), "");
});
