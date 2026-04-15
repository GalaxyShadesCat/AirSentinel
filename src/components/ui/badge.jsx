import React from "react";

export function Badge({ className = "", ...props }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700 ${className}`.trim()}
      {...props}
    />
  );
}
