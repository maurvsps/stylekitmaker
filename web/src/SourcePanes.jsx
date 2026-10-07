import { useRef, useState } from "react";

/** The three ways to add a picture: from a library, from a link, from the device. */
export const SOURCE_LABELS = { library: "Library", link: "Link", upload: "Upload" };

export function SourceTabs({ value, onChange, tabs }) {
  return (
    <div className="source-tabs" role="tablist" aria-label="Where the image comes from">
      {tabs.map((id) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>
          {SOURCE_LABELS[id]}
        </button>
      ))}
    </div>
  );
}

/** Runs `task` while showing "busy", and turns a thrown error into a message next to the control. */
function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (task) => {
    setBusy(true);
    setError("");
    try {
      await task();
      return true;
    } catch (err) {
      setError(err?.message || "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/** Paste a direct image link. `onLink(url)` resolves when the image is in place, or throws a readable error. */
export function LinkPane({ onLink, onDone, hint = "https://i.ibb.co/xxxx/logo.png" }) {
  const [url, setUrl] = useState("");
  const { busy, error, run } = useTask();
  const submit = async (e) => {
    e.preventDefault();
    if (await run(() => onLink(url))) onDone?.();
  };
  return (
    <form className="source-pane" onSubmit={submit}>
      <label className="field">
        <span>Image link</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={hint} spellCheck={false} autoFocus aria-label="Image link" />
      </label>
      <p className="source-hint">Paste the direct address of the image (it ends in .png, .jpg, .webp or .svg). Links have no size limit.</p>
      {error && <p className="source-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !url.trim()}>{busy ? "Loading..." : "Add from link"}</button>
    </form>
  );
}

/** Pick or drop a file. `onFile(file)` resolves when the image is in place, or throws a readable error. */
export function UploadPane({ onFile, onDone }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const { busy, error, run } = useTask();
  const take = async (file) => {
    if (file && (await run(() => onFile(file)))) onDone?.();
  };
  return (
    <div className="source-pane">
      <button type="button" className={`drop-zone${over ? " over" : ""}`} disabled={busy} onClick={() => input.current.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}>
        <strong>{busy ? "Loading..." : "Upload from device"}</strong>
        <span>Choose a file or drop it here. PNG, SVG, JPG or WebP.</span>
      </button>
      {error && <p className="source-error" role="alert">{error}</p>}
      <input ref={input} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={(e) => {
        const file = e.target.files[0];
        e.target.value = "";
        take(file);
      }} />
    </div>
  );
}
