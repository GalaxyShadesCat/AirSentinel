import test from "node:test";
import assert from "node:assert/strict";
import { simulateAndClassify } from "./helpers/pipeline.js";

const cases = [
  {
    name: "rapid pattern is detected with elevated baseline and moderate depth",
    input: { mode: "rapid", baseBpm: 18, depth: 0.8, irregularity: 0.25, posture: "supine" },
    expected: "Rapid",
  },
  {
    name: "shallow pattern is detected with low depth",
    input: { mode: "shallow", baseBpm: 15, depth: 0.6, irregularity: 0.22, posture: "left" },
    expected: "Shallow",
  },
  {
    name: "slow deep pattern is detected with higher depth and lower baseline",
    input: { mode: "slowDeep", baseBpm: 12, depth: 1.2, irregularity: 0.18, posture: "supine" },
    expected: "Slow",
  },
  {
    name: "apnoea pattern is detected with low-motion fraction",
    input: { mode: "apnoea", baseBpm: 14, depth: 0.9, irregularity: 0.18, posture: "supine" },
    expected: "Apnoea-like",
  },
  {
    name: "normal pattern remains normal at typical manual settings",
    input: { mode: "normal", baseBpm: 15, depth: 0.85, irregularity: 0.2, posture: "supine" },
    expected: "Normal",
  },
];

for (const c of cases) {
  test(c.name, () => {
    const out = simulateAndClassify(c.input);
    assert.equal(
      out.detectedPattern,
      c.expected,
      `expected ${c.expected} but got ${out.detectedPattern} with features ${JSON.stringify(out.features)}`
    );
  });
}
