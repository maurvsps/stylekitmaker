import { useEffect, useRef, useState } from "react";

/** The flat texture of one garment, as the compositor paints it, with an optional UV layout overlay. */
export default function TextureView({ texture, uvSrc }) {
  const canvas = useRef(null);
  const [overlay, setOverlay] = useState(true);

  // Copy the texture canvas whenever it is repainted (the 3D view keeps rendering it at the same time).
  useEffect(() => {
    let frame;
    let version = -1;
    const tick = () => {
      const c = canvas.current;
      if (c && texture.version !== version) {
        version = texture.version;
        const src = texture.image;
        c.width = c.height = Math.min(src.width, 2048);
        c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [texture]);

  return (
    <div className="texture-view">
      <div className="texture-frame">
        <canvas ref={canvas} aria-label="Garment texture" />
        {overlay && uvSrc && <img src={uvSrc} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
      </div>
      <label className="texture-toggle" title="Outlines where each part of the shirt sits on the texture">
        <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
        UV layout guide
      </label>
    </div>
  );
}
