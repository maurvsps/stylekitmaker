import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchLogo } from "./logoSearch.js";
import { LinkPane, SourceTabs, UploadPane } from "./SourcePanes.jsx";

/**
 * One popup for adding a picture to the kit: from a library (presets and online search), from a link, or from the
 * device. Rendered in a portal on <body>, so it sits above the whole editor instead of inside the sidebar.
 *
 * library: omit `onSearch` and `presets` for a popup with only Link and Upload (kit images).
 * onPickFile(file) / onPickLink(url): resolve once the image is placed, or throw an Error with a message to show.
 * targets + targetId + onTarget: a selector for where it goes (sponsor spots); otherwise `targetLabel` is shown.
 */
export default function LogoPickerModal({
  isOpen, onClose, title, subtitle, targetLabel, targets, targetId, onTarget,
  presets = [], presetsTitle = "Popular", placeholder, credit, onSearch, onPickPreset, onPick,
  onPickFile, onPickLink, onError,
}) {
  const hasLibrary = !!onSearch || presets.length > 0;
  const tabs = [...(hasLibrary ? ["library"] : []), "link", "upload"];
  const [source, setSource] = useState(tabs[0]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pickingId, setPickingId] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    setQuery("");
    setResults(null);
    setSource(hasLibrary ? "library" : "link");
    const focus = setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => { clearTimeout(focus); removeEventListener("keydown", onKey); };
  }, [isOpen, onClose, hasLibrary]);

  if (!isOpen) return null;

  const search = async (e) => {
    e.preventDefault();
    if (!query.trim() || !onSearch) return;
    setBusy(true);
    try {
      setResults(await onSearch(query.trim()));
    } catch (err) {
      setResults([]);
      onError?.(`Search failed (${err.message}). Check your connection, or use a link or upload instead.`);
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
      onError?.(`Could not download image (${err.message}). Try a link or upload instead.`);
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

        {(targets || targetLabel) && (
          <div className="logo-modal-target">
            <span>Applying to</span>
            {targets
              ? <select value={targetId} onChange={(e) => onTarget(e.target.value)} aria-label="Where to place it">
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              : <strong>{targetLabel}</strong>}
          </div>
        )}

        <SourceTabs value={source} onChange={setSource} tabs={tabs} />

        <div className="club-modal-body">
          {source === "library" && (
            <>
              {onSearch && (
                <form className="club-modal-toolbar" onSubmit={search}>
                  <div className="club-modal-search">
                    <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setResults(null); }}
                      placeholder={placeholder} aria-label="Search logos" />
                    {query && <button type="button" className="quiet club-search-clear" onClick={() => { setQuery(""); setResults(null); }}>Clear</button>}
                  </div>
                  <button type="submit" disabled={busy || !query.trim()}>{busy ? "Searching..." : "Search online"}</button>
                </form>
              )}

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
            </>
          )}

          {source === "link" && <LinkPane onLink={onPickLink} onDone={onClose} />}
          {source === "upload" && <UploadPane onFile={onPickFile} onDone={onClose} />}
        </div>

        {source === "library" && credit && <div className="club-modal-footer"><span>{credit}</span></div>}
      </div>
    </div>,
    document.body,
  );
}
