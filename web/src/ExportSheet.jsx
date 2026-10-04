import { useEffect, useRef, useState } from "react";

/** Shows an export when the page cannot download files: the image to press-and-hold, or the JSON to copy. */
export default function ExportSheet({ file, onClose }) {
  const close = useRef(null);
  const text = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    close.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.text);
      setCopied(true);
    } catch {
      text.current.select();
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={file.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{file.title}</h2>
          <button ref={close} type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
        {file.kind === "image" ? (
          <>
            <img src={file.url} alt={file.title} />
            <p>Press and hold the image to save it (right-click on a computer).</p>
          </>
        ) : (
          <>
            <textarea ref={text} readOnly value={file.text} rows={10} />
            <div className="row">
              <button type="button" onClick={copy}>
                {copied ? "Copied" : "Copy JSON"}
              </button>
            </div>
            <p>Paste it into a file named {file.filename} to load the design later.</p>
          </>
        )}
      </div>
    </div>
  );
}
