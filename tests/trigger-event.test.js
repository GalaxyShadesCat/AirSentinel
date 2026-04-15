import test from "node:test";
import assert from "node:assert/strict";
import { simulateAndClassify } from "./helpers/pipeline.js";

test("trigger event increases model risk and reduces depth in manual normal mode", () => {
  const baseInput = {
    mode: "normal",
    baseBpm: 15,
    currentRate: 15,
    depth: 0.85,
    irregularity: 0.2,
    posture: "supine",
    seconds: 60,
  };

  const withoutTrigger = simulateAndClassify(baseInput);
  const withTrigger = simulateAndClassify({
    ...baseInput,
    triggerWindow: { start: 46, end: 58 },
  });

  assert.ok(
    withTrigger.features.meanDepth < withoutTrigger.features.meanDepth,
    `expected mean depth to decrease with trigger, got ${withTrigger.features.meanDepth} vs ${withoutTrigger.features.meanDepth}`
  );
  assert.ok(
    withTrigger.mlScore > withoutTrigger.mlScore,
    `expected ml score to increase with trigger, got ${withTrigger.mlScore} vs ${withoutTrigger.mlScore}`
  );
});
