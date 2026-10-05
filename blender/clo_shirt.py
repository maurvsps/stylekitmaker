"""
Build a shirt template from a garment made in CLO 3D / Marvelous Designer (.zprj).

    .bpy/bin/python blender/clo_shirt.py -- path/to/shirt.zprj [--collar crew|v|v_wide|scoop|wide] [--name shirt_clo]

--collar picks the neck (see COLLARS): crew keeps CLO's band; v, v_wide and scoop cut a deeper neckline into the front
panel and wide keeps CLO's; all of them then sew on a new rib band. Each builds its own template (shirt_clo_v, ...).

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
DECIMATE = 0.4          # keep this share of CLO's triangles: its sim mesh is far denser than the view needs
WELD = 0.0006           # metres: vertices this close (where CLO sewed two pieces) become one
SEAM = 0.004            # metres: vertices this close across two pieces count as sewn together

# Collar variants built from the same garment: (template suffix, label, neckline cut, band width in metres).
# "crew" keeps CLO's own collar band; the others cut a new neckline into the front panel (or keep CLO's) and sew
# a new rib band along it.
COLLARS = {
    "crew": ("", "Crew neck (realistic)", None, None),
    "v": ("_v", "V-neck (realistic)", "v", 0.006),
    "v_wide": ("_v_wide", "V-neck, wide trim (realistic)", "v", 0.016),
    "scoop": ("_scoop", "Deep round neck (realistic)", "scoop", 0.015),
    "wide": ("_wide", "Crew neck, wide band (realistic)", None, 0.02),
}
NECK_DEPTH = {"v": 0.065, "scoop": 0.04}  # metres the new neckline drops below CLO's at the front centre


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
        if c["role"] == "+":
            match_yoke(c, q, [p for p in ps if p["role"] in ("front", "back") and p is not q])
    return ps


def match_yoke(yoke, home, others):
    """The yoke is laid out next to the panel it shares the most seam with (`home`), so a vertical pattern runs on
    from that panel over the shoulder, but meets the other panel's stripes a few centimetres off (a white block
    on a red stripe at the shoulder seam). Shear its p so that along the other seam it matches that panel too,
    blending from no change at the home seam. Pattern space mirrors the back, so the other panel's p is matched
    with whichever sign fits the yoke as laid out."""
    P = yoke["P"] / 1000
    home_ids = np.array([i for i, _ in seam_pairs(P, home["P"] / 1000, SEAM)])
    for other in others:
        pairs = seam_pairs(P, other["P"] / 1000, SEAM)
        if len(pairs) < 3:
            continue
        i, j = np.array(pairs).T
        cur = yoke["uv"][i, 0]
        target = min((sign * other["uv"][j, 0] for sign in (1, -1)), key=lambda t: np.abs(t - cur).mean())
        delta = target - cur
        d_home = np.linalg.norm(P[:, None, :] - P[None, home_ids, :], axis=2).min(1) if len(home_ids) else 1
        d_seam = np.linalg.norm(P[:, None, :] - P[None, i, :], axis=2)
        near = d_seam.argmin(1)
        w = d_home / np.maximum(d_home + d_seam.min(1), 1e-9)
        yoke["uv"][:, 0] += w * delta[near]
        print(f"[clo] yoke matched to {other['role']}: shifted up to {np.abs(delta).max() * 100:.1f} cm at its seam")


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


def cut_neckline(front, collar, shape, depth):
    """Cut a deeper neckline into the front panel, in its flat frame (p across, q up): a straight V or a round
    scoop from CLO's neck corners down to `depth` below its front centre. Triangles crossing the line are clipped."""
    P, uv = front["P"], front["uv"]
    C = np.concatenate([c["P"] for c in collar])
    outline = np.unique(boundary(front["F"]))
    neck = [i for i in outline if np.linalg.norm(C - P[i], axis=1).min() < 5]  # mm: sewn to the collar
    nb = uv[neck]
    ps = np.abs(nb[:, 0]).max()
    qs = nb[np.abs(nb[:, 0]) > 0.9 * ps, 1].min()
    qv = nb[np.abs(nb[:, 0]) < 0.03, 1].min() - depth
    a = np.clip(np.abs(uv[:, 0]) / ps, 0, 1)
    line = qv + (qs - qv) * (a if shape == "v" else 1 - np.sqrt(1 - a * a))
    f = np.where(np.abs(uv[:, 0]) < ps, line - uv[:, 1], 1.0)  # >= 0: keep
    keys = ("P", "R", "uv")
    extra = {k: [] for k in keys}
    made = {}

    def cross(i, j):
        k = (min(i, j), max(i, j))
        if k not in made:
            t = f[i] / (f[i] - f[j])
            for key in keys:
                extra[key].append(front[key][i] + (front[key][j] - front[key][i]) * t)
            made[k] = len(P) + len(made)
        return made[k]

    F = []
    for tri in front["F"]:
        keep = f[tri] >= 0
        if keep.all():
            F.append(list(tri))
        elif keep.any():
            poly = []
            for j in range(3):
                i0, i1 = tri[j], tri[(j + 1) % 3]
                if f[i0] >= 0:
                    poly.append(i0)
                if (f[i0] >= 0) != (f[i1] >= 0):
                    poly.append(cross(i0, i1))
            F += [[poly[0], poly[k], poly[k + 1]] for k in range(1, len(poly) - 1)]
    for key in keys:
        front[key] = np.concatenate([front[key], np.array(extra[key]).reshape(-1, front[key].shape[1])])
    F = np.array(F)
    used = np.unique(F)
    remap = -np.ones(len(front["P"]), int)
    remap[used] = np.arange(len(used))
    for key in keys:
        front[key] = front[key][used]
    front["F"] = remap[F]
    front["cut"] = (np.arange(len(remap)) >= len(P))[used]
    print(f"[clo] {shape} neckline: {depth * 100:.0f} cm deeper at the front, {len(made)} edges cut")


def neck_marks(ps, collar):
    """Flag, per body piece, the outline vertices that form the neck opening: those CLO sewed to its collar band,
    plus the ones a new neckline cut made."""
    C = np.concatenate([c["P"] for c in collar])
    for p in ps:
        if p["island"] not in ("front", "back"):
            continue
        mark = np.zeros(len(p["P"]), bool)
        for i in np.unique(boundary(p["F"])):
            mark[i] = np.linalg.norm(C - p["P"][i], axis=1).min() < 6  # mm
        if "cut" in p:
            mark |= p["cut"]
        p["neck"] = mark


def sew_band(part, neck_ids, width, rows=4, samples=160):
    """A rib band along the neck opening, `width` metres wide: it carries on from the shirt's surface past the
    neckline (standing up round the back of the neck, lying on the chest down a V) and tucks 3 mm under the
    neckline so no gap shows. Its UVs are the collar island's frame: p around from the front centre (both ways),
    q up the band."""
    V = np.array([tuple(v) for v in part.verts])
    other = {}
    for ids, _, _ in part.faces:
        for j in range(3):
            a, b = ids[j], ids[(j + 1) % 3]
            other.setdefault((min(a, b), max(a, b)), []).append(ids[(j + 2) % 3])
    edges = [(e, c[0]) for e, c in other.items() if len(c) == 1 and e[0] in neck_ids and e[1] in neck_ids]
    mid = np.array([(V[a] + V[b]) / 2 for (a, b), _ in edges])
    away = []
    for (a, b), c in edges:
        e = V[b] - V[a]
        m = (V[a] + V[b]) / 2 - V[c]
        m -= e * (m @ e) / (e @ e)
        away.append(m / np.linalg.norm(m))
    away = np.array(away)
    centre = mid[:, :2].mean(0)
    # Order the neckline round the neck (top view), starting at the front centre (-y) and running towards +x.
    ang = np.arctan2(mid[:, 0] - centre[0], -(mid[:, 1] - centre[1]))
    order = np.argsort(ang)
    pts, dirs, ang = mid[order], away[order], ang[order]
    # Resample evenly by angle and smooth: the band edge stays even where the neckline's triangles are not.
    t = np.linspace(-np.pi, np.pi, samples, endpoint=False)
    def ring(values):
        ext_a = np.concatenate([ang - 2 * np.pi, ang, ang + 2 * np.pi])
        ext_v = np.concatenate([values, values, values])
        return np.stack([np.interp(t, ext_a, ext_v[:, k]) for k in range(values.shape[1])], 1)
    c, d = ring(pts), ring(dirs)
    for _ in range(3):
        c = (np.roll(c, 1, 0) + 2 * c + np.roll(c, -1, 0)) / 4
        d = (np.roll(d, 1, 0) + 2 * d + np.roll(d, -1, 0)) / 4
    d /= np.linalg.norm(d, axis=1)[:, None]
    # Lift the band a millimetre off the shirt where it lies on it.
    tangent = np.roll(c, -1, 0) - np.roll(c, 1, 0)
    normal = np.cross(tangent, d)
    normal /= np.linalg.norm(normal, axis=1)[:, None]
    outwards = c - np.c_[np.tile(centre, (samples, 1)), c[:, 2]]
    normal *= np.sign((normal * outwards).sum(1))[:, None]
    tuck = 0.003
    grid = []
    for r in range(rows):
        q = -tuck + (width + tuck) * r / (rows - 1)
        grid.append([part.vert(c[i] + d[i] * q + normal[i] * 0.001) for i in range(samples)])
    seg = np.linalg.norm(np.roll(c, -1, 0) - c, axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    k0 = samples // 2  # t = 0: the front centre
    s = s - s[k0]
    circ = s[-1] - s[0]
    # Which way round to wind: the band's face should look the same way as the shirt beside it.
    n0 = np.cross(c[k0 + 1] - c[k0], d[k0])
    flip = n0 @ normal[k0] < 0
    for i in range(samples):
        j = (i + 1) % samples
        p0, p1 = s[i], s[i] + seg[i]
        if (p0 + p1) / 2 > circ / 2:
            p0, p1 = p0 - circ, p1 - circ
        if (p0 + p1) / 2 < -circ / 2:
            p0, p1 = p0 + circ, p1 + circ
        for r in range(rows - 1):
            q0 = -tuck + (width + tuck) * r / (rows - 1)
            q1 = -tuck + (width + tuck) * (r + 1) / (rows - 1)
            quad = [(grid[r][i], (p0, q0)), (grid[r][j], (p1, q0)), (grid[r + 1][j], (p1, q1)), (grid[r + 1][i], (p0, q1))]
            if flip:  # reversing the winding mirrors the UVs too: p then runs the other way round
                quad = [(v, (-p, q)) for v, (p, q) in quad[::-1]]
            for tri in (quad[:3], [quad[0], quad[2], quad[3]]):
                part.face([v for v, _ in tri], [uv for _, uv in tri], "collar")
    print(f"[clo] new collar band: {width * 100:.1f} cm wide, {circ * 100:.0f} cm round, from {len(edges)} neckline edges")


def to_ours(P, hem, neck_x, neck_z):
    """CLO (mm, Y up, avatar facing +Z) -> ours (metres, Z up, facing -Y, hem at z = 0)."""
    return np.stack([(P[:, 0] - neck_x) * SCALE, -(P[:, 2] - neck_z) * SCALE + NECK_Y,
                     (P[:, 1] - hem) * SCALE - DROP * 1000], 1) / 1000


def clo_part(path, collar_kind="crew"):
    _, _, cut, band = COLLARS[collar_kind]
    ps = place(classify(pieces(read_pac(path))))
    front = next(p for p in ps if p["role"] == "front")
    collar = [p for p in ps if p["island"] == "collar"]
    neck = np.concatenate([p["P"] for p in collar])
    if cut:
        cut_neckline(front, collar, cut, NECK_DEPTH[cut])
    hem = front["P"][:, 1].min()
    for p in ps:
        p["V"] = to_ours(p["P"], hem, (neck[:, 0].min() + neck[:, 0].max()) / 2,
                         (neck[:, 2].min() + neck[:, 2].max()) / 2)

    # The collar strip runs on past the back centre: wrap it so p is measured both ways from the front centre.
    ring = np.concatenate([p["uv"][:, 0] for p in collar])
    circ = ring.max() - ring.min()

    part = mk.Part("Shirt")
    part.params = dict(collar="v-neck" if COLLARS[collar_kind][2] == "v" else "crew", sleeves="short", fit="regular", source="clo")
    if band:  # CLO's band comes off; a new one is sewn on below
        neck_marks(ps, collar)
        ps = [p for p in ps if p["island"] != "collar"]
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

    if band:
        sew_band(part, {p["ids"][i] for p in ps if "neck" in p for i in np.nonzero(p["neck"])[0]}, band)
    print(f"[clo] {len(ps)} pieces -> {[p['role'] for p in ps]}, {len(part.verts)} verts, "
          f"collar {circ:.3f} m round")
    return part


def decimate(obj, ratio):
    """Fewer triangles where the cloth is flat. Seams, the outline and UV island borders are kept as they are:
    collapsing an edge across a border drags the other piece's UVs with it, which shows as saw-tooth stripes and
    smeared knit along the shoulder, armhole and collar seams."""
    import bmesh
    import bpy

    if ratio >= 1:
        return
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.active
    keep = []
    for v in bm.verts:
        uvs = {(round(l[uv].uv.x, 5), round(l[uv].uv.y, 5)) for l in v.link_loops}
        if len(uvs) > 1 or v.is_boundary or any(len(e.link_faces) != 2 for e in v.link_edges):
            keep.append(v.index)
    bm.free()
    group = obj.vertex_groups.new(name="Seams")
    group.add(keep, 1.0, "REPLACE")
    mod = obj.modifiers.new("Lighter", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.vertex_group = group.name
    mod.invert_vertex_group = True  # weight 1 = never collapse
    mod.vertex_group_factor = 1000
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    if "Seams" in obj.vertex_groups:
        obj.vertex_groups.remove(obj.vertex_groups["Seams"])
    print(f"[clo] decimate kept {len(keep)} seam vertices")


def build(path, out_name, draco, collar_kind="crew"):
    import bpy
    import json
    import shutil

    bpy.ops.wm.read_factory_settings(use_empty=True)
    part = clo_part(path, collar_kind)
    obj, layout, names = mk.build_object(part)
    mk.add_folds(obj, part, names, None, 0)  # only drops the Local UV layer: the artist's drape stays as it is
    decimate(obj, DECIMATE)
    bad = mk.check_uvs(obj, names)

    for size in mk.UV_SIZES:
        mk.write_uv_png(obj, part, names, layout, size, os.path.join(mk.UV_DIR, f"{out_name}_uv_{size}.png"))
    shutil.copyfile(os.path.join(mk.UV_DIR, f"{out_name}_uv_{mk.UV_SIZES[0]}.png"),
                    os.path.join(mk.MODELS_DIR, f"{out_name}_uv.png"))
    template = {
        "template": "shirt", "name": out_name, "label": COLLARS[collar_kind][1], "params": part.params,
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
    collar = argv[argv.index("--collar") + 1] if "--collar" in argv else "crew"
    name = argv[argv.index("--name") + 1] if "--name" in argv else "shirt_clo" + COLLARS[collar][0]
    build(argv[0], name, "--no-draco" not in argv, collar)
