import test from "node:test";
import assert from "node:assert/strict";
import { simulateManualPatternAccuracy } from "./helpers/pipeline.js";

const oneMinuteCases = [
  {
    name: "normal label stays >=95% accurate over 60s",
    input: { mode: "normal", expectedLabel: "Normal", baseBpm: 15, currentRate: 15, depth: 0.85, irregularity: 0.28, posture: "supine" },
  },
  {
    name: "rapid label stays >=95% accurate over 60s",
    input: { mode: "rapid", expectedLabel: "Rapid", baseBpm: 15, currentRate: 24, depth: 0.9, irregularity: 0.12, posture: "supine" },
  },
  {
    name: "shallow label stays >=95% accurate over 60s",
    input: { mode: "shallow", expectedLabel: "Shallow", baseBpm: 15, currentRate: 13.5, depth: 0.5, irregularity: 0.18, posture: "supine" },
  },
  {
    name: "slow label stays >=95% accurate over 60s",
    input: { mode: "slowDeep", expectedLabel: "Slow", baseBpm: 12, currentRate: 9, depth: 0.9, irregularity: 0.18, posture: "supine" },
  },
  {
    name: "apnoea-like label stays >=95% accurate over 60s",
    input: { mode: "apnoea", expectedLabel: "Apnoea-like", baseBpm: 14, currentRate: 12, depth: 0.9, irregularity: 0.16, posture: "supine" },
  },
];

for (const c of oneMinuteCases) {
  test(c.name, () => {
    const out = simulateManualPatternAccuracy(c.input);
    assert.ok(
      out.accuracy >= 0.95,
      `expected >=0.95 accuracy, got ${out.accuracy.toFixed(4)} (${out.correct}/${out.checks})`
    );
  });
}
