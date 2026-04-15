import React from "react";

export function Switch({ checked = false, onCheckedChange, className = "" }) {
  return (
    <label className={`inline-flex cursor-pointer items-center ${className}`.trim()}>
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
      />
    </label>
  );
}
