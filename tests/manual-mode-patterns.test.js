import test from "node:test";
import assert from "node:assert/strict";
import { simulateAndClassify } from "./helpers/pipeline.js";

const manualPatternCases = [
  {
    name: "manual normal preset detects Normal",
    input: { mode: "normal", baseBpm: 15, depth: 0.85, irregularity: 0.28, posture: "supine" },
    expected: "Normal",
  },
  {
    name: "manual rapid preset detects Rapid",
    input: { mode: "rapid", baseBpm: 15, depth: 0.9, irregularity: 0.12, posture: "supine" },
    expected: "Rapid",
  },
  {
    name: "manual shallow preset detects Shallow",
    input: { mode: "shallow", baseBpm: 15, depth: 0.5, irregularity: 0.18, posture: "supine" },
    expected: "Shallow",
  },
  {
    name: "manual slow preset detects Slow",
    input: { mode: "slowDeep", baseBpm: 12, depth: 0.9, irregularity: 0.18, posture: "supine" },
    expected: "Slow",
  },
  {
    name: "manual apnoea preset detects Apnoea-like",
    input: { mode: "apnoea", baseBpm: 14, depth: 0.9, irregularity: 0.16, posture: "supine" },
    expected: "Apnoea-like",
  },
  {
    name: "manual rapid remains Rapid on left posture",
    input: { mode: "rapid", baseBpm: 15, depth: 0.9, irregularity: 0.2, posture: "left" },
    expected: "Rapid",
  },
  {
    name: "manual shallow remains Shallow on left posture",
    input: { mode: "shallow", baseBpm: 15, depth: 0.55, irregularity: 0.1, posture: "left" },
    expected: "Shallow",
  },
];

for (const c of manualPatternCases) {
  test(c.name, () => {
    const out = simulateAndClassify(c.input);
    assert.equal(
      out.detectedPattern,
      c.expected,
      `expected ${c.expected} but got ${out.detectedPattern} with features ${JSON.stringify(out.features)}`
    );
  });
}
