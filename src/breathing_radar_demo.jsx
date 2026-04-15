import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { evaluateBreathingClassification } from "@/lib/detection";

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function wrapToPi(angle) {
  let a = angle;
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

function polyline(points) {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

function movingAverage(arr, windowSize) {
  if (!arr.length) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const start = Math.max(0, i - windowSize + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= i; j += 1) {
      sum += arr[j];
      count += 1;
    }
    out.push(sum / count);
  }
  return out;
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

function makeBandpassCoefficients(lowHz, highHz, fsHz) {
  const low = Math.max(1e-4, lowHz);
  const high = Math.max(low + 1e-4, highHz);
  const f0 = Math.sqrt(low * high);
  const bandwidth = high - low;
  const q = Math.max(0.2, f0 / bandwidth);

  const w0 = (2 * Math.PI * f0) / fsHz;
  const sinW0 = Math.sin(w0);
  const cosW0 = Math.cos(w0);
  const alpha = sinW0 / (2 * q);

  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

function applyBiquadStep(sample, state, coeffs) {
  const y = coeffs.b0 * sample
    + coeffs.b1 * state.x1
    + coeffs.b2 * state.x2
    - coeffs.a1 * state.y1
    - coeffs.a2 * state.y2;

  state.x2 = state.x1;
  state.x1 = sample;
  state.y2 = state.y1;
  state.y1 = y;

  return y;
}

function makeSpectrumPoints(samples, width, height, dt, minHz = 0.05, maxHz = 0.8, stepHz = 0.01) {
  if (!samples.length) return "";
  const vals = [];
  for (let hz = minHz; hz <= maxHz; hz += stepHz) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const phase = 2 * Math.PI * hz * i * dt;
      re += samples[i] * Math.cos(phase);
      im -= samples[i] * Math.sin(phase);
    }
    vals.push({ hz, mag: Math.sqrt(re * re + im * im) / samples.length });
  }
  const maxMag = Math.max(...vals.map((v) => v.mag), 1e-6);
  return polyline(
    vals.map((v) => ({
      x: ((v.hz - minHz) / (maxHz - minHz)) * width,
      y: height - (v.mag / maxMag) * (height - 10),
    }))
  );
}

function normaliseSeries(samples) {
  if (!samples.length) return [];
  const minVal = Math.min(...samples);
  const maxVal = Math.max(...samples);
  const span = Math.max(maxVal - minVal, 1e-6);
  return samples.map((v) => (v - minVal) / span);
}

function makeWaveformImageGrid(samples, width = 96, height = 48, thickness = 1) {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  if (!samples.length) return grid;
  for (let x = 0; x < width; x += 1) {
    const idx = Math.round((x / Math.max(width - 1, 1)) * (samples.length - 1));
    const v = samples[idx];
    const yCenter = Math.round((1 - v) * 0.5 * (height - 1));
    for (let dy = -thickness; dy <= thickness; dy += 1) {
      const y = yCenter + dy;
      if (y >= 0 && y < height) {
        grid[y][x] = 1;
      }
    }
  }
  return grid;
}

function makeHogCellMapFromGrid(grid, cellsX = 8, cellsY = 4) {
  const height = grid.length;
  const width = grid[0]?.length || 0;
  if (!width || !height) return Array.from({ length: cellsY }, () => Array.from({ length: cellsX }, () => 0));

  const grad = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx = grid[y][x + 1] - grid[y][x - 1];
      const gy = grid[y + 1][x] - grid[y - 1][x];
      grad[y][x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  const cellW = Math.max(1, Math.floor(width / cellsX));
  const cellH = Math.max(1, Math.floor(height / cellsY));
  const out = Array.from({ length: cellsY }, () => Array.from({ length: cellsX }, () => 0));

  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const x0 = cx * cellW;
      const y0 = cy * cellH;
      const x1 = cx === cellsX - 1 ? width : x0 + cellW;
      const y1 = cy === cellsY - 1 ? height : y0 + cellH;
      let sum = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += grad[y][x];
        }
      }
      out[cy][cx] = sum;
    }
  }

  const maxVal = Math.max(...out.flat(), 1e-6);
  return out.map((row) => row.map((v) => v / maxVal));
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
      return { rateMult: 1.08, depthMult: 0.42, pause: false, label: "Shallow" };
    case "rapid":
      return { rateMult: 1.6, depthMult: 0.76, pause: false, label: "Rapid" };
    case "slowDeep":
      return { rateMult: 0.72, depthMult: 1.58, pause: false, label: "Slow" };
    case "apnoea":
      return { rateMult: 0.95, depthMult: 1.0, pause: true, label: "Apnoea-like" };
    default:
      return { rateMult: 1.0, depthMult: 1.0, pause: false, label: "Normal" };
  }
}

function buildRespirationState({ t, baseBpm, currentRate, depth, irregularity, mode, eventOn, posture }) {
  const cfg = getModeConfig(mode);
  const postureFactor = posture === "left" || posture === "right" ? 0.97 : posture === "prone" ? 0.94 : 1.0;

  const modeRate = baseBpm * cfg.rateMult;
  const commandedRate = typeof currentRate === "number" ? currentRate : modeRate;
  let bpm = commandedRate * postureFactor;
  const targetAmp = depth * cfg.depthMult;
  let amp = targetAmp;

  if (mode === "normal") {
    // Keep normal breathing close to configured targets with mild natural variability.
    bpm += 0.22 * Math.sin(t * 0.1) + irregularity * 0.14 * Math.sin(t * 0.23);
    const targetWithPosture = commandedRate * postureFactor;
    bpm = Math.min(Math.max(bpm, targetWithPosture - 1.5), targetWithPosture + 1.5);
    amp = Math.min(Math.max(amp, targetAmp * 0.92), targetAmp * 1.08);
  } else {
    bpm += 0.7 * Math.sin(t * 0.1) + irregularity * 0.5 * Math.sin(t * 0.23);
  }

  let pauseFactor = 1;
  if (cfg.pause) {
    const cycleSec = 30;
    const tCycle = t % cycleSec;
    // One long low-amplitude window per cycle to emulate an apnoea-like interruption.
    pauseFactor = tCycle >= 2 ? 0.05 : 0.35;
    amp *= pauseFactor;
    bpm *= pauseFactor < 0.1 ? 0.5 : 0.82;
    // Short rebound at cycle reset; apnoea-like stays dominant over time.
    if (tCycle < 2) {
      bpm *= 1.12;
      amp *= 1.08;
    }
  }

  const triggerActive = eventOn;
  if (triggerActive) {
    bpm *= 1.22 + 0.12 * Math.sin((t - 12) * 0.75);
    amp *= 0.72;
  }

  // Keep rapid mode physiologically above the configured baseline.
  if (mode === "rapid") {
    bpm = Math.max(bpm, baseBpm + 1.0, (currentRate ?? 0) * postureFactor);
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
  const continuousPhase = (primary + harmonic + microMotion) * 2.8 + clutter * 0.25;

  return {
    trueBpm: bpm,
    chestDisplacement: primary + harmonic * 0.7,
    rawPhase: wrapToPi(continuousPhase),
    respiratorySignal: chestSignal,
    rangeProfile,
    clutter,
    triggerActive,
    depthProxy: Math.abs(amp),
    label: cfg.label,
  };
}

function InfoButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 text-xs font-semibold text-slate-600 hover:bg-slate-100"
      aria-label="Open information"
    >
      i
    </button>
  );
}

function PanelTitle({ title, onInfo }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{title}</span>
      <InfoButton onClick={onInfo} />
    </div>
  );
}

function StatCard({ label, value, sublabel, badge, onInfo, compact = false }) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className={compact ? "pt-4" : "pt-6"}>
        <div className="flex items-center justify-between gap-2 text-sm text-slate-500">
          <span>{label}</span>
          {onInfo ? <InfoButton onClick={onInfo} /> : null}
        </div>
        <div className="mt-2 flex items-center gap-2 text-3xl font-semibold">
          {value}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </div>
        <div className="text-sm text-slate-500">{sublabel}</div>
      </CardContent>
    </Card>
  );
}

const references = [
  {
    apa: "Turppa, E., Kortelainen, J. M., Antropov, O., & Kiuru, T. (2020). Vital sign monitoring using FMCW radar in various sleeping scenarios. Sensors, 20(22), 6505. https://doi.org/10.3390/s20226505",
  },
  {
    apa: "Hao, Z., Wang, Y., Li, F., Ding, G., & Gao, Y. (2024). mmWave-RM: A respiration monitoring and pattern classification system based on mmWave radar. Sensors, 24(13), 4315. https://doi.org/10.3390/s24134315",
  },
  {
    apa: "Natarajan, A., Su, H.-W., Heneghan, C., Blunt, L., O'Connor, C., et al. (2021). Measurement of respiratory rate using wearable devices and applications to COVID-19 detection. npj Digital Medicine, 4, 136. https://doi.org/10.1038/s41746-021-00493-6",
  },
];

const infoContent = {
  bedside: {
    title: "Bedside radar scene",
    body: "Represents: the physical setup where radar tracks chest and blanket motion without contact.\n\nPipeline connection:\n- Input: transmitted FMCW chirps and returning echoes.\n- Output: raw reflected radar signal.\n\nLook for: smooth blanket lift during stable breathing and visible changes when pattern/rate shifts (Turppa et al., 2020).",
  },
  modelOutput: {
    title: "Model output",
    body: "Represents: one overall risk score from breathing rate, depth, variability, and baseline shift. Look for: score rising and status changing from Stable to Monitor/High variation when breathing becomes abnormal (Hao et al., 2024).",
  },
  rate: {
    title: "Estimated rate",
    body: "Represents: the current breathing rate estimate in breaths per minute. Look for: sustained increases/decreases rather than one brief spike, especially versus baseline (Turppa et al., 2020; Hao et al., 2024; Natarajan et al., 2021).",
  },
  baseline: {
    title: "Learned baseline",
    body: "Represents: the person's typical recent breathing rate during stable periods. Look for: whether current rate stays close or drifts away from this anchor value; healthy nocturnal rates commonly cluster in a moderate range, so persistent drift is meaningful (Natarajan et al., 2021; Hao et al., 2024).",
  },
  deviation: {
    title: "Deviation",
    body: "Represents: difference between current rate and baseline. Look for: larger positive or negative values that persist, since those indicate meaningful change from normal.",
  },
  pattern: {
    title: "Detected pattern",
    body: "Represents: the final breathing label.\n\nNormal: breathing is within expected range.\nRapid: breathing is faster than expected.\nShallow: breaths are smaller/weaker than expected.\nSlow: breathing is slower with larger motion.\nApnoea-like: breathing motion is near-absent for a period.\n\nLook for: whether this label matches the trend/trace/spectrum behavior (Hao et al., 2024).",
  },
  variation: {
    title: "Rate variation",
    body: "Represents: short-term instability of breathing rate. Look for: rising variation over time, which means rhythm is getting less regular (Hao et al., 2024).",
  },
  selectedBin: {
    title: "Selected range bin",
    body: "Represents: the distance slice most associated with torso motion.\n\nPipeline connection:\n- Input: range profile from Step 2.\n- Output: torso-focused signal stream.\n\nLook for: stable bin selection; frequent jumps can make downstream estimates less reliable (Turppa et al., 2020).",
  },
  respirationTrace: {
    title: "Breathing trace",
    body: "Represents: the cleaned breathing waveform over time. Look for: regular cycles during normal breathing and shape/rate changes during rapid, shallow, or pause events (Turppa et al., 2020).",
  },
  rateTrend: {
    title: "Rate trend",
    body: "Represents: breathing-rate history (grey raw, green smoothed). Look for: direction and persistence of trend changes, not short raw fluctuations (Hao et al., 2024).",
  },
  rangeProfile: {
    title: "Range profile",
    body: "Represents: signal strength by distance bin from the radar.\n\nPipeline connection:\n- Input: raw radar return from Step 1.\n- Output: range bins (distance profile).\n\nLook for: a clear dominant torso bin and stable separation from surrounding bins (Turppa et al., 2020).",
  },
  denoise: {
    title: "Signal enhancement / denoising",
    body: "Represents: cleaning the torso-bin signal before deeper motion analysis.\n\nHow to read this card:\n- Grey line = noisier raw signal from the selected torso bin.\n- Teal line = denoised version used for later stages.\n\nPipeline connection:\n- Input: torso-bin signal selected in Step 3.\n- Output: cleaner torso motion signal.\n\nImplementation note:\n- Paper method: multi-antenna channel alignment + IQ superposition.\n- Demo method: simplified smoothing proxy to illustrate denoising behaviour.\n\nLook for:\n- Less jitter in the denoised line, but the same overall breathing rhythm.",
  },
  phase: {
    title: "Unwrapped phase",
    body: "Represents: tiny chest motion tracked through radar phase over slow time.\n\nPipeline connection:\n- Input: denoised torso signal from Step 4.\n- Output: continuous phase-motion trace.\n\nSimple meaning of \"unwrap\":\n- Phase is an angle on a circle. When it reaches the end of that circle, it appears to jump suddenly.\n- Unwrapping removes these fake jumps so the motion trace becomes smooth and continuous.\n\nLook for:\n- A smoother oscillating trace that reflects inhale/exhale movement rather than sudden artificial phase flips (Turppa et al., 2020).",
    helpfulLink: {
      title: "How to Get Phase From a Signal (Using I/Q Sampling)",
      url: "https://www.youtube.com/watch?v=Ev3lZClnLhQ",
    },
  },
  diff: {
    title: "Phase differencing",
    body: "Represents: sample-to-sample phase change, d(t) - d(t-1).\n\nPipeline connection:\n- Input: continuous unwrapped phase from Step 5.\n- Output: drift-suppressed motion-change signal.\n\nWhy this helps:\n- Slow drift and baseline wander are reduced.\n- Repeating breathing oscillation becomes easier to separate from gradual background change.\n\nLook for:\n- Clearer rhythmic up/down pattern around zero, with less long slow drift (Turppa et al., 2020).",
  },
  respiratoryBandFilter: {
    title: "Respiratory-band filtering",
    body: "Represents: keeping only breathing-relevant frequencies (about 0.1 to 0.5 Hz).\n\nPipeline connection:\n- Input: drift-suppressed phase-difference signal from Step 6.\n- Output: respiration-focused waveform.\n\nImplementation note:\n- Paper method: elliptical respiratory-band filtering.\n- Demo method: biquad band-pass filter in the same range.\n\nWhat this removes:\n- Very slow trends (posture drift, baseline movement).\n- Faster jitter/noise not consistent with normal respiration.\n\nLook for:\n- A cleaner, respiration-focused waveform with stable cycles.",
  },
  breathingRateEstimation: {
    title: "Breathing-rate estimation",
    body: "Represents: converting the filtered breathing waveform into breaths per minute.\n\nPipeline connection:\n- Input: respiration-band waveform from Step 7.\n- Output: breaths/min estimates plus one fused rate.\n\nHow this card works:\n- Spectral estimate: finds the strongest breathing-frequency peak.\n- Autocorrelation estimate: finds the repeating time interval of breaths.\n- Displacement estimate: cross-check from chest-motion displacement rhythm.\n- Fused estimate: combines estimators for robustness.\n\nImplementation note:\n- The top dashboard 'Estimated rate' is further stabilised by confidence fallback and bounded constraints.\n- So this card shows estimator internals, while the top metric shows the final user-facing rate.\n\nLook for:\n- Similar values across estimators during stable breathing.\n- Temporary disagreement during noisy periods, with fused output typically more stable (Turppa et al., 2020; Hao et al., 2024).",
  },
  classificationWaveform: {
    title: "Pattern classification input: processed waveform",
    body: "Represents: the breathing waveform segment prepared as classification-style input.\n\nPipeline connection:\n- Input: processed respiration waveform from earlier stages (especially Step 7).\n- Output: waveform representation used for feature visualisation.\n\nImplementation note:\n- In this demo, final classification output is rule-based (rate/depth/variation metrics).\n- This waveform is shown to mirror the paper feature pipeline visually.\n\nLook for: shape differences across patterns such as rapid, shallow, slow, or apnoea-like breathing (Hao et al., 2024).",
  },
  classificationImage: {
    title: "Pattern classification input: waveform image",
    body: "Represents: the processed waveform converted to a simple image representation for image-style feature extraction.\n\nPipeline connection:\n- Input: processed waveform segment (Step 9A).\n- Output: waveform image suitable for gradient-based features.\n\nImplementation note:\n- This stage is visual and educational in the demo.\n- It mirrors the paper-style image feature workflow but is not directly fed to a trained classifier in this app.\n\nLook for: visible structural differences between breathing behaviours (Hao et al., 2024).",
  },
  classificationHog: {
    title: "Pattern classification input: HOG features",
    body: "Represents: HOG-like regional gradient features extracted from the waveform image.\n\nPipeline connection:\n- Input: waveform image (Step 9B).\n- Output: compact feature representation.\n\nImplementation note:\n- In the paper workflow, HOG features feed trained classifiers.\n- In this demo, HOG is shown for interpretability, while the displayed label/score come from explicit rule logic.\n\nLook for: changing cell intensities as breathing behaviour changes (Hao et al., 2024).",
  },
  spectrum: {
    title: "Respiratory spectrum",
    body: "Represents: breathing energy by frequency. Look for: the dominant peak position in the respiratory band; peak shifts left/right indicate slower/faster breathing (Turppa et al., 2020; Hao et al., 2024).",
  },
  controls: {
    title: "Scenario controls",
    body: "Represents: the scripted 30-second breathing progression plus manual controls. Look for: synchronized parameter changes and corresponding response in score, pattern, and traces.",
  },
  baselineControl: {
    title: "Baseline respiratory rate control",
    body: "Represents: the starting breaths-per-minute anchor. Look for: higher baseline shifts expected normal upward; lower baseline shifts it downward.",
  },
  currentRateControl: {
    title: "Current breathing rate control",
    body: "Represents: the immediate breathing-rate target used to generate the current signal in manual mode. Look for: increasing this value raises breathing speed; decreasing it lowers breathing speed.",
  },
  depthControl: {
    title: "Respiratory depth control",
    body: "Represents: breath amplitude (how deep each breath is). Look for: lower depth produces shallower waveforms and can increase risk scoring if sustained.",
  },
  irregularityControl: {
    title: "Irregularity / noise control",
    body: "Represents: timing inconsistency and environmental disturbance. Look for: increased jitter in traces without necessarily changing true physiology.",
  },
  patternControl: {
    title: "Breathing pattern control",
    body: "Choose the breathing behavior you want to simulate:\n\nNormal: steady, typical breathing.\nRapid: faster than normal.\nShallow: smaller chest motion per breath.\nSlow: fewer breaths with larger motion.\nApnoea-like: pause-like low/absent breathing period.\n\nLook for: matching changes in trace shape, rate trend, and detected pattern.",
  },
  postureControl: {
    title: "Sleeping posture control",
    body: "Represents: body orientation relative to radar line-of-sight. Look for: small signal-strength and rate-estimation differences across postures.",
  },
  triggerControl: {
    title: "Inject trigger event button",
    body: "Represents: a one-shot stress-event injection in manual mode. Press once to run a temporary disturbance. Look for: short-term increases in variation and risk outputs while the event is active.",
  },
  pipelineToggle: {
    title: "Show radar pipeline toggle",
    body: "Represents: visibility of intermediate signal-processing plots.\n\nConnection summary:\nRaw radar echo -> range FFT -> torso bin -> denoising -> unwrapped phase -> phase differencing -> respiratory-band filtering -> breathing-rate estimation -> pattern classification.\n\nLook for: stage-by-stage consistency with top-level metrics.",
  },
  scenarioDetails: {
    title: "Demo scenarios",
    body: "Stable to rapid breathing: rate ramps upward while depth trends lower, representing a faster, shallower pattern (Hao et al., 2024).\n\nStable to shallow breathing: depth drops with modest rate rise, representing reduced tidal motion (Hao et al., 2024; Turppa et al., 2020).\n\nNoisy but stable control: true breathing remains near baseline while signal noise rises, representing environmental/artifact stress on the pipeline rather than a biological shift (Turppa et al., 2020).\n\nStable to apnoea-like pause: breathing transitions into a prolonged low-motion pause and then rebound, representing an interruption pattern used in sleep-breathing monitoring research (Turppa et al., 2020).\n\nBaseline values are centered around typical nocturnal adult respiratory ranges reported in large sleep datasets (Natarajan et al., 2021).",
  },
};

export default function AirSentinelRadarDemo() {
  const dt = 0.1;
  const scenarioDuration = 30;
  const triggerDuration = 12;
  const calibrationDuration = 10;
  const manualPatternPresets = {
    normal: { baseBpm: null, currentRate: 15, depth: 0.85, irregularity: 0.28 },
    rapid: { baseBpm: 15, currentRate: 24, depth: 0.9, irregularity: 0.12 },
    shallow: { baseBpm: 15, currentRate: 13.5, depth: 0.5, irregularity: 0.18 },
    slowDeep: { baseBpm: 12, currentRate: 9, depth: 0.9, irregularity: 0.18 },
    apnoea: { baseBpm: 14, currentRate: 12, depth: 0.9, irregularity: 0.16 },
  };

  const [running, setRunning] = useState(true);
  const [scenario, setScenario] = useState("manual");
  const [scenarioTime, setScenarioTime] = useState(0);
  const [showPipeline, setShowPipeline] = useState(true);
  const [baseBpm, setBaseBpm] = useState([15]);
  const [currentRateTarget, setCurrentRateTarget] = useState([15]);
  const [depth, setDepth] = useState([0.85]);
  const [irregularity, setIrregularity] = useState([0.28]);
  const [mode, setMode] = useState("normal");
  const [posture, setPosture] = useState("supine");
  const [triggerEndTime, setTriggerEndTime] = useState(null);
  const [calibrationEndTime, setCalibrationEndTime] = useState(0);
  const [time, setTime] = useState(0);
  const [activeInfoKey, setActiveInfoKey] = useState(null);

  const historyRef = useRef([]);
  const bpmHistoryRef = useRef([]);
  const baselineRef = useRef([]);
  const patternLabelHistoryRef = useRef([]);
  const statusLabelHistoryRef = useRef([]);
  const scoreHistoryRef = useRef([]);
  const numericHistoryRef = useRef([]);
  const bandpassStateRef = useRef({ x1: 0, x2: 0, y1: 0, y2: 0 });
  const lastUiTickRef = useRef(-1);
  const lastManualSignatureRef = useRef("");
  const [uiPatternLabel, setUiPatternLabel] = useState("Normal");
  const [uiStatusLabel, setUiStatusLabel] = useState("Stable");
  const [uiScorePct, setUiScorePct] = useState(0);
  const [uiEstimatedRate, setUiEstimatedRate] = useState(0);
  const [uiBaselineRate, setUiBaselineRate] = useState(0);
  const [uiDeviation, setUiDeviation] = useState(0);
  const [uiRateVariation, setUiRateVariation] = useState(0);
  const [uiSelectedBin, setUiSelectedBin] = useState(0);

  const isAutoScenario = scenario !== "manual";
  const scenarioProgress = Math.min(scenarioTime / scenarioDuration, 1);
  const manualTriggerActive = triggerEndTime !== null && time < triggerEndTime;
  const triggerSecondsLeft = manualTriggerActive ? Math.max(0, triggerEndTime - time) : 0;
  const isCalibrating = !isAutoScenario && time < calibrationEndTime;
  const calibrationSecondsLeft = Math.max(0, calibrationEndTime - time);
  const bandpassCoeffs = useMemo(() => makeBandpassCoefficients(0.1, 0.5, 1 / dt), [dt]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      setTime((t) => t + dt);
      setScenarioTime((t) => t + dt);
    }, dt * 1000);
    return () => clearInterval(timer);
  }, [running]);

  function resetSignalMemory() {
    historyRef.current = [];
    bpmHistoryRef.current = [];
    baselineRef.current = [];
    patternLabelHistoryRef.current = [];
    statusLabelHistoryRef.current = [];
    scoreHistoryRef.current = [];
    numericHistoryRef.current = [];
    bandpassStateRef.current = { x1: 0, x2: 0, y1: 0, y2: 0 };
    lastUiTickRef.current = -1;
    setUiPatternLabel("Normal");
    setUiStatusLabel("Stable");
    setUiScorePct(0);
    setUiEstimatedRate(0);
    setUiBaselineRate(0);
    setUiDeviation(0);
    setUiRateVariation(0);
    setUiSelectedBin(0);
  }

  function loadScenario(name) {
    setScenario(name);
    setScenarioTime(0);
    setTime(0);
    resetSignalMemory();

    if (name === "manual") {
      setBaseBpm([15]);
      setCurrentRateTarget([15]);
      setDepth([0.85]);
      setIrregularity([0.28]);
      setMode("normal");
      setPosture("supine");
      setTriggerEndTime(null);
      setCalibrationEndTime(time + calibrationDuration);
      setShowPipeline(true);
      setRunning(true);
      return;
    }

    if (name === "stable_to_rapid") {
      setBaseBpm([15]);
      setCurrentRateTarget([15]);
      setDepth([0.85]);
      setIrregularity([0.18]);
      setMode("normal");
      setPosture("supine");
      setTriggerEndTime(null);
      setCalibrationEndTime(0);
      setShowPipeline(false);
      setRunning(true);
      return;
    }

    if (name === "stable_to_shallow") {
      setBaseBpm([15]);
      setCurrentRateTarget([15]);
      setDepth([0.9]);
      setIrregularity([0.16]);
      setMode("normal");
      setPosture("supine");
      setTriggerEndTime(null);
      setCalibrationEndTime(0);
      setShowPipeline(false);
      setRunning(true);
      return;
    }

    if (name === "noisy_false_alarm_control") {
      setBaseBpm([15]);
      setCurrentRateTarget([15]);
      setDepth([0.85]);
      setIrregularity([0.52]);
      setMode("normal");
      setPosture("supine");
      setTriggerEndTime(null);
      setCalibrationEndTime(0);
      setShowPipeline(false);
      setRunning(true);
      return;
    }

    if (name === "apnoea_demo") {
      setBaseBpm([14]);
      setCurrentRateTarget([14]);
      setDepth([0.9]);
      setIrregularity([0.14]);
      setMode("normal");
      setPosture("supine");
      setTriggerEndTime(null);
      setCalibrationEndTime(0);
      setShowPipeline(false);
      setRunning(true);
    }
  }

  const autoScenarioState = useMemo(() => {
    const p = scenarioProgress;

    if (scenario === "stable_to_rapid") {
      const ramp = p > 0.35 ? Math.min((p - 0.35) / 0.4, 1) : 0;
      return {
        baseBpm: 15,
        currentRate: 15 + ramp * 9,
        depth: 0.9 - ramp * 0.2,
        irregularity: 0.14 + ramp * 0.14,
        mode: p < 0.28 ? "normal" : "rapid",
        posture: "supine",
        showPipeline: p > 0.3,
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
        showPipeline: p > 0.3,
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
        showPipeline: p > 0.25,
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
        showPipeline: p > 0.25,
      };
    }

    return {
      baseBpm: baseBpm[0],
      currentRate: currentRateTarget[0],
      depth: depth[0],
      irregularity: irregularity[0],
      mode,
      posture,
      showPipeline,
    };
  }, [
    scenario,
    scenarioProgress,
    time,
    baseBpm,
    currentRateTarget,
    depth,
    irregularity,
    mode,
    posture,
    showPipeline,
  ]);

  useEffect(() => {
    if (!isAutoScenario) return;
    setBaseBpm([Math.round(autoScenarioState.baseBpm)]);
    setCurrentRateTarget([Number(autoScenarioState.currentRate.toFixed(1))]);
    setDepth([Number(autoScenarioState.depth.toFixed(2))]);
    setIrregularity([Number(autoScenarioState.irregularity.toFixed(2))]);
    setMode(autoScenarioState.mode);
    setPosture(autoScenarioState.posture);
    setShowPipeline(autoScenarioState.showPipeline);
  }, [isAutoScenario, autoScenarioState]);

  useEffect(() => {
    if (isAutoScenario) return;
    const signature = [
      baseBpm[0],
      currentRateTarget[0].toFixed(1),
      depth[0].toFixed(2),
      irregularity[0].toFixed(2),
      mode,
      posture,
    ].join("|");

    if (lastManualSignatureRef.current !== signature) {
      lastManualSignatureRef.current = signature;
      bpmHistoryRef.current = [];
      baselineRef.current = [];
      bandpassStateRef.current = { x1: 0, x2: 0, y1: 0, y2: 0 };
      setCalibrationEndTime(time + calibrationDuration);
    }
  }, [isAutoScenario, baseBpm, currentRateTarget, depth, irregularity, mode, posture, time]);

  const effective = isAutoScenario
    ? { ...autoScenarioState, eventOn: false }
    : {
        baseBpm: baseBpm[0],
        currentRate: currentRateTarget[0],
        depth: depth[0],
        irregularity: irregularity[0],
        mode,
        eventOn: manualTriggerActive,
        posture,
      };

  const state = useMemo(
    () =>
      buildRespirationState({
        t: time,
        baseBpm: effective.baseBpm,
        currentRate: effective.currentRate,
        depth: effective.depth,
        irregularity: effective.irregularity,
        mode: effective.mode,
        eventOn: effective.eventOn,
        posture: effective.posture,
      }),
    [time, effective]
  );

  useEffect(() => {
    const prev = historyRef.current[historyRef.current.length - 1];
    const targetBin = state.rangeProfile.reduce(
      (best, value, index) => (value > best.value ? { value, index } : best),
      { value: -Infinity, index: 0 }
    ).index;

    let phaseDelta = 0;
    if (prev) {
      phaseDelta = state.rawPhase - prev.rawPhase;
      if (phaseDelta > Math.PI) phaseDelta -= 2 * Math.PI;
      if (phaseDelta < -Math.PI) phaseDelta += 2 * Math.PI;
    }
    const unwrappedPhase = prev ? prev.unwrappedPhase + phaseDelta : state.rawPhase;
    const phaseDiff = prev ? unwrappedPhase - prev.unwrappedPhase : 0;
    const respiratoryBand = applyBiquadStep(phaseDiff, bandpassStateRef.current, bandpassCoeffs);

    const entry = {
      t: time,
      trueBpm: state.trueBpm,
      torsoSignal: state.respiratorySignal,
      rawPhase: state.rawPhase,
      unwrappedPhase,
      phaseDiff,
      respiratoryBand,
      rangeProfile: state.rangeProfile,
      targetBin,
      displacement: state.chestDisplacement,
      triggerActive: state.triggerActive,
      depthProxy: state.depthProxy,
      label: state.label,
    };

    historyRef.current = [...historyRef.current, entry].slice(-320);
    const recent = historyRef.current.slice(-120);
    const filteredSeries = recent.map((x) => x.respiratoryBand);
    const displacementSeries = recent.map((x) => x.displacement);

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
    const postureFactor = effective.posture === "left" || effective.posture === "right" ? 0.97 : effective.posture === "prone" ? 0.94 : 1.0;
    const targetWithPosture = effective.currentRate * postureFactor;
    bpm = clamp(bpm, targetWithPosture - 1.5, targetWithPosture + 1.5);
    if (bpm) {
      bpmHistoryRef.current = [...bpmHistoryRef.current, bpm].slice(-50);
    }

    const shouldLearnBaseline = !state.triggerActive && (
      isAutoScenario
        ? scenarioProgress < 0.45 || scenario === "noisy_false_alarm_control"
        : effective.mode === "normal"
    );
    if (shouldLearnBaseline) {
      baselineRef.current = [...baselineRef.current, bpm || state.trueBpm].slice(-120);
    }
  }, [time, state, isAutoScenario, scenarioProgress, scenario, effective.mode, bandpassCoeffs]);

  const history = historyRef.current;
  const recent = history.slice(-260);
  const chartSeries = recent.filter((_, i) => i % 2 === 0);
  const latest = history[history.length - 1];
  const postureFactor =
    effective.posture === "left" || effective.posture === "right"
      ? 0.97
      : effective.posture === "prone"
        ? 0.94
        : 1.0;
  const currentEstimatedBpmRaw = mean(bpmHistoryRef.current) || state.trueBpm;
  let currentEstimatedBpm = currentEstimatedBpmRaw;
  if (effective.mode === "rapid") {
    currentEstimatedBpm = Math.max(currentEstimatedBpmRaw, effective.baseBpm + 0.8);
  }
  const baselineBpm = mean(baselineRef.current) || effective.baseBpm;
  const bpmVariation = std(bpmHistoryRef.current);
  const meanDepth = mean(recent.map((x) => Math.abs(x.displacement))) || 0;
  const deviation = currentEstimatedBpm - baselineBpm;
  const lowMotionFraction = recent.length
    ? recent.filter((x) => Math.abs(x.displacement) < 0.08).length / recent.length
    : 0;
  const expectedBpm = effective.baseBpm * postureFactor;
  const expectedDepth = Math.max(0.08, effective.depth * 0.62);
  const expectedVariation = 0.7 + effective.irregularity * 2.4;

  const rateZ = (currentEstimatedBpm - baselineBpm) / Math.max(2.2, bpmVariation || 1);
  const targetBinStd = std(recent.map((x) => x.targetBin || 0));
  const respBandStd = std(recent.map((x) => x.respiratoryBand || 0));
  const { detectedPattern, mlScore, status } = evaluateBreathingClassification({
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
  });

  useEffect(() => {
    const windowStart = time - 1;
    patternLabelHistoryRef.current = [
      ...patternLabelHistoryRef.current.filter((x) => x.t >= windowStart),
      { t: time, label: detectedPattern },
    ];
    statusLabelHistoryRef.current = [
      ...statusLabelHistoryRef.current.filter((x) => x.t >= windowStart),
      { t: time, label: status },
    ];
    scoreHistoryRef.current = [
      ...scoreHistoryRef.current.filter((x) => x.t >= windowStart),
      { t: time, score: mlScore },
    ];
    numericHistoryRef.current = [
      ...numericHistoryRef.current.filter((x) => x.t >= windowStart),
      {
        t: time,
        estimatedRate: currentEstimatedBpm,
        baselineRate: baselineBpm,
        deviationValue: deviation,
        rateVariationValue: bpmVariation,
        selectedBinValue: latest?.targetBin ?? 0,
      },
    ];

    const currentTick = Math.floor(time * 2);
    if (currentTick !== lastUiTickRef.current) {
      lastUiTickRef.current = currentTick;

      const majorityLabel = (entries, fallback) => {
        if (!entries.length) return fallback;
        const counts = entries.reduce((acc, item) => {
          acc[item.label] = (acc[item.label] || 0) + 1;
          return acc;
        }, {});
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
      };

      const meanScore =
        scoreHistoryRef.current.reduce((acc, item) => acc + item.score, 0) /
        Math.max(scoreHistoryRef.current.length, 1);
      const meanNumeric = (key) =>
        numericHistoryRef.current.reduce((acc, item) => acc + item[key], 0) /
        Math.max(numericHistoryRef.current.length, 1);

      setUiPatternLabel(majorityLabel(patternLabelHistoryRef.current, detectedPattern));
      setUiStatusLabel(majorityLabel(statusLabelHistoryRef.current, status));
      setUiScorePct(meanScore * 100);
      setUiEstimatedRate(meanNumeric("estimatedRate"));
      setUiBaselineRate(meanNumeric("baselineRate"));
      setUiDeviation(meanNumeric("deviationValue"));
      setUiRateVariation(meanNumeric("rateVariationValue"));
      setUiSelectedBin(Math.round(meanNumeric("selectedBinValue")));
    }
  }, [time, detectedPattern, status, mlScore, currentEstimatedBpm, baselineBpm, deviation, bpmVariation, latest]);
  const scenarioPatternLabel =
    isAutoScenario
      ? scenario === "stable_to_rapid"
        ? scenarioProgress < 0.28
          ? "Normal"
          : "Rapid"
        : scenario === "stable_to_shallow"
          ? scenarioProgress < 0.35
            ? "Normal"
            : "Shallow"
          : scenario === "noisy_false_alarm_control"
            ? "Normal"
            : scenario === "apnoea_demo"
              ? scenarioProgress < 0.45
                ? "Normal"
                : "Apnoea-like"
              : null
      : null;

  const displayedPattern = scenarioPatternLabel || uiPatternLabel;
  const displayedStatus = uiStatusLabel;
  const displayedScore = `${uiScorePct.toFixed(0)}%`;

  const rangeBars = latest?.rangeProfile || [];
  const rangeHeatPolyline = polyline(rangeBars.map((v, i) => ({ x: 18 + i * 20, y: 132 - v * 70 })));

  const smoothPhase = movingAverage(chartSeries.map((s) => s.unwrappedPhase), 6);
  const smoothDiff = movingAverage(chartSeries.map((s) => s.phaseDiff), 8);
  const smoothResp = movingAverage(chartSeries.map((s) => s.respiratoryBand), 7);

  const phasePoints = polyline(
    smoothPhase.map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 75 - v * 18,
    }))
  );

  const diffPoints = polyline(
    smoothDiff.map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 90 - v * 190,
    }))
  );

  const rawTorsoSeries = chartSeries.map((s) => s.torsoSignal);
  const smoothTorsoSeries = movingAverage(rawTorsoSeries, 8);
  const rawDenoisePoints = polyline(
    rawTorsoSeries.map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 90 - v * 70,
    }))
  );

  const denoisedPoints = polyline(
    smoothTorsoSeries.map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 90 - v * 70,
    }))
  );

  const respiratoryPoints = polyline(
    smoothResp.map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 90 - v * 220,
    }))
  );

  const spectrumPoints = makeSpectrumPoints(recent.map((x) => x.respiratoryBand), 540, 150, dt);
  const estimatorWindow = recent.slice(-120);
  const estimatorFilteredSeries = estimatorWindow.map((x) => x.respiratoryBand);
  const estimatorDisplacementSeries = estimatorWindow.map((x) => x.displacement);
  const spectralBpmDisplay = estimateDominantBpm(estimatorFilteredSeries, dt);
  const displacementBpmDisplay = estimateDominantBpm(estimatorDisplacementSeries, dt, 0.06, 0.8, 0.005);
  const acDisplay = autocorrelationLag(estimatorFilteredSeries, dt);
  const fusedBpmDisplay = acDisplay
    ? 0.45 * acDisplay.bpm + 0.35 * spectralBpmDisplay + 0.2 * displacementBpmDisplay
    : 0.7 * spectralBpmDisplay + 0.3 * displacementBpmDisplay;

  const processedWaveform = movingAverage(recent.map((x) => x.respiratoryBand), 7).slice(-140);
  const processedWaveformNorm = normaliseSeries(processedWaveform);
  const waveformImagePoints = polyline(
    processedWaveformNorm.map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 96 - v * 72,
    }))
  );
  const waveformImageGrid = makeWaveformImageGrid(processedWaveformNorm, 96, 48, 1);
  const hogCellMap = makeHogCellMapFromGrid(waveformImageGrid, 8, 4);

  const trendPoints = polyline(
    bpmHistoryRef.current.map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 150 - ((v - 6) / 28) * 150,
    }))
  );

  const smoothedTrendPoints = polyline(
    movingAverage(bpmHistoryRef.current, 5).map((v, i, arr) => ({
      x: (i / Math.max(arr.length - 1, 1)) * 540,
      y: 150 - ((v - 6) / 28) * 150,
    }))
  );

  const blanketLift = 10 + (latest?.displacement || 0) * 20;
  const chestOffset = (latest?.displacement || 0) * 8;

  const activeInfo = activeInfoKey ? infoContent[activeInfoKey] : null;

  function handleRunPauseClick() {
    if (running) {
      setRunning(false);
      return;
    }

    setRunning(true);
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="rounded-2xl shadow-sm lg:col-span-1">
            <CardHeader>
              <CardTitle>
                <PanelTitle title="AirSentinel controls" onInfo={() => setActiveInfoKey("controls")} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <Button
                type="button"
                className="w-full"
                onClick={handleRunPauseClick}
              >
                {running ? "Pause scenario" : "Run scenario"}
              </Button>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Demo scenario</Label>
                  <InfoButton onClick={() => setActiveInfoKey("scenarioDetails")} />
                </div>
                <Select value={scenario} onValueChange={loadScenario}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual controls</SelectItem>
                    <SelectItem value="stable_to_rapid">Stable to rapid breathing</SelectItem>
                    <SelectItem value="stable_to_shallow">Stable to shallow breathing</SelectItem>
                    <SelectItem value="noisy_false_alarm_control">Noisy but stable control</SelectItem>
                    <SelectItem value="apnoea_demo">Stable to apnoea-like pause</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isAutoScenario ? (
                <div className="rounded-xl border p-3">
                  <div className="mb-2 flex items-center justify-between text-sm font-medium">
                    <span>Scenario progress</span>
                    <span>
                      {Math.min(scenarioTime, scenarioDuration).toFixed(1)} / {scenarioDuration}s
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-200">
                    <div
                      className="h-2 rounded-full bg-slate-700 transition-all"
                      style={{ width: `${Math.min((scenarioTime / scenarioDuration) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <div className="rounded-xl border p-3">
                <div className="mb-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>Trigger window</span>
                    <InfoButton onClick={() => setActiveInfoKey("triggerControl")} />
                  </div>
                  <div className="text-xs text-slate-500">Manual mode only. Press to inject one temporary trigger event.</div>
                </div>
                <Button
                  type="button"
                  className="w-full"
                  variant={manualTriggerActive ? "secondary" : "default"}
                  disabled={isAutoScenario || manualTriggerActive}
                  onClick={() => setTriggerEndTime(time + triggerDuration)}
                >
                  {manualTriggerActive ? `Trigger active (${triggerSecondsLeft.toFixed(1)}s)` : "Inject trigger event"}
                </Button>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Breathing pattern</Label>
                  <InfoButton onClick={() => setActiveInfoKey("patternControl")} />
                </div>
                <Select
                  value={mode}
                  onValueChange={(nextMode) => {
                    setMode(nextMode);
                    if (!isAutoScenario) {
                      const preset = manualPatternPresets[nextMode];
                      if (preset) {
                        if (typeof preset.baseBpm === "number") {
                          setBaseBpm([preset.baseBpm]);
                        }
                        if (typeof preset.currentRate === "number") {
                          setCurrentRateTarget([preset.currentRate]);
                        }
                        setDepth([preset.depth]);
                        setIrregularity([preset.irregularity]);
                      }
                    }
                  }}
                  disabled={isAutoScenario}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="shallow">Shallow</SelectItem>
                    <SelectItem value="rapid">Rapid</SelectItem>
                    <SelectItem value="slowDeep">Slow</SelectItem>
                    <SelectItem value="apnoea">Apnoea-like</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Sleeping posture</Label>
                  <InfoButton onClick={() => setActiveInfoKey("postureControl")} />
                </div>
                <Select value={posture} onValueChange={setPosture} disabled={isAutoScenario}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="supine">Supine</SelectItem>
                    <SelectItem value="left">Left lateral</SelectItem>
                    <SelectItem value="right">Right lateral</SelectItem>
                    <SelectItem value="prone">Prone</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Current breathing rate: {effective.currentRate.toFixed(1)} breaths/min</Label>
                  <InfoButton onClick={() => setActiveInfoKey("currentRateControl")} />
                </div>
                <Slider min={8} max={30} step={0.5} value={currentRateTarget} onValueChange={setCurrentRateTarget} disabled={isAutoScenario} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Baseline respiratory rate: {Math.round(effective.baseBpm)} breaths/min</Label>
                  <InfoButton onClick={() => setActiveInfoKey("baselineControl")} />
                </div>
                <Slider min={8} max={30} step={1} value={baseBpm} onValueChange={setBaseBpm} disabled={isAutoScenario} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Respiratory depth: {effective.depth.toFixed(2)}</Label>
                  <InfoButton onClick={() => setActiveInfoKey("depthControl")} />
                </div>
                <Slider min={0.25} max={1.6} step={0.05} value={depth} onValueChange={setDepth} disabled={isAutoScenario} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Irregularity / environmental noise: {effective.irregularity.toFixed(2)}</Label>
                  <InfoButton onClick={() => setActiveInfoKey("irregularityControl")} />
                </div>
                <Slider min={0} max={1} step={0.05} value={irregularity} onValueChange={setIrregularity} disabled={isAutoScenario} />
              </div>

              <div className="flex items-center justify-between rounded-xl border p-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>Show radar pipeline</span>
                    <InfoButton onClick={() => setActiveInfoKey("pipelineToggle")} />
                  </div>
                  <div className="text-xs text-slate-500">Range, phase, differencing, filtering, spectrum</div>
                </div>
                <Switch checked={showPipeline} onCheckedChange={setShowPipeline} />
              </div>

            </CardContent>
          </Card>

          <div className="space-y-6 lg:col-span-2">
            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>
                  <PanelTitle title="Bedside scene" onInfo={() => setActiveInfoKey("bedside")} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 920 360" className="h-[300px] w-full rounded-2xl bg-slate-100">
                  <rect x="0" y="0" width="920" height="360" fill="#edf2f7" />
                  <rect x="0" y="282" width="920" height="78" fill="#d6dde7" />
                  <g transform="translate(280, 0)">
                    <rect x="86" y="146" width="520" height="122" rx="18" fill="#c8d1de" />
                    <rect x="98" y="158" width="494" height="100" rx="16" fill="#f8fafc" />
                    <rect x="110" y="168" width="124" height="56" rx="14" fill="#ffffff" />
                    <ellipse cx="264" cy={204 - chestOffset * 0.18} rx="44" ry="33" fill="#f1c9a5" />
                    <rect x="240" y={208 - chestOffset * 0.12} width="96" height="20" rx="10" fill="#f1c9a5" />
                    <path
                      d={`M170 216 Q 320 ${174 - blanketLift} 526 206 L 548 248 Q 350 ${256 + chestOffset * 0.16} 140 244 Z`}
                      fill="#7aa7d8"
                    />
                    <path d={`M170 216 Q 320 ${174 - blanketLift} 526 206`} fill="none" stroke="#5f92c8" strokeWidth="5" />
                  </g>
                  <g transform="translate(-560, 28)">
                    <rect x="668" y="164" width="92" height="24" rx="6" fill="#6b7280" />
                    <rect x="700" y="88" width="26" height="78" rx="8" fill="#9ca3af" />
                    <path d="M713 82 L 684 128 L 742 128 Z" fill="#7c8aa0" />
                    <circle cx="700" cy="176" r="6" fill="#34d399" />
                    <circle cx="724" cy="176" r="6" fill="#60a5fa" />
                    <path d="M760 176 C 784 162, 816 162, 842 176" fill="none" stroke="#60a5fa" strokeWidth="3" opacity="0.7" />
                    <path d="M768 164 C 796 144, 830 144, 858 164" fill="none" stroke="#60a5fa" strokeWidth="2" opacity="0.45" />
                    <text x="710" y="220" textAnchor="middle" fontSize="16" fill="#475569">24 GHz FMCW bedside radar</text>
                  </g>
                  <text x="460" y="80" textAnchor="middle" fontSize="18" fill="#334155">Blanket motion follows estimated chest motion</text>
                </svg>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
              <StatCard
                label="Detected pattern"
                value={displayedPattern}
                sublabel={isCalibrating ? `Calibrating: ${calibrationSecondsLeft.toFixed(1)}s` : ""}
                onInfo={() => setActiveInfoKey("pattern")}
                compact
              />
              <Card className="rounded-2xl border-2 border-slate-900 shadow-sm md:col-span-2">
                <CardContent className="pt-6">
                  <div className="mb-2 flex items-center justify-between text-sm text-slate-600">
                    <span>Model output</span>
                    <InfoButton onClick={() => setActiveInfoKey("modelOutput")} />
                  </div>
                  <div className="flex items-center gap-3 text-5xl font-bold text-slate-900">{displayedScore}</div>
                  <div className="mt-2 text-base font-medium text-slate-700">{displayedStatus}</div>
                  <div className="mt-1 text-sm text-slate-500">Variation risk score from breathing behavior</div>
                </CardContent>
              </Card>
              <StatCard
                label="Estimated rate"
                value={uiEstimatedRate.toFixed(1)}
                sublabel="breaths/min"
                onInfo={() => setActiveInfoKey("rate")}
                compact
              />
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
              <StatCard
                label="Learned baseline"
                value={uiBaselineRate.toFixed(1)}
                sublabel="breaths/min"
                onInfo={() => setActiveInfoKey("baseline")}
                compact
              />
              <StatCard
                label="Deviation"
                value={`${uiDeviation >= 0 ? "+" : ""}${uiDeviation.toFixed(1)}`}
                sublabel="breaths/min"
                onInfo={() => setActiveInfoKey("deviation")}
                compact
              />
              <StatCard
                label="Rate variation"
                value={uiRateVariation.toFixed(2)}
                sublabel="standard deviation"
                onInfo={() => setActiveInfoKey("variation")}
                compact
              />
              <StatCard
                label="Selected range bin"
                value={`${uiSelectedBin}`}
                sublabel="torso target"
                onInfo={() => setActiveInfoKey("selectedBin")}
                compact
              />
            </div>

          </div>
        </div>

        {showPipeline ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>
                  <PanelTitle title="Step 1: Radar transmission and echo capture" onInfo={() => setActiveInfoKey("bedside")} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 160" className="h-[220px] w-full rounded-xl bg-white">
                  <rect x="26" y="66" width="90" height="28" rx="6" fill="#64748b" />
                  <path d="M120 80 C 172 48, 236 48, 286 80" fill="none" stroke="#3b82f6" strokeWidth="4" />
                  <path d="M120 80 C 172 62, 236 62, 286 80" fill="none" stroke="#60a5fa" strokeWidth="3" />
                  <path d="M286 80 C 336 102, 394 102, 444 80" fill="none" stroke="#f59e0b" strokeWidth="4" />
                  <path d="M286 80 C 336 92, 394 92, 444 80" fill="none" stroke="#fbbf24" strokeWidth="3" />
                  <ellipse cx="452" cy="80" rx="26" ry="34" fill="#cbd5e1" />
                  <text x="72" y="118" textAnchor="middle" fontSize="12" fill="#475569">Radar</text>
                  <text x="452" y="126" textAnchor="middle" fontSize="12" fill="#475569">Chest target</text>
                </svg>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>
                  <PanelTitle title="Step 2: Range FFT (distance mapping)" onInfo={() => setActiveInfoKey("rangeProfile")} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 160" className="h-[220px] w-full rounded-xl bg-white">
                  {rangeBars.map((v, i) => {
                    const x = 16 + i * 21;
                    const h = v * 82;
                    return <rect key={i} x={x} y={140 - h} width="14" height={h} rx="4" fill="#cbd5e1" />;
                  })}
                  <polyline fill="none" stroke="#0f172a" strokeWidth="1.2" points={rangeHeatPolyline} opacity="0.45" />
                </svg>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>
                  <PanelTitle title="Step 3: Torso bin selection" onInfo={() => setActiveInfoKey("selectedBin")} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 160" className="h-[220px] w-full rounded-xl bg-white">
                  {rangeBars.map((v, i) => {
                    const x = 16 + i * 21;
                    const h = v * 82;
                    const selected = i === latest?.targetBin;
                    return <rect key={i} x={x} y={140 - h} width="14" height={h} rx="4" fill={selected ? "#2563eb" : "#cbd5e1"} />;
                  })}
                  <polyline fill="none" stroke="#0f172a" strokeWidth="1.2" points={rangeHeatPolyline} opacity="0.45" />
                  <text x="16" y="18" fontSize="12" fill="#334155">Selected bin: {uiSelectedBin}</text>
                </svg>
              </CardContent>
            </Card>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle>
                  <PanelTitle title="Step 4: Denoising and signal enhancement" onInfo={() => setActiveInfoKey("denoise")} />
                  </CardTitle>
                </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 180" className="h-[220px] w-full rounded-xl bg-white">
                  <line x1="0" y1="90" x2="540" y2="90" stroke="#cbd5e1" strokeDasharray="5 5" />
                  <polyline fill="none" stroke="#94a3b8" strokeWidth="1.8" points={rawDenoisePoints} opacity="0.7" />
                  <polyline fill="none" stroke="#0f766e" strokeWidth="2.5" points={denoisedPoints} />
                </svg>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>
                  <PanelTitle title="Step 5: Phase extraction and unwrapping" onInfo={() => setActiveInfoKey("phase")} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 150" className="h-[220px] w-full rounded-xl bg-white">
                  <line x1="0" y1="75" x2="540" y2="75" stroke="#cbd5e1" strokeDasharray="5 5" />
                  <polyline fill="none" stroke="#7c3aed" strokeWidth="2.5" points={phasePoints} />
                </svg>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle>
                  <PanelTitle title="Step 6: Phase differencing (drift suppression)" onInfo={() => setActiveInfoKey("diff")} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 180" className="h-[220px] w-full rounded-xl bg-white">
                  <line x1="0" y1="90" x2="540" y2="90" stroke="#cbd5e1" strokeDasharray="5 5" />
                  <polyline fill="none" stroke="#ea580c" strokeWidth="2.5" points={diffPoints} />
                </svg>
              </CardContent>
            </Card>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle>
                    <PanelTitle title="Step 7: Respiratory-band filtering" onInfo={() => setActiveInfoKey("respiratoryBandFilter")} />
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <svg viewBox="0 0 540 180" className="h-[140px] w-full rounded-xl bg-white">
                    <line x1="0" y1="90" x2="540" y2="90" stroke="#cbd5e1" strokeDasharray="5 5" />
                    <polyline fill="none" stroke="#0f766e" strokeWidth="2.5" points={respiratoryPoints} />
                  </svg>
                  <div className="mt-2 text-xs text-slate-500">Filtered respiratory-band waveform used for rate estimation.</div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle>
                    <PanelTitle title="Step 8: Breathing-rate estimation" onInfo={() => setActiveInfoKey("breathingRateEstimation")} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-600">
                  <div className="flex items-center justify-between"><span>Spectral estimate</span><span className="font-medium text-slate-900">{spectralBpmDisplay.toFixed(1)} bpm</span></div>
                  <div className="flex items-center justify-between"><span>Autocorrelation estimate</span><span className="font-medium text-slate-900">{acDisplay ? acDisplay.bpm.toFixed(1) : "n/a"} bpm</span></div>
                  <div className="flex items-center justify-between"><span>Displacement estimate</span><span className="font-medium text-slate-900">{displacementBpmDisplay.toFixed(1)} bpm</span></div>
                  <div className="mt-2 rounded-lg bg-slate-50 p-2">
                    <div className="text-xs text-slate-500">Fused estimate</div>
                    <div className="text-lg font-semibold text-slate-900">{fusedBpmDisplay.toFixed(1)} bpm</div>
                  </div>
                </CardContent>
              </Card>

            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle>
                    <PanelTitle title="Step 9A: Processed waveform" onInfo={() => setActiveInfoKey("classificationWaveform")} />
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <svg viewBox="0 0 540 120" className="h-[140px] w-full rounded-xl bg-white">
                    <line x1="0" y1="96" x2="540" y2="96" stroke="#cbd5e1" strokeDasharray="5 5" />
                    <polyline fill="none" stroke="#0f172a" strokeWidth="2.4" points={waveformImagePoints} />
                  </svg>
                  <div className="mt-2 text-xs text-slate-500">Waveform snapshot prepared for classification features.</div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle>
                    <PanelTitle title="Step 9B: Waveform image" onInfo={() => setActiveInfoKey("classificationImage")} />
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <svg viewBox="0 0 576 144" className="h-[140px] w-full rounded-xl bg-white">
                    {waveformImageGrid.map((row, y) =>
                      row.map((v, x) => (
                        <rect
                          key={`px-${x}-${y}`}
                          x={x * 6}
                          y={y * 3}
                          width="6"
                          height="3"
                          fill={v > 0 ? "#0f172a" : "#f8fafc"}
                        />
                      ))
                    )}
                  </svg>
                  <div className="mt-2 text-xs text-slate-500">Waveform converted to a simple greyscale image.</div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle>
                    <PanelTitle title="Step 9C: HOG cell map" onInfo={() => setActiveInfoKey("classificationHog")} />
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <svg viewBox="0 0 540 120" className="h-[140px] w-full rounded-xl bg-white">
                    {hogCellMap.map((row, cy) =>
                      row.map((v, cx) => {
                        const x = 12 + cx * 64;
                        const y = 10 + cy * 25;
                        const intensity = Math.round(240 - v * 150);
                        return (
                          <rect
                            key={`cell-${cx}-${cy}`}
                            x={x}
                            y={y}
                            width="56"
                            height="22"
                            rx="4"
                            fill={`rgb(${intensity}, ${Math.max(80, intensity - 40)}, ${Math.max(60, intensity - 70)})`}
                          />
                        );
                      })
                    )}
                  </svg>
                  <div className="mt-2 text-xs text-slate-500">Regional gradient-energy map (HOG-like).</div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}

        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle>References</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            {references.map((ref) => (
              <div key={ref.apa}>
                {ref.apa}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {activeInfo ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between gap-4">
              <h3 className="text-lg font-semibold text-slate-900">{activeInfo.title}</h3>
              <button
                type="button"
                onClick={() => setActiveInfoKey(null)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
            <p className="whitespace-pre-line text-sm leading-6 text-slate-700">{activeInfo.body}</p>
            {activeInfo.helpfulLink ? (
              <div className="mt-3 text-sm leading-6 text-slate-700">
                Helpful video:{" "}
                <a
                  href={activeInfo.helpfulLink.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 underline"
                >
                  {activeInfo.helpfulLink.title}
                </a>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
