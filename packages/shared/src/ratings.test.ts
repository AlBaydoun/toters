import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summariseRatings, evaluateCourierRating, topCompliments, MIN_RATINGS_TO_DISPLAY,
} from "./ratings.js";

test("a rating is hidden until the sample means something", () => {
  const few = summariseRatings([{ score: 5 }, { score: 5 }]);
  assert.equal(few.display, null, "two five-star reviews is not a 5.0 track record");
  assert.equal(few.count, 2);
  assert.equal(few.average, 5);

  const enough = summariseRatings(Array.from({ length: MIN_RATINGS_TO_DISPLAY }, () => ({ score: 5 })));
  assert.equal(enough.display, 5);
});

test("contested reviews are excluded from the average immediately", () => {
  const summary = summariseRatings([
    { score: 5 }, { score: 5 }, { score: 5 }, { score: 5 }, { score: 5 },
    { score: 1, contested: true },
  ]);
  assert.equal(summary.count, 5);
  assert.equal(summary.average, 5);
  assert.equal(summary.excludedAsContested, 1);
  // The courier should not carry a disputed rating while waiting on review.
  assert.equal(summary.display, 5);
});

test("skipped courier ratings are not counted as zeros", () => {
  // A customer who rates the food but not the delivery must not drag the
  // courier's average to the floor.
  const summary = summariseRatings([{ score: null }, { score: null }, { score: 4 }]);
  assert.equal(summary.count, 1);
  assert.equal(summary.average, 4);
});

test("no ratings yields null, not a division by zero", () => {
  const summary = summariseRatings([]);
  assert.equal(summary.display, null);
  assert.equal(summary.average, 0);
  assert.equal(summary.count, 0);
});

test("averages round to one decimal for display but keep precision underneath", () => {
  const summary = summariseRatings([
    { score: 4 }, { score: 5 }, { score: 4 }, { score: 5 }, { score: 5 },
  ]);
  assert.equal(summary.display, 4.6);
  assert.ok(Math.abs(summary.average - 4.6) < 1e-9);
});

test("a low rating flags for human review and never permits automated action", () => {
  const summary = summariseRatings(Array.from({ length: 25 }, () => ({ score: 2 })));
  const decision = evaluateCourierRating(summary);

  assert.equal(decision.flagForHumanReview, true);
  assert.ok(decision.reason);
  // The Platform Work Directive requires human review of decisions that
  // materially affect a worker. This must stay false.
  assert.equal(decision.automatedActionPermitted, false);
});

test("a small sample never flags, however bad it looks", () => {
  const summary = summariseRatings(Array.from({ length: 6 }, () => ({ score: 1 })));
  const decision = evaluateCourierRating(summary);
  assert.equal(decision.flagForHumanReview, false);
  assert.equal(decision.automatedActionPermitted, false);
});

test("compliments rank by frequency and ignore contested reviews", () => {
  const top = topCompliments([
    { compliments: ["FRIENDLY", "FAST"] },
    { compliments: ["FRIENDLY"] },
    { compliments: ["CAREFUL_WITH_FOOD"] },
    { compliments: ["FAST", "FAST"], contested: true },
  ]);

  assert.equal(top[0]?.code, "FRIENDLY");
  assert.equal(top[0]?.count, 2);
  // The contested review's two FAST tags must not inflate the count.
  assert.equal(top.find((t) => t.code === "FAST")?.count, 1);
});
