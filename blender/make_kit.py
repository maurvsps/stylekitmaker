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
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree
import numpy as np

# ---------------------------------------------------------------- parameters
COLLAR_TYPE = "crew"        # "crew" | "v-neck" | "polo"
SLEEVE_LENGTH = "short"     # "short" | "long" | a length in metres, e.g. 0.4
FIT = "regular"             # "slim" | "regular" | "loose"
SLEEVE_ANGLE = 68.0         # degrees below horizontal: relaxed arms, still clear of the torso
SUBDIVISION_LEVELS = 1      # Catmull-Clark levels applied before export
FOLD_STRENGTH = 0.72       # subtle sewn-fabric creases, softened by the cloth drape
BUILD = ["shirt", "shorts", "socks"]  # templates to generate
UV_SIZES = (1024, 2048)     # UV layout PNG sizes
DRACO = True                # Draco mesh compression
DRAPE_FRAMES = 20           # cloth simulation frames (0 = no drape)
CLOTH_SHRINK = 0.0          # >0 tightens the cloth onto the body while it drapes
AO_SIZE = 1024              # baked ambient occlusion texture, public/models/<name>_ao.png
AO_SAMPLES = 64
AO_FLOOR = 0.2             # darkest the baked occlusion gets
THICKNESS = 0.0022          # fabric thickness (metres): hems, cuffs and collar edges show a rolled edge, not a sheet
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
SLEEVES = {"short": 0.25, "long": 0.58}

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
        self.limbs = []          # sleeve axes: [(centre, radius)] from the shoulder out, for the mannequin's arms
        self.pin = set()         # island names held in place while the cloth drapes (collar, waistband)
        self.pin_below = 0.0     # ...and the cloth up to this far (metres) below them
        self.pin_hem = False     # keep a garment's lower edge from being pulled up by gravity
        self.pin_near = 0.0      # ...and any cloth closer than this (metres) to the pinned vertices
        self.drape = True        # False: keep the modelled shape (socks are knitted tubes that hug the leg)
        self.bending = 0.6       # cloth bending stiffness: higher = fewer, broader folds

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
        "crew": (0.085, 0.08, 0.035),
        # A sports V-neck should open at the collarbone without dropping into the upper chest.
        "v-neck": (0.12, 0.065, 0.02),
        # Johnny collar (retro polo): a V opening the fold-down collar lies around.
        "polo": (0.1, 0.06, 0.015),
    }[collar]
    return dict(
        collar=collar, fit=fit, fw=fw, length=0.74 * fl,
        cols=32, rows=32, armpit_t=0.7, neck_s=0.36,
        # Extra ease at the chest and a shaped waist keep the jersey fitted without looking painted on.
        width=[(0, .224), (.32, .219), (.6, .233), (.72, .24), (1, .222)],
        depth_front=[(0, .108), (.32, .103), (.62, .116)],
        depth_back=[(0, .105), (.32, .099), (.62, .108)],
        chest_t=0.62, armhole_depth=0.075, shoulder_drop=0.075,
        neck_drop_front=neck[0], neck_depth_front=neck[1], neck_drop_back=neck[2], neck_depth_back=0.05,
        sleeve_len=sleeve_len * fl, sleeve_angle=math.radians(SLEEVE_ANGLE),
        cuff_radius=(0.085 if sleeve_len < 0.35 else 0.045) * fw,
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
        drop = P["neck_drop_front"] * ((1 - u) if collar in ("v-neck", "polo") else round_)
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
        part.limbs.append([(frames[k][0].copy(), r_root * 0.97 if k == 0 else
                            lerp(r_root * 0.97, P["cuff_radius"], frames[k][3] / L)) for k in range(K + 1)])
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
        "crew": [(0.0, 0.0), (0.011, 0.001), (0.021, 0.002), (0.027, 0.001)],
        "v-neck": [(0.0, 0.0), (0.01, -0.003), (0.02, -0.004), (0.023, 0.0)],
        "polo": None,  # see johnny_collar
    }[collar]
    part.island("collar", "shirt_collar", "collar",
                "p: metres around from the front centre (seam at the back), q: metres up the band")
    front = loop.index(vid[(False, half, R)])
    if collar == "polo":
        band(part, loop, front, [None] * len(JOHNNY), "collar", gap=0.028, rows=johnny_collar(part, loop))
    else:
        band(part, loop, front, profile, "collar")

    part.pin, part.pin_below, part.pin_hem = {"collar"}, 0.035, True
    part.pin_near = 0.02 if collar == "polo" else 0.0
    part.params = dict(collar=collar, sleeves=sleeves, fit=fit, sleeve_angle=SLEEVE_ANGLE)
    part.layout_order = ["front", "back", "sleeve_right", "sleeve_left", "collar"]
    return part


# Johnny collar rows: (stand height, outward, lift off the shirt), scaled per point by johnny_collar.
# The stand rises from the neckline, rolls over and the fall lies back down on the shirt.
JOHNNY = [(0.0, 0.0, 0.0), (0.014, -0.002, 0.0), (0.027, -0.002, 0.0), (0.033, 0.004, 0.0),
          (0.03, 0.012, 0.003), (0.014, 0.026, 0.004), (-0.001, 0.04, 0.004), (-0.012, 0.052, 0.003)]


def johnny_collar(part, loop):
    """Positions of the polo collar rows (JOHNNY) around the neckline loop, as a list of rows of Vectors.
    At the back the collar stands about 3 cm and falls over the shoulders; towards the V it lies flatter on the
    chest and its fall widens into the collar points. "Outward" is across the neckline on the shirt's surface:
    sideways and down from the V edges, away from the neck at the back."""
    V = part.verts
    N = len(loop)
    base = [V[k] for k in loop]
    centre = sum(base, Vector()) / N
    top = max(b.z for b in base)
    up = Vector((0, 0, 1))
    frames = []
    for k, b in enumerate(base):
        t = (base[(k + 1) % N] - base[k - 1]).normalized()
        radial = Vector((b.x - centre.x, b.y - centre.y, 0)).normalized()
        # How far down the V this point is: 0 round the back and sides, 1 at the bottom of the opening.
        w = smoothstep(0.012, 0.085, top - b.z) if b.y < centre.y else 0.0
        m = (radial * (0.25 + 0.75 * w) + up * (1 - w)).normalized()  # the shirt surface's normal, roughly
        out = t.cross(m).normalized()
        if out.dot(radial) < 0:
            out = -out
        stand = lerp(1.0, 0.3, w)
        fall = lerp(1.0, 2.1, smoothstep(0.25, 1.0, w) ** 1.5)  # the collar points
        frames.append((b, out, m, stand, fall))
    # The fall (rows from the fold on) is laid onto the shirt built so far, lifted by its thickness.
    bvh = BVHTree.FromPolygons([Vector(v) for v in V], [ids for ids, _, _ in part.faces])
    rows = []
    for r, (h, o, l) in enumerate(JOHNNY):
        row = []
        for b, out, m, st, fa in frames:
            pt = b + up * (h * st) + out * (o * fa)
            if r >= 4:
                loc, n, _, _ = bvh.find_nearest(pt)
                if n.dot(m) < 0:
                    n = -n
                pt = loc + n * (0.004 + l)
            row.append(pt + m * l if r < 4 else pt)
        rows.append(row)
    return rows


def band(part, loop, front_index, profile, island, gap=0.0, rows=None):
    """A band rising from a closed vertex loop (collar, waistband). profile: (height, outward offset) per row,
    the first row being the loop itself; `rows` instead gives every row's positions (the first row unused).
    The UV seam sits opposite front_index; faces whose ends are both closer than `gap` to the front centre are
    left out (an opening)."""
    V = part.verts
    N = len(loop)
    base = [V[k] for k in loop]
    centre = sum(base, Vector()) / N
    up = Vector((0, 0, 1))
    if rows is None:
        rows = [[b + up * h + Vector((b.x - centre.x, b.y - centre.y, 0)).normalized() * o for b in base]
                for h, o in profile]
    rows = [loop] + [[part.vert(pt) for pt in row] for row in rows[1:]]
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


def ridge(x):
    """Fold profile with period 2*pi: rounded crests, sharp creases (cloth folds look like this, not like a sine)."""
    return 2 * abs(math.sin(x / 2)) - 1


def fold_band(a, q, start, end, wavelength, width):
    """Folds running from `start` towards `end` (points in (|p|, q) metres): the crests run along that line and
    repeat across it every `wavelength`; they fade out over `width` either side and towards `end`."""
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    rx, ry = a - start[0], q - start[1]
    along = rx * ux + ry * uy
    across = -rx * uy + ry * ux
    if along < 0 or along > length:
        return 0.0
    fade = smoothstep(0, 0.04, along) * smoothstep(length, length * 0.35, along) * smoothstep(width, 0, abs(across))
    return fade * ridge(2 * math.pi * across / wavelength)


def shirt_folds(kind, p, q, island):
    """Fold displacement along the normal (metres) at local coordinates (p, q): drag folds from the armpits towards
    the waist, bunching over the hips at the sides, a soft wave at the hem and creases under the sleeves.
    The cloth simulation then relaxes them into natural shapes."""
    back = island == "back"
    if kind == "body":
        a = abs(p)
        side = 1 if p >= 0 else -1
        vary = 0.75 + 0.25 * math.sin(3.1 * p + 1.7 * side + (2.3 if back else 0))
        pit = 0.007 * fold_band(a, q, (0.215, 0.5), (0.06, 0.16), 0.055, 0.075)
        waist = (0.004 * smoothstep(0.12, 0.2, a) * smoothstep(0.05, 0.12, q) * smoothstep(0.34, 0.22, q)
                 * ridge(2 * math.pi * (q + 0.15 * a) / 0.062))
        hem = 0.005 * smoothstep(0.16, 0.0, q) * ridge(2 * math.pi * a / 0.13 + (1.3 if back else 0.4))
        return (pit + waist + hem) * vary
    if kind == "sleeve":
        l, a = -q, abs(p)
        under = 0.008 * smoothstep(0.06, 0.15, a) * smoothstep(0.16, 0.02, l) * ridge(2 * math.pi * (l + 0.6 * a) / 0.045)
        cuff = 0.0025 * smoothstep(0.1, 0.2, l) * ridge(2 * math.pi * p / 0.07 + 0.8)
        return under + cuff
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
    pelvis_w = [(0, hip), (0.35, hip), (0.6, 0.186 * fw), (1, 0.168 * fw)]
    # Above the shirt hem (t > ~0.6) the shorts stay inside the shirt, which drapes close to the body there.
    pelvis_d = {False: [(0, .095), (0.35, .106), (0.6, .088), (1, .078)],
                True: [(0, .1), (0.35, .12), (0.6, .09), (1, .08)]}

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

    part.pin, part.pin_below, part.bending = {"waistband"}, 0.04, 3.0
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

    part.drape = False
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


def make_mannequin_material():
    mat = bpy.data.materials.get("Mannequin skin") or bpy.data.materials.new("Mannequin skin")
    mat.use_nodes = True
    mat.diffuse_color = (0.58, 0.43, 0.31, 1.0)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = mat.diffuse_color
    bsdf.inputs["Roughness"].default_value = 0.62
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


# ---------------------------------------------------------------- mannequin, cloth drape, ambient occlusion
# An invisible body in the kit's shared frame. The garments drape onto it with Blender's cloth simulation, and it
# shades them when the ambient occlusion is baked (the inside of the collar, under the arms, between the legs).

# Torso rings: (z, half width, front depth, back depth), hips to the base of the neck.
TORSO = [(-0.135, 0.155, 0.067, 0.08), (-0.1, 0.178, 0.087, 0.105), (-0.02, 0.18, 0.091, 0.104),
         (0.18, 0.17, 0.088, 0.097), (0.38, 0.194, 0.104, 0.102), (0.5, 0.207, 0.101, 0.1),
         (0.58, 0.216, 0.086, 0.09), (0.64, 0.19, 0.067, 0.074), (0.69, 0.105, 0.055, 0.06),
         (0.71, 0.06, 0.05, 0.05)]
NECK = [(0.7, 0.056), (0.86, 0.05)]
# Legs: (z, radius, forward offset) from the hip down; x is the sock centre line.
LEG = [(-0.06, 0.07, 0.0), (-0.18, 0.074, 0.0), (-0.32, 0.068, -0.003), (-0.47, 0.046, -0.004), (-0.6, 0.05, 0.004),
       (-0.78, 0.036, 0.0), (-0.88, 0.031, 0.0)]


def ring_tube(name, rings, segs=32, cap=True):
    """A closed tube through rings of (centre, e1, e2, r1, r2): ellipses in the plane spanned by e1, e2."""
    bm = bmesh.new()
    loops = []
    for c, e1, e2, r1, r2 in rings:
        loops.append([bm.verts.new(c + e1 * (r1 * math.cos(2 * math.pi * m / segs)) +
                                   e2 * (r2 * math.sin(2 * math.pi * m / segs))) for m in range(segs)])
    for a, b in zip(loops, loops[1:]):
        for m in range(segs):
            bm.faces.new([a[m], a[(m + 1) % segs], b[(m + 1) % segs], b[m]])
    if cap:
        bm.faces.new(loops[0][::-1])
        bm.faces.new(loops[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def mannequin(part, fw):
    """A proportioned base body, fused into a continuous smooth collision/display mesh."""
    X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    objs = []
    rings = []
    # Keep the body just inside the shorts at the waist so the fused skin surface cannot poke through the gap.
    # The shorts' top tucks under the shirt: let it drape inside the shirt's own clearance (above the hips).
    under = -0.008 if part.name == "Shirt" else 0.0
    for z, w, df, db in TORSO:
        g = under * smoothstep(0.16, 0.08, z) if part.name == "Shirt" else -0.022 * smoothstep(-0.13, -0.04, z)
        w, df, db = w + g, df + g, db + g
        # front and back depths differ: shift the ellipse's centre so each side reaches its own depth
        d = (df + db) / 2
        rings.append((Vector((0, (db - df) / 2, z)), X, Y, w * fw, d * fw))
    objs.append(ring_tube("Body_torso", rings))
    objs.append(ring_tube("Body_neck", [(Vector((0, 0.005, z)), X, Y, r, r * 1.05) for z, r in NECK]))
    for limb in part.limbs:
        pts = [c for c, _ in limb]
        rad = [r for _, r in limb]
        # carry on past the cuff to the wrist so short sleeves rest on a forearm
        d = (pts[-1] - pts[-2]).normalized()
        extra = 0.26 if (pts[-1] - pts[0]).length < 0.35 else 0.06
        pts.append(pts[-1] + d * extra)
        rad.append(rad[-1] * 0.6)
        side = 1 if pts[0].x > 0 else -1
        # start inside the torso so arm and body overlap at the shoulder
        root = pts[0] - (pts[1] - pts[0]).normalized() * 0.06 + Vector((0, 0, 0.02))
        pts.insert(0, root)
        rad.insert(0, rad[0])
        arm = []
        for i, (c, r) in enumerate(zip(pts, rad)):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            e1 = (Y - t * t.dot(Y)).normalized()
            e2 = t.cross(e1)
            arm.append((c, e1, e2, r * 0.66, r * 0.7))
        objs.append(ring_tube(f"Body_arm_{side}", arm))
        objs.append(shoulder_ball(pts[1] + Vector((0, 0, 0.005)), rad[1] * 0.75, f"Body_shoulder_{side}"))
        # A shaped, featureless hand continues the forearm beyond the sleeve cuff.
        objs.append(shoulder_ball(pts[-1] + d * 0.035, 0.041, f"Body_hand_{side}",
                                  shape=(0.82, 0.72, 1.35), axis=d))
    for sg in (1, -1):
        x = sg * 0.105 * fw
        objs.append(ring_tube(f"Body_leg_{sg}", [(Vector((x + sg * 0.012 * max(0, (z + 0.47) / 0.31), y, z)),
                                                  X, Y, r * fw, r * fw * 1.05) for z, r, y in LEG]))
    # A smooth display head meets the neck; the fused surface removes the ball-and-socket look at the joints.
    objs.append(shoulder_ball(Vector((0, 0.005, 0.975)), 0.105, "Body_head",
                              shape=(0.76, 0.88, 1.08)))

    # Fuse overlapping body forms so the exported mannequin has natural shoulder/neck transitions and no visible
    # seams. Use the same continuous surface for cloth collisions and ambient occlusion.
    bpy.ops.object.select_all(action="DESELECT")
    for item in objs:
        item.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    body = bpy.context.object
    body.name = "Mannequin"
    remesh = body.modifiers.new("Continuous body", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = 0.009
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth = body.modifiers.new("Soften anatomy", "SMOOTH")
    smooth.factor = 0.55
    smooth.iterations = 3
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    for poly in body.data.polygons:
        poly.use_smooth = True
    return [body]


def shoulder_ball(c, r, name, shape=(1.0, 1.0, 1.0), axis=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=r)
    rotation = Vector((0, 0, 1)).rotation_difference(axis.normalized()) if axis is not None else None
    for v in bm.verts:
        p = Vector((v.co.x * shape[0], v.co.y * shape[1], v.co.z * shape[2]))
        v.co = (rotation @ p if rotation else p) + c
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def drape(obj, part, names, body, frames):
    """Let the garment settle onto the body under gravity (cloth simulation), pinned at part.pin, then apply it."""
    if frames <= 0 or not part.drape:
        return
    mesh = obj.data
    isl = mesh.attributes["island"].data
    pinned = set()
    for poly in mesh.polygons:
        if names[isl[poly.index].value] in part.pin:
            pinned.update(poly.vertices)
    bands = set(pinned)
    if pinned and part.pin_below:
        # also hold the cloth just below the pinned band, so the band doesn't drag it into creases
        # Measure down from the upper edge of the pinned area. Using the lowest vertex here makes a V-neck
        # pin an entire wedge of the chest because its front point sits far below the shoulders.
        floor = max(mesh.vertices[i].co.z for i in pinned) - part.pin_below
        pinned.update(v.index for v in mesh.vertices if v.co.z >= floor)
    if pinned and part.pin_near:
        # Hold the cloth lying under a pinned band (the fall of a polo collar) so it can't drape through it.
        tree = KDTree(len(bands))
        for i in bands:
            tree.insert(mesh.vertices[i].co, i)
        tree.balance()
        pinned.update(v.index for v in mesh.vertices if tree.find(v.co)[2] < part.pin_near)
    if part.pin_hem:
        # Anchor the bottom edge as well as the collar. This stops gravity from shortening the shirt and shifting
        # artwork toward the neck, especially on V-necks where the front collar has a deep centre point.
        hem = min(v.co.z for v in mesh.vertices)
        pinned.update(v.index for v in mesh.vertices if v.co.z <= hem + 0.009)
    group = obj.vertex_groups.new(name="pin")
    group.add(sorted(pinned), 1.0, "REPLACE")
    for b in body:
        col = b.modifiers.new("Collision", "COLLISION")
        b.collision.thickness_outer = 0.006
        b.collision.cloth_friction = 8.0
    cloth = obj.modifiers.new("Cloth", "CLOTH")
    st = cloth.settings
    st.quality = 10
    st.mass = 0.15
    st.tension_stiffness = st.compression_stiffness = 20
    st.shear_stiffness = 8
    st.bending_stiffness = part.bending
    st.air_damping = 2.0
    st.pin_stiffness = 1.0
    st.vertex_group_mass = "pin"
    st.shrink_min = CLOTH_SHRINK
    cs = cloth.collision_settings
    cs.distance_min = 0.004
    cs.collision_quality = 4
    cs.use_self_collision = True
    cs.self_distance_min = 0.003
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, frames
    cloth.point_cache.frame_start, cloth.point_cache.frame_end = 1, frames
    for f in range(1, frames + 1):
        scene.frame_set(f)
    deps = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(obj.evaluated_get(deps), preserve_all_data_layers=True, depsgraph=deps)
    old = obj.data
    obj.modifiers.clear()
    obj.vertex_groups.clear()
    obj.data = new
    new.name = old.name
    bpy.data.meshes.remove(old)
    for b in body:
        b.modifiers.clear()


def bake_ao(obj, body, path, size):
    """Bake ambient occlusion (garment and body both occlude) into a greyscale PNG on the garment's UVs."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = AO_SAMPLES
    scene.world = scene.world or bpy.data.worlds.new("World")
    scene.world.light_settings.distance = 0.12
    img = bpy.data.images.new("ao", size, size, alpha=False, float_buffer=False)
    img.generated_color = (1, 1, 1, 1)
    nodes = []
    for mat in obj.data.materials:
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = img
        mat.node_tree.nodes.active = node
        nodes.append((mat, node))
    for o in bpy.context.scene.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type="AO", margin=8, use_clear=True)
    # Lift the result: keep contact shadows, but never darker than AO_FLOOR.
    px = np.array(img.pixels[:]).reshape(-1, 4)
    v = AO_FLOOR + (1 - AO_FLOOR) * px[:, 0]
    px[:, 0] = px[:, 1] = px[:, 2] = v
    img.pixels = px.ravel().tolist()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    for mat, node in nodes:
        mat.node_tree.nodes.remove(node)
    bpy.data.images.remove(img)


def thicken(obj, thickness):
    """Give the cloth a thickness: an inner shell (same UVs, facing in) joined to the outer by a rim at every open
    edge, so hems, cuffs and the collar read as fabric with an edge instead of a paper-thin sheet."""
    if thickness <= 0:
        return
    mod = obj.modifiers.new("Thickness", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = -1  # inwards: the outside, where the design is, stays where it was
    mod.use_quality_normals = True  # no spikes where the rim turns sharply
    mod.use_rim = True
    deps = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(deps), preserve_all_data_layers=True, depsgraph=deps)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    mesh.name = old.name
    bpy.data.meshes.remove(old)
    for poly in mesh.polygons:
        poly.use_smooth = True


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
    objects = obj if isinstance(obj, (list, tuple)) else [obj]
    for item in objects:
        item.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
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
    body = mannequin(part, FITS[part.params["fit"]][0])
    add_folds(obj, part, names, folds, FOLD_STRENGTH)
    drape(obj, part, names, body, DRAPE_FRAMES)
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

    if AO_SIZE:
        bake_ao(obj, body, os.path.join(MODELS_DIR, f"{out_name}_ao.png"), AO_SIZE)
    thicken(obj, THICKNESS)  # after the bake: the inner shell shares the outer's UVs
    how = export_glb(obj, os.path.join(MODELS_DIR, f"{out_name}.glb"), draco)
    if out_name == "shirt":
        skin = make_mannequin_material()
        for item in body:
            item.data.materials.clear()
            item.data.materials.append(skin)
        body_how = export_glb(body, os.path.join(MODELS_DIR, "mannequin.glb"), draco)
        print(f"[kit] mannequin: {len(body)} meshes, GLB {body_how}")
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
