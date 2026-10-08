// A range slider with arrow buttons either side, for fine steps (and for touch screens, where dragging is imprecise).
// Holding a button repeats the step.
import { useEffect, useRef } from "react";

const Chevron = ({ dir }) => (
  <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d={dir < 0 ? "M7.5 2 3.5 6l4 4" : "M4.5 2l4 4-4 4"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const decimals = (n) => (String(n).split(".")[1] || "").length;

export default function RangeInput({ value, onChange, min = 0, max = 100, step = 1, label, ...rest }) {
  const latest = useRef({ value, onChange, min, max, step });
  latest.current = { value, onChange, min, max, step };
  const timer = useRef(null);
  const stop = () => { clearTimeout(timer.current); clearInterval(timer.current); };
  useEffect(() => stop, []);

  const nudge = (dir) => {
    const c = latest.current;
    const places = Math.max(decimals(c.step), decimals(c.min));
    const next = Math.min(c.max, Math.max(c.min, Number((Number(c.value) + dir * c.step).toFixed(places))));
    if (next !== Number(c.value)) c.onChange(next);
  };
  const hold = (dir) => (e) => {
    e.preventDefault();
    stop();
    nudge(dir);
    timer.current = setTimeout(() => { timer.current = setInterval(() => nudge(dir), 70); }, 400);
  };
  const arrow = (dir, text, name) => (
    <button type="button" className="range-step" aria-label={`${name}${label ? ` ${label}` : ""}`}
      onPointerDown={hold(dir)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nudge(dir); } }}
      disabled={dir < 0 ? Number(value) <= min : Number(value) >= max}>{text}</button>
  );

  return (
    <div className="range-row">
      {arrow(-1, <Chevron dir={-1} />, "Decrease")}
      <input type="range" className="range-input" aria-label={label} value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))} {...rest} />
      {arrow(1, <Chevron dir={1} />, "Increase")}
    </div>
  );
}
