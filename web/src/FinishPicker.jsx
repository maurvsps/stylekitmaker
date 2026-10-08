import { FINISH_GROUPS, matchFinish } from "./finishes.js";

/** The finishes in groups, as small cards with a swatch. onPick(preset) gets the whole preset ({ id, label, finish }). */
export default function FinishPicker({ finish, onPick }) {
  const active = matchFinish(finish)?.id;
  return (
    <div className="finish-picker">
      {FINISH_GROUPS.map((group) => (
        <div key={group.id} className="finish-group" role="radiogroup" aria-label={group.label}>
          <span className="finish-group-label">{group.label}</span>
          <div className="finish-grid">
            {group.items.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={active === p.id} className={`finish-card${active === p.id ? " on" : ""}`} onClick={() => onPick(p)}>
                <span className="finish-swatch" style={{ background: p.swatch }} aria-hidden="true" />
                <span className="finish-name">{p.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
