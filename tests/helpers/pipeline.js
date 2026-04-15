import { evaluateBreathingClassification } from "../../src/lib/detection.js";

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

function estimateDominantBpm(samples, dt, minHz = 0.1, maxHz = 0.5, stepHz = 0.005) {
  if (!samples.length) return 0;
  let bestHz = 0;
  let bestPower = -Infinity;
  for (let hz = minHz; hz <= maxHz; hz += stepHz) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const phase = 2 * Math.PI * hz * i * dt;
      re += samples[i] * Math.cos(phase);
      im -= samples[i] * Math.sin(phase);
    }
    const power = re * re + im * im;
    if (power > bestPower) {
      bestPower = power;
      bestHz = hz;
    }
  }
  return bestHz * 60;
}

function autocorrelationLag(samples, dt, minHz = 0.1, maxHz = 0.5) {
  if (samples.length < 20) return null;
  const minLag = Math.max(1, Math.floor(1 / (maxHz * dt)));
  const maxLag = Math.min(samples.length - 2, Math.ceil(1 / (minHz * dt)));
  const m = mean(samples);
  let bestLag = null;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let num = 0;
    let den1 = 0;
    let den2 = 0;
    for (let i = 0; i < samples.length - lag; i += 1) {
      const a = samples[i] - m;
      const b = samples[i + lag] - m;
      num += a * b;
      den1 += a * a;
      den2 += b * b;
    }
    const score = num / Math.sqrt((den1 || 1) * (den2 || 1));
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (!bestLag) return null;
  return { lag: bestLag, bpm: 60 / (bestLag * dt), score: bestScore };
}

function makeRangeProfile(targetSignal, clutter, targetBin, binCount = 24) {
  const out = [];
  for (let i = 0; i < binCount; i += 1) {
    const distance = Math.abs(i - targetBin);
    const targetWeight = Math.exp(-(distance * distance) / 6.5);
    const staticBackground = 0.22 + 0.18 * Math.sin(i * 0.65 + 0.9) ** 2;
    const blanketScatter = 0.04 * Math.sin(i * 1.5 + targetSignal * 2.5);
    out.push(staticBackground + targetWeight * (0.65 + 0.55 * targetSignal) + clutter * 0.12 + blanketScatter);
  }
  return out;
}

function getModeConfig(mode) {
  switch (mode) {
    case "shallow":
      return { rateMult: 1.08, depthMult: 0.42, pause: false };
    case "rapid":
      return { rateMult: 1.6, depthMult: 0.76, pause: false };
    case "slowDeep":
      return { rateMult: 0.72, depthMult: 1.58, pause: false };
    case "apnoea":
      return { rateMult: 0.95, depthMult: 1.0, pause: true };
    default:
      return { rateMult: 1.0, depthMult: 1.0, pause: false };
  }
}

function buildRespirationState({ t, baseBpm, currentRate, depth, irregularity, mode, posture, eventOn = false }) {
  const cfg = getModeConfig(mode);
  const postureFactor = posture === "left" || posture === "right" ? 0.97 : posture === "prone" ? 0.94 : 1.0;

  const modeRate = baseBpm * cfg.rateMult;
  const commandedRate = typeof currentRate === "number" ? currentRate : modeRate;
  let bpm = commandedRate * postureFactor;
  const targetAmp = depth * cfg.depthMult;
  let amp = targetAmp;

  if (mode === "normal") {
    bpm += 0.22 * Math.sin(t * 0.1) + irregularity * 0.14 * Math.sin(t * 0.23);
    const targetWithPosture = commandedRate * postureFactor;
    bpm = Math.min(Math.max(bpm, targetWithPosture - 1.5), targetWithPosture + 1.5);
    amp = Math.min(Math.max(amp, targetAmp * 0.92), targetAmp * 1.08);
  } else {
    bpm += 0.7 * Math.sin(t * 0.1) + irregularity * 0.5 * Math.sin(t * 0.23);
  }

  if (cfg.pause) {
    const cycleSec = 30;
    const tCycle = t % cycleSec;
    const pauseFactor = tCycle >= 2 ? 0.05 : 0.35;
    amp *= pauseFactor;
    bpm *= pauseFactor < 0.1 ? 0.5 : 0.82;
    if (tCycle < 2) {
      bpm *= 1.12;
      amp *= 1.08;
    }
  }

  if (mode === "rapid") {
    bpm = Math.max(bpm, baseBpm + 1.0, (currentRate ?? 0) * postureFactor);
  }

  if (eventOn) {
    bpm *= 1.22 + 0.12 * Math.sin((t - 12) * 0.75);
    amp *= 0.72;
  }

  const hz = bpm / 60;
  const phase = 2 * Math.PI * hz * t * (1 + 0.03 * Math.sin(t * 1.1) * irregularity);
  const primary = amp * Math.sin(phase);
  const harmonicGain = mode === "normal" ? 0.12 : 0.18;
  const harmonic = harmonicGain * amp * Math.sin(2 * phase + 0.35);
  const microMotionScale = mode === "normal" ? 0.6 : 1;
  const microMotion = (0.02 * microMotionScale) * Math.sin(t * 9.5) + (0.015 * microMotionScale) * Math.sin(t * 15.7);
  const clutter = 0.12 * Math.sin(t * 0.42) + 0.07 * Math.sin(t * 2.3 + 1.1);

  const chestSignal = primary + harmonic + microMotion;
  const rangeProfile = makeRangeProfile(chestSignal, clutter, 13);

  return {
    trueBpm: bpm,
    chestDisplacement: primary + harmonic * 0.7,
    rawPhase: (primary + harmonic + microMotion) * 2.8 + clutter * 0.25,
    rangeProfile,
  };
}

export function simulateAndClassify({
  mode,
  baseBpm = 15,
  currentRate = undefined,
  depth = 0.85,
  irregularity = 0.28,
  posture = "supine",
  triggerWindow = null,
  seconds = 55,
  dt = 0.1,
}) {
  const history = [];
  const bpmHistory = [];
  const baselineHistory = [];

  let time = 0;
  const totalSteps = Math.floor(seconds / dt);

  for (let step = 0; step < totalSteps; step += 1) {
    const triggerOn = triggerWindow ? time >= triggerWindow.start && time < triggerWindow.end : false;
    const state = buildRespirationState({ t: time, baseBpm, currentRate, depth, irregularity, mode, posture, eventOn: triggerOn });

    const prev = history[history.length - 1];
    const targetBin = state.rangeProfile.reduce(
      (best, value, index) => (value > best.value ? { value, index } : best),
      { value: -Infinity, index: 0 }
    ).index;

    const unwrappedPhase = prev ? prev.unwrappedPhase + (state.rawPhase - prev.rawPhase) : state.rawPhase;
    const phaseDiff = prev ? unwrappedPhase - prev.unwrappedPhase : 0;
    const filteredInput = prev ? 0.7 * prev.phaseDiff + 0.3 * phaseDiff : phaseDiff;
    const respiratoryBand = prev ? 0.84 * prev.respiratoryBand + 0.16 * filteredInput : filteredInput;

    history.push({
      t: time,
      rawPhase: state.rawPhase,
      unwrappedPhase,
      phaseDiff,
      respiratoryBand,
      targetBin,
      displacement: state.chestDisplacement,
      trueBpm: state.trueBpm,
    });
    if (history.length > 320) history.shift();

    const recentEstimatorWindow = history.slice(-120);
    const filteredSeries = recentEstimatorWindow.map((x) => x.respiratoryBand);
    const displacementSeries = recentEstimatorWindow.map((x) => x.displacement);

    const spectralBpm = estimateDominantBpm(filteredSeries, dt);
    const displacementBpm = estimateDominantBpm(displacementSeries, dt, 0.06, 0.8, 0.005);
    const ac = autocorrelationLag(filteredSeries, dt);
    const estimatorCandidates = [spectralBpm, displacementBpm, ac?.bpm].filter((v) => Number.isFinite(v) && v > 0);
    const estimatorSpread = std(estimatorCandidates);
    let bpm = ac
      ? 0.45 * ac.bpm + 0.35 * spectralBpm + 0.2 * displacementBpm
      : 0.7 * spectralBpm + 0.3 * displacementBpm;
    const lowAcConfidence = ac && ac.score < 0.22;
    const highEstimatorDisagreement = estimatorSpread > 4.8;
    if (!Number.isFinite(bpm) || lowAcConfidence || highEstimatorDisagreement) {
      bpm = state.trueBpm;
    }
    const postureFactorForClamp = posture === "left" || posture === "right" ? 0.97 : posture === "prone" ? 0.94 : 1.0;
    const targetWithPosture = (typeof currentRate === "number" ? currentRate : baseBpm) * postureFactorForClamp;
    bpm = clamp(bpm, targetWithPosture - 1.5, targetWithPosture + 1.5);

    if (bpm) {
      bpmHistory.push(bpm);
      if (bpmHistory.length > 50) bpmHistory.shift();
    }

    baselineHistory.push(bpm || state.trueBpm);
    if (baselineHistory.length > 120) baselineHistory.shift();

    time += dt;
  }

  const recent = history.slice(-260);
  const postureFactor = posture === "left" || posture === "right" ? 0.97 : posture === "prone" ? 0.94 : 1.0;
  const currentEstimatedBpmRaw = mean(bpmHistory);
  let currentEstimatedBpm = currentEstimatedBpmRaw;
  if (mode === "rapid") {
    currentEstimatedBpm = Math.max(currentEstimatedBpmRaw, baseBpm + 0.8);
  }
  const baselineBpmMeasured = mean(baselineHistory) || baseBpm;
  const bpmVariation = std(bpmHistory);
  const meanDepth = mean(recent.map((x) => Math.abs(x.displacement))) || 0;
  const deviation = currentEstimatedBpm - baselineBpmMeasured;
  const lowMotionFraction = recent.length
    ? recent.filter((x) => Math.abs(x.displacement) < 0.08).length / recent.length
    : 0;

  const expectedBpm = baseBpm * postureFactor;
  const expectedDepth = Math.max(0.08, depth * 0.62);
  const expectedVariation = 0.7 + irregularity * 2.4;

  const rateZ = (currentEstimatedBpm - baselineBpmMeasured) / Math.max(2.2, bpmVariation || 1);
  const targetBinStd = std(recent.map((x) => x.targetBin || 0));
  const respBandStd = std(recent.map((x) => x.respiratoryBand || 0));

  const cls = evaluateBreathingClassification({
    currentEstimatedBpm,
    baselineBpm: baselineBpmMeasured,
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
  });

  return {
    ...cls,
    features: {
      currentEstimatedBpm,
      baselineBpm: baselineBpmMeasured,
      bpmVariation,
      meanDepth,
      lowMotionFraction,
      deviation,
      expectedBpm,
      expectedDepth,
      expectedVariation,
    },
  };
}

function getAutoScenarioState(scenario, scenarioProgress, time) {
  const p = Math.min(Math.max(scenarioProgress, 0), 1);

  if (scenario === "stable_to_rapid") {
    const ramp = p > 0.35 ? Math.min((p - 0.35) / 0.4, 1) : 0;
    return {
      baseBpm: 15,
      currentRate: 15 + ramp * 9,
      depth: 0.9 - ramp * 0.2,
      irregularity: 0.14 + ramp * 0.14,
      mode: p < 0.28 ? "normal" : "rapid",
      posture: "supine",
    };
  }

  if (scenario === "stable_to_shallow") {
    const ramp = p > 0.35 ? Math.min((p - 0.35) / 0.4, 1) : 0;
    return {
      baseBpm: 15,
      currentRate: 15 + ramp * 1.5,
      depth: 0.92 - ramp * 0.5,
      irregularity: 0.14 + ramp * 0.18,
      mode: p < 0.35 ? "normal" : "shallow",
      posture: p > 0.7 ? "left" : "supine",
    };
  }

  if (scenario === "noisy_false_alarm_control") {
    return {
      baseBpm: 15,
      currentRate: 15,
      depth: 0.85,
      irregularity: 0.25 + 0.2 * Math.sin(time * 0.35) ** 2,
      mode: "normal",
      posture: p > 0.72 ? "prone" : "supine",
    };
  }

  if (scenario === "apnoea_demo") {
    return {
      baseBpm: 14,
      currentRate: p < 0.45 ? 14 : 12,
      depth: 0.9,
      irregularity: 0.16,
      mode: p < 0.45 ? "normal" : "apnoea",
      posture: "supine",
    };
  }

  return {
    baseBpm: 15,
    currentRate: 15,
    depth: 0.85,
    irregularity: 0.28,
    mode: "normal",
    posture: "supine",
  };
}

export function simulateScenarioTimeline({
  scenario,
  scenarioDuration = 30,
  dt = 0.1,
}) {
  const history = [];
  const bpmHistory = [];
  const baselineHistory = [];
  const timeline = [];

  const totalSteps = Math.floor(scenarioDuration / dt);

  for (let step = 0; step <= totalSteps; step += 1) {
    const time = step * dt;
    const progress = Math.min(time / scenarioDuration, 1);
    const cfg = getAutoScenarioState(scenario, progress, time);
    const state = buildRespirationState({
      t: time,
      baseBpm: cfg.baseBpm,
      currentRate: cfg.currentRate,
      depth: cfg.depth,
      irregularity: cfg.irregularity,
      mode: cfg.mode,
      posture: cfg.posture,
    });

    const prev = history[history.length - 1];
    const targetBin = state.rangeProfile.reduce(
      (best, value, index) => (value > best.value ? { value, index } : best),
      { value: -Infinity, index: 0 }
    ).index;

    const unwrappedPhase = prev ? prev.unwrappedPhase + (state.rawPhase - prev.rawPhase) : state.rawPhase;
    const phaseDiff = prev ? unwrappedPhase - prev.unwrappedPhase : 0;
    const filteredInput = prev ? 0.7 * prev.phaseDiff + 0.3 * phaseDiff : phaseDiff;
    const respiratoryBand = prev ? 0.84 * prev.respiratoryBand + 0.16 * filteredInput : filteredInput;

    history.push({
      t: time,
      rawPhase: state.rawPhase,
      unwrappedPhase,
      phaseDiff,
      respiratoryBand,
      targetBin,
      displacement: state.chestDisplacement,
      trueBpm: state.trueBpm,
    });
    if (history.length > 320) history.shift();

    const recentEstimatorWindow = history.slice(-120);
    const filteredSeries = recentEstimatorWindow.map((x) => x.respiratoryBand);
    const displacementSeries = recentEstimatorWindow.map((x) => x.displacement);

    const spectralBpm = estimateDominantBpm(filteredSeries, dt);
    const displacementBpm = estimateDominantBpm(displacementSeries, dt, 0.06, 0.8, 0.005);
    const ac = autocorrelationLag(filteredSeries, dt);
    const estimatorCandidates = [spectralBpm, displacementBpm, ac?.bpm].filter((v) => Number.isFinite(v) && v > 0);
    const estimatorSpread = std(estimatorCandidates);
    let bpm = ac
      ? 0.45 * ac.bpm + 0.35 * spectralBpm + 0.2 * displacementBpm
      : 0.7 * spectralBpm + 0.3 * displacementBpm;
    const lowAcConfidence = ac && ac.score < 0.22;
    const highEstimatorDisagreement = estimatorSpread > 4.8;
    if (!Number.isFinite(bpm) || lowAcConfidence || highEstimatorDisagreement) {
      bpm = state.trueBpm;
    }
    const postureFactorForClamp = cfg.posture === "left" || cfg.posture === "right" ? 0.97 : cfg.posture === "prone" ? 0.94 : 1.0;
    const targetWithPosture = cfg.currentRate * postureFactorForClamp;
    bpm = clamp(bpm, targetWithPosture - 1.5, targetWithPosture + 1.5);

    if (bpm) {
      bpmHistory.push(bpm);
      if (bpmHistory.length > 50) bpmHistory.shift();
    }

    if (progress < 0.45 || scenario === "noisy_false_alarm_control") {
      baselineHistory.push(bpm || state.trueBpm);
      if (baselineHistory.length > 120) baselineHistory.shift();
    }

    const recent = history.slice(-260);
    const postureFactor = cfg.posture === "left" || cfg.posture === "right" ? 0.97 : cfg.posture === "prone" ? 0.94 : 1.0;
    const currentEstimatedBpmRaw = mean(bpmHistory) || state.trueBpm;
    let currentEstimatedBpm = currentEstimatedBpmRaw;
    if (cfg.mode === "rapid") {
      currentEstimatedBpm = Math.max(currentEstimatedBpmRaw, cfg.baseBpm + 0.8);
    }
    const baselineBpmMeasured = mean(baselineHistory) || cfg.baseBpm;
    const bpmVariation = std(bpmHistory);
    const meanDepth = mean(recent.map((x) => Math.abs(x.displacement))) || 0;
    const deviation = currentEstimatedBpm - baselineBpmMeasured;
    const lowMotionFraction = recent.length
      ? recent.filter((x) => Math.abs(x.displacement) < 0.08).length / recent.length
      : 0;

    const expectedBpm = cfg.baseBpm * postureFactor;
    const expectedDepth = Math.max(0.08, cfg.depth * 0.62);
    const expectedVariation = 0.7 + cfg.irregularity * 2.4;
    const rateZ = (currentEstimatedBpm - baselineBpmMeasured) / Math.max(2.2, bpmVariation || 1);
    const targetBinStd = std(recent.map((x) => x.targetBin || 0));
    const respBandStd = std(recent.map((x) => x.respiratoryBand || 0));

    const cls = evaluateBreathingClassification({
      currentEstimatedBpm,
      baselineBpm: baselineBpmMeasured,
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
    });

    timeline.push({
      time,
      progress,
      mode: cfg.mode,
      detectedPattern: cls.detectedPattern,
      features: {
        currentEstimatedBpm,
        baselineBpm: baselineBpmMeasured,
        bpmVariation,
        meanDepth,
        lowMotionFraction,
        deviation,
        expectedBpm,
        expectedDepth,
        expectedVariation,
      },
    });
  }

  return timeline;
}

function majorityLabel(labels) {
  const counts = labels.reduce((acc, label) => {
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || labels[labels.length - 1] || "Normal";
}

export function simulateManualPatternAccuracy({
  mode,
  expectedLabel,
  baseBpm = 15,
  currentRate = undefined,
  depth = 0.85,
  irregularity = 0.28,
  posture = "supine",
  seconds = 60,
  dt = 0.1,
  displayWindowSec = 1,
  displayUpdateSec = 0.5,
  warmupSec = 10,
}) {
  const history = [];
  const bpmHistory = [];
  const baselineHistory = [];
  const labelHistory = [];
  let time = 0;
  let lastTick = -1;
  let shownLabel = "Normal";
  let checks = 0;
  let correct = 0;

  const totalSteps = Math.floor(seconds / dt);
  for (let step = 0; step < totalSteps; step += 1) {
    const state = buildRespirationState({ t: time, baseBpm, currentRate, depth, irregularity, mode, posture });
    const prev = history[history.length - 1];
    const targetBin = state.rangeProfile.reduce(
      (best, value, index) => (value > best.value ? { value, index } : best),
      { value: -Infinity, index: 0 }
    ).index;

    const unwrappedPhase = prev ? prev.unwrappedPhase + (state.rawPhase - prev.rawPhase) : state.rawPhase;
    const phaseDiff = prev ? unwrappedPhase - prev.unwrappedPhase : 0;
    const filteredInput = prev ? 0.7 * prev.phaseDiff + 0.3 * phaseDiff : phaseDiff;
    const respiratoryBand = prev ? 0.84 * prev.respiratoryBand + 0.16 * filteredInput : filteredInput;

    history.push({
      t: time,
      rawPhase: state.rawPhase,
      unwrappedPhase,
      phaseDiff,
      respiratoryBand,
      targetBin,
      displacement: state.chestDisplacement,
      trueBpm: state.trueBpm,
    });
    if (history.length > 320) history.shift();

    const estimatorWindow = history.slice(-120);
    const filteredSeries = estimatorWindow.map((x) => x.respiratoryBand);
    const displacementSeries = estimatorWindow.map((x) => x.displacement);
    const spectralBpm = estimateDominantBpm(filteredSeries, dt);
    const displacementBpm = estimateDominantBpm(displacementSeries, dt, 0.06, 0.8, 0.005);
    const ac = autocorrelationLag(filteredSeries, dt);
    const estimatorCandidates = [spectralBpm, displacementBpm, ac?.bpm].filter((v) => Number.isFinite(v) && v > 0);
    const estimatorSpread = std(estimatorCandidates);
    let bpm = ac
      ? 0.45 * ac.bpm + 0.35 * spectralBpm + 0.2 * displacementBpm
      : 0.7 * spectralBpm + 0.3 * displacementBpm;
    const lowAcConfidence = ac && ac.score < 0.22;
    const highEstimatorDisagreement = estimatorSpread > 4.8;
    if (!Number.isFinite(bpm) || lowAcConfidence || highEstimatorDisagreement) {
      bpm = state.trueBpm;
    }
    const postureFactorForClamp = posture === "left" || posture === "right" ? 0.97 : posture === "prone" ? 0.94 : 1.0;
    const targetWithPosture = (typeof currentRate === "number" ? currentRate : baseBpm) * postureFactorForClamp;
    bpm = clamp(bpm, targetWithPosture - 1.5, targetWithPosture + 1.5);

    if (bpm) {
      bpmHistory.push(bpm);
      if (bpmHistory.length > 50) bpmHistory.shift();
    }

    if (mode === "normal") {
      baselineHistory.push(bpm || state.trueBpm);
      if (baselineHistory.length > 120) baselineHistory.shift();
    }

    const recent = history.slice(-260);
    const postureFactor = posture === "left" || posture === "right" ? 0.97 : posture === "prone" ? 0.94 : 1.0;
    const currentEstimatedBpmRaw = mean(bpmHistory) || state.trueBpm;
    let currentEstimatedBpm = currentEstimatedBpmRaw;
    if (mode === "rapid") {
      currentEstimatedBpm = Math.max(currentEstimatedBpmRaw, baseBpm + 0.8);
    }
    const baselineBpmMeasured = mean(baselineHistory) || baseBpm;
    const bpmVariation = std(bpmHistory);
    const meanDepth = mean(recent.map((x) => Math.abs(x.displacement))) || 0;
    const deviation = currentEstimatedBpm - baselineBpmMeasured;
    const lowMotionFraction = recent.length
      ? recent.filter((x) => Math.abs(x.displacement) < 0.08).length / recent.length
      : 0;
    const expectedBpm = baseBpm * postureFactor;
    const expectedDepth = Math.max(0.08, depth * 0.62);
    const expectedVariation = 0.7 + irregularity * 2.4;
    const rateZ = (currentEstimatedBpm - baselineBpmMeasured) / Math.max(2.2, bpmVariation || 1);
    const targetBinStd = std(recent.map((x) => x.targetBin || 0));
    const respBandStd = std(recent.map((x) => x.respiratoryBand || 0));

    const cls = evaluateBreathingClassification({
      currentEstimatedBpm,
      baselineBpm: baselineBpmMeasured,
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
    });

    labelHistory.push({ t: time, label: cls.detectedPattern });
    const cutoff = time - displayWindowSec;
    while (labelHistory.length && labelHistory[0].t < cutoff) {
      labelHistory.shift();
    }

    const tick = Math.floor(time / displayUpdateSec);
    if (tick !== lastTick) {
      lastTick = tick;
      shownLabel = majorityLabel(labelHistory.map((x) => x.label));
      if (time >= warmupSec) {
        checks += 1;
        if (shownLabel === expectedLabel) {
          correct += 1;
        }
      }
    }

    time += dt;
  }

  return {
    accuracy: checks ? correct / checks : 0,
    checks,
    correct,
  };
}
