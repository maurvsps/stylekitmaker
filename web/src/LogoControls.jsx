const POSITIONS = {
  crest: [["left", "Left breast"], ["center", "Center chest"]],
  brand: [["right", "Right chest"], ["center", "Center"], ["left", "Left chest"]],
};

/**
 * What only a logo layer needs, shown at the top of its options: the picture with a Change button (opens the right
 * library), the crest's colour/mono style and quick club picks, and the chest position presets.
 * Size, colour, outline, blending and finish are the ordinary layer fields below it.
 */
export default function LogoControls({ layer, slot, project, logo }) {
  const asset = project.assets[layer.asset];
  const positions = POSITIONS[slot.id];
  const position = positions && logo.position(slot, layer);
  const isCrest = slot.id === "crest";
  return (
    <div className="logo-controls">
      <div className="logo-slot-card populated">
        <div className="logo-slot-main">
          <div className="logo-preview">{asset ? <img src={asset.src} alt="" /> : <span aria-hidden="true">+</span>}</div>
          <div className="logo-slot-info">
            <span className="logo-slot-label">{slot.label}</span>
            <span className="logo-slot-file">{layer.clubData?.name || asset?.name || "No picture"}</span>
          </div>
        </div>
        <div className="logo-slot-actions">
          <button type="button" className="quiet slot-act-btn" onClick={() => logo.change(slot)} title="Upload, paste a link or pick from the library">
            Change
          </button>
        </div>
      </div>

      {isCrest && (
        <div className="customizer-row">
          <span className="group-label">Badge style</span>
          <div className="seg" role="group" aria-label="Badge style">
            {[["color", "Full colour"], ["mono", "Monochrome"]].map(([mode, label]) => (
              <button key={mode} type="button" className={logo.crestStyle === mode ? "on" : ""} aria-pressed={logo.crestStyle === mode}
                onClick={() => logo.setCrestStyle(mode)}>{label}</button>
            ))}
          </div>
        </div>
      )}

      {positions && (
        <div className="customizer-row">
          <span className="group-label">{isCrest ? "Crest position" : "Chest position"}</span>
          <div className="seg" role="group" aria-label="Position">
            {positions.map(([key, label]) => (
              <button key={key} type="button" className={position === key ? "on" : ""} aria-pressed={position === key}
                onClick={() => logo.setPosition(slot, key)}>{label}</button>
            ))}
          </div>
        </div>
      )}

      {isCrest && (
        <div className="quick-clubs-section">
          <div className="quick-clubs-header">
            <span className="group-label">Quick picks</span>
            <button type="button" className="link" onClick={logo.openClubs}>View all (400+)</button>
          </div>
          <div className="quick-clubs-row">
            {logo.quickClubs.map((club) => (
              <button key={club.name} type="button" className="quick-club-btn" title={club.name} onClick={() => logo.pickClub(club)}>
                <img src={logo.crestStyle === "mono" && club.monoUrl ? club.monoUrl : club.colorUrl} alt="" className="quick-club-thumb" loading="lazy" />
                <span>{club.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
