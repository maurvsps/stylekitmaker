import { useEffect, useState } from "react";
import { loadKits, storeKits } from "./myKits.js";

/** Saved kits of this browser (with previews) and a share link for the current one. */
export default function MyKits({ actions, onError }) {
  const [kits, setKits] = useState(loadKits);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!note) return undefined;
    const t = setTimeout(() => setNote(""), 6000);
    return () => clearTimeout(t);
  }, [note]);

  const persist = (next) => {
    if (!storeKits(next)) {
      onError("Your browser has no room left for another saved kit. Delete an old one, or use image links instead of uploaded files.");
      return false;
    }
    setKits(next);
    return true;
  };

  const save = async () => {
    setBusy(true);
    try {
      const thumb = await actions.kitThumbnail();
      const entry = {
        id: `k${Date.now().toString(36)}`, name: name.trim() || `Kit ${kits.length + 1}`.slice(0, 40),
        savedAt: Date.now(), thumb, data: actions.kitData(),
      };
      if (persist([entry, ...kits])) {
        setName("");
        setNote(`Saved "${entry.name}".`);
      }
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    setBusy(true);
    try {
      const { url, skipped } = await actions.shareLink();
      try {
        await navigator.clipboard.writeText(url);
        setNote(`Link copied.${skipped ? ` ${skipped} uploaded file${skipped > 1 ? "s" : ""} left out: use image links to share them.` : ""}`);
      } catch {
        window.prompt("Copy this link:", url);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="section-copy">Keep several kits in this browser, or send a link so someone else opens your design.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Name this kit (optional)" aria-label="Kit name" />
        <button type="submit" disabled={busy}>Save kit</button>
      </form>
      <button type="button" className="quiet" disabled={busy} onClick={share}>Copy share link</button>
      {note && <p className="save-status" role="status">{note}</p>}
      {kits.length > 0 && (
        <ul className="my-kits">
          {kits.map((k) => (
            <li key={k.id} className="my-kit">
              <span className="my-kit-thumb">{k.thumb && <img src={k.thumb} alt="" />}</span>
              <span className="my-kit-meta"><strong>{k.name}</strong><small>{new Date(k.savedAt).toLocaleDateString()}</small></span>
              <button type="button" className="quiet slot-act-btn" onClick={() => { actions.applyKit(k.data); setNote(`Opened "${k.name}". Undo brings your previous kit back.`); }}>Open</button>
              <button type="button" className="quiet slot-act-btn danger" aria-label={`Delete ${k.name}`} onClick={() => persist(kits.filter((x) => x.id !== k.id))}>x</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
