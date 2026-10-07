import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchLogo } from "./logoSearch.js";

/**
 * Popup logo library for kit brands and sponsors. Rendered in a portal on <body>
 * so it sits above the whole editor instead of being clipped by the sidebar.
 *
 * presets: optional [{ id, name, svg }] quick picks shown as a grid.
 * onPickPreset(preset) / onPick(file, result): resolve once the logo is applied.
 */
export default function LogoPickerModal({
  isOpen, onClose, title, subtitle, targetLabel, presets = [], presetsTitle = "Popular",
  placeholder, credit, onSearch, onPickPreset, onPick, onUpload, onError,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pickingId, setPickingId] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    setQuery("");
    setResults(null);
    const focus = setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => { clearTimeout(focus); removeEventListener("keydown", onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const search = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults(await onSearch(query.trim()));
    } catch (err) {
      setResults([]);
      onError(`Search failed (${err.message}). Check your connection or upload a file directly.`);
    } finally {
      setBusy(false);
    }
  };

  const pickResult = async (r) => {
    setPickingId(r.url);
    try {
      const file = await fetchLogo(r.url, r.name);
      await onPick(file, r);
      onClose();
    } catch (err) {
      onError(`Could not download image (${err.message}). Try uploading a file.`);
    } finally {
      setPickingId(null);
    }
  };

  const pickPreset = async (p) => {
    setPickingId(p.id);
    try {
      await onPickPreset(p);
      onClose();
    } finally {
      setPickingId(null);
    }
  };

  const q = query.trim().toLowerCase();
  const shownPresets = q ? presets.filter((p) => p.name.toLowerCase().includes(q)) : presets;

  return createPortal(
    <div className="sheet-backdrop club-modal-backdrop" onClick={onClose}>
      <div className="sheet club-modal logo-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head club-modal-head">
          <div className="club-modal-title">
            <h2>{title}</h2>
            <span className="club-modal-subtitle">{subtitle}</span>
          </div>
          <button type="button" className="quiet club-modal-close" onClick={onClose}>Close</button>
        </div>

        <div className="logo-modal-target">
          <span>Applying to</span><strong>{targetLabel}</strong>
          <button type="button" className="quiet slot-act-btn" onClick={() => { onUpload(); onClose(); }}>Upload from device</button>
        </div>

        <form className="club-modal-toolbar" onSubmit={search}>
          <div className="club-modal-search">
            <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setResults(null); }}
              placeholder={placeholder} aria-label="Search logos" />
            {query && <button type="button" className="quiet club-search-clear" onClick={() => { setQuery(""); setResults(null); }}>Clear</button>}
          </div>
          <button type="submit" disabled={busy || !query.trim()}>{busy ? "Searching..." : "Search online"}</button>
        </form>

        <div className="club-modal-body">
          {presets.length > 0 && (
            <div className="logo-modal-group">
              <span className="group-label">{presetsTitle}</span>
              {shownPresets.length > 0 ? (
                <div className="club-modal-grid">
                  {shownPresets.map((p) => (
                    <button key={p.id} type="button" className="club-modal-card" disabled={pickingId === p.id} onClick={() => pickPreset(p)}>
                      <div className="club-modal-badge-box preset-svg" dangerouslySetInnerHTML={{ __html: p.svg }} />
                      <span className="club-modal-badge-name">{p.name}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="section-copy">No saved match. Press Search online to look further.</p>
              )}
            </div>
          )}

          {results && (
            <div className="logo-modal-group">
              <span className="group-label">Online results</span>
              {results.length === 0 ? <p className="section-copy">No results found.</p> : (
                <div className="club-modal-grid">
                  {results.map((r) => (
                    <button key={r.url} type="button" className="club-modal-card" title={r.name} disabled={pickingId === r.url} onClick={() => pickResult(r)}>
                      <div className="club-modal-badge-box">
                        <img src={r.thumb} alt="" className="club-modal-badge-img" loading="lazy"
                          onError={(e) => { if (e.currentTarget.src !== r.url) e.currentTarget.src = r.url; }} />
                      </div>
                      <span className="club-modal-badge-name">{r.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {!presets.length && !results && (
            <div className="club-modal-empty"><p>Type a name and search to find logos online.</p></div>
          )}
        </div>

        {credit && <div className="club-modal-footer"><span>{credit}</span></div>}
      </div>
    </div>,
    document.body,
  );
}
