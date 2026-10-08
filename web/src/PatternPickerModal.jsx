import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Popup to choose a pattern, styled like the logo picker. `renderSwatch(def)` draws a pattern's preview.
 * onPick(def) is called with the chosen pattern; the popup closes after.
 */
export default function PatternPickerModal({ isOpen, onClose, patterns, current, renderSwatch, onPick }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    setQuery("");
    const focus = setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => { clearTimeout(focus); removeEventListener("keydown", onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  const q = query.trim().toLowerCase();
  const shown = patterns.filter((p) => !q || p.label.toLowerCase().includes(q));

  return createPortal(
    <div className="sheet-backdrop club-modal-backdrop" onClick={onClose}>
      <div className="sheet club-modal logo-modal" role="dialog" aria-modal="true" aria-label="Choose a pattern" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head club-modal-head">
          <div className="club-modal-title">
            <h2>Patterns</h2>
            <span className="club-modal-subtitle">{patterns.length} designs, painted in your kit colours</span>
          </div>
          <button type="button" className="quiet club-modal-close" onClick={onClose}>Close</button>
        </div>
        <div className="club-modal-body">
          <div className="club-modal-toolbar">
            <div className="club-modal-search">
              <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search patterns (e.g. stripes, stars)..." aria-label="Search patterns" />
              {query && <button type="button" className="quiet club-search-clear" onClick={() => setQuery("")}>Clear</button>}
            </div>
          </div>
          {shown.length ? (
            <div className="club-modal-grid">
              {shown.map((def) => (
                <button key={def.id} type="button" className={`club-modal-card${current === def.id ? " active" : ""}`} aria-pressed={current === def.id}
                  onClick={() => { onPick(def); onClose(); }}>
                  <div className="club-modal-badge-box pattern-thumb">{renderSwatch(def)}</div>
                  <span className="club-modal-badge-name">{def.label}</span>
                </button>
              ))}
            </div>
          ) : <p className="section-copy">No patterns match.</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
