import test from "node:test";
import assert from "node:assert/strict";
import { simulateScenarioTimeline } from "./helpers/pipeline.js";

function inWindow(timeline, minProgress, maxProgress = 1) {
  return timeline.filter((x) => x.progress >= minProgress && x.progress <= maxProgress);
}

function mostFrequentLabel(entries) {
  const counts = entries.reduce((acc, x) => {
    acc[x.detectedPattern] = (acc[x.detectedPattern] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

test("stable_to_rapid transitions from Normal and settles on Rapid without apnoea-like late", () => {
  const timeline = simulateScenarioTimeline({ scenario: "stable_to_rapid" });
  const early = inWindow(timeline, 0.05, 0.3);
  const late = inWindow(timeline, 0.7, 0.98);

  assert.equal(mostFrequentLabel(early), "Normal");
  assert.equal(mostFrequentLabel(late), "Rapid");
  assert.equal(late.some((x) => x.detectedPattern === "Apnoea-like"), false);
  assert.equal(late.some((x) => x.detectedPattern === "Slow"), false);
});

test("stable_to_rapid has no apnoea-like or slow labels after rapid transition", () => {
  const timeline = simulateScenarioTimeline({ scenario: "stable_to_rapid" });
  const rapidWindow = inWindow(timeline, 0.45, 0.98);
  assert.equal(rapidWindow.some((x) => x.detectedPattern === "Apnoea-like"), false);
  assert.equal(rapidWindow.some((x) => x.detectedPattern === "Slow"), false);
});

test("stable_to_shallow transitions from Normal and reaches Shallow without apnoea-like late", () => {
  const timeline = simulateScenarioTimeline({ scenario: "stable_to_shallow" });
  const early = inWindow(timeline, 0.05, 0.3);
  const late = inWindow(timeline, 0.7, 0.98);

  assert.equal(mostFrequentLabel(early), "Normal");
  assert.equal(late.some((x) => x.detectedPattern === "Shallow"), true);
  assert.equal(late.some((x) => x.detectedPattern === "Apnoea-like"), false);
});

test("noisy_false_alarm_control remains predominantly Normal", () => {
  const timeline = simulateScenarioTimeline({ scenario: "noisy_false_alarm_control" });
  const midToLate = inWindow(timeline, 0.3, 0.98);
  assert.equal(mostFrequentLabel(midToLate), "Normal");
});

test("apnoea_demo reaches apnoea-like label after transition", () => {
  const timeline = simulateScenarioTimeline({ scenario: "apnoea_demo" });
  const late = inWindow(timeline, 0.6, 0.98);
  assert.equal(late.some((x) => x.detectedPattern === "Apnoea-like"), true);
});
