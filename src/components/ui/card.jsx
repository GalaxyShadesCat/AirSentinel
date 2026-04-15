import React from "react";

export function Card({ className = "", ...props }) {
  return <div className={`border bg-white text-slate-900 ${className}`.trim()} {...props} />;
}

export function CardHeader({ className = "", ...props }) {
  return <div className={`flex flex-col space-y-1.5 p-6 ${className}`.trim()} {...props} />;
}

export function CardTitle({ className = "", ...props }) {
  return <h3 className={`text-lg font-semibold leading-none tracking-tight ${className}`.trim()} {...props} />;
}

export function CardContent({ className = "", ...props }) {
  return <div className={`p-6 pt-0 ${className}`.trim()} {...props} />;
}
