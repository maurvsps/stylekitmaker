"""
Build a shirt template from a garment made in CLO 3D / Marvelous Designer (.zprj).

    .bpy/bin/python blender/clo_shirt.py -- path/to/shirt.zprj [--name shirt_clo]

A .zprj keeps every pattern piece twice: flat (the 2D pattern, millimetres) and draped on CLO's avatar (3D,
millimetres, Y up). The flat pieces are exactly what a UV frame in metres wants, so the islands come straight from
the patterns: front, back (+ yoke), sleeves (+ cuffs) and the collar band (+ its tabs), each placed next to the piece
it is sewn to. The draped shape is kept as the artist left it (no folds, no re-drape), scaled to our kit's size.
Then the usual pipeline: UV pack, template JSON, UV PNGs, AO bake, thickness, GLB. The editor shows the shirt alone.
"""

import io
import os
import re
import struct
import sys
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_kit as mk  # noqa: E402  (imports bpy, which provides mathutils)

SCALE = 1.1             # CLO avatar -> our kit: the collar top lands where make_kit's crew collar does
DROP = 0.03             # metres the hem hangs below z = 0, over the top of the shorts
NECK_Y = 0.005          # our neck's centre, front to back
WELD = 0.0006           # metres: vertices this close (where CLO sewed two pieces) become one
SEAM = 0.004            # metres: vertices this close across two pieces count as sewn together


# ---------------------------------------------------------------- reading the .zprj


def read_pac(path):
    """The garment file inside a .zprj (a zip holding a .zpac, itself a zip holding the .pac)."""
    with zipfile.ZipFile(path) as z:
        zpac = next(n for n in z.namelist() if n.endswith(".zpac"))
        with zipfile.ZipFile(io.BytesIO(z.read(zpac))) as zz:
            pac = next(n for n in zz.namelist() if n.endswith(".pac"))
            return zz.read(pac)


def parse_map(d, pos):
    """One record: name, key count N, N key lengths, N value types, N value lengths (u32), then key/value pairs."""
    name = re.match(rb"map[A-Za-z0-9_]+?(?=[\x00-\x20])", d[pos:pos + 64]).group(0)
    i = pos + len(name)
    n = d[i]
    i += 1
    key_len = list(d[i:i + n])
    i += 2 * n  # key lengths, then value types
    val_len = struct.unpack("<%dI" % n, d[i:i + 4 * n])
    i += 4 * n
    out = {}
    for k, L in zip(key_len, val_len):
        key = d[i:i + k].decode("latin1")
        i += k
        out[key] = d[i:i + L]
        i += L
    return name.decode(), out


def u32(b):
    return struct.unpack("<I", b[:4])[0]


def pieces(d):
    """Every pattern piece that is on the avatar: 3D positions, flat positions (mm) and triangles."""
    blocks = []
    for m in re.finditer(rb"mapMesh(2D|3D)", d):
        try:
            blocks.append(parse_map(d, m.start()))
        except Exception:
            continue
    out = []
    for i, (name, o) in enumerate(blocks):
        if name != "mapMesh3D":
            continue
        n = u32(o["uiVertexCount3D"])
        flat = next((o2 for name2, o2 in reversed(blocks[:i])
                     if name2 == "mapMesh2D" and u32(o2["uiVertexCount2D"]) == n), None)
        if flat is None:
            continue
        out.append(dict(P=np.frombuffer(o["baPos3D"], "<f4").reshape(-1, 3).astype(float),
                        R=np.frombuffer(flat["baRest"], "<f4").reshape(-1, 2).astype(float),
                        F=np.frombuffer(flat["baTri"], "<u4").reshape(-1, 3).astype(int)))
    return out


# ---------------------------------------------------------------- which piece is which


def classify(ps):
    """Name the pieces: front, back, sleeve/cuff per side, collar bands; anything else joins its neighbour."""
    for p in ps:
        p["c"] = p["P"].mean(0)
        ext = p["R"].max(0) - p["R"].min(0)
        p["band"] = min(ext) < 25  # a strip: collar band, cuff or tab
    body = sorted([p for p in ps if abs(p["c"][0]) < 60 and not p["band"]], key=lambda p: -len(p["P"]))
    front, back = sorted(body[:2], key=lambda p: -p["c"][2])
    front["role"], back["role"] = "front", "back"
    for side, name in ((1, "sleeve_left"), (-1, "sleeve_right")):
        arm = sorted([p for p in ps if p["c"][0] * side > 120], key=lambda p: -len(p["P"]))
        arm[0]["role"] = name
        for p in arm[1:]:
            p["role"] = name + "+"
    collar = [p for p in ps if "role" not in p and p["band"]]
    for p in collar:
        p["role"] = "collar"
    for p in ps:
        p.setdefault("role", "+")  # a yoke or other panel: joins whatever it is sewn to
    return ps


# ---------------------------------------------------------------- flat frames


def seam_pairs(a, b, tol):
    """(index in a, index in b) for vertices of a lying within tol of a vertex of b (3D)."""
    out = []
    for s in range(0, len(a), 2048):
        d2 = ((a[s:s + 2048, None, :] - b[None, :, :]) ** 2).sum(-1)
        j = d2.argmin(1)
        ok = d2[np.arange(len(j)), j] < tol * tol
        out += [(s + i, j[i]) for i in np.nonzero(ok)[0]]
    return out


def fit_rigid(src, dst):
    """Rotation (or reflection) + translation taking 2D points src onto dst, least squares."""
    cs, cd = src.mean(0), dst.mean(0)
    u, _, vt = np.linalg.svd((src - cs).T @ (dst - cd))
    rot = u @ vt
    return lambda x: (x - cs) @ rot + cd


def ring_strips(strips):
    """The collar: strips sewn end to end round the neck. Lay them out in order round the neck, the front one
    centred on p = 0, each running the way the neck goes round and up the way it stands."""
    allP = np.concatenate([p["P"] for p in strips])
    x0, z0 = (allP[:, 0].min() + allP[:, 0].max()) / 2, (allP[:, 2].min() + allP[:, 2].max()) / 2
    turn = lambda P: np.arctan2(P[..., 0] - x0, P[..., 2] - z0)  # 0 at the front centre
    for p in strips:
        R = p["R"] / 1000
        R = R - R.mean(0)
        axis = np.linalg.svd(R, full_matrices=False)[2]
        a = R @ axis[0]
        b = R @ axis[1]
        mid = turn(p["c"])
        ang = (turn(p["P"]) - mid + np.pi) % (2 * np.pi) - np.pi
        if np.corrcoef(a, ang)[0, 1] < 0:
            a = -a
        # up the band: compare with the height left once the neckline's own rise and fall along a is removed
        h = p["P"][:, 1] - np.polyval(np.polyfit(a, p["P"][:, 1], 4), a)
        if np.corrcoef(b, h)[0, 1] < 0:
            b = -b
        p["ab"], p["mid"] = np.stack([a - a.min(), b - b.min()], 1), mid % (2 * np.pi)
    front = min(strips, key=lambda p: min(p["mid"], 2 * np.pi - p["mid"]))
    rest = sorted((p for p in strips if p is not front), key=lambda p: (p["mid"] - front["mid"]) % (2 * np.pi))
    start = -front["ab"][:, 0].max() / 2
    for p in [front] + rest:
        p["uv"] = p["ab"] + [start, 0]
        p["island"] = "collar"
        start += p["ab"][:, 0].max()


def place(ps):
    """Give every piece flat coordinates (metres) in its island's frame; children are laid next to the piece they
    are sewn to."""
    for p in ps:
        p["uv"] = None
    ring_strips([p for p in ps if p["role"] == "collar"])
    roots = {p["role"]: p for p in ps if not p["role"].endswith("+") and p["role"] != "collar"}
    for name, p in roots.items():
        R = p["R"] / 1000
        if name in ("front", "back"):  # across from the centre line, up from the hem
            uv = R - [(R[:, 0].min() + R[:, 0].max()) / 2, R[:, 1].min()]
        elif name.startswith("sleeve"):  # around from the top of the cap, down from it
            uv = R.copy()
            if np.corrcoef(uv[:, 1], -np.abs(p["P"][:, 0]))[0, 1] < 0:  # the cap is the end nearest the body
                uv = -uv
            uv = uv - uv[uv[:, 1].argmax()]
        # q must run the way the piece runs up the body (CLO may store a piece upside down)
        if not name.startswith("sleeve") and np.corrcoef(uv[:, 1], p["P"][:, 1])[0, 1] < 0:
            uv = -uv
            uv[:, 1] -= uv[:, 1].min()
        p["uv"], p["island"] = uv, name
    todo = [p for p in ps if p["uv"] is None]
    while todo:
        best = None
        for c in todo:
            for q in ps:
                allowed = (c["role"][:-1],) if c["role"] != "+" else ("front", "back")
                if q["uv"] is None or q["island"] not in allowed:
                    continue
                pairs = seam_pairs(c["P"] / 1000, q["P"] / 1000, SEAM)
                if len(pairs) >= 3 and (best is None or len(pairs) > len(best[2])):
                    best = (c, q, pairs)
        if best is None:
            raise SystemExit(f"[clo] {len(todo)} piece(s) not sewn to anything")
        c, q, pairs = best
        i, j = np.array(pairs).T
        c["uv"] = fit_rigid(c["R"][i] / 1000, q["uv"][j])(c["R"] / 1000)
        c["island"] = q["island"]
        todo.remove(c)
    return ps


# ---------------------------------------------------------------- the part


def boundary(F):
    """Edges used by one triangle only: the piece's outline."""
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), 1)
    u, n = np.unique(e, axis=0, return_counts=True)
    return u[n == 1]


def stitch(ps, reach=0.006):
    """Close the seams. CLO sews pieces whose outlines have different vertex spacing, so neighbouring edges cross or
    overlap by a few millimetres (dark lines in the AO bake, creases in the shading). Move every outline vertex of a
    piece onto the outline of a piece earlier in the list when one is within reach, so the two meet edge to edge."""
    rank = {"front": 0, "back": 1, "+": 2, "sleeve_left": 3, "sleeve_right": 3, "sleeve_left+": 4, "sleeve_right+": 4}
    done = []
    for p in sorted(ps, key=lambda p: rank.get(p["role"], 5)):  # body, yoke, sleeves, cuffs, collar
        edges = boundary(p["F"])
        ids = np.unique(edges)
        if done:
            A = np.concatenate([q["V"][e[:, 0]] for q, e in done])
            B = np.concatenate([q["V"][e[:, 1]] for q, e in done])
            AB = B - A
            for i in ids:
                v = p["V"][i]
                t = np.clip(((v - A) * AB).sum(1) / np.maximum((AB * AB).sum(1), 1e-12), 0, 1)
                foot = A + AB * t[:, None]
                d = np.linalg.norm(foot - v, axis=1)
                k = d.argmin()
                if d[k] < reach:
                    p["V"][i] = foot[k]
        done.append((p, edges))


def to_ours(P, hem, neck_x, neck_z):
    """CLO (mm, Y up, avatar facing +Z) -> ours (metres, Z up, facing -Y, hem at z = 0)."""
    return np.stack([(P[:, 0] - neck_x) * SCALE, -(P[:, 2] - neck_z) * SCALE + NECK_Y,
                     (P[:, 1] - hem) * SCALE - DROP * 1000], 1) / 1000


def clo_part(path):
    ps = place(classify(pieces(read_pac(path))))
    front = next(p for p in ps if p["role"] == "front")
    collar = [p for p in ps if p["island"] == "collar"]
    neck = np.concatenate([p["P"] for p in collar])
    hem = front["P"][:, 1].min()
    for p in ps:
        p["V"] = to_ours(p["P"], hem, (neck[:, 0].min() + neck[:, 0].max()) / 2,
                         (neck[:, 2].min() + neck[:, 2].max()) / 2)

    # The collar strip runs on past the back centre: wrap it so p is measured both ways from the front centre.
    ring = np.concatenate([p["uv"][:, 0] for p in collar])
    circ = ring.max() - ring.min()

    part = mk.Part("Shirt")
    part.params = dict(collar="crew", sleeves="short", fit="regular", source="clo")
    part.island("front", "shirt_body", "body", "p: metres across from the centre line, q: metres up from the hem")
    part.island("back", "shirt_body", "body", "p: metres across from the centre line, q: metres up from the hem")
    for name in ("sleeve_left", "sleeve_right"):
        uv = np.concatenate([p["uv"] for p in ps if p["island"] == name])
        part.island(name, "shirt_sleeves", "sleeve",
                    "p: metres around from the top line (underarm seam at both ends), q: minus metres from the shoulder",
                    length=round(float(-uv[:, 1].min()), 4))
    part.island("collar", "shirt_collar", "collar", "p: metres around from the front centre, q: metres up the band")
    part.layout_order = ["front", "back", "sleeve_right", "sleeve_left", "collar"]

    stitch(ps)

    # Weld what CLO sewed: one vertex where pieces meet, so the seams shade smoothly and thicken as one surface.
    allV = np.concatenate([p["V"] for p in ps])
    key = np.round(allV / WELD).astype(np.int64)
    ids, base = {}, 0
    for p in ps:
        p["ids"] = []
        for k, v in zip(map(tuple, key[base:base + len(p["V"])]), p["V"]):
            if k not in ids:
                ids[k] = part.vert(v)
            p["ids"].append(ids[k])
        base += len(p["V"])
    seen = set()
    for p in ps:
        name = p["island"]
        for tri in p["F"]:
            uv = [tuple(p["uv"][i]) for i in tri]
            if name == "collar" and sum(u for u, _ in uv) / 3 > circ / 2:
                uv = [(u - circ, v) for u, v in uv]
            vids = [p["ids"][i] for i in tri]
            if len(set(vids)) == 3 and frozenset(vids) not in seen:  # welding can fold a sliver onto its neighbour
                seen.add(frozenset(vids))
                part.face(vids, uv, name)

    print(f"[clo] {len(ps)} pieces -> {[p['role'] for p in ps]}, {len(part.verts)} verts, "
          f"collar {circ:.3f} m round")
    return part


def build(path, out_name, draco):
    import bpy
    import json
    import shutil

    bpy.ops.wm.read_factory_settings(use_empty=True)
    part = clo_part(path)
    obj, layout, names = mk.build_object(part)
    mk.add_folds(obj, part, names, None, 0)  # only drops the Local UV layer: the artist's drape stays as it is
    bad = mk.check_uvs(obj, names)

    for size in mk.UV_SIZES:
        mk.write_uv_png(obj, part, names, layout, size, os.path.join(mk.UV_DIR, f"{out_name}_uv_{size}.png"))
    shutil.copyfile(os.path.join(mk.UV_DIR, f"{out_name}_uv_{mk.UV_SIZES[0]}.png"),
                    os.path.join(mk.MODELS_DIR, f"{out_name}_uv.png"))
    template = {
        "template": "shirt", "name": out_name, "label": "Crew neck (realistic)", "params": part.params,
        "materials": part.materials,
        "texture": "One square texture for every part. rect = [x, y, w, h] in texture units, origin top-left. "
                   "A point (p, q) of an island's local frame (metres) lands at "
                   "x = rect.x + scale * (p - pmin), y = rect.y + scale * (qmax - q).",
        "islands": {},
    }
    for n in names:
        L, info = layout[n], part.islands[n]
        template["islands"][n] = {
            "material": info["material"], "kind": info["kind"], "frame": info["frame"],
            "rect": [round(L["u0"], 6), round(1 - L["v1"], 6), round(L["w"], 6), round(L["h"], 6)],
            "pmin": round(L["pmin"], 6), "qmax": round(L["qmax"], 6), "scale": round(L["scale"], 6),
            **{k: v for k, v in info.items() if k not in ("material", "kind", "frame", "mirrored_p")},
        }
    for dest in (os.path.join(mk.MODELS_DIR, f"{out_name}.json"), os.path.join(mk.UV_DIR, f"{out_name}_uv.json")):
        with open(dest, "w") as fh:
            json.dump(template, fh, indent=2)

    # The shirt is shown alone: only its own folds shade it.
    mk.bake_ao(obj, [], os.path.join(mk.MODELS_DIR, f"{out_name}_ao.png"), mk.AO_SIZE)
    mk.thicken(obj, mk.THICKNESS, inner=True)
    how = mk.export_glb(obj, os.path.join(mk.MODELS_DIR, f"{out_name}.glb"), draco)
    mk.write_manifest()
    print(f"[clo] {out_name}: {len(obj.data.vertices)} verts, UV faces wound wrong {bad}, GLB {how}")


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if not argv:
        raise SystemExit(__doc__)
    name = argv[argv.index("--name") + 1] if "--name" in argv else "shirt_clo"
    build(argv[0], name, "--no-draco" not in argv)
