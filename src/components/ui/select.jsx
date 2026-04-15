import React from "react";

function flattenChildren(children, out = []) {
  React.Children.forEach(children, (child) => {
    if (!child) return;
    if (Array.isArray(child)) {
      flattenChildren(child, out);
      return;
    }
    if (child.type === SelectItem) {
      out.push({ value: child.props.value, label: child.props.children });
      return;
    }
    if (child.props?.children) {
      flattenChildren(child.props.children, out);
    }
  });
  return out;
}

export function Select({ value, onValueChange, children }) {
  const options = flattenChildren(children, []);
  return (
    <select
      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function SelectTrigger() {
  return null;
}

export function SelectValue() {
  return null;
}

export function SelectContent() {
  return null;
}

export function SelectItem() {
  return null;
}
