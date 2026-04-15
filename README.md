# AirSentinel Breathing Radar Demo

This project is an educational, interactive demo that explains how contactless breathing monitoring with FMCW/mmWave radar works.

It is inspired by two papers:

1. Turppa et al. (2020): Vital-sign extraction from FMCW radar in sleeping scenarios.
2. Hao et al. (2024): Respiration pattern classification with mmWave radar.

## What the Demo Shows in Simple Terms

The dashboard turns tiny chest motion into easy-to-read outputs:

- **Estimated rate**: current breaths per minute.
- **Learned baseline**: your typical recent rate.
- **Deviation**: how far current breathing is from baseline.
- **Rate variation**: how stable or unstable the rhythm is.
- **Detected pattern**: normal / rapid / shallow / slow / apnoea-like.
- **Model output (%)**: one combined “watch level” score.

## Radar Processing Pipeline (Paper-Aligned Demo Implementation)

The papers describe a clear end-to-end flow:

**Radar chirps -> distance selection -> motion extraction -> breathing signal -> rate/pattern output**

### 1. Radar transmission and echo capture
- The radar sends FMCW chirps and receives echoes from objects in front of it, including the chest.
- Each breath causes very small chest movements, which slightly change the returned signal.
- Input: transmitted chirps and reflected echoes from the scene.
- Output: raw radar return signal.

### 2. Range FFT (distance mapping)
- A range FFT converts the raw echo into distance bins (slices by distance from the radar).
- This tells the system where signal energy is coming from in space.
- Input: raw radar return signal.
- Output: range profile (signal energy by distance bin).

### 3. Torso bin selection
- The system selects the bin that best represents the chest/torso location.
- This is important because all later breathing analysis depends on tracking the correct distance bin.
- Input: range profile from Step 2.
- Output: torso-focused signal stream from the selected bin.

### 4. Denoising and signal enhancement
- Hao et al. (2024) aligns signals from multiple receive antennas, then superimposes them (IQ summation with cross-correlation alignment).
- In simple terms: the system lines up several noisy versions of the same chest motion, then combines them so shared breathing information adds up while random noise tends to cancel out.
- This improves signal-to-noise ratio before later steps, so small breathing motion is easier to see reliably.
- Demo implementation note: this app uses a simplified denoising proxy (smoothing) to illustrate the effect rather than full multi-antenna channel alignment.
- Input: torso-focused signal stream from Step 3.
- Output: cleaner torso motion signal.

### 5. Phase extraction and phase unwrapping
- From the selected bin, the system extracts phase over time (slow time).
- Phase is the part of the radar signal that is most sensitive to tiny forward/back chest movement.
- Simple meaning of "unwrap": phase behaves like a clock angle, so when it passes the end of the circle it appears to jump suddenly. Unwrapping stitches those jump points back into one smooth line.
- Helpful video: [How to Get Phase From a Signal (Using I/Q Sampling)](https://www.youtube.com/watch?v=Ev3lZClnLhQ)
- Input: cleaner torso motion signal from Step 4.
- Output: continuous phase-motion trace.

### 6. Phase differencing (drift suppression)
- The papers use backward differencing, d(t) - d(t-1).
- This compares each sample with the previous sample, so very slow baseline drift is reduced.
- Breathing is periodic, so after differencing its up/down rhythm becomes more visible than slow environmental drift.
- Input: unwrapped phase-motion trace from Step 5.
- Output: drift-suppressed phase-difference signal.

### 7. Respiratory-band filtering
- The cleaned signal is filtered to the normal respiration band (`0.1-0.5 Hz`).
- Hao et al. (2024) uses an elliptical filter for this stage.
- This keeps only frequencies where normal adult breathing usually appears and suppresses slower and faster components that are likely not respiration.
- In practical terms, it removes movement trends and high-frequency jitter that can distort rate estimation.
- Demo implementation note: this app uses a digital biquad band-pass filter in the same respiratory range (`0.1-0.5 Hz`) to simulate this stage.
- Input: phase-difference signal from Step 6.
- Output: respiration-focused waveform (`0.1-0.5 Hz`).

### 8. Breathing-rate estimation
- Breathing frequency is estimated from the processed waveform (for example, spectral peak methods).
- Turppa et al. (2020) also uses autocorrelation of the phase signal for robust respiration interval estimation.
- Spectral methods ask: "which frequency has the strongest breathing energy?" and convert that frequency to breaths per minute.
- Autocorrelation asks: "how often does the waveform repeat?" and converts repeating interval to breaths per minute.
- Using more than one estimator improves robustness when one method is uncertain.
- Demo implementation note: this app combines spectral, autocorrelation, and displacement estimates, then applies confidence checks and bounded output constraints for stable demo behaviour.
- Input: respiration-band waveform from Step 7.
- Output: breathing-rate estimate(s) in breaths/min and trend values.

### 9. Pattern classification
- Hao et al. (2024) converts processed breathing waveforms into image features (HOG), then classifies breathing patterns using KNN, SVM, CNN+LSTM, and G-SVM.
- Reported best overall classification accuracy is 94.75% with G-SVM.
- Demo implementation note: this app visualises waveform-image and HOG-like features, but the final label/score are produced by transparent rule-based logic rather than a trained paper classifier.
- Input: processed waveform features plus trend/deviation/depth variability metrics.
- Output: breathing pattern label and model output score.

## How This Repo Relates

- This repository is still a demo, but the displayed stages map to the same paper pipeline steps: range selection, phase tracking, differencing, respiratory-band signal, and rate/pattern outputs.
- The current code uses simplified signal generation and rule-based decision logic for clarity, rather than reproducing full paper training/validation workflows.

## Scenario Mapping to Paper Ideas

- **Stable -> rapid breathing**: shows increasing rate and instability.
- **Stable -> shallow breathing**: shows lower depth with altered rhythm.
- **Noisy but stable control**: shows that noise can stress signal processing without true physiological change.
- **Stable -> apnoea-like pause**: demonstrates low-motion pause behaviour and rebound.

These scenario goals align with how the papers discuss variation in respiratory states and robustness testing.

## Run Locally

```bash
npm install
npm run dev
```

## Sources

1. Turppa E, Kortelainen JM, Antropov O, Kiuru T. *Vital Sign Monitoring Using FMCW Radar in Various Sleeping Scenarios*. Sensors. 2020;20(22):6505. https://doi.org/10.3390/s20226505
2. Hao Z, Wang Y, Li F, Ding G, Gao Y. *mmWave-RM: A Respiration Monitoring and Pattern Classification System Based on mmWave Radar*. Sensors. 2024;24(13):4315. https://doi.org/10.3390/s24134315
3. Natarajan A, Su H-W, Heneghan C, Blunt L, O’Connor C, et al. *Measurement of respiratory rate using wearable devices and applications to COVID-19 detection*. npj Digital Medicine. 2021;4:136. https://doi.org/10.1038/s41746-021-00493-6
