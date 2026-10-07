import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CLUBS_CATALOG } from "./brandPresets.js";
import { searchCrests } from "./logoSearch.js";
import { LOWER_LABEL, SEASON } from "./season2627.js";

const LEAGUE_GROUPS = [
  { id: "all", label: "All clubs" },
  { id: "new", label: `${SEASON} promoted`, season: "promoted" },
  { id: "laliga", label: "La Liga", leagues: ["La Liga"] },
  { id: "premier", label: "Premier League", leagues: ["Premier League"] },
  { id: "seriea", label: "Serie A", leagues: ["Serie A"] },
  { id: "bundesliga", label: "Bundesliga", leagues: ["Bundesliga"] },
  { id: "ligue1", label: "Ligue 1", leagues: ["Ligue 1"] },
  { id: "americas", label: "Americas", leagues: ["Liga Profesional", "MLS", "Brasileirão", "Liga Promerica"] },
  { id: "saudi", label: "Saudi Pro", leagues: ["Saudi Pro League"] },
  { id: "lower", label: "Lower divisions", leagues: [LOWER_LABEL, "Championship", "Segunda División", "Serie B", "2. Bundesliga", "Ligue 2"] },
  { id: "other", label: "Other leagues", leagues: ["J.League", "K League", "Chinese Super League", "Primeira Liga", "Hong Kong Premier League"] },
];

export default function ClubPickerModal({
  isOpen,
  onClose,
  onSelectClub,
  currentClub,
  activeCrestStyle = "color",
  palette = ["#ffffff", "#000000", "#d4af37"],
}) {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [styleMode, setStyleMode] = useState(activeCrestStyle);
  const [onlineResults, setOnlineResults] = useState(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [pickingId, setPickingId] = useState(null);
  const [broken, setBroken] = useState(() => new Set()); // clubs whose crest image failed to load: hidden, not shown blank

  const searchInputRef = useRef(null);

  // Sync styleMode with parent whenever modal opens
  useEffect(() => {
    if (isOpen) {
      setStyleMode(activeCrestStyle);
      setSearch("");
      setOnlineResults(null);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen, activeCrestStyle]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Filter clubs from catalog
  const filteredClubs = useMemo(() => {
    let list = CLUBS_CATALOG.filter((c) => !broken.has(c.name));
    const q = search.trim().toLowerCase();

    // League tab filter
    if (activeTab !== "all") {
      const group = LEAGUE_GROUPS.find((g) => g.id === activeTab);
      if (group?.season) list = list.filter((c) => c.seasonStatus === group.season);
      else if (group?.leagues) list = list.filter((c) => group.leagues.includes(c.league));
    }

    // Search query filter
    if (q) {
      list = list.filter((c) => {
        if (c.name.toLowerCase().includes(q)) return true;
        if (c.fullName && c.fullName.toLowerCase().includes(q)) return true;
        if (c.city && c.city.toLowerCase().includes(q)) return true;
        if (c.league && c.league.toLowerCase().includes(q)) return true;
        if (c.aliases && c.aliases.some((a) => a.toLowerCase().includes(q))) return true;
        return false;
      });
    }

    return list;
  }, [search, activeTab, broken]);

  // Search Wikimedia online fallback
  const handleSearchOnline = async () => {
    if (!search.trim()) return;
    setOnlineBusy(true);
    try {
      const results = await searchCrests(search.trim());
      setOnlineResults(results);
    } catch {
      setOnlineResults([]);
    } finally {
      setOnlineBusy(false);
    }
  };

  const handleSelectClub = async (club) => {
    if (club.needsOnline) {
      // No bundled vector for this club yet: look it up online instead.
      setSearch(club.name);
      setOnlineBusy(true);
      try { setOnlineResults(await searchCrests(club.name)); } catch { setOnlineResults([]); } finally { setOnlineBusy(false); }
      return;
    }
    setPickingId(club.name);
    try {
      await onSelectClub(club, styleMode);
      onClose();
    } finally {
      setPickingId(null);
    }
  };

  const handleSelectOnline = async (r) => {
    setPickingId(r.name);
    try {
      const clubObj = {
        name: r.name,
        colorUrl: r.url,
        monoUrl: r.monoUrl || null,
        url: r.url,
        league: r.source || "Online",
      };
      await onSelectClub(clubObj, styleMode);
      onClose();
    } finally {
      setPickingId(null);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="sheet-backdrop club-modal-backdrop" onClick={onClose}>
      <div
        className="sheet club-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Football Club Crests"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="sheet-head club-modal-head">
          <div className="club-modal-title">
            <h2>Football Club Crests</h2>
            <span className="club-modal-subtitle">
              {SEASON} season: top flights updated for promotions and relegations
            </span>
          </div>
          <button type="button" className="quiet club-modal-close" onClick={onClose} title="Close">
            Close
          </button>
        </div>

        {/* Modal Controls Bar: Search & Style Mode */}
        <div className="club-modal-toolbar">
          <div className="club-modal-search">
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOnlineResults(null);
              }}
              placeholder="Search by club name, city, nickname (e.g. Madrid, Arsenal, Boca, Milan)..."
              aria-label="Search clubs"
            />
            {search && (
              <button
                type="button"
                className="quiet club-search-clear"
                onClick={() => setSearch("")}
                title="Clear search"
              >
                Clear
              </button>
            )}
          </div>

          <div className="club-modal-style-toggle">
            <span className="label">Preview style:</span>
            <div className="seg">
              <button
                type="button"
                className={styleMode === "color" ? "on" : ""}
                onClick={() => setStyleMode("color")}
              >
                Full color
              </button>
              <button
                type="button"
                className={styleMode === "mono" ? "on" : ""}
                onClick={() => setStyleMode("mono")}
              >
                Monochrome
              </button>
            </div>
          </div>
        </div>

        {/* League Tabs */}
        <div className="club-modal-tabs">
          {LEAGUE_GROUPS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`club-tab-btn${activeTab === tab.id ? " active" : ""}`}
              onClick={() => {
                setActiveTab(tab.id);
                setOnlineResults(null);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Main Clubs Grid */}
        <div className="club-modal-body">
          {filteredClubs.length > 0 ? (
            <div className="club-modal-grid">
              {filteredClubs.map((club) => {
                const isSelected = currentClub?.name === club.name;
                const isBusy = pickingId === club.name;
                const thumbSrc =
                  styleMode === "mono" && club.monoUrl ? club.monoUrl : club.colorUrl;
                const initials = club.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();

                return (
                  <button
                    key={club.id || club.name}
                    type="button"
                    className={`club-modal-card${isSelected ? " selected" : ""}${
                      isBusy ? " loading" : ""
                    }`}
                    title={`${club.name}${club.league ? ` (${club.league})` : ""}`}
                    disabled={isBusy}
                    onClick={() => handleSelectClub(club)}
                  >
                    <div className="club-modal-badge-box">
                      {!thumbSrc ? <span className="club-modal-initials" aria-hidden="true">{initials}</span> : <img
                        src={thumbSrc}
                        alt=""
                        className="club-modal-badge-img"
                        loading="lazy"
                        onError={(e) => {
                          if (club.colorUrl && e.currentTarget.src !== club.colorUrl) {
                            e.currentTarget.src = club.colorUrl;
                          } else {
                            setBroken((prev) => new Set(prev).add(club.name));
                          }
                        }}
                      />}
                    </div>
                    <span className="club-modal-badge-name">{club.name}</span>
                    <div className="club-modal-badge-footer">
                      <span className="club-league-tag">{club.nation || club.league}</span>
                      {club.monoUrl && <span className="mono-pill">Mono</span>}
                      {club.seasonStatus && <span className={`season-pill ${club.seasonStatus}`}>{club.seasonStatus === "promoted" ? "Promoted" : "Relegated"}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="club-modal-empty">
              <p>No catalog clubs matching "{search}".</p>
              {!onlineResults && (
                <button
                  type="button"
                  className="browse-online-btn"
                  disabled={onlineBusy}
                  onClick={handleSearchOnline}
                >
                  {onlineBusy ? "Searching Wikimedia..." : `Search Wikimedia online for "${search}"`}
                </button>
              )}
            </div>
          )}

          {/* Online Wikimedia Search Results if triggered */}
          {onlineResults && (
            <div className="club-modal-online-section">
              <span className="group-label">Online search results (Wikimedia Commons)</span>
              {onlineResults.length === 0 ? (
                <p className="fine">No vector badges found online for this search.</p>
              ) : (
                <div className="club-modal-grid">
                  {onlineResults.map((r) => (
                    <button
                      key={r.url}
                      type="button"
                      className="club-modal-card"
                      title={r.name}
                      onClick={() => handleSelectOnline(r)}
                    >
                      <div className="club-modal-badge-box">
                        <img
                          src={r.thumb}
                          alt=""
                          className="club-modal-badge-img"
                          loading="lazy"
                        />
                      </div>
                      <span className="club-modal-badge-name">{r.name}</span>
                      <div className="club-modal-badge-footer">
                        <span className="club-league-tag">Online</span>
                        {r.hasMono && <span className="mono-pill">Mono</span>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Info */}
        <div className="club-modal-footer">
          <span className="catalog-count">
            Showing {filteredClubs.length} of {CLUBS_CATALOG.length} clubs
          </span>
          <span className="source-credit">
            Vectors from FCLOGO CDN (jsDelivr) & Wikimedia Commons
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
