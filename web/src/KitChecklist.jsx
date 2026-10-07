/** What the kit has and what is still missing; each row jumps to its step. */
export default function KitChecklist({ items, onGo }) {
  const done = items.filter((i) => i.done).length;
  return (
    <div className="checklist">
      <div className="checklist-head"><strong>Before you export</strong><span>{done} of {items.length}</span></div>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={i.done ? "done" : ""}>
            <button type="button" className="checklist-row" onClick={() => onGo(i)}>
              <span className="checklist-mark" aria-hidden="true">{i.done ? "✓" : ""}</span>
              <span>{i.label}{i.optional && !i.done ? <small> optional</small> : null}</span>
              <span className="checklist-go" aria-hidden="true">›</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
