import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const textOf = (node) =>
  Children.toArray(node).map((n) => (isValidElement(n) ? textOf(n.props.children) : String(n))).join("");

/** Flatten <option> / <optgroup> children (also inside fragments) into rows of a group heading or an option. */
function parse(children, rows = []) {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    if (c.type === "option") {
      const label = textOf(c.props.children);
      rows.push({ kind: "option", value: String(c.props.value ?? label), label, disabled: !!c.props.disabled, hidden: !!c.props.hidden });
    } else if (c.type === "optgroup") {
      rows.push({ kind: "group", label: c.props.label });
      parse(c.props.children, rows);
    } else if (c.props?.children) {
      parse(c.props.children, rows);
    }
  });
  return rows;
}

const GAP = 6; // between the button and the menu
const EDGE = 8; // keep this far from the window edge

/**
 * A drop-in for <select> with our own menu: the same <option> / <optgroup> children, and onChange receives
 * { target: { value } }. The list opens under the button (above it when there is no room), and follows the keyboard:
 * Arrow keys, Home / End, Enter or Space to choose, Escape to close, letters to jump.
 */
export default function Select({ value, onChange, children, className = "", disabled = false, ...rest }) {
  const rows = parse(children);
  const all = rows.filter((r) => r.kind === "option");
  const options = all.filter((o) => !o.hidden); // a hidden option only supplies the button's label (a placeholder)
  const current = all.find((o) => o.value === String(value ?? ""));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1); // index into `options`
  const [place, setPlace] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();

  const enabled = (i) => options[i] && !options[i].disabled;
  const step = (from, dir) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i;
    return from;
  };

  const openMenu = () => {
    if (disabled) return;
    const selected = options.findIndex((o) => o.value === String(value ?? ""));
    setActive(selected >= 0 ? selected : step(-1, 1));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (i) => {
    if (!enabled(i)) return;
    close();
    if (options[i].value !== String(value ?? "")) onChange?.({ target: { value: options[i].value } });
  };

  // Place the menu next to the button: below it, or above when that side has more room.
  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current.getBoundingClientRect();
    const below = innerHeight - r.bottom - EDGE - GAP;
    const above = r.top - EDGE - GAP;
    const up = below < 220 && above > below;
    const width = Math.max(r.width, 200);
    setPlace({
      left: Math.max(EDGE, Math.min(r.left, innerWidth - width - EDGE)),
      minWidth: r.width,
      maxWidth: innerWidth - 2 * EDGE,
      maxHeight: Math.min(360, up ? above : below),
      ...(up ? { bottom: innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [open]);

  // Close on a click elsewhere, a resize, or a scroll that is not the menu's own.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (!menu.current?.contains(e.target) && !trigger.current?.contains(e.target)) close(false);
    };
    const onScroll = (e) => {
      if (!menu.current?.contains(e.target)) close(false);
    };
    const onResize = () => close(false);
    addEventListener("pointerdown", outside, true);
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("pointerdown", outside, true);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", onResize);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, place]);

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "ArrowDown") setActive(step(active, 1));
    else if (e.key === "ArrowUp") setActive(step(active, -1));
    else if (e.key === "Home") setActive(step(-1, 1));
    else if (e.key === "End") setActive(step(options.length, -1));
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const hit = options.findIndex((o, i) => enabled(i) && o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    } else return;
    e.preventDefault();
  };

  let index = -1;
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`select-trigger ${className}`.trim()}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        {...rest}
      >
        <span className="select-label">{current?.label ?? ""}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && place && createPortal(
        <div ref={menu} id={`${id}-list`} className="select-menu" role="listbox" style={place}>
          {rows.map((row, k) => {
            if (row.kind === "option" && row.hidden) return null;
            if (row.kind === "group") return <div key={`g${k}`} className="select-group" role="presentation">{row.label}</div>;
            const i = ++index;
            const selected = row.value === String(value ?? "");
            return (
              <div
                key={`o${k}`}
                id={`${id}-${i}`}
                data-index={i}
                role="option"
                aria-selected={selected}
                aria-disabled={row.disabled || undefined}
                className={`select-option${i === active ? " active" : ""}`}
                onPointerMove={() => !row.disabled && setActive(i)}
                onPointerDown={(e) => e.preventDefault()} // keep the focus on the button
                onClick={() => choose(i)}
              >
                <span>{row.label}</span>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
