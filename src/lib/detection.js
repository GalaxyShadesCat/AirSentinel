function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

export function evaluateBreathingClassification({
  currentEstimatedBpm,
  baselineBpm,
  bpmVariation,
  meanDepth,
  deviation,
  lowMotionFraction,
  expectedBpm,
  expectedDepth,
  expectedVariation,
  rateZ,
  targetBinStd,
  respBandStd,
}) {
  const rateFromExpected = currentEstimatedBpm - expectedBpm;
  const depthRatio = meanDepth / Math.max(expectedDepth, 1e-6);
  const variationExcess = bpmVariation - expectedVariation;

  const ruleScore = clamp(
    (Math.max(0, rateFromExpected) / 7) * 0.3 +
      (Math.max(0, 1 - depthRatio) / 1.2) * 0.22 +
      (Math.max(0, variationExcess) / 2.8) * 0.2 +
      (Math.max(0, Math.abs(deviation) - 1.5) / 6) * 0.12 +
      (Math.max(0, lowMotionFraction - 0.12) / 0.25) * 0.16,
    0,
    1
  );

  const detectedPattern = (() => {
    const veryLowMotion = meanDepth < 0.09 || respBandStd < 0.008;
    const clearPauseLikeRate = currentEstimatedBpm < expectedBpm * 0.82 || deviation < -2.2;
    const strongPausePattern = lowMotionFraction > 0.34 && depthRatio < 0.75;
    if (strongPausePattern) return "Apnoea-like";
    if (veryLowMotion && clearPauseLikeRate) return "Apnoea-like";

    const isRapid =
      currentEstimatedBpm >= 16 ||
      currentEstimatedBpm >= expectedBpm + 2.2 ||
      rateFromExpected >= 2.8 ||
      (rateZ >= 1.3 && currentEstimatedBpm >= expectedBpm - 0.2);
    if (isRapid) return "Rapid";

    const isShallow =
      (meanDepth < 0.33 || depthRatio < 0.82) &&
      currentEstimatedBpm >= 9.8 &&
      lowMotionFraction < 0.32;
    if (isShallow) return "Shallow";

    const isSlowDeep =
      (currentEstimatedBpm <= 10.5 && meanDepth >= 0.45) ||
      (currentEstimatedBpm <= expectedBpm - 2 && depthRatio >= 1.25);
    if (isSlowDeep) return "Slow";

    const unstableTargeting = targetBinStd > 1.5 && bpmVariation > 2.3;
    if (unstableTargeting && currentEstimatedBpm >= 18) return "Rapid";

    return "Normal";
  })();

  const patternBoost =
    detectedPattern === "Apnoea-like"
      ? 0.24
      : detectedPattern === "Rapid"
        ? 0.16
        : detectedPattern === "Shallow"
          ? 0.12
          : detectedPattern === "Slow"
            ? 0.1
            : 0;

  const mlScore = clamp(ruleScore * 0.86 + patternBoost, 0, 1);
  const status = mlScore >= 0.72 ? "High variation" : mlScore >= 0.42 ? "Monitor closely" : "Stable";

  return {
    detectedPattern,
    mlScore,
    status,
    ruleScore,
    depthRatio,
    variationExcess,
    rateFromExpected,
  };
}
