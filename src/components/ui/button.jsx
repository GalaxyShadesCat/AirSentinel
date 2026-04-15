import React from "react";

const variants = {
  default: "bg-slate-900 text-white hover:bg-slate-800",
  outline: "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
  secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200",
};

export function Button({ className = "", variant = "default", type = "button", ...props }) {
  const variantClass = variants[variant] || variants.default;
  return (
    <button
      type={type}
      className={`inline-flex h-10 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors ${variantClass} ${className}`.trim()}
      {...props}
    />
  );
}
