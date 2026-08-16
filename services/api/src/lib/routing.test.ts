import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePolyline, straightLine } from "./routing.js";

test("polyline decoding matches the reference example", () => {
  // The canonical test vector from the encoded-polyline format description.
  const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[0]!.latitude - 38.5) < 1e-5);
  assert.ok(Math.abs(points[0]!.longitude - -120.2) < 1e-5);
  assert.ok(Math.abs(points[2]!.latitude - 43.252) < 1e-5);
  assert.ok(Math.abs(points[2]!.longitude - -126.453) < 1e-5);
});

test("empty geometry decodes to no points rather than throwing", () => {
  assert.deepEqual(decodePolyline(""), []);
});

test("the straight-line fallback gives a usable route, not an empty one", () => {
  // Leipzig Hbf -> Völkerschlachtdenkmal.
  const route = straightLine(
    { latitude: 51.3459, longitude: 12.381 },
    { latitude: 51.3123, longitude: 12.4131 },
  );
  assert.equal(route.points.length, 2);
  assert.ok(route.distanceMeters > 3000 && route.distanceMeters < 5000);
  // A map with an approximate line beats a map with nothing on it.
  assert.ok(route.durationSeconds > 0);
});
