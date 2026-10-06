# -*- coding: utf-8 -*-
"""共有画像に埋めるサイト名のアウトライン（src/brandGlyphs.ts）を作る。

使い方:
  curl -o /tmp/dela.ttf "https://fonts.gstatic.com/s/delagothicone/v19/hESp6XxvMDRA-2eD0lXpDa6QkBA2QkEN.ttf"
  python3 scripts/brand-glyphs.py /tmp/dela.ttf src/brandGlyphs.ts

ttf は Google Fonts の v1 CSS API（古い User-Agent で引くと ttf を返す）から取った
Dela Gothic One の欧文サブセット。ライセンスは public/fonts/DelaGothicOne-OFL.txt。

サーバ描画の resvg に 2 つ目のフォントを読ませられなかったので、サイト名だけ字形を
持たせている。日本語は共有画像でも Noto Sans JP のまま。
"""
import struct, json, sys

CHARS = " !'-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

d = open(sys.argv[1], "rb").read()

def tables():
    n = struct.unpack(">H", d[4:6])[0]
    t = {}
    for i in range(n):
        off = 12 + 16 * i
        tag = d[off:off + 4].decode("latin1")
        o, l = struct.unpack(">II", d[off + 8:off + 16])
        t[tag] = (o, l)
    return t

T = tables()
head_o = T["head"][0]
units = struct.unpack(">H", d[head_o + 18:head_o + 20])[0]
index_to_loc = struct.unpack(">h", d[head_o + 50:head_o + 52])[0]
maxp_o = T["maxp"][0]
num_glyphs = struct.unpack(">H", d[maxp_o + 4:maxp_o + 6])[0]
hhea_o = T["hhea"][0]
num_hmetrics = struct.unpack(">H", d[hhea_o + 34:hhea_o + 36])[0]

# loca
loca_o = T["loca"][0]
if index_to_loc == 0:
    loca = [struct.unpack(">H", d[loca_o + 2 * i:loca_o + 2 * i + 2])[0] * 2 for i in range(num_glyphs + 1)]
else:
    loca = [struct.unpack(">I", d[loca_o + 4 * i:loca_o + 4 * i + 4])[0] for i in range(num_glyphs + 1)]

# hmtx
hmtx_o = T["hmtx"][0]
def advance(gid):
    i = min(gid, num_hmetrics - 1)
    return struct.unpack(">H", d[hmtx_o + 4 * i:hmtx_o + 4 * i + 2])[0]

# cmap format 4
cmap_o = T["cmap"][0]
ntab = struct.unpack(">H", d[cmap_o + 2:cmap_o + 4])[0]
sub = None
for i in range(ntab):
    p = cmap_o + 4 + 8 * i
    pid, eid, off = struct.unpack(">HHI", d[p:p + 8])
    if pid == 3 and eid in (1, 10):
        sub = cmap_o + off
assert sub is not None
seg2 = struct.unpack(">H", d[sub + 6:sub + 8])[0]
seg = seg2 // 2
ends = [struct.unpack(">H", d[sub + 14 + 2 * i:sub + 16 + 2 * i])[0] for i in range(seg)]
starts = [struct.unpack(">H", d[sub + 16 + seg2 + 2 * i:sub + 18 + seg2 + 2 * i])[0] for i in range(seg)]
deltas = [struct.unpack(">h", d[sub + 16 + seg2 * 2 + 2 * i:sub + 18 + seg2 * 2 + 2 * i])[0] for i in range(seg)]
ro_base = sub + 16 + seg2 * 3
ranges = [struct.unpack(">H", d[ro_base + 2 * i:ro_base + 2 * i + 2])[0] for i in range(seg)]

def gid_of(ch):
    c = ord(ch)
    for i in range(seg):
        if starts[i] <= c <= ends[i]:
            if ranges[i] == 0:
                return (c + deltas[i]) & 0xFFFF
            p = ro_base + 2 * i + ranges[i] + 2 * (c - starts[i])
            g = struct.unpack(">H", d[p:p + 2])[0]
            return (g + deltas[i]) & 0xFFFF if g else 0
    return 0

glyf_o = T["glyf"][0]

def contours(gid):
    """輪郭ごとの [(x, y, on_curve), ...] を返す。合成グリフは空。"""
    s, e = loca[gid], loca[gid + 1]
    if s == e:
        return []
    g = glyf_o + s
    nc = struct.unpack(">h", d[g:g + 2])[0]
    if nc < 0:
        return []  # 合成グリフ（今回の文字種では出てこない）
    p = g + 10
    end_pts = [struct.unpack(">H", d[p + 2 * i:p + 2 * i + 2])[0] for i in range(nc)]
    p += 2 * nc
    ilen = struct.unpack(">H", d[p:p + 2])[0]
    p += 2 + ilen
    npts = end_pts[-1] + 1
    flags = []
    while len(flags) < npts:
        f = d[p]; p += 1
        flags.append(f)
        if f & 8:
            r = d[p]; p += 1
            flags.extend([f] * r)
    xs, v = [], 0
    for f in flags:
        if f & 2:
            dx = d[p]; p += 1
            v += dx if f & 16 else -dx
        elif not (f & 16):
            v += struct.unpack(">h", d[p:p + 2])[0]; p += 2
        xs.append(v)
    ys, v = [], 0
    for f in flags:
        if f & 4:
            dy = d[p]; p += 1
            v += dy if f & 32 else -dy
        elif not (f & 32):
            v += struct.unpack(">h", d[p:p + 2])[0]; p += 2
        ys.append(v)
    out, start = [], 0
    for end in end_pts:
        out.append([(xs[i], ys[i], bool(flags[i] & 1)) for i in range(start, end + 1)])
        start = end + 1
    return out

def path_of(gid):
    """SVG の d。y はフォント座標（上が +）なので、呼ぶ側で反転させる前提のまま出す。"""
    parts = []
    for pts in contours(gid):
        if not pts:
            continue
        # 始点は on-curve 点。無ければ中点から始める。
        if pts[0][2]:
            first = pts[0]; rest = pts[1:] + [pts[0]]
        else:
            if pts[-1][2]:
                first = pts[-1]; rest = pts[:] + [pts[-1]]
            else:
                mx = (pts[0][0] + pts[-1][0]) / 2.0
                my = (pts[0][1] + pts[-1][1]) / 2.0
                first = (mx, my, True); rest = pts[:] + [first]
        parts.append("M%s %s" % (num(first[0]), num(first[1])))
        ctrl = None
        for (x, y, on) in rest:
            if on:
                if ctrl is None:
                    parts.append("L%s %s" % (num(x), num(y)))
                else:
                    parts.append("Q%s %s %s %s" % (num(ctrl[0]), num(ctrl[1]), num(x), num(y)))
                    ctrl = None
            else:
                if ctrl is not None:
                    mx = (ctrl[0] + x) / 2.0; my = (ctrl[1] + y) / 2.0
                    parts.append("Q%s %s %s %s" % (num(ctrl[0]), num(ctrl[1]), num(mx), num(my)))
                ctrl = (x, y)
        if ctrl is not None:
            parts.append("Q%s %s %s %s" % (num(ctrl[0]), num(ctrl[1]), num(first[0]), num(first[1])))
        parts.append("Z")
    return "".join(parts)

def num(v):
    v = round(float(v), 1)
    return str(int(v)) if v == int(v) else str(v)

glyphs = {}
for ch in CHARS:
    gid = gid_of(ch)
    if not gid and ch != " ":
        continue
    glyphs[ch] = {"a": advance(gid), "d": path_of(gid)}

ts = [
    "// 自動生成（scripts/brand-glyphs.py）。手で編集しない。",
    "// Dela Gothic One（SIL OFL 1.1, Copyright 2020 The Dela Gothic Project Authors）の",
    "// 欧文・数字だけをアウトライン化したもの。共有画像はサーバで resvg が描くが、",
    "// resvg に 2 つ目のフォントを読ませられなかったので、サイト名だけパスで持っている。",
    "// 座標はフォントの em（%d）単位、y は上向き。" % units,
    "export const BRAND_UNITS_PER_EM = %d;" % units,
    "export const BRAND_GLYPHS: Record<string, { a: number; d: string }> = %s;" % json.dumps(glyphs, ensure_ascii=False, separators=(",", ":")),
    "",
]
open(sys.argv[2], "w").write("\n".join(ts))
print("glyphs:", len(glyphs), "unitsPerEm:", units)
