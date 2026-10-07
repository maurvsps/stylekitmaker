// A flat front and back of the shirt with a button on every logo position: tap a spot to fill or edit it.
const SHIRT = "M40 8 22 18 8 40l14 8 8-10v62h60V38l8 10 14-8-14-22L80 8c-5 8-35 8-40 0Z";

// Positions as seen by the viewer (the wearer's left is on the viewer's right).
const SPOTS = [
  { id: "brand", label: "Kit brand", side: "front", x: 46, y: 34 },
  { id: "crest", label: "Crest", side: "front", x: 74, y: 34 },
  { id: "shirt-sponsor", label: "Front sponsor", side: "front", x: 60, y: 58 },
  { id: "sleeve-right", label: "Right sleeve", side: "front", x: 13, y: 33 },
  { id: "sleeve-left", label: "Left sleeve", side: "front", x: 107, y: 33 },
  { id: "back-sponsor", label: "Back sponsor", side: "back", x: 60, y: 66 },
];

export default function PlacementMap({ filled, active, palette, onPick }) {
  const fill = palette?.[0] || "#c8102e";
  const trim = palette?.[2] || "#0b1f3a";
  return (
    <figure className="placement-map">
      <svg viewBox="0 0 270 112" role="group" aria-label="Logo positions on the shirt">
        {["front", "back"].map((side, i) => (
          <g key={side} transform={`translate(${i * 150} 0)`}>
            <path d={SHIRT} fill={fill} stroke="rgba(255,255,255,.35)" strokeWidth="1.2" />
            <path d={side === "front" ? "M40 8c5 9 35 9 40 0" : "M40 8c5 4 35 4 40 0"} fill="none" stroke={trim} strokeWidth="2.4" />
            <text x="60" y="108" textAnchor="middle" className="placement-side">{side === "front" ? "Front" : "Back"}</text>
            {SPOTS.filter((s) => s.side === side).map((s) => (
              <g key={s.id} className={`placement-spot${filled[s.id] ? " filled" : ""}${active === s.id ? " active" : ""}`}
                role="button" tabIndex={0} aria-label={`${s.label}${filled[s.id] ? " (filled)" : " (empty)"}`}
                onClick={() => onPick(s.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(s.id); } }}>
                <title>{s.label}</title>
                <circle cx={s.x} cy={s.y} r="8.5" />
                <text x={s.x} y={s.y + 3.4} textAnchor="middle">{filled[s.id] ? "✓" : "+"}</text>
              </g>
            ))}
          </g>
        ))}
      </svg>
      <figcaption>Tap a spot to add or change what goes there.</figcaption>
    </figure>
  );
}
