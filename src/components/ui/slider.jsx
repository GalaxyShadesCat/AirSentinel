import React from "react";

export function Slider({ min = 0, max = 100, step = 1, value = [0], onValueChange, className = "" }) {
  const current = Array.isArray(value) ? value[0] : value;
  return (
    <input
      className={`h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 ${className}`.trim()}
      type="range"
      min={min}
      max={max}
      step={step}
      value={current}
      onChange={(e) => onValueChange?.([Number(e.target.value)])}
    />
  );
}
