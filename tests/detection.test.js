import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBreathingClassification } from "../src/lib/detection.js";

function baseInput(overrides = {}) {
  return {
    currentEstimatedBpm: 12,
    baselineBpm: 12,
    bpmVariation: 1.0,
    meanDepth: 0.4,
    deviation: 0,
    lowMotionFraction: 0.08,
    expectedBpm: 12,
    expectedDepth: 0.4,
    expectedVariation: 1.2,
    rateZ: 0,
    targetBinStd: 0.7,
    respBandStd: 0.1,
    ...overrides,
  };
}

test("detects normal", () => {
  const out = evaluateBreathingClassification(baseInput());
  assert.equal(out.detectedPattern, "Normal");
  assert.ok(out.mlScore >= 0 && out.mlScore <= 1);
});

test("detects rapid breathing", () => {
  const out = evaluateBreathingClassification(
    baseInput({
      currentEstimatedBpm: 16,
      expectedBpm: 12,
      deviation: 4,
      rateZ: 1.5,
      meanDepth: 0.36,
    })
  );
  assert.equal(out.detectedPattern, "Rapid");
});

test("does not mark rapid from rateZ alone when absolute rate is not rapid", () => {
  const out = evaluateBreathingClassification(
    baseInput({
      currentEstimatedBpm: 13.5,
      expectedBpm: 15,
      deviation: 3.2,
      rateZ: 1.6,
      meanDepth: 0.38,
      expectedDepth: 0.4,
      lowMotionFraction: 0.1,
    })
  );
  assert.notEqual(out.detectedPattern, "Rapid");
});

test("detects shallow pattern", () => {
  const out = evaluateBreathingClassification(
    baseInput({
      currentEstimatedBpm: 12,
      meanDepth: 0.18,
      expectedDepth: 0.4,
      lowMotionFraction: 0.15,
    })
  );
  assert.equal(out.detectedPattern, "Shallow");
});

test("detects slow and deep", () => {
  const out = evaluateBreathingClassification(
    baseInput({
      currentEstimatedBpm: 8.8,
      expectedBpm: 12,
      meanDepth: 0.58,
      expectedDepth: 0.4,
    })
  );
  assert.equal(out.detectedPattern, "Slow");
});

test("detects apnoea-like pause", () => {
  const out = evaluateBreathingClassification(
    baseInput({
      currentEstimatedBpm: 9,
      expectedBpm: 12,
      meanDepth: 0.07,
      lowMotionFraction: 0.3,
      respBandStd: 0.008,
      deviation: -4,
    })
  );
  assert.equal(out.detectedPattern, "Apnoea-like");
});
