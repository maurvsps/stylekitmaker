"""Football kit generator: builds the kit meshes, unwraps them, writes UV layout PNGs and exports Draco GLBs.

Run headless (from the repository root):

    blender --background --python blender/make_kit.py
    blender --background --python blender/make_kit.py -- --collar polo --sleeves long --fit loose

Options after `--` override the constants below:
    --collar crew|v-neck|polo   --sleeves short|long|<metres>   --fit slim|regular|loose
    --only shirt[,shorts,...]   --name <output basename>         --no-draco

Outputs (paths relative to the repository root):
    public/models/<name>.glb         kit mesh, one material per part, Draco compressed
    public/models/<name>.json        UV template: where every panel sits on the texture (read by the web editor)
    public/models/<name>_uv.png      1024 px UV guide for the editor overlay
    assets/uv/<name>_uv_1024.png, assets/uv/<name>_uv_2048.png, assets/uv/<name>_uv.json

Conventions
    Blender space: metres, Z up, the wearer faces -Y (glTF/three.js: Y up, faces +Z). +X is the wearer's left.
    Texture space: one square texture shared by every part. Islands never overlap. The texture's top edge is UV v = 1
    (glTF/canvas y = 0), so a canvas drawn top-down maps straight onto the model (CanvasTexture with flipY = false).
    Each island has a local 2D frame in metres (p right, q up, as seen from outside the garment) and the JSON gives
    the rectangle and scale that turn local metres into texture coordinates. Text drawn upright in that frame reads
    correctly on the 3D model.

New templates: write a function that returns a "part" (see `shirt_part`) and register it in TEMPLATES.
"""
import bpy, bmesh, math, os, sys, json, shutil, subprocess, tempfile
from mathutils import Vector
import numpy as np

# ---------------------------------------------------------------- parameters
COLLAR_TYPE = "crew"        # "crew" | "v-neck" | "polo"
SLEEVE_LENGTH = "short"     # "short" | "long" | a length in metres, e.g. 0.4
FIT = "regular"             # "slim" | "regular" | "loose"
SLEEVE_ANGLE = 50.0         # degrees below horizontal (the pose the sleeves are modelled in)
SUBDIVISION_LEVELS = 1      # Catmull-Clark levels applied before export
FOLD_STRENGTH = 1.0         # 0 = no fold detail
BUILD = ["shirt", "shorts", "socks"]  # templates to generate
UV_SIZES = (1024, 2048)     # UV layout PNG sizes
DRACO = True                # Draco mesh compression
# Shirt templates built by default (the editor's template selector): (output name, label, collar, sleeves).
# Passing --collar or --sleeves builds a single shirt instead.
SHIRT_VARIANTS = [
    ("shirt", "Crew neck", "crew", "short"),
    ("shirt_vneck", "V-neck", "v-neck", "short"),
    ("shirt_polo", "Polo", "polo", "short"),
    ("shirt_long", "Long sleeve", "crew", "long"),
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(ROOT, "public", "models")
UV_DIR = os.path.join(ROOT, "assets", "uv")

FITS = {  # (width/depth scale, length scale)
    "slim": (0.93, 0.98),
    "regular": (1.0, 1.0),
    "loose": (1.08, 1.03),
}
SLEEVES = {"short": 0.23, "long": 0.58}

# ---------------------------------------------------------------- small helpers


def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def curve(keys, t):
    """Smooth interpolation through (t, value) keys."""
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t <= t1:
            return lerp(v0, v1, smoothstep(t0, t1, t))
    return keys[-1][1]


def newell_normal(pts):
    n = Vector()
    for a, b in zip(pts, pts[1:] + pts[:1]):
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n.normalized()


def arc_lengths(pts, closed=False):
    """Cumulative distances along a polyline (closed: one extra entry for the return to the start)."""
    out, acc = [0.0], 0.0
    seq = pts + pts[:1] if closed else pts
    for a, b in zip(seq, seq[1:]):
        acc += (b - a).length
        out.append(acc)
    return out


class Part:
    """Mesh under construction: vertices, faces with per-corner local UVs (metres), islands and materials."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []          # (vertex ids, [(p, q) per corner], island name)
        self.islands = {}        # name -> {"material": str, "kind": str, "frame": str, ...}
        self.materials = []

    def vert(self, co):
        self.verts.append(Vector(co))
        return len(self.verts) - 1

    def island(self, name, material, kind, frame, **extra):
        if material not in self.materials:
            self.materials.append(material)
        self.islands[name] = dict(material=material, kind=kind, frame=frame, **extra)

    def face(self, ids, uvs, island):
        self.faces.append((ids, uvs, island))


# ---------------------------------------------------------------- shirt template


def shirt_params(collar, sleeves, fit):
    fw, fl = FITS[fit]
    sleeve_len = SLEEVES[sleeves] if isinstance(sleeves, str) else float(sleeves)
    neck = {  # front drop, front depth, back drop
        "crew": (0.075, 0.075, 0.02),
        "v-neck": (0.17, 0.07, 0.02),
        "polo": (0.045, 0.07, 0.015),
    }[collar]
    return dict(
        collar=collar, fit=fit, fw=fw, length=0.74 * fl,
        cols=24, rows=24, armpit_t=0.7, neck_s=1 / 3,
        width=[(0, .245), (.35, .232), (.62, .25), (.72, .25), (1, .228)],
        depth_front=[(0, .118), (.35, .108), (.62, .115)],
        depth_back=[(0, .112), (.35, .104), (.62, .108)],
        chest_t=0.62, armhole_depth=0.06, shoulder_drop=0.045,
        neck_drop_front=neck[0], neck_depth_front=neck[1], neck_drop_back=neck[2], neck_depth_back=0.05,
        sleeve_len=sleeve_len * fl, sleeve_angle=math.radians(SLEEVE_ANGLE),
        cuff_radius=(0.07 if sleeve_len < 0.35 else 0.045) * fw,
    )


def shirt_part(collar=COLLAR_TYPE, sleeves=SLEEVE_LENGTH, fit=FIT):
    P = shirt_params(collar, sleeves, fit)
    part = Part("Shirt")
    C, R = P["cols"], P["rows"]
    A = round(P["armpit_t"] * R)
    tA = A / R
    half = C // 2
    neck_cols = round(P["neck_s"] * half)
    sn = neck_cols / half
    iL, iR = half - neck_cols, half + neck_cols
    fw = P["fw"]

    def s_of(i):
        return -1 + 2 * i / C

    def depth(back, t):
        d = curve(P["depth_back" if back else "depth_front"], min(t, P["chest_t"]))
        if t > P["chest_t"]:
            u = (t - P["chest_t"]) / (1 - P["chest_t"])
            d *= math.sqrt(max(0.0, 1 - u * u))
        return d * fw

    def armhole(t):
        return P["armhole_depth"] * fw * math.sin(math.pi * (t - tA) / (1 - tA)) if t > tA else 0.0

    def neck(back, s):
        """(drop of the top edge, how far the neckline sits in front of / behind the shoulder line)."""
        a = abs(s)
        if a >= sn - 1e-9:
            return 0.0, 0.0
        u = a / sn
        round_ = math.sqrt(max(0.0, 1 - u * u))
        if back:
            return P["neck_drop_back"] * round_, P["neck_depth_back"] * round_
        drop = P["neck_drop_front"] * ((1 - u) if collar == "v-neck" else round_)
        return drop, P["neck_depth_front"] * round_

    def top(back, s):
        a = abs(s)
        if a < sn:
            return P["length"] - neck(back, s)[0]
        return P["length"] - P["shoulder_drop"] * ((a - sn) / (1 - sn)) ** 1.2

    def position(back, i, j):
        s, t = s_of(i), j / R
        width = curve(P["width"], t) * fw
        d, e = depth(back, t), armhole(t)
        across = (1 - abs(s) ** 2.4) ** (1 / 2.4)
        y = e + (d - e) * across + neck(back, s)[1] * t ** 4
        return Vector((s * width, y if back else -y, t * top(back, s)))

    def shared_with_front(i, j):
        side_seam = i in (0, C) and j <= A
        shoulder_seam = j == R and abs(s_of(i)) >= sn - 1e-9
        return side_seam or shoulder_seam

    vid = {}
    for back in (False, True):
        for j in range(R + 1):
            for i in range(C + 1):
                if back and shared_with_front(i, j):
                    vid[(True, i, j)] = vid[(False, i, j)]
                else:
                    vid[(back, i, j)] = part.vert(position(back, i, j))
    V = part.verts

    # Body panels. Local frame: p = arc across from the centre line, q = arc up from the hem.
    # Front: p grows toward +X (seen from the front); back: toward -X (seen from behind).
    for back, name in ((False, "front"), (True, "back")):
        part.island(name, "shirt_body", "body",
                    "p: metres across from the centre line, q: metres up from the hem")
        q = {}
        for i in range(C + 1):
            col = [V[vid[(back, i, j)]] for j in range(R + 1)]
            for j, a in enumerate(arc_lengths(col)):
                q[(i, j)] = a
        p = {}
        for j in range(R + 1):
            row = [V[vid[(back, i, j)]] for i in range(C + 1)]
            arcs = arc_lengths(row)
            for i in range(C + 1):
                p[(i, j)] = (arcs[i] - arcs[half]) * (-1 if back else 1)
        for j in range(R):
            for i in range(C):
                corners = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
                if back:
                    corners.reverse()
                part.face([vid[(back, a, b)] for a, b in corners], [(p[c], q[c]) for c in corners], name)

    # Sleeves: tubes bridged to the armholes, bending down to SLEEVE_ANGLE.
    for sg, name in ((1, "sleeve_left"), (-1, "sleeve_right")):
        part.island(name, "shirt_sleeves", "sleeve",
                    "p: metres around from the top line (underarm seam at both ends), q: minus metres from the shoulder",
                    length=P["sleeve_len"])
        edge = C if sg > 0 else 0
        ring0 = ([vid[(False, edge, j)] for j in range(A, R + 1)] +
                 [vid[(True, edge, j)] for j in range(R - 1, A, -1)])
        M = len(ring0)
        pts = [V[k] for k in ring0]
        c = sum(pts, Vector()) / M
        n = newell_normal(pts)
        if n.x * sg < 0:
            n = -n
        e1 = (Vector((0, 0, 1)) - n * n.z).normalized()
        e2 = n.cross(e1)
        polar = [(math.atan2((pt - c).dot(e2), (pt - c).dot(e1)), ((pt - c) - n * (pt - c).dot(n)).length)
                 for pt in pts]
        r_root = sum(r for _, r in polar) / M
        L = P["sleeve_len"]
        K = max(4, round(L / 0.04))
        target = Vector((sg * math.cos(P["sleeve_angle"]), 0, -math.sin(P["sleeve_angle"])))
        bend = min(0.13, 0.55 * L)
        steps = K * 50
        pos, T, E1, E2 = c.copy(), n.copy(), e1.copy(), e2.copy()
        frames = [(pos.copy(), E1.copy(), E2.copy(), 0.0)]
        for step in range(1, steps + 1):
            l = L * step / steps
            Tn = n.slerp(target, smoothstep(0, bend, l))
            rot = T.rotation_difference(Tn)
            E1, E2, T = rot @ E1, rot @ E2, Tn
            pos = pos + Tn * (L / steps)
            if step % 50 == 0:
                frames.append((pos.copy(), E1.copy(), E2.copy(), l))
        rings = [ring0]
        for k in range(1, K + 1):
            center, f1, f2, l = frames[k]
            blend = smoothstep(0, min(0.07, 0.4 * L), l)
            radius = lerp(r_root * 0.97, P["cuff_radius"], l / L)
            ring = []
            for phi, r0 in polar:
                r = lerp(r0, radius, blend)
                ring.append(part.vert(center + (f1 * math.cos(phi) + f2 * math.sin(phi)) * r))
            rings.append(ring)
        uv = []
        for k, ring in enumerate(rings):
            arcs = arc_lengths([V[x] for x in ring], closed=True)
            top_line = arcs[M // 2]
            uv.append([(a - top_line, -frames[k][3]) for a in arcs])
        for k in range(K):
            for m in range(M):
                ids = [rings[k][m], rings[k][(m + 1) % M], rings[k + 1][(m + 1) % M], rings[k + 1][m]]
                uvs = [uv[k][m], uv[k][m + 1], uv[k + 1][m + 1], uv[k + 1][m]]
                part.face(ids, uvs, name)

    # Collar band around the neck hole, seam at the back centre.
    loop = ([vid[(True, i, R)] for i in range(half, iR + 1)] +
            [vid[(False, i, R)] for i in range(iR - 1, iL - 1, -1)] +
            [vid[(True, i, R)] for i in range(iL + 1, half)])
    # (height, outward offset) per row; outward is horizontal, away from the neck centre.
    profile = {
        "crew": [(0.0, 0.0), (0.011, -0.004), (0.022, -0.006), (0.026, -0.001)],
        "v-neck": [(0.0, 0.0), (0.01, -0.003), (0.02, -0.004), (0.023, 0.0)],
        "polo": [(0.0, 0.0), (0.015, -0.003), (0.03, -0.004), (0.035, 0.004), (0.014, 0.022), (-0.004, 0.038)],
    }[collar]
    part.island("collar", "shirt_collar", "collar",
                "p: metres around from the front centre (seam at the back), q: metres up the band")
    band(part, loop, loop.index(vid[(False, half, R)]), profile, "collar",
         gap=0.03 if collar == "polo" else 0.0)  # the polo opening at the front

    part.params = dict(collar=collar, sleeves=sleeves, fit=fit, sleeve_angle=SLEEVE_ANGLE)
    part.layout_order = ["front", "back", "sleeve_right", "sleeve_left", "collar"]
    return part


def band(part, loop, front_index, profile, island, gap=0.0):
    """A band rising from a closed vertex loop (collar, waistband). profile: (height, outward offset) per row,
    the first row being the loop itself. The UV seam sits opposite front_index; faces whose ends are both
    closer than `gap` to the front centre are left out (an opening)."""
    V = part.verts
    N = len(loop)
    base = [V[k] for k in loop]
    centre = sum(base, Vector()) / N
    up = Vector((0, 0, 1))
    rows = [loop]
    for h, o in profile[1:]:
        row = []
        for b in base:
            out = Vector((b.x - centre.x, b.y - centre.y, 0)).normalized()
            row.append(part.vert(b + up * h + out * o))
        rows.append(row)
    # Indices 0..N run round the loop from the seam (opposite the front) back to it; p = 0 at the front.
    start = (front_index + N // 2) % N
    order = [(start + m) % N for m in range(N + 1)]
    walk = arc_lengths([base[k] for k in order[:-1]], closed=True)
    p_of = [w - walk[N - N // 2] for w in walk]
    q_of = [[0.0] * (N + 1)]
    for r in range(1, len(rows)):
        q_of.append([q_of[-1][m] + (V[rows[r][k]] - V[rows[r - 1][k]]).length for m, k in enumerate(order)])
    for r in range(len(rows) - 1):
        for m in range(N):
            if gap and abs(p_of[m]) < gap and abs(p_of[m + 1]) < gap:
                continue
            k0, k1 = order[m], order[m + 1]
            ids = [rows[r][k0], rows[r][k1], rows[r + 1][k1], rows[r + 1][k0]]
            uvs = [(p_of[m], q_of[r][m]), (p_of[m + 1], q_of[r][m + 1]),
                   (p_of[m + 1], q_of[r + 1][m + 1]), (p_of[m], q_of[r + 1][m])]
            part.face(ids, uvs, island)


def shirt_folds(kind, p, q, island):
    """Fold displacement along the normal (metres) at local coordinates (p, q)."""
    if kind == "body":
        a = abs(p)
        drape = 0.0042 * smoothstep(0.32, 0.02, q) * math.sin(a * 38 + 1.6 * math.sin(q * 9 + a * 4))
        waist = (0.0022 * smoothstep(0.18, 0.27, a) * smoothstep(0.12, 0.22, q) * smoothstep(0.46, 0.36, q)
                 * math.sin(q * 62))
        pit = 0.0026 * math.exp(-((a - 0.29) ** 2 + (q - 0.49) ** 2) / 0.004) * math.sin((q + 0.8 * a) * 75)
        return drape + waist + pit
    if kind == "sleeve":
        l = -q
        under = 0.0026 * smoothstep(0.08, 0.2, abs(p)) * smoothstep(0.16, 0.0, l) * math.sin(l * 55 + p * 9)
        return under
    return 0.0


# ---------------------------------------------------------------- shorts template
# Shared kit frame: the shirt hem is at z = 0, the shorts waist sits under it and the socks below the knee,
# so the three GLBs line up when loaded together.


def shorts_part(fit=FIT):
    fw, fl = FITS[fit]
    part = Part("Shorts")
    C, RL, RP = 24, 8, 10           # columns across a panel, rows hem->crotch, rows crotch->waist
    R, Jc, half = RL + RP, RL, C // 2
    z_hem, z_crotch, z_waist = -0.33 * fl, -0.17 * fl, 0.10
    hip = 0.205 * fw                 # half width at the hips; each leg is half of that at the crotch
    a_c = hip / 2
    pelvis_w = [(0, hip), (0.35, hip), (1, 0.185 * fw)]
    # Above the shirt hem (t > ~0.6) the shorts stay inside the shirt (back depth there is ~0.11).
    pelvis_d = {False: [(0, .095), (0.35, .108), (0.6, .096), (1, .086)],
                True: [(0, .1), (0.35, .122), (0.6, .098), (1, .088)]}

    def position(back, i, j, sg):
        s = -1 + 2 * i / C
        u = abs(s)
        sg = sg or (1 if s >= 0 else -1)
        if j <= Jc:  # legs: two ellipses, inner seam at u = 0, outer seam at u = 1
            t = j / Jc
            a = lerp(0.115, a_c / fw, t) * fw
            d = lerp(0.1, 0.095, t) * fw
            xc = a_c + 0.02 * (1 - t) * fw
            x = sg * (xc - a * math.cos(math.pi * u))
            y = d * math.sin(math.pi * u)
            z = lerp(z_hem, z_crotch, t)
        else:        # pelvis: the two leg lobes blend into one ellipse
            t = (j - Jc) / RP
            beta = 1 - smoothstep(0, 0.5, t)
            xl, yl = sg * a_c * (1 - math.cos(math.pi * u)), 0.095 * fw * math.sin(math.pi * u)
            xp = sg * u * curve(pelvis_w, t)
            yp = curve(pelvis_d[back], t) * fw * (1 - u ** 2.4) ** (1 / 2.4)
            x, y = lerp(xp, xl, beta), lerp(yp, yl, beta)
            z = lerp(z_crotch, z_waist, t)
        return Vector((x, y if back else -y, z))

    def key(back, i, j, side):
        """side: which leg a corner on the centre column below the crotch belongs to."""
        sg = side if (i == half and j < Jc) else 0
        if back and (i in (0, C) or (i == half and j <= Jc)):
            back = False  # side seams, inner leg seams and the crotch point are shared with the front
        return (back, i, j, sg)

    vid = {}
    for back in (False, True):
        for j in range(R + 1):
            for i in range(C + 1):
                for side in ((-1, 1) if (i == half and j < Jc) else (0,)):
                    k = key(back, i, j, side)
                    if k not in vid:
                        vid[k] = part.vert(position(k[0], i, j, side))
    V = part.verts

    for back, name in ((False, "front"), (True, "back")):
        part.island(name, "shorts_body", "body",
                    "p: metres across from the centre line (wearer's left on the front is +x), q: metres above the "
                    "leg hem (straight height)")
        uv = {}
        # q is the straight height, not the arc up the columns: the centre seam curves back between the legs,
        # and measuring along it would bend horizontal designs into a V at the front.
        for side in (-1, 1):
            for i in range(C + 1):
                for j in range(R + 1):
                    k = key(back, i, j, side)
                    uv.setdefault(k, [0.0, V[vid[k]].z - z_hem])
        for j in range(R + 1):
            for side in (-1, 1):
                cols = range(half, C + 1) if side > 0 else range(half, -1, -1)
                row = [V[vid[key(back, i, j, side)]] for i in cols]
                offset = abs(row[0].x)  # the gap between the legs below the crotch
                for i, arc in zip(cols, arc_lengths(row)):
                    p = side * (arc + offset)
                    uv[key(back, i, j, side)][0] = -p if back else p
        for j in range(R):
            for i in range(C):
                side = -1 if i < half else 1
                corners = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
                if back:
                    corners.reverse()
                ks = [key(back, a, b, side) for a, b in corners]
                part.face([vid[k] for k in ks], [tuple(uv[k]) for k in ks], name)

    loop = ([vid[key(True, i, R, 0)] for i in range(half, C)] +
            [vid[key(False, i, R, 0)] for i in range(C, -1, -1)] +
            [vid[key(True, i, R, 0)] for i in range(1, half)])
    part.island("waistband", "shorts_waistband", "band",
                "p: metres around from the front centre (seam at the back), q: metres up the band")
    band(part, loop, loop.index(vid[key(False, half, R, 0)]),
         [(0.0, 0.0), (0.018, -0.004), (0.036, -0.006), (0.04, -0.001)], "waistband")

    part.params = dict(fit=fit)
    part.layout_order = ["front", "back", "waistband"]
    return part


def shorts_folds(kind, p, q, island):
    if kind != "body":
        return 0.0
    a = abs(p)
    drape = 0.003 * smoothstep(0.12, 0.0, q) * math.sin(a * 42 + 1.2 * math.sin(q * 20))
    crotch = 0.0018 * math.exp(-((a - 0.06) ** 2 + (q - 0.17) ** 2) / 0.003) * math.sin((q - a) * 80)
    return drape + crotch


# ---------------------------------------------------------------- socks template


def socks_part(fit=FIT):
    fw = FITS[fit][0]
    part = Part("Socks")
    M = 16
    z_top, z_ankle, bend = -0.47, -0.92, 0.05
    leg = z_top - z_ankle
    foot, toe = 0.14, 0.05
    top_band = 0.06
    leg_r = [(0, .054), (.13, .06), (.28, .05), (leg, .037)]

    def frame(l, x):
        """Centre, axis frame (E1 = front of the shin, turning into the top of the foot; E2 sideways)."""
        E2 = Vector((-1, 0, 0))
        if l <= leg:
            return Vector((x, 0, z_top - l)), Vector((0, -1, 0)), E2
        arc = bend * math.pi / 2
        if l <= leg + arc:
            th = (l - leg) / bend
            return (Vector((x, -bend + bend * math.cos(th), z_ankle - bend * math.sin(th))),
                    Vector((0, -math.cos(th), math.sin(th))), E2)
        return Vector((x, -bend - (l - leg - arc), z_ankle - bend)), Vector((0, 0, 1)), E2

    def radii(l):
        arc = bend * math.pi / 2
        if l <= leg:
            r = curve(leg_r, l)
            return r, r
        if l <= leg + arc:
            t = (l - leg) / arc
            return lerp(.037, .034, t), lerp(.037, .044, t)
        t = (l - leg - arc) / (foot + toe)
        tip = l - (leg + arc + foot)
        shrink = math.sqrt(max(0.0, 1 - (tip / toe) ** 2)) if tip > 0 else 1.0
        return lerp(.034, .03, t) * shrink, lerp(.044, .046, t) * shrink

    arc = bend * math.pi / 2
    stops = sorted(set(
        [round(top_band * k / 2, 4) for k in range(3)] +
        [round(top_band + (leg - top_band) * k / 13, 4) for k in range(14)] +
        [round(leg + arc * k / 5, 4) for k in range(6)] +
        [round(leg + arc + foot * k / 4, 4) for k in range(5)] +
        [round(leg + arc + foot + toe * f, 4) for f in (0.4, 0.7, 0.9)]))
    end = leg + arc + foot + toe
    for sg, side in ((1, "left"), (-1, "right")):
        body, top = f"sock_{side}", f"sock_top_{side}"
        part.island(top, "socks_top", "sock_top", "p: metres around from the front of the shin (seam at the back), "
                    "q: minus metres down from the top edge")
        part.island(body, "socks_body", "sock", "p: metres around from the front of the shin / top of the foot "
                    "(seam at the back and sole), q: minus metres along the sock from the top edge", length=end)
        x = sg * 0.105 * fw
        rings, uv = [], []
        for l in stops:
            c, E1, E2 = frame(l, x)
            r1, r2 = radii(l)
            r1, r2 = r1 * fw, r2 * fw
            pts = [c + E1 * (math.cos(math.pi + 2 * math.pi * m / M) * r1)
                   + E2 * (math.sin(math.pi + 2 * math.pi * m / M) * r2 * sg) for m in range(M)]
            rings.append([part.vert(pt) for pt in pts])
            arcs = arc_lengths(pts, closed=True)
            uv.append([(a - arcs[M // 2], -l) for a in arcs])
        for k in range(len(stops) - 1):
            name = top if stops[k + 1] <= top_band + 1e-6 else body
            for m in range(M):
                ids = [rings[k][m], rings[k][(m + 1) % M], rings[k + 1][(m + 1) % M], rings[k + 1][m]]
                part.face(ids, [uv[k][m], uv[k][m + 1], uv[k + 1][m + 1], uv[k + 1][m]], name)
        c, _, _ = frame(end, x)
        tip = part.vert(c + Vector((0, -0.004, 0)))
        last = uv[-1]
        for m in range(M):
            part.face([rings[-1][m], rings[-1][(m + 1) % M], tip],
                      [last[m], last[m + 1], ((last[m][0] + last[m + 1][0]) / 2, -end)], body)

    part.params = dict(fit=fit)
    part.layout_order = ["sock_left", "sock_right", "sock_top_left", "sock_top_right"]
    return part


def socks_folds(kind, p, q, island):
    if kind != "sock":
        return 0.0
    l = -q
    ankle = 0.0016 * math.exp(-((l - 0.43) / 0.035) ** 2) * math.sin(l * 140 + p * 25)
    knee = 0.0012 * math.exp(-((l - 0.09) / 0.03) ** 2) * math.sin(l * 110 + p * 12)
    return ankle + knee


TEMPLATES = {
    "shirt": (shirt_part, shirt_folds),
    "shorts": (shorts_part, shorts_folds),
    "socks": (socks_part, socks_folds),
}

# ---------------------------------------------------------------- mesh building, UV layout


def build_object(part):
    bm = bmesh.new()
    verts = [bm.verts.new(v) for v in part.verts]
    local = bm.loops.layers.uv.new("Local")
    island_layer = bm.faces.layers.int.new("island")
    names = list(part.islands)
    mats = part.materials
    for ids, uvs, island in part.faces:
        f = bm.faces.new([verts[i] for i in ids])
        f.material_index = mats.index(part.islands[island]["material"])
        f[island_layer] = names.index(island)
        by_vert = {verts[i]: uv for i, uv in zip(ids, uvs)}
        for loop in f.loops:
            loop[local].uv = by_vert[loop.vert]
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # recalc_face_normals is consistent per connected piece but may pick inward on an open surface:
    # make each piece face away from its own centre.
    seen = set()
    for f0 in bm.faces:
        if f0 in seen:
            continue
        piece, stack = [], [f0]
        seen.add(f0)
        while stack:
            f = stack.pop()
            piece.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g not in seen:
                        seen.add(g)
                        stack.append(g)
        centre = sum((f.calc_center_median() for f in piece), Vector()) / len(piece)
        outward = sum(f.normal.dot(f.calc_center_median() - centre) * f.calc_area() for f in piece)
        if outward < 0:
            bmesh.ops.reverse_faces(bm, faces=piece)
    bm.normal_update()

    # Every island must read the right way round from outside: counter-clockwise around the outward normal.
    for k, name in enumerate(names):
        area = 0.0
        for f in bm.faces:
            if f[island_layer] != k:
                continue
            uv = [l[local].uv for l in f.loops]
            area += sum(a.x * b.y - b.x * a.y for a, b in zip(uv, uv[1:] + uv[:1]))
        flip = area < 0
        part.islands[name]["mirrored_p"] = flip
        if flip:
            for f in bm.faces:
                if f[island_layer] == k:
                    for l in f.loops:
                        l[local].uv.x = -l[local].uv.x

    layout = pack_islands(part, bm, local, island_layer, names)
    final = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        L = layout[names[f[island_layer]]]
        for l in f.loops:
            p, q = l[local].uv
            l[final].uv = (L["u0"] + L["scale"] * (p - L["pmin"]), L["v1"] - L["scale"] * (L["qmax"] - q))

    mesh = bpy.data.meshes.new(part.name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.uv_layers.active = mesh.uv_layers["UVMap"]
    mesh.uv_layers["UVMap"].active_render = True
    for m in part.materials:
        mesh.materials.append(make_material(m))
    obj = bpy.data.objects.new(part.name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, layout, names


def pack_islands(part, bm, local, island_layer, names, margin=0.02):
    """Shelf-pack the islands top-down at one shared scale (texture units per metre), as large as fits."""
    box = {n: [1e9, 1e9, -1e9, -1e9] for n in names}
    for f in bm.faces:
        b = box[names[f[island_layer]]]
        for l in f.loops:
            p, q = l[local].uv
            b[0], b[1], b[2], b[3] = min(b[0], p), min(b[1], q), max(b[2], p), max(b[3], q)
    order = [n for n in part.layout_order if n in names]

    def place(scale):
        out, x, top, shelf_h = {}, margin, 1 - margin, 0.0
        for n in order:
            w, h = (box[n][2] - box[n][0]) * scale, (box[n][3] - box[n][1]) * scale
            if x + w > 1 - margin + 1e-9:
                x, top, shelf_h = margin, top - shelf_h - margin, 0.0
            out[n] = dict(u0=x, v1=top, w=w, h=h, pmin=box[n][0], qmax=box[n][3], scale=scale)
            x += w + margin
            shelf_h = max(shelf_h, h)
        return out, top - shelf_h

    lo, hi = 0.1, 5.0
    for _ in range(40):
        mid = (lo + hi) / 2
        _, bottom = place(mid)
        lo, hi = (mid, hi) if bottom >= margin and all(
            v["u0"] + v["w"] <= 1 - margin + 1e-9 for v in place(mid)[0].values()) else (lo, mid)
    layout, _ = place(lo)
    return layout


def make_material(name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = False  # exported as doubleSided: the inside of the shirt is visible
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
    bsdf.inputs["Roughness"].default_value = 0.8
    return mat


def subdivide(obj, levels):
    if levels <= 0:
        return obj
    mod = obj.modifiers.new("Subdivision", "SUBSURF")
    mod.levels = mod.render_levels = levels
    mod.uv_smooth = "PRESERVE_BOUNDARIES"
    mod.boundary_smooth = "ALL"
    deps = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(deps), preserve_all_data_layers=True, depsgraph=deps)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    mesh.name = old.name
    bpy.data.meshes.remove(old)
    return obj


def add_folds(obj, part, names, fold_fn, strength):
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    local = bm.loops.layers.uv["Local"]
    island_layer = bm.faces.layers.int["island"]
    bm.normal_update()
    moves = []
    if strength:
        for v in bm.verts:
            vals = []
            for l in v.link_loops:
                name = names[l.face[island_layer]]
                p, q = l[local].uv
                if part.islands[name]["mirrored_p"]:
                    p = -p
                vals.append(fold_fn(part.islands[name]["kind"], p, q, name))
            moves.append((v, v.normal * (sum(vals) / len(vals)) * strength))
        for v, d in moves:
            v.co += d
    bm.loops.layers.uv.remove(local)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True


def check_uvs(obj, names):
    """Count UV faces wound the wrong way (folded or overlapping) per island."""
    mesh = obj.data
    uv = mesh.uv_layers["UVMap"].data
    isl = mesh.attributes["island"].data
    bad = {n: 0 for n in names}
    for poly in mesh.polygons:
        pts = [uv[i].uv for i in poly.loop_indices]
        area = sum(a.x * b.y - b.x * a.y for a, b in zip(pts, pts[1:] + pts[:1]))
        if area <= 0:
            bad[names[isl[poly.index].value]] += 1
    return bad


# ---------------------------------------------------------------- UV layout PNG

FONT = {
    "A": ".###.#...##...#######...##...##...#", "B": "####.#...##...#####.#...##...#####.",
    "C": ".###.#...##....#....#....#...#.###.", "D": "####.#...##...##...##...##...#####.",
    "E": "######....#....####.#....#....#####", "F": "######....#....####.#....#....#....",
    "G": ".###.#...##....#.####...##...#.####", "H": "#...##...##...#######...##...##...#",
    "I": ".###...#....#....#....#....#...###.", "J": "..###...#....#....#....#.#..#..##..",
    "K": "#...##..#.#.#..##...#.#..#..#.#...#", "L": "#....#....#....#....#....#....#####",
    "M": "#...###.###.#.##.#.##...##...##...#", "N": "#...##...###..##.#.##..###...##...#",
    "O": ".###.#...##...##...##...##...#.###.", "P": "####.#...##...#####.#....#....#....",
    "Q": ".###.#...##...##...##.#.##..#..##.#", "R": "####.#...##...#####.#.#..#..#.#...#",
    "S": ".#####....#.....###.....#....#####.", "T": "#####..#....#....#....#....#....#..",
    "U": "#...##...##...##...##...##...#.###.", "V": "#...##...##...##...##...#.#.#...#..",
    "W": "#...##...##...##.#.##.#.##.#.#.#.#.", "X": "#...##...#.#.#...#...#.#.#...##...#",
    "Y": "#...##...#.#.#...#....#....#....#..", "Z": "#####....#...#...#...#...#....#####",
    "0": ".###.#...##..###.#.###..##...#.###.", "1": "..#...##....#....#....#....#...###.",
    "2": ".###.#...#....#...#...#...#...#####", "3": "####.....#....#.###.....#....#####.",
    "4": "...#...##..#.#.#..#.#####...#....#.", "5": "######....####.....#....##...#.###.",
    "6": "..##..#...#....####.#...##...#.###.", "7": "#####....#...#...#...#....#....#...",
    "8": ".###.#...##...#.###.#...##...#.###.", "9": ".###.#...##...#.####....#...#..##..",
    "-": "...............#####...............", ".": ".........................##...##...",
    "/": "....#...#....#...#....#...#....#...", " ": "." * 35,
}

ISLAND_TINTS = {"body": (0.18, 0.55, 0.95), "sleeve": (0.95, 0.45, 0.25), "collar": (0.35, 0.85, 0.45),
                "band": (0.35, 0.85, 0.45), "sock": (0.18, 0.55, 0.95), "sock_top": (0.35, 0.85, 0.45)}


def draw_text(img, text, cx, cy, size, color):
    """Bitmap text centred at pixel (cx, cy); size = pixel height of a glyph."""
    cell = max(1, int(size / 7))
    width = len(text) * 6 * cell - cell
    x0, y0 = int(cx - width / 2), int(cy - 7 * cell / 2)
    H, W = img.shape[:2]
    for k, ch in enumerate(text.upper()):
        glyph = FONT.get(ch, FONT[" "])
        for idx, px in enumerate(glyph):
            if px != "#":
                continue
            r, c = divmod(idx, 5)
            y, x = y0 + r * cell, x0 + (k * 6 + c) * cell
            img[max(0, y):min(H, y + cell), max(0, x):min(W, x + cell), :3] = color
            img[max(0, y):min(H, y + cell), max(0, x):min(W, x + cell), 3] = 1


def draw_segments(img, segs, color, alpha, thick):
    """segs: (n, 4) array of pixel coordinates x0, y0, x1, y1."""
    if len(segs) == 0:
        return
    H, W = img.shape[:2]
    lengths = np.ceil(np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])).astype(int) + 1
    idx = np.repeat(np.arange(len(segs)), lengths)
    t = np.concatenate([np.linspace(0, 1, n) for n in lengths])
    xs = segs[idx, 0] + (segs[idx, 2] - segs[idx, 0]) * t
    ys = segs[idx, 1] + (segs[idx, 3] - segs[idx, 1]) * t
    r = thick // 2
    for dx in range(-r, thick - r):
        for dy in range(-r, thick - r):
            x = np.clip(np.round(xs + dx).astype(int), 0, W - 1)
            y = np.clip(np.round(ys + dy).astype(int), 0, H - 1)
            img[y, x, :3] = img[y, x, :3] * (1 - alpha) + np.array(color) * alpha
            img[y, x, 3] = 1


def write_uv_png(obj, part, names, layout, size, path):
    mesh = obj.data
    mesh.calc_loop_triangles()
    uv = np.array([d.uv for d in mesh.uv_layers["UVMap"].data], dtype=np.float64).reshape(-1, 2)
    px = np.stack([uv[:, 0] * size, (1 - uv[:, 1]) * size], axis=1)  # image rows go down from v = 1
    island_of = np.array([a.value for a in mesh.attributes["island"].data])
    img = np.zeros((size, size, 4))
    img[..., :3] = (0.075, 0.08, 0.09)
    img[..., 3] = 1
    for k in range(1, 8):  # reference grid every 1/8
        c = int(k * size / 8)
        img[c, :, :3] = img[:, c, :3] = (0.14, 0.15, 0.17)
    # Island fills.
    for tri in mesh.loop_triangles:
        kind = part.islands[names[island_of[tri.polygon_index]]]["kind"]
        tint = np.array(ISLAND_TINTS[kind]) * 0.32 + 0.06
        p = px[list(tri.loops)]
        x0, y0 = np.floor(p.min(0)).astype(int)
        x1, y1 = np.ceil(p.max(0)).astype(int)
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = p
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-12:
            continue
        w0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
        w1 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w0 + w1 <= 1 + 1e-6)
        yy, xx = (ys[inside] - 0.5).astype(int), (xs[inside] - 0.5).astype(int)
        ok = (xx >= 0) & (xx < size) & (yy >= 0) & (yy < size)
        img[yy[ok], xx[ok], :3] = tint
    # Edges: every mesh edge faintly, island borders bold.
    edge_faces = {}
    for poly in mesh.polygons:
        li = list(poly.loop_indices)
        for a, b in zip(li, li[1:] + li[:1]):
            va, vb = mesh.loops[a].vertex_index, mesh.loops[b].vertex_index
            key = (min(va, vb), max(va, vb))
            pair = (a, b) if va < vb else (b, a)
            edge_faces.setdefault(key, []).append((island_of[poly.index], pair))
    inner, border = [], []
    for uses in edge_faces.values():
        (isl, (a, b)) = uses[0]
        seam = len(uses) == 1 or any(i != isl or np.abs(uv[x] - uv[a]).max() > 1e-5 or np.abs(uv[y] - uv[b]).max() > 1e-5
                                     for i, (x, y) in uses[1:])
        (border if seam else inner).append([*px[a], *px[b]])
        if seam:
            border.extend([*px[x], *px[y]] for _, (x, y) in uses[1:])
    inner, border = np.array(inner), np.array(border)
    draw_segments(img, inner, (0.75, 0.8, 0.85), 0.35, 1)
    draw_segments(img, border, (0.95, 0.97, 1.0), 1.0, max(2, size // 512))
    # Labels.
    for name, L in layout.items():
        label = name.replace("_", " ")
        cx, cy = (L["u0"] + L["w"] / 2) * size, (1 - L["v1"] + L["h"] / 2) * size
        glyph = min(L["h"] * size * 0.28, L["w"] * size * 0.8 / (len(label) * 6 / 7))
        draw_text(img, label, cx, cy, glyph, (1, 1, 1))
    info = " ".join([part.name] + [str(part.params[k]) for k in ("collar", "sleeves", "fit") if k in part.params]
                    + [f"{size}px"])
    if min(L["v1"] - L["h"] for L in layout.values()) > 0.04:  # only where it cannot cover an island
        draw_text(img, info, size * 0.75, size * 0.975, size / 64, (0.6, 0.65, 0.7))

    image = bpy.data.images.new(os.path.basename(path), size, size, alpha=True)
    image.pixels.foreach_set(np.flipud(img).astype(np.float32).ravel())
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)


# ---------------------------------------------------------------- export


def blender_draco_available():
    try:
        from io_scene_gltf2.io.com import gltf2_io_draco_compression_extension as draco
        return draco.dll_exists(quiet=True)
    except Exception:
        return False


def gltf_transform_cmd():
    local = os.path.join(ROOT, "web", "node_modules", ".bin", "gltf-transform")
    if os.path.exists(local):
        return [local]
    npx = shutil.which("npx")
    return [npx, "--yes", "@gltf-transform/cli"] if npx else None


def export_glb(obj, path, draco):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    native = draco and blender_draco_available()
    target = path if native or not draco else os.path.join(tempfile.mkdtemp(), "raw.glb")
    bpy.ops.export_scene.gltf(
        filepath=target, export_format="GLB", use_selection=True, export_apply=True,
        export_texcoords=True, export_normals=True, export_materials="EXPORT", export_yup=True,
        export_draco_mesh_compression_enable=native, export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14, export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
    )
    if not draco or native:
        return "Blender Draco" if native else "uncompressed"
    cmd = gltf_transform_cmd()
    if cmd:
        try:
            subprocess.run(cmd + ["draco", target, path, "--quantize-position", "14", "--quantize-normal", "10",
                                  "--quantize-texcoord", "12"], check=True, capture_output=True)
            return "Draco via gltf-transform"
        except Exception as err:
            print("WARNING: gltf-transform draco failed:", err)
    shutil.copyfile(target, path)
    print("WARNING: this Blender has no Draco library and gltf-transform is unavailable; exported uncompressed.")
    return "uncompressed"


def build_template(name, kwargs, out_name, draco):
    make, folds = TEMPLATES[name]
    part = make(**kwargs)
    obj, layout, names = build_object(part)
    subdivide(obj, SUBDIVISION_LEVELS)
    add_folds(obj, part, names, folds, FOLD_STRENGTH)
    bad = check_uvs(obj, names)

    os.makedirs(MODELS_DIR, exist_ok=True)
    os.makedirs(UV_DIR, exist_ok=True)
    for size in UV_SIZES:
        write_uv_png(obj, part, names, layout, size, os.path.join(UV_DIR, f"{out_name}_uv_{size}.png"))
    shutil.copyfile(os.path.join(UV_DIR, f"{out_name}_uv_{UV_SIZES[0]}.png"),
                    os.path.join(MODELS_DIR, f"{out_name}_uv.png"))

    template = {
        "template": name, "name": out_name, "params": part.params,
        "materials": part.materials,
        "texture": "One square texture for every part. rect = [x, y, w, h] in texture units, origin top-left. "
                   "A point (p, q) of an island's local frame (metres) lands at "
                   "x = rect.x + scale * (p - pmin), y = rect.y + scale * (qmax - q).",
        "islands": {},
    }
    for n in names:
        L = layout[n]
        info = part.islands[n]
        template["islands"][n] = {
            "material": info["material"], "kind": info["kind"], "frame": info["frame"],
            "rect": [round(L["u0"], 6), round(1 - L["v1"], 6), round(L["w"], 6), round(L["h"], 6)],
            "pmin": round(L["pmin"], 6), "qmax": round(L["qmax"], 6), "scale": round(L["scale"], 6),
            **{k: (round(v, 6) if isinstance(v, float) else v) for k, v in info.items()
               if k not in ("material", "kind", "frame", "mirrored_p")},
        }
    for path in (os.path.join(MODELS_DIR, f"{out_name}.json"), os.path.join(UV_DIR, f"{out_name}_uv.json")):
        with open(path, "w") as fh:
            json.dump(template, fh, indent=2)

    how = export_glb(obj, os.path.join(MODELS_DIR, f"{out_name}.glb"), draco)
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"[kit] {out_name}: {len(obj.data.vertices)} verts, {tris} tris, materials {part.materials}, "
          f"islands {names}, UV faces wound wrong {bad}, GLB {how}")
    return obj


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"collar": COLLAR_TYPE, "sleeves": SLEEVE_LENGTH, "fit": FIT, "only": BUILD, "name": None,
            "draco": DRACO}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-draco":
            opts["draco"] = False
        elif a in ("--collar", "--sleeves", "--fit", "--only", "--name"):
            i += 1
            opts[a[2:]] = argv[i].split(",") if a == "--only" else argv[i]
            opts.setdefault("explicit", set()).add(a[2:])
        else:
            raise SystemExit(f"unknown option {a}")
        i += 1
    s = opts["sleeves"]
    if s not in SLEEVES:
        opts["sleeves"] = float(s)
    if opts["collar"] not in ("crew", "v-neck", "polo") or opts["fit"] not in FITS:
        raise SystemExit("collar must be crew|v-neck|polo and fit slim|regular|loose")
    return opts


def write_manifest():
    """public/models/kits.json: every generated template, for the editor's template selector."""
    labels = {name: label for name, label, _, _ in SHIRT_VARIANTS}
    kits = []
    for file in sorted(os.listdir(MODELS_DIR)):
        if not file.endswith(".json") or file == "kits.json":
            continue
        with open(os.path.join(MODELS_DIR, file)) as fh:
            data = json.load(fh)
        if "template" not in data or not os.path.exists(os.path.join(MODELS_DIR, data["name"] + ".glb")):
            continue
        kits.append({"name": data["name"], "garment": data["template"], "label": labels.get(data["name"], data["name"]),
                     "params": data["params"]})
    order = list(labels)
    kits.sort(key=lambda k: (k["garment"], order.index(k["name"]) if k["name"] in order else len(order), k["name"]))
    with open(os.path.join(MODELS_DIR, "kits.json"), "w") as fh:
        json.dump({"kits": kits}, fh, indent=2)


def main():
    opts = parse_args()
    explicit = opts.get("explicit", set())
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name in opts["only"]:
        kwargs = dict(fit=opts["fit"])
        if name == "shirt" and not explicit & {"collar", "sleeves", "name"}:
            for out, _, collar, sleeves in SHIRT_VARIANTS:
                bpy.ops.wm.read_factory_settings(use_empty=True)
                build_template(name, dict(kwargs, collar=collar, sleeves=sleeves), out, opts["draco"])
            continue
        if name == "shirt":
            kwargs.update(collar=opts["collar"], sleeves=opts["sleeves"])
        out = opts["name"] if opts["name"] and len(opts["only"]) == 1 else name
        bpy.ops.wm.read_factory_settings(use_empty=True)
        build_template(name, kwargs, out, opts["draco"])
    write_manifest()


if __name__ == "__main__":
    main()
