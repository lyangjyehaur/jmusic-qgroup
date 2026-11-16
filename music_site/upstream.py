#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""群友日本音乐爱好成分统计 —— 极简无依赖后端。

用法:
  python server.py            # 默认 0.0.0.0:8788
  JPM_PORT=9000 python server.py

数据保存在同目录 data.json（只在本机，不对外同步）。
备份在同目录 backups/（每小时最多一份，保留最近 30 份）。
管理员默认密码 jpadmin（可在 /admin.html 里改）。
"""
import hashlib
import math
import hmac
import json
import os
import gzip
import re
import secrets
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
DATA_FILE = os.environ.get("JPM_DATA", os.path.join(BASE, "data.json"))
BACKUP_DIR = os.path.join(BASE, "backups")
WALLS_DIR = os.path.join(PUBLIC, "walls")
WALLS_MANIFEST = os.path.join(WALLS_DIR, "manifest.json")
WALL_MAX_BYTES = 10 * 1024 * 1024
WALL_EXTS = {"png": "png", "jpeg": "jpg", "jpg": "jpg", "webp": "webp", "svg+xml": "svg"}
PORT = int(os.environ.get("JPM_PORT", "8788"))
MAX_MAIN_CREATED = 2
MAX_SUB_CREATED = 8
MAX_ENTRIES_PER_MEMBER = MAX_MAIN_CREATED + MAX_SUB_CREATED
MAX_SELECTION = 20
NOTE_MAX = 140
NOTE_TOP_N = 1
MAX_MAIN_SELECTION = 5
MAX_SUB_SELECTION = 15
KINDS = {"main": "领域", "sub": "细分"}
LEVELS = {4: "本命", 3: "常听", 2: "听过一些", 1: "只听过几首"}
LEVEL_WEIGHTS = {4: 1.0, 3: 0.8, 2: 0.5, 1: 0.3}
MAX_ENTRY_LEN = 24
MAX_NAME_LEN = 16
MAX_SHOUT_LEN = 140
SHOUT_COOLDOWN_SEC = 24 * 3600
SHOUT_TTL_DAYS = 30
SHOUT_HISTORY_MAX = 500
QQ_RE = re.compile(r"^\d{4,12}$")
CATEGORIES = ["歌手", "乐队", "组合", "偶像", "Vocaloid P", "作曲家", "社团", "企划", "其他"]
DEFAULT_ADMIN_PASSWORD = "jpadmin"
TOKEN_TTL = 2 * 3600
RECENT_DAYS = 3

CTYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

_lock = threading.Lock()
_GZIP_CACHE = {}
data = {"entries": {}, "members": {}, "settings": {}}
_admin_tokens = {}
_last_backup = 0.0
TREND_INTERVAL = 1800      # 热度趋势：每 30 分钟采样一次
TREND_KEEP = 48            # 只保留最近 24 小时的点


def sha256(s):
    return hashlib.sha256(str(s).encode("utf-8")).hexdigest()


def hash_pin(pin):
    return hashlib.sha256(("jpm-pin|" + str(pin)).encode("utf-8")).hexdigest()


def pin_ok(pin, digest):
    try:
        return hmac.compare_digest(hash_pin(pin), str(digest))
    except Exception:
        return False


def _active_total():
    """有选择记录的人数，作为 IDF 的语料规模。"""
    try:
        return max(1, sum(1 for m in data["members"].values() if m.get("selection")))
    except Exception:
        return 1


def _entry_weight(eid, counts=None, total=None):
    """冷门加权（对数 IDF）：越少人选权重越高，0 人 1.8，全员都选降到 1.0。
    相比旧的「10 人封顶」线性版，随群规模自适应，热门词之间也能分出层次。"""
    counts = counts if counts is not None else entry_counts()
    n = counts.get(eid, 0)
    total = total if total is not None else _active_total()
    if total <= 1:
        return 1.0
    ratio = math.log((total + 1.0) / (n + 1.0)) / math.log(total + 1.0)
    ratio = max(0.0, min(1.0, ratio))
    return 1.0 + 0.8 * ratio



def _weighted_dice(x, y, counts):
    if not x or not y:
        return 0.0
    inter = x & y
    if not inter:
        return 0.0

    def w(i):
        return _entry_weight(i, counts)

    return 2.0 * sum(w(i) for i in inter) / (sum(w(i) for i in x) + sum(w(i) for i in y))


def overlap_label(n_shared, ratio, niche=0):
    """重合度评语（方案 D：先看共同项数，再用重合率细分）。ratio 为 0~1。"""
    if n_shared <= 0:
        return "没有重合"
    if n_shared >= 4:
        return "灵魂同款"
    if n_shared == 3:
        return "很合拍" if ratio >= 0.25 else "口味相近"
    if n_shared == 2:
        if ratio >= 0.20 and niche >= 1:
            return "冷门同好"
        if ratio >= 0.20:
            return "口味相近"
        return "同圈可聊"
    return "只碰上一首"


MATCH_CAP = {0: 0, 1: 36, 2: 49, 3: 64}


def match_percent(ratio, n_shared):
    """方案一（校准刻度）：展示分 = 100×√严格重合率，并按共同项数量设上限，
    保证数字与评语不矛盾（只碰上一首 ≤36、同圈可聊 ≤49、很合拍 ≤64）。"""
    n = int(n_shared or 0)
    if n <= 0:
        return 0
    base = int(round(100 * math.sqrt(max(0.0, min(1.0, float(ratio or 0))))))
    cap = MATCH_CAP.get(n, 100)
    return max(0, min(base, cap))


def match_stats(a, b, counts=None):
    """Dice 相似度：领域/细分分开算，领域 30% + 细分 70%。
    细分按熟悉度加权（本命 1.0 / 常听 0.8 / 听过一些 0.5 / 只听过几首 0.3），
    共同项按双方较低档计入；领域保持冷门加权。"""
    ia = norm_selection(a)
    ib = norm_selection(b)
    if not ia or not ib:
        return 0, {}
    counts = counts if counts is not None else entry_counts()
    entries = data["entries"]
    am, asub, bm, bsub = set(), set(), set(), set()
    mine_level = {}
    theirs_level = {}
    for it in ia:
        mine_level[it["id"]] = it["level"]
        e = entries.get(it["id"])
        (am if (e and entry_kind(e) == "main") else asub).add(it["id"])
    for it in ib:
        theirs_level[it["id"]] = it["level"]
        e = entries.get(it["id"])
        (bm if (e and entry_kind(e) == "main") else bsub).add(it["id"])
    dom = None
    if am or bm:
        wa = {i: _level_weight(mine_level.get(i, 3)) for i in am}
        wb = {i: _level_weight(theirs_level.get(i, 3)) for i in bm}
        den = sum(wa.values()) + sum(wb.values())
        num = sum(min(wa[i], wb[i]) for i in (set(wa) & set(wb)))
        dom = (2.0 * num / den) if den else 0.0
    sub = None
    if asub or bsub:
        wa = {i: _level_weight(mine_level.get(i, 3)) for i in asub}
        wb = {i: _level_weight(theirs_level.get(i, 3)) for i in bsub}
        den = sum(wa.values()) + sum(wb.values())
        num = sum(min(wa[i], wb[i]) for i in (set(wa) & set(wb)))
        sub = (2.0 * num / den) if den else 0.0
    parts = []
    if dom is not None:
        # 领域也按熟悉度加权，且权重略高于细分（0.55 vs 0.45）
        parts.append((dom, 0.55))
    if sub is not None:
        parts.append((sub, 0.45))
    if not parts:
        return 0, {}
    wsum = sum(w for _, w in parts)
    ratio = sum(v * w for v, w in parts) / wsum
    score = int(round(100 * ratio))
    shared = set(x["id"] for x in ia) & set(x["id"] for x in ib)
    n_shared = len(shared)
    share_dom = sum(1 for i in shared if i in entries and entry_kind(entries[i]) == "main")
    share_sub = n_shared - share_dom
    niche = sum(1 for i in shared if counts.get(i, 0) <= 2)
    low_data = min(len(ia), len(ib)) <= 3
    mine_covered = bool(shared) and shared == set(x["id"] for x in ia)
    theirs_covered = bool(shared) and shared == set(x["id"] for x in ib)
    both_top = sum(
        1 for i in shared
        if i in entries and entry_kind(entries[i]) != "main"
        and mine_level.get(i, 3) >= 4 and theirs_level.get(i, 3) >= 4
    )
    mine_count, theirs_count = len(ia), len(ib)
    label = overlap_label(n_shared, ratio, niche)
    mp = match_percent(ratio, n_shared)
    return score, {
        "score": score,
        "ratio": int(round(ratio * 100)),
        "sharedCount": n_shared,
        "sharedDomain": share_dom,
        "sharedSub": share_sub,
        "nicheShared": niche,
        "lowData": low_data,
        "mineCovered": mine_covered,
        "theirsCovered": theirs_covered,
        "mineCount": mine_count,
        "theirsCount": theirs_count,
        "domainRatio": int(round(dom * 100)) if dom is not None else None,
        "subRatio": int(round(sub * 100)) if sub is not None else None,
        "bothTop": both_top,
        "label": label,
        "matchPercent": mp,
    }


def similarity_pct(mine, theirs):
    a = mine.get("selection", []) if isinstance(mine, dict) else mine
    b = theirs.get("selection", []) if isinstance(theirs, dict) else theirs
    score, _ = match_stats(a, b)
    return score


ROOM_MAX_PICKS = 40


def room_selection(qq):
    m = data["members"].get(qq) or {}
    return norm_selection(m.get("selection", []))


def room_name(qq):
    m = data["members"].get(qq) or {}
    return m.get("name") or qq


def room_analysis(qqs, counts=None):
    """一组人的包房匹配度：两两配对（校准分），给出平均分、最弱一对、最孤单成员、共同词条。"""
    members = data["members"]
    qqs = [q for q in dict.fromkeys(qqs) if q in members][:ROOM_MAX_PICKS]
    counts = counts if counts is not None else entry_counts()
    entries = data["entries"]
    names = {q: room_name(q) for q in qqs}
    sels = {q: room_selection(q) for q in qqs}
    pairs = []
    for i, a in enumerate(qqs):
        for b in qqs[i + 1:]:
            _, d = match_stats(sels[a], sels[b], counts)
            pairs.append({
                "a": a, "b": b, "aName": names[a], "bName": names[b],
                "score": d.get("matchPercent", 0), "raw": d.get("score", 0),
                "label": d.get("label", ""), "shared": d.get("sharedCount", 0),
            })
    scores = [p["score"] for p in pairs] or [0]
    avg = int(round(sum(scores) / len(scores)))
    worst = min(pairs, key=lambda p: p["score"]) if pairs else None
    per = {}
    for p in pairs:
        per.setdefault(p["a"], []).append(p["score"])
        per.setdefault(p["b"], []).append(p["score"])
    loner = None
    if per:
        q = min(per, key=lambda x: (sum(per[x]) / len(per[x]), x))
        loner = {"qq": q, "name": names[q], "avg": int(round(sum(per[q]) / len(per[q])))}
    need = max(2, (len(qqs) * 3 + 4) // 5)
    tally = {}
    for q in qqs:
        for it in sels[q]:
            tally[it["id"]] = tally.get(it["id"], 0) + 1
    common = []
    for eid, n in tally.items():
        e = entries.get(eid)
        if not e or n < need:
            continue
        common.append({"id": eid, "text": e.get("text", ""), "kind": entry_kind(e),
                       "n": n, "count": (counts.get(eid) or 0)})
    common.sort(key=lambda x: (-x["n"], x["count"], x["text"]))
    def _mavg(q):
        arr = per.get(q) or []
        if not arr:
            return 100 if len(qqs) == 1 else 0
        return int(round(sum(arr) / len(arr)))

    mem = [{"qq": q, "name": names[q], "count": len(sels[q]), "avg": _mavg(q)} for q in qqs]
    mavgs = [m["avg"] for m in mem] or [0]
    return {
        "members": mem,
        "memberMax": max(mavgs),
        "memberMin": min(mavgs),
        "pairs": sorted(pairs, key=lambda p: p["score"]),
        "avg": avg,
        "min": min(scores),
        "worst": worst,
        "loner": loner,
        "common": common[:8],
        "need": need,
    }


def room_split(qqs, rooms=None, capacity=None, counts=None, same_gender=False, sizes=None):
    """把人分到若干包房：种子-贪心 + 局部调整，尽量让组内平均分高。"""
    members = data["members"]
    qqs = [q for q in dict.fromkeys(qqs) if q in members][:ROOM_MAX_PICKS]
    n = len(qqs)
    if n < 2:
        return {"error": "至少需要 2 位成员"}
    counts = counts if counts is not None else entry_counts()
    sels = {q: room_selection(q) for q in qqs}
    names = {q: room_name(q) for q in qqs}
    mat = {}
    for i, a in enumerate(qqs):
        for b in qqs[i + 1:]:
            _, d = match_stats(sels[a], sels[b], counts)
            v = d.get("matchPercent", 0)
            mat[(a, b)] = v
            mat[(b, a)] = v

    def sc(a, b):
        return mat.get((a, b), 0)

    try:
        capacity = int(capacity) if capacity else 0
    except (TypeError, ValueError):
        capacity = 0
    try:
        rooms = int(rooms) if rooms else 0
    except (TypeError, ValueError):
        rooms = 0
    size_list = []
    if isinstance(sizes, list) and sizes:
        for x in sizes:
            try:
                v = int(x)
            except (TypeError, ValueError):
                continue
            if v >= 1:
                size_list.append(v)
        size_list = size_list[:40]
        if len(size_list) < 2:
            return {"error": "自定义人数至少需要 2 间房"}
        if sum(size_list) < n:
            return {"error": "自定义人数总和小于参与人数（%d 人）" % n}
        capacity = max(size_list)
        room_n = len(size_list)
        size_list = size_list[:room_n]
    elif capacity:
        capacity = max(2, capacity)
        room_n = max(2, (n + capacity - 1) // capacity)
    elif rooms:
        room_n = max(2, min(rooms, n))
        capacity = (n + room_n - 1) // room_n
    else:
        return {"error": "请先填房数或每房人数"}
    capacity = max(2, capacity)
    room_n = min(room_n, n)

    genders = {}
    if same_gender:
        for q in qqs:
            mm = members[q]
            g = str(mm.get("gender") or "")
            genders[q] = g if (mm.get("genderPublic") and g in ("female", "male")) else ""
    GENDER_BONUS = 200

    total = {q: sum(sc(q, o) for o in qqs if o != q) for q in qqs}
    order = sorted(qqs, key=lambda q: (-total[q], q))
    groups = [[] for _ in range(room_n)]
    seed_genders = set()
    for i in range(room_n):
        if same_gender and i > 0 and order:
            order.sort(key=lambda q: (genders.get(q, "") in seed_genders, -total[q], q))
        pick = order.pop(0)
        groups[i].append(pick)
        if same_gender and genders.get(pick):
            seed_genders.add(genders[pick])
    for q in order:
        best, best_key = None, None
        for gi, g in enumerate(groups):
            cap_i = size_list[gi] if size_list else capacity
            if len(g) >= cap_i:
                continue
            avg = sum(sc(q, o) for o in g) / len(g)
            if same_gender and genders.get(q) and all(genders.get(o) == genders[q] for o in g):
                avg += GENDER_BONUS
            key = (avg, -len(g))
            if best_key is None or key > best_key:
                best, best_key = gi, key
        if best is None:
            best = min(range(room_n), key=lambda gi: len(groups[gi]))
        groups[best].append(q)
    for _ in range(8):
        improved = False
        for gi, g in enumerate(groups):
            for q in list(g):
                if len(g) <= 1:
                    continue
                base = sum(sc(q, o) for o in g if o != q) / max(1, len(g) - 1)
                if same_gender and genders.get(q) and all(genders.get(o) == genders[q] for o in g if o != q):
                    base += GENDER_BONUS
                for gj, g2 in enumerate(groups):
                    cap_j = size_list[gj] if size_list else capacity
                    if gj == gi or not g2 or len(g2) >= cap_j:
                        continue
                    cand = sum(sc(q, o) for o in g2) / len(g2)
                    if same_gender and genders.get(q) and all(genders.get(o) == genders[q] for o in g2):
                        cand += GENDER_BONUS
                    if cand > base + 1:
                        g.remove(q)
                        g2.append(q)
                        improved = True
                        break
                if improved:
                    break
            if improved:
                break
        if not improved:
            break

    out = []
    for g in groups:
        a = room_analysis(g, counts)
        out.append({
            "qqs": g,
            "members": a.get("members") or [{"qq": q, "name": names[q], "count": len(sels[q])} for q in g],
            "memberMax": a.get("memberMax", 0),
            "memberMin": a.get("memberMin", 0),
            "avg": a.get("avg", 0),
            "min": a.get("min", 0),
            "worst": a.get("worst"),
            "common": (a.get("common") or [])[:5],
        })
    out.sort(key=lambda r: (-r["avg"], -r["min"]))
    return {"rooms": out, "capacity": capacity, "roomCount": room_n, "sizes": (size_list or None)}


def load():
    global data
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding="utf-8") as f:
            data = json.load(f)
    data.setdefault("entries", {})
    data.setdefault("members", {})
    data.setdefault("settings", {})
    data.setdefault("shouts", [])
    data.setdefault("shoutHistory", [])
    data.setdefault("trend", [])
    if not data["settings"].get("adminPasswordHash"):
        data["settings"]["adminPasswordHash"] = sha256(DEFAULT_ADMIN_PASSWORD)
    for e in data["entries"].values():
        e.setdefault("category", "其他")
        e.setdefault("createdAt", 0)
    for m in data["members"].values():
        m.setdefault("boardUserId", "")
        m.setdefault("gender", "")
        m.setdefault("genderPublic", False)
        if m.get("selection"):
            m["selection"] = norm_selection(m.get("selection"))


def write_backup(force=False):
    """每小时最多备份一次，保留最近 30 份。"""
    global _last_backup
    now = time.time()
    if not force and now - _last_backup < 3600:
        return
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        name = "data-" + time.strftime("%Y%m%d-%H%M%S") + ".json"
        tmp = os.path.join(BACKUP_DIR, name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, os.path.join(BACKUP_DIR, name))
        _last_backup = now
        files = sorted(os.listdir(BACKUP_DIR))
        for old in files[:-30]:
            try:
                os.remove(os.path.join(BACKUP_DIR, old))
            except OSError:
                pass
    except OSError:
        pass


def save():
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA_FILE)
    write_backup()


# ---------- 喊话板 ----------
def active_shouts(now=None):
    """30 天内有效，最新的在前。"""
    now = time.time() if now is None else now
    cutoff = now - SHOUT_TTL_DAYS * 86400
    out = [s for s in data.get("shouts", []) if float(s.get("createdAt") or 0) > cutoff]
    out.sort(key=lambda s: float(s.get("createdAt") or 0), reverse=True)
    return out


def shout_public(s, viewer=""):
    if not s:
        return None
    qq = str(s.get("qq") or "")
    m = data.get("members", {}).get(qq)
    name = (m or {}).get("name") or s.get("name") or "群友"
    created = int(s.get("createdAt") or 0)
    return {
        "id": s.get("id"),
        "text": s.get("text", ""),
        "name": name,
        "qq": qq,
        "createdAt": created,
        "expiresAt": created + SHOUT_TTL_DAYS * 86400,
        "mine": bool(viewer) and qq == str(viewer),
    }


def _shout_ts(s):
    return float(s.get("createdAt") or 0)


def archive_shouts(now=None, extra=None):
    """把超过 30 天的喊话（以及 extra 里的条目）移入历史喊话，最多保留 SHOUT_HISTORY_MAX 条。"""
    now = time.time() if now is None else now
    cutoff = now - SHOUT_TTL_DAYS * 86400
    hist = data.setdefault("shoutHistory", [])
    seen = {str(h.get("id")) for h in hist}
    moved = 0
    keep = []
    for s in data.get("shouts", []):
        if _shout_ts(s) > cutoff:
            keep.append(s)
            continue
        sid = str(s.get("id"))
        if sid not in seen:
            h = dict(s)
            h["archivedAt"] = int(now)
            hist.append(h)
            seen.add(sid)
        moved += 1
    for s in extra or []:
        sid = str(s.get("id"))
        if sid not in seen:
            h = dict(s)
            h["archivedAt"] = int(now)
            hist.append(h)
            seen.add(sid)
        moved += 1
    if moved:
        hist.sort(key=_shout_ts, reverse=True)
        del hist[SHOUT_HISTORY_MAX:]
        data["shouts"] = keep
        save()
    return moved


def history_shouts():
    hist = list(data.get("shoutHistory", []))
    hist.sort(key=_shout_ts, reverse=True)
    return hist



def load_walls():
    try:
        with open(WALLS_MANIFEST, "r", encoding="utf-8") as f:
            m = json.load(f) or {}
    except Exception:
        m = {}
    m.setdefault("rotateSeconds", 24)
    m.setdefault("items", [])
    return m


def save_walls(m):
    os.makedirs(WALLS_DIR, exist_ok=True)
    tmp = WALLS_MANIFEST + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    os.replace(tmp, WALLS_MANIFEST)


def walls_payload():
    m = load_walls()
    items = []
    for it in m.get("items", []):
        src = str(it.get("src") or "")
        name = src.rsplit("/", 1)[-1]
        path = os.path.join(WALLS_DIR, name)
        ok = bool(name) and os.path.isfile(path)
        items.append({
            "name": it.get("name") or name,
            "src": src,
            "size": os.path.getsize(path) if ok else 0,
            "missing": not ok,
            "enabled": it.get("enabled") is not False,
        })
    return {"rotateSeconds": int(m.get("rotateSeconds") or 24), "items": items}


def wall_safe_path(src):
    src = str(src or "").strip()
    if src.startswith("/"):
        src = src[1:]
    if not src.startswith("walls/"):
        return None
    name = src[len("walls/"):]
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    path = os.path.join(WALLS_DIR, name)
    if not os.path.abspath(path).startswith(os.path.abspath(WALLS_DIR) + os.sep):
        return None
    return path


def entry_counts():
    counts = {}
    for m in data["members"].values():
        for eid in sel_ids(m.get("selection", [])):
            counts[eid] = counts.get(eid, 0) + 1
    return counts



def trend_counts():
    """当前时刻每个词条被多少人选中。"""
    counts = {}
    for m in data.get("members", {}).values():
        for it in (m.get("selection") or []):
            eid = it.get("id") if isinstance(it, dict) else it
            if eid:
                counts[eid] = counts.get(eid, 0) + 1
    return counts


def seed_trend_from_backups():
    """升级时用旧的小时备份补一段历史，之后由 30 分钟采样接管。"""
    if data.get("trend"):
        return
    pts = []
    try:
        names = sorted(os.listdir(BACKUP_DIR))[-TREND_KEEP:]
    except OSError:
        names = []
    for name in names:
        if not re.match(r"^data-[\w.-]+\.json$", name):
            continue
        full = os.path.join(BACKUP_DIR, name)
        try:
            with open(full, encoding="utf-8") as f:
                snap = json.load(f)
            ts = int(os.path.getmtime(full))
        except Exception:
            continue
        counts = {}
        for m in snap.get("members", {}).values():
            for it in (m.get("selection") or []):
                eid = it.get("id") if isinstance(it, dict) else it
                if eid:
                    counts[eid] = counts.get(eid, 0) + 1
        pts.append({"t": ts, "counts": counts})
    if pts:
        data["trend"] = pts[-TREND_KEEP:]
        save()


def trend_snapshot(force=False):
    """记录一个趋势点（默认半小时一次）。即使没人改动也记，保证刻度均匀。"""
    now = int(time.time())
    pts = data.setdefault("trend", [])
    if pts and not force and now - int(pts[-1].get("t") or 0) < TREND_INTERVAL - 30:
        return
    if pts and not force and now - int(pts[-1].get("t") or 0) < 60:
        return
    pts.append({"t": now, "counts": trend_counts()})
    data["trend"] = pts[-TREND_KEEP:]
    save()


def trend_loop():
    while True:
        try:
            now = time.time()
            nxt = (int(now // TREND_INTERVAL) + 1) * TREND_INTERVAL
            time.sleep(max(5, nxt - now))
            with _lock:
                trend_snapshot(force=True)
        except Exception:
            time.sleep(30)


def entry_payload(entry, counts=None):
    counts = counts if counts is not None else entry_counts()
    return {
        "id": entry["id"],
        "text": entry["text"],
        "count": counts.get(entry["id"], 0),
        "createdBy": entry.get("createdBy", ""),
        "category": entry.get("category") or "其他",
        "kind": entry_kind(entry),
        "kindLabel": KINDS[entry_kind(entry)],
        "aliases": [str(x) for x in (entry.get("aliases") or []) if str(x).strip()],
        "createdAt": int(entry.get("createdAt") or 0),
    }


def entry_kind(e):
    kind = str(e.get("kind") or "")
    if kind in KINDS:
        return kind
    return "main" if (e.get("category") or "") == "领域" else "sub"


def norm_selection(sel):
    """统一为 [{"id": str, "level": 1..4}]；旧数据（纯 id 列表）按常听(3)迁移。"""
    out, seen = [], set()
    for it in sel or []:
        if isinstance(it, dict):
            eid = str(it.get("id") or it.get("entryId") or "")
            try:
                lvl = int(it.get("level") or 3)
            except (TypeError, ValueError):
                lvl = 3
        else:
            eid, lvl = str(it), 3
        if not eid or eid in seen:
            continue
        seen.add(eid)
        out.append({"id": eid, "level": max(1, min(4, lvl))})
    return out


def sel_ids(sel):
    return [x["id"] for x in norm_selection(sel)]


def _level_weight(level):
    try:
        return LEVEL_WEIGHTS.get(int(level or 3), 0.5)
    except (TypeError, ValueError):
        return 0.5


def selection_kind_counts(ids):
    main_n = sub_n = 0
    for eid in ids:
        e = data["entries"].get(eid)
        if not e:
            continue
        if entry_kind(e) == "main":
            main_n += 1
        else:
            sub_n += 1
    return main_n, sub_n


def entries_payload():
    counts = entry_counts()
    items = [entry_payload(e, counts) for e in data["entries"].values()]
    for it in items:
        creator = data["members"].get(it.get("createdBy") or "")
        it["creatorName"] = "管理员" if it.get("createdBy") == "admin" else (creator.get("name", "") if creator else "")
    items.sort(key=lambda x: (-x["count"], x["text"]))
    return items


def member_payload(m):
    return {
        "qq": m["qq"],
        "name": m["name"],
        "selection": [
            {
                "id": it["id"],
                "level": it["level"],
                "text": (data["entries"].get(it["id"]) or {}).get("text", ""),
                "kind": entry_kind(data["entries"][it["id"]]) if it["id"] in data["entries"] else "sub",
            }
            for it in norm_selection(m.get("selection", []))
        ],
        "created": list(m.get("created", [])),
        "createdCount": len(m.get("created", [])),
        "createdMain": sum(1 for i in m.get("created", []) if i in data["entries"] and entry_kind(data["entries"][i]) == "main"),
        "createdSub": sum(1 for i in m.get("created", []) if i in data["entries"] and entry_kind(data["entries"][i]) != "main"),
        "createdLimits": {"main": MAX_MAIN_CREATED, "sub": MAX_SUB_CREATED},
        "selectionMain": selection_kind_counts(sel_ids(m.get("selection", [])))[0],
        "selectionSub": selection_kind_counts(sel_ids(m.get("selection", [])))[1],
        "selectionLimits": {"main": MAX_MAIN_SELECTION, "sub": MAX_SUB_SELECTION},
        "hasPin": bool(m.get("pinHash")),
        "note": str(m.get("note") or ""),
        "gender": str(m.get("gender") or ""),
        "genderPublic": bool(m.get("genderPublic")),
    }


def _recent_count(items, hours=24):
    cutoff = time.time() - hours * 3600
    n = 0
    for it in items:
        try:
            ts = float(it.get("createdAt") or 0)
        except (TypeError, ValueError):
            ts = 0
        if ts > cutoff:
            n += 1
    return n


def state_payload():
    now = time.time()
    cutoff = now - 24 * 3600
    members = data["members"].values()
    recent_members = sum(1 for m in members if float(m.get("createdAt") or 0) > cutoff)
    recent_entries = _recent_count(data["entries"].values())
    return {
        "entries": entries_payload(),
        "memberCount": len(data["members"]),
        "recentMembers24h": recent_members,
        "recentEntries24h": recent_entries,
        "categories": CATEGORIES,
        "kinds": KINDS,
        "selectionLimits": {"main": MAX_MAIN_SELECTION, "sub": MAX_SUB_SELECTION},
        "now": int(time.time()),
    }


def clean_text(s, max_len):
    s = " ".join(str(s or "").strip().split())
    return s[:max_len]


def clean_category(c):
    c = str(c or "").strip()
    return c if c in CATEGORIES else "其他"


def normalize_entry_key(text):
    """词条查重用的归一化：全角/半角、大小写、多余空格、零宽字符都不算新词条。"""
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = re.sub(r"[\u200b-\u200f\ufeff\u00ad]", "", s)
    s = re.sub(r"\s+", " ", s).strip().casefold()
    return s


def find_entry_by_text(text):
    key = normalize_entry_key(text)
    if not key:
        return None
    for e in data["entries"].values():
        if normalize_entry_key(e["text"]) == key:
            return e
        for alias in (e.get("aliases") or []):
            if normalize_entry_key(str(alias)) == key:
                return e
    return None


def name_key(name):
    """名字归一化：全角/半角、大小写、零宽、所有空白（含中文空格）都不算区分。"""
    s = unicodedata.normalize("NFKC", str(name or ""))
    s = re.sub(r"[\u200b-\u200f\ufeff\u00ad]", "", s)
    return re.sub(r"\s+", "", s).casefold()


def find_member_by_name(name, exclude_qq=""):
    """按名字找账号（归一化后比较），保证「一个名字只能登记一个账号」。"""
    key = name_key(name)
    if not key:
        return None
    for m in data["members"].values():
        if m.get("qq") == exclude_qq:
            continue
        if name_key(m.get("name", "")) == key:
            return m
    return None


def admin_ok(token):
    exp = _admin_tokens.get(token)
    return bool(exp and exp > time.time())


def prune_tokens():
    now = time.time()
    for k in [k for k, v in _admin_tokens.items() if v <= now]:
        _admin_tokens.pop(k, None)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30  # 防止半死连接长期持有 _lock

    # ---------- helpers ----------
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        enc = None
        if len(body) > 400 and "gzip" in (self.headers.get("Accept-Encoding") or "").lower():
            body = gzip.compress(body, 6)
            enc = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if enc:
            self.send_header("Content-Encoding", enc)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, status=200, ctype="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_download(self, filename, obj):
        body = json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, max_bytes=64 * 1024):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > max_bytes:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ---------- routing ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                return self.send_json({"ok": True, "time": int(time.time())})
            if path == "/api/qgroup/events":
                try:
                    limit = max(1, min(100, int(query.get("limit", ["20"])[0] or 20)))
                    offset = max(0, int(query.get("offset", ["0"])[0] or 0))
                except ValueError:
                    return self.send_json({"error": "分页参数不对"}, 400)
                lifecycle = (query.get("lifecycle", [""])[0] or "").strip()
                res = qgroup_events(limit, offset, lifecycle)
                if res.get("error"):
                    return self.send_json({"error": res["error"]}, res.get("status", 503))
                return self.send_json(res)
            if path == "/api/qgroup/event":
                eid = (query.get("id", [""])[0] or "").strip()
                if not eid:
                    return self.send_json({"error": "缺少活动 id"}, 400)
                payload = qgroup_event_payload(eid)
                if payload.get("error"):
                    return self.send_json({"error": payload["error"]}, payload.get("status", 400))
                return self.send_json(payload)
            if path == "/api/state":
                with _lock:
                    payload = state_payload()
                raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                etag = '"' + sha256(raw)[:20] + '"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    return
                enc = None
                body = raw
                if len(raw) > 400 and "gzip" in (self.headers.get("Accept-Encoding") or "").lower():
                    body = gzip.compress(raw, 6)
                    enc = "gzip"
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                if enc:
                    self.send_header("Content-Encoding", enc)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Vary", "Accept-Encoding")
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/member":
                qq = query.get("qq", [""])[0]
                viewer = query.get("me", [""])[0]
                with _lock:
                    m = data["members"].get(qq)
                    if not m:
                        return self.send_json({"error": "未找到该群友"}, 404)
                    counts = entry_counts()
                    picks = []
                    for it in norm_selection(m.get("selection", [])):
                        eid = it["id"]
                        e = data["entries"].get(eid)
                        if not e:
                            continue
                        picks.append({
                            "id": eid,
                            "text": e["text"],
                            "category": e.get("category", "其他"),
                            "kind": entry_kind(e),
                            "level": it["level"],
                            "count": counts.get(eid, 0),
                        })
                    payload = member_payload(m)
                    if viewer != qq and not m.get("genderPublic"):
                        payload["gender"] = ""
                    if not self.note_allowed(viewer, qq):
                        payload["note"] = ""
                    return self.send_json({
                        "member": payload,
                        "picks": picks,
                    })
            if path == "/api/members":
                with _lock:
                    items = []
                    for qq, m in data["members"].items():
                        items.append({
                            "qq": qq,
                            "name": m.get("name") or qq,
                            "count": len(norm_selection(m.get("selection", []))),
                            "gender": (str(m.get("gender") or "") if m.get("genderPublic") else ""),
                        })
                    items.sort(key=lambda x: (x["name"], x["qq"]))
                    return self.send_json({"members": items})

            if path == "/api/compare":
                me_qq = query.get("me", [""])[0].strip()
                other_qq = query.get("qq", [""])[0].strip()
                with _lock:
                    if not me_qq or not other_qq:
                        return self.send_json({"error": "缺少参数"}, 400)
                    if me_qq == other_qq:
                        return self.send_json({"error": "这是你自己，换一个人的 QQ 吧"}, 400)
                    me_m = data["members"].get(me_qq)
                    other_m = data["members"].get(other_qq)
                    if not me_m:
                        return self.send_json({"error": "你还没有登记，先登记再来比"}, 404)
                    if not other_m:
                        return self.send_json({"error": "没找到这个 QQ 的账号"}, 404)
                    counts = entry_counts()
                    score, stats = match_stats(me_m.get("selection", []), other_m.get("selection", []), counts)

                    def cmp_picks(m):
                        out = []
                        for it in norm_selection(m.get("selection", [])):
                            e = data["entries"].get(it["id"])
                            if not e:
                                continue
                            k = entry_kind(e)
                            out.append({
                                "id": it["id"], "text": e["text"], "kind": k,
                                "level": it["level"],
                                "levelLabel": LEVELS.get(it["level"], "") if it["level"] else "",
                                "count": counts.get(it["id"], 0),
                            })
                        out.sort(key=lambda p: (0 if p["kind"] == "main" else 1, -p["count"], p["text"]))
                        return out

                    mine_picks = cmp_picks(me_m)
                    theirs_picks = cmp_picks(other_m)
                    shared_ids = set(x["id"] for x in mine_picks) & set(x["id"] for x in theirs_picks)
                    shared = []
                    for x in mine_picks:
                        if x["id"] in shared_ids:
                            y = [p for p in theirs_picks if p["id"] == x["id"]][0]
                            shared.append({
                                "id": x["id"], "text": x["text"], "kind": x["kind"],
                                "myLevel": x["level"], "theirLevel": y["level"],
                                "myLevelLabel": x["levelLabel"], "theirLevelLabel": y["levelLabel"],
                                "count": x["count"],
                            })
                    return self.send_json({
                        "me": {"qq": me_qq, "name": me_m.get("name", ""), "note": str(me_m.get("note") or "")},
                        "other": {"qq": other_qq, "name": other_m.get("name", ""),
                                  "note": (str(other_m.get("note") or "") if self.note_allowed(me_qq, other_qq) else "")},
                        "otherNote": (str(other_m.get("note") or "")
                                      if self.note_allowed(me_qq, other_qq) else ""),
                        "score": score,
                        "matchPercent": (stats or {}).get("matchPercent", score),
                        "stats": stats or {},
                        "shared": shared,
                        "onlyMine": [x for x in mine_picks if x["id"] not in shared_ids],
                        "onlyTheirs": [x for x in theirs_picks if x["id"] not in shared_ids],
                        "mine": mine_picks,
                        "theirs": theirs_picks,
                    })
            if path == "/api/shouts":
                viewer = str(query.get("qq", [""])[0]).strip()
                with _lock:
                    now = time.time()
                    archive_shouts(now)
                    lst = active_shouts(now)
                    mine = next((s for s in lst if str(s.get("qq")) == viewer), None)
                    next_allowed = int(float(mine.get("createdAt") or 0) + SHOUT_COOLDOWN_SEC) if mine else 0
                    return self.send_json({
                        "shouts": [shout_public(s, viewer) for s in lst],
                        "now": int(now),
                        "cooldownHours": SHOUT_COOLDOWN_SEC // 3600,
                        "ttlDays": SHOUT_TTL_DAYS,
                        "nextAllowedAt": next_allowed,
                        "mine": shout_public(mine, viewer),
                        "historyTotal": len(data.get("shoutHistory", [])),
                    })
            if path == "/api/shouts/history":
                with _lock:
                    archive_shouts(time.time())
                    try:
                        offset = int(query.get("offset", ["0"])[0])
                    except ValueError:
                        offset = 0
                    try:
                        limit = int(query.get("limit", ["10"])[0])
                    except ValueError:
                        limit = 10
                    offset = max(0, offset)
                    limit = max(1, min(50, limit))
                    hist = history_shouts()
                    return self.send_json({
                        "items": [shout_public(s) for s in hist[offset:offset + limit]],
                        "total": len(hist),
                        "offset": offset,
                        "limit": limit,
                    })
            if path == "/api/me":
                qq = query.get("qq", [""])[0]
                with _lock:
                    m = data["members"].get(qq)
                    if not m:
                        return self.send_json({"error": "未注册"}, 404)
                    cutoff = time.time() - 24 * 3600
                    recent_members = sum(
                        1 for mm in data["members"].values()
                        if float(mm.get("createdAt") or 0) > cutoff
                    )
                    recent_entries = _recent_count(data["entries"].values())
                    return self.send_json({
                        "member": member_payload(m),
                        "entries": entries_payload(),
                        "memberCount": len(data["members"]),
                        "recentMembers24h": recent_members,
                        "recentEntries24h": recent_entries,
                        "categories": CATEGORIES,
                    })
            if path == "/api/matches":
                qq = query.get("qq", [""])[0]
                sort_mode = query.get("sort", ["rare"])[0]
                with _lock:
                    return self.send_json(self.compute_matches(qq, sort_mode))
            if path == "/api/entry/members":
                eid = query.get("id", [""])[0]
                with _lock:
                    entry = data["entries"].get(eid)
                    if not entry:
                        return self.send_json({"error": "词条不存在"}, 404)
                    members = []
                    for m in data["members"].values():
                        if eid in sel_ids(m.get("selection", [])):
                            members.append({"qq": m["qq"], "name": m["name"]})
                    members.sort(key=lambda x: x["name"])
                    return self.send_json({"entry": entry_payload(entry), "members": members})
            if path == "/api/clusters":
                with _lock:
                    return self.send_json(self.compute_clusters())
            if path == "/api/trend":
                with _lock:
                    return self.send_json(self.compute_trend())
            if path == "/api/export":
                token = query.get("token", [""])[0]
                if not admin_ok(token):
                    return self.send_json({"error": "需要管理员登录"}, 401)
                with _lock:
                    return self.send_download("jpm-data-" + time.strftime("%Y%m%d-%H%M%S") + ".json", data)
            if path == "/api/admin/backups":
                token = query.get("token", [""])[0]
                if not admin_ok(token):
                    return self.send_json({"error": "需要管理员登录"}, 401)
                files = []
                try:
                    for name in sorted(os.listdir(BACKUP_DIR), reverse=True)[:30]:
                        if name.endswith(".json"):
                            files.append({"name": name, "size": os.path.getsize(os.path.join(BACKUP_DIR, name))})
                except OSError:
                    pass
                return self.send_json({"backups": files})
            if path == "/api/admin/backup":
                token = query.get("token", [""])[0]
                name = query.get("name", [""])[0]
                if not admin_ok(token):
                    return self.send_json({"error": "需要管理员登录"}, 401)
                if not re.match(r"^data-[\w.-]+\.json$", name):
                    return self.send_json({"error": "文件名不对"}, 400)
                full = os.path.join(BACKUP_DIR, name)
                if not os.path.isfile(full):
                    return self.send_json({"error": "备份不存在"}, 404)
                with open(full, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            return self.serve_static(path)
        except Exception as exc:  # noqa: BLE001
            return self.send_json({"error": f"服务器错误: {exc}"}, 500)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        limit = int(WALL_MAX_BYTES * 1.6) + 8192 if path == "/api/admin/wall/upload" else 64 * 1024
        body = self.read_body(limit)
        try:
            routes = {
                "/api/join": self.api_join,
                "/api/entry": self.api_create_entry,
                "/api/entry/update": self.api_update_entry,
                "/api/entry/delete": self.api_delete_entry,
                "/api/selection": self.api_selection,
                "/api/note": self.api_note,
                "/api/gender": self.api_gender,
                "/api/room/preview": self.api_room_preview,
                "/api/room/split": self.api_room_split,
                "/api/room/recalc": self.api_room_recalc,
                "/api/qgroup/split": self.api_qgroup_split,
                "/api/qgroup/rooms": self.api_qgroup_rooms,
                "/api/shout": self.api_shout,
                "/api/admin/shout/delete": self.api_admin_shout_delete,
                "/api/admin/shout/list": self.api_admin_shout_list,
                "/api/admin/login": self.api_admin_login,
                "/api/admin/create": self.api_admin_create,
                "/api/admin/edit": self.api_admin_edit,
                "/api/admin/delete": self.api_admin_delete,
                "/api/admin/merge": self.api_admin_merge,
                "/api/admin/reset": self.api_admin_reset,
                "/api/admin/password": self.api_admin_password,
                "/api/admin/pin": self.api_admin_pin,
                "/api/admin/members": self.api_admin_members,
                "/api/admin/member/delete": self.api_admin_member_delete,
                "/api/admin/member/board": self.api_admin_member_board,
                "/api/admin/walls": self.api_admin_walls,
                "/api/admin/wall/upload": self.api_admin_wall_upload,
                "/api/admin/wall/delete": self.api_admin_wall_delete,
                "/api/admin/wall/config": self.api_admin_wall_config,
                "/api/admin/wall/toggle": self.api_admin_wall_toggle,
                "/api/admin/wall/move": self.api_admin_wall_move,
            }
            fn = routes.get(path)
            if fn:
                with _lock:
                    return fn(body)
            return self.send_json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            return self.send_json({"error": f"服务器错误: {exc}"}, 500)

    # ---------- api: member ----------
    def api_join(self, body):
        qq = str(body.get("qq", "")).strip()
        name = clean_text(body.get("name", ""), MAX_NAME_LEN)
        consent = bool(body.get("consent", False))
        pin = str(body.get("pin", "")).strip()
        if not QQ_RE.match(qq):
            return self.send_json({"error": "QQ 号格式不对（4-12 位数字）"}, 400)
        if not name:
            return self.send_json({"error": "名字不能为空"}, 400)
        if not consent:
            return self.send_json({"error": "需要同意把信息用于群友匹配"}, 400)
        if not re.match(r"^\d{4,6}$", pin):
            return self.send_json({"error": "请设置 4-6 位数字口令（用来确认是你本人）"}, 400)
        m = data["members"].get(qq)
        other = find_member_by_name(name, exclude_qq=qq)
        if other:
            return self.send_json(
                {"error": f"名字「{name}」已经被别的账号用了，换个名字吧（可以加个后缀，比如「{name}2」）"},
                409,
            )
        if m:
            ph = m.get("pinHash")
            if ph and not pin_ok(pin, ph):
                return self.send_json({"error": "口令不对，换一个或找管理员重置"}, 403)
            m["name"] = name
            m["consent"] = True
            if not ph:
                m["pinHash"] = hash_pin(pin)
            m["lastJoinAt"] = int(time.time())
        else:
            m = {
                "qq": qq, "name": name, "consent": True, "selection": [], "created": [],
                "createdAt": int(time.time()), "pinHash": hash_pin(pin), "lastJoinAt": int(time.time()),
                "boardUserId": "", "gender": "", "genderPublic": False,
            }
            data["members"][qq] = m
        save()
        return self.send_json({"member": member_payload(m), "entries": entries_payload(), "memberCount": len(data["members"]), "categories": CATEGORIES})

    def api_create_entry(self, body):
        qq = str(body.get("qq", "")).strip()
        text = clean_text(body.get("text", ""), MAX_ENTRY_LEN)
        category = clean_category(body.get("category"))
        kind = str(body.get("kind") or "").strip()
        if kind not in KINDS:
            kind = "main" if category == "领域" else "sub"
        if not text:
            return self.send_json({"error": "词条不能为空"}, 400)
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "请先登记（QQ + 名字）"}, 401)
        existing = find_entry_by_text(text)
        if existing:
            return self.send_json(
                {
                    "error": f"已经有「{existing['text']}」这个词条了，直接在列表里选它就行，不用再创建",
                    "existingId": existing["id"],
                },
                409,
            )
        created_entries = [data["entries"][i] for i in m.get("created", []) if i in data["entries"]]
        main_created = sum(1 for e in created_entries if entry_kind(e) == "main")
        sub_created = len(created_entries) - main_created
        if kind == "main" and main_created >= MAX_MAIN_CREATED:
            return self.send_json({"error": f"领域最多自建 {MAX_MAIN_CREATED} 个词条"}, 400)
        if kind != "main" and sub_created >= MAX_SUB_CREATED:
            return self.send_json({"error": f"细分最多自建 {MAX_SUB_CREATED} 个词条"}, 400)
        if kind == "main":
            category = "领域"
        eid = "e" + uuid.uuid4().hex[:8]
        entry = {"id": eid, "text": text, "createdBy": qq, "category": category, "kind": kind, "createdAt": int(time.time())}
        data["entries"][eid] = entry
        m.setdefault("created", []).append(eid)
        save()
        return self.send_json({"entry": {"id": eid, "text": text, "category": category, "kind": kind}, "member": member_payload(m), "entries": entries_payload()})

    def api_update_entry(self, body):
        """修改自己创建的词条（名字 + 分类）。"""
        qq = str(body.get("qq", "")).strip()
        eid = str(body.get("entryId", "")).strip()
        text = clean_text(body.get("text", ""), MAX_ENTRY_LEN)
        category = clean_category(body.get("category")) if "category" in body else None
        if not text:
            return self.send_json({"error": "词条不能为空"}, 400)
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "请先登记（QQ + 名字）"}, 401)
        entry = data["entries"].get(eid)
        if not entry:
            return self.send_json({"error": "词条不存在"}, 404)
        if entry.get("createdBy") != qq:
            return self.send_json({"error": "只能修改自己创建的词条"}, 403)
        existing = find_entry_by_text(text)
        if existing and existing["id"] != eid:
            return self.send_json({"error": "已经有同名的词条了，换个名字吧"}, 400)
        entry["text"] = text
        if category:
            entry["category"] = category
        body_kind = str(body.get("kind") or "").strip()
        if body_kind in KINDS:
            entry["kind"] = body_kind
        elif category:
            entry["kind"] = "main" if category == "领域" else "sub"
        entry["updatedAt"] = int(time.time())
        save()
        return self.send_json({"entry": entry_payload(entry), "member": member_payload(m), "entries": entries_payload()})

    def api_delete_entry(self, body):
        """删除自己创建的词条：已经有人选了就不让删（避免把别人的选择弄丢）。"""
        qq = str(body.get("qq", "")).strip()
        eid = str(body.get("entryId", "")).strip()
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "请先登记（QQ + 名字）"}, 401)
        entry = data["entries"].get(eid)
        if not entry:
            return self.send_json({"error": "词条不存在"}, 404)
        if entry.get("createdBy") != qq:
            return self.send_json({"error": "只能删除自己创建的词条"}, 403)
        users = [x["name"] for x in data["members"].values() if eid in sel_ids(x.get("selection", []))]
        if users:
            return self.send_json({"error": "已经有人选了这个词条（" + "、".join(users[:3]) + "），删掉会影响他们的选择"}, 409)
        data["entries"].pop(eid, None)
        for mm in data["members"].values():
            if eid in mm.get("created", []):
                mm["created"].remove(eid)
        save()
        return self.send_json({"ok": True, "member": member_payload(m), "entries": entries_payload()})

    def api_selection(self, body):
        qq = str(body.get("qq", "")).strip()
        raw = body.get("selection")
        if raw is None:
            raw = body.get("entryIds") or []
        if not isinstance(raw, list):
            return self.send_json({"error": "selection 必须是数组"}, 400)
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "请先登记（QQ + 名字）"}, 401)
        clean = []
        for it in norm_selection(raw):
            if it["id"] in data["entries"]:
                e = data["entries"][it["id"]]
                clean.append({"id": it["id"], "level": it["level"]})
        if not clean:
            return self.send_json({"error": "至少选择 1 个词条"}, 400)
        ids = [x["id"] for x in clean]
        main_n, sub_n = selection_kind_counts(ids)
        if main_n > MAX_MAIN_SELECTION:
            return self.send_json({"error": f"领域最多选 {MAX_MAIN_SELECTION} 个（现在选了 {main_n} 个）"}, 400)
        if sub_n > MAX_SUB_SELECTION:
            return self.send_json({"error": f"细分最多选 {MAX_SUB_SELECTION} 个（现在选了 {sub_n} 个）"}, 400)
        if len(clean) > MAX_SELECTION:
            return self.send_json({"error": f"最多选 {MAX_SELECTION} 个词条"}, 400)
        m["selection"] = clean
        save()
        return self.send_json({"ok": True, "member": member_payload(m), "entries": entries_payload()})

    def note_allowed(self, me_qq, other_qq):
        me_qq = str(me_qq or "").strip()
        other_qq = str(other_qq or "").strip()
        if not me_qq or not other_qq:
            return False
        if me_qq == other_qq:
            return True
        res = self.compute_matches(me_qq)
        for m in res.get("matches", [])[:NOTE_TOP_N]:
            if m["qq"] == other_qq:
                return True
        return False

    def api_gender(self, body):
        qq = str(body.get("qq", "")).strip()
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "未注册"}, 401)
        raw_gender = str(body.get("gender", "") or "").strip()
        custom_gender = re.sub(r"\s+", " ", str(body.get("genderCustom", "") or "").strip())
        low = raw_gender.lower()
        if low in ("", "female", "male"):
            gender = low
        else:
            gender = custom_gender[:12]
            if not gender:
                return self.send_json({"error": "先写一个自定义性别名称"}, 400)
            if re.search(r"[\x00-\x1f\x7f<>]", gender):
                return self.send_json({"error": "性别名称里有不允许的字符"}, 400)
        public = bool(body.get("genderPublic", False))
        # do_POST 已持有 _lock，这里不能再加（非可重入锁会死锁）
        m["gender"] = gender
        m["genderPublic"] = bool(public and gender)
        save()
        return self.send_json({"ok": True, "gender": m["gender"], "genderPublic": m["genderPublic"]})

    def api_note(self, body):
        qq = str(body.get("qq") or "").strip()
        note = str(body.get("note") or "").strip()
        note = re.sub(r"\s+", " ", note)[:NOTE_MAX]
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "未注册"}, 404)
        m["note"] = note
        m["noteAt"] = time.time() if note else 0
        save()
        return self.send_json({"ok": True, "note": note})

    # ---------- api: 喊话板 ----------
    def api_room_preview(self, body):
        qqs = body.get("qqs") or []
        if not isinstance(qqs, list):
            return self.send_json({"error": "成员格式不对"}, 400)
        qqs = [str(q).strip() for q in qqs if str(q).strip()]
        if len(qqs) < 2:
            return self.send_json({"error": "至少选 2 位成员"}, 400)
        return self.send_json(room_analysis(qqs))

    def api_room_split(self, body):
        qqs = body.get("qqs") or []
        if not isinstance(qqs, list):
            return self.send_json({"error": "成员格式不对"}, 400)
        qqs = [str(q).strip() for q in qqs if str(q).strip()]
        if len(qqs) < 2:
            return self.send_json({"error": "至少选 2 位成员"}, 400)
        sizes = body.get("sizes")
        res = room_split(qqs, rooms=body.get("rooms"), capacity=body.get("capacity"),
                         same_gender=bool(body.get("same_gender")),
                         sizes=sizes if isinstance(sizes, list) and sizes else None)
        if res.get("error"):
            return self.send_json({"error": res["error"]}, 400)
        return self.send_json(res)

    def api_room_recalc(self, body):
        """手动调整后的房间重新算分：rooms = [[qq, ...], ...]"""
        rooms = body.get("rooms") or []
        if not isinstance(rooms, list):
            return self.send_json({"error": "房间格式不对"}, 400)
        members = data["members"]
        counts = entry_counts()
        out = []
        for qqs in rooms:
            if not isinstance(qqs, list):
                continue
            clean = [str(q).strip() for q in qqs]
            clean = [q for q in dict.fromkeys(clean) if q in members][:ROOM_MAX_PICKS]
            a = room_analysis(clean, counts)
            out.append({
                "qqs": clean,
                "members": a.get("members") or [{"qq": q, "name": room_name(q)} for q in clean],
                "avg": a["avg"], "min": a["min"], "worst": a["worst"],
                "memberMax": a.get("memberMax"), "memberMin": a.get("memberMin"),
                "loner": a["loner"], "common": a["common"],
            })
        return self.send_json({"rooms": out})

    def api_qgroup_split(self, body):
        eid = str(body.get("event_id") or "").strip()
        if not eid:
            return self.send_json({"error": "缺少活动 id"}, 400)
        payload = qgroup_event_payload(eid)
        if payload.get("error"):
            return self.send_json({"error": payload["error"]}, payload.get("status", 400))
        qqs = payload.get("matched_qqs") or []
        if len(qqs) < 2:
            return self.send_json({"error": "可匹配的报名者不足 2 人：先在后台给群友填「看板 ID」，或报名者还没在本站登记"}, 400)
        mode = "capacity" if str(body.get("mode") or "") == "capacity" else "rooms"
        try:
            val = int(body.get("value"))
        except (TypeError, ValueError):
            val = None
        same_gender = bool(body.get("same_gender"))
        sizes = body.get("sizes")
        if isinstance(sizes, list) and sizes:
            res = room_split(qqs, sizes=sizes, same_gender=same_gender)
        elif mode == "capacity":
            res = room_split(qqs, capacity=val, same_gender=same_gender)
        else:
            res = room_split(qqs, rooms=val, same_gender=same_gender)
        if res.get("error"):
            return self.send_json({"error": res["error"]}, 400)
        rooms = [{
            "qqs": r.get("qqs") or [],
            "members": r.get("members", []),
            "avg": r.get("avg"), "min": r.get("min"),
            "memberMax": r.get("memberMax"), "memberMin": r.get("memberMin"),
            "worst": r.get("worst"), "common": (r.get("common") or [])[:4],
        } for r in res.get("rooms", [])]
        return self.send_json({"event_id": eid, "mode": mode, "rooms": rooms, "capacity": res.get("capacity")})

    def api_qgroup_rooms(self, body):
        rooms = body.get("rooms") or []
        if not isinstance(rooms, list):
            return self.send_json({"error": "房间格式不对"}, 400)
        members = data["members"]
        counts = entry_counts()
        out = []
        for qqs in rooms:
            if not isinstance(qqs, list):
                continue
            clean = [str(q).strip() for q in qqs]
            clean = [q for q in dict.fromkeys(clean) if q in members][:ROOM_MAX_PICKS]
            a = room_analysis(clean, counts)
            out.append({
                "qqs": clean,
                "members": a.get("members") or [{"qq": q, "name": room_name(q)} for q in clean],
                "avg": a["avg"], "min": a["min"], "worst": a["worst"],
                "memberMax": a.get("memberMax"), "memberMin": a.get("memberMin"),
                "loner": a["loner"], "common": (a["common"] or [])[:4],
            })
        return self.send_json({"rooms": out})

    def api_shout(self, body):
        qq = str(body.get("qq") or "").strip()
        text = clean_text(body.get("text", ""), MAX_SHOUT_LEN)
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "请先登记（QQ + 名字）"}, 401)
        if not text:
            return self.send_json({"error": "喊话内容不能为空"}, 400)
        now = time.time()
        lst = data.setdefault("shouts", [])
        mine = next((s for s in lst if str(s.get("qq")) == qq), None)
        if mine:
            nxt = float(mine.get("createdAt") or 0) + SHOUT_COOLDOWN_SEC
            if now < nxt:
                return self.send_json(
                    {"error": "24 小时内只能发一条喊话，可以改天再来", "nextAllowedAt": int(nxt)},
                    429,
                )
        cutoff = now - SHOUT_TTL_DAYS * 86400
        old_own = [s for s in lst if str(s.get("qq")) == qq]
        if old_own:
            archive_shouts(now, extra=old_own)
        else:
            archive_shouts(now)
        data["shouts"] = [
            s for s in data.get("shouts", [])
            if str(s.get("qq")) != qq and float(s.get("createdAt") or 0) > cutoff
        ]
        data["shouts"].append({
            "id": "s" + uuid.uuid4().hex[:8],
            "qq": qq,
            "name": m.get("name", ""),
            "text": text,
            "createdAt": int(now),
        })
        m["lastShoutAt"] = int(now)
        save()
        active = active_shouts(now)
        return self.send_json({
            "ok": True,
            "shouts": [shout_public(s, qq) for s in active],
            "now": int(now),
            "nextAllowedAt": int(now) + SHOUT_COOLDOWN_SEC,
            "historyTotal": len(data.get("shoutHistory", [])),
        })

    def api_admin_shout_list(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员权限"}, 403)
        now = time.time()
        archive_shouts(now)
        active = active_shouts(now)
        hist = history_shouts()

        def view(s, archived):
            d = shout_public(s)
            d["archivedAt"] = int(s.get("archivedAt") or 0) if archived else 0
            return d

        return self.send_json({
            "now": int(now),
            "active": [view(s, False) for s in active],
            "history": [view(s, True) for s in hist],
        })

    def api_admin_shout_delete(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员权限"}, 403)
        sid = str(body.get("id") or "")
        before = len(data.get("shouts", [])) + len(data.get("shoutHistory", []))
        data["shouts"] = [s for s in data.get("shouts", []) if str(s.get("id")) != sid]
        data["shoutHistory"] = [s for s in data.get("shoutHistory", []) if str(s.get("id")) != sid]
        save()
        after = len(data.get("shouts", [])) + len(data.get("shoutHistory", []))
        return self.send_json({"ok": True, "removed": before - after})


    def compute_matches(self, qq, sort_mode="rare"):
        sort_mode = "familiar" if str(sort_mode or "") == "familiar" else "rare"
        me = data["members"].get(qq)
        if not me:
            return {"error": "未注册", "matches": []}
        mine_items = norm_selection(me.get("selection", []))
        mine_ids = set(x["id"] for x in mine_items)
        mine_levels = {x["id"]: x["level"] for x in mine_items}
        if not mine_ids:
            return {"matches": [], "me": member_payload(me)}
        counts = entry_counts()

        def hot_key(e):
            ent = data["entries"].get(e) or {}
            return (0 if entry_kind(ent) == "main" else 1, -counts.get(e, 0), ent.get("text", ""))

        matches = []
        for other in data["members"].values():
            if other["qq"] == qq:
                continue
            other_items = norm_selection(other.get("selection", []))
            their_ids = set(x["id"] for x in other_items)
            their_levels = {x["id"]: x["level"] for x in other_items}
            shared = mine_ids & their_ids
            if not shared:
                continue
            sim, detail = match_stats(mine_items, other_items, counts)
            fam = 0.0
            my_top = 0
            for e in shared:
                ent = data["entries"].get(e)
                if not ent:
                    continue
                # 熟悉度优先：按「我」的熟悉度排序（我的本命共同项最重要），领域与细分都计入
                lv = mine_levels.get(e, 3)
                if lv >= 4:
                    my_top += 1
                fam += 1.0 if lv >= 4 else (0.6 if lv == 3 else (0.2 if lv == 2 else 0.05))
            matches.append({
                "famScore": round(fam, 2),
                "myTopShared": my_top,
                "qq": other["qq"],
                "name": other["name"],
                "gender": (str(other.get("gender") or "") if other.get("genderPublic") else ""),
                "note": str(other.get("note") or ""),
                "overlap": len(shared),
                "similarity": sim,
                "ratio": detail.get("ratio", 0),
                "sharedCount": detail.get("sharedCount", len(shared)),
                "sharedDomain": detail.get("sharedDomain", 0),
                "sharedSub": detail.get("sharedSub", len(shared)),
                "nicheShared": detail.get("nicheShared", 0),
                "label": detail.get("label", ""),
                "lowData": detail.get("lowData", False),
                "mineCovered": detail.get("mineCovered", False),
                "theirsCovered": detail.get("theirsCovered", False),
                "mineCount": detail.get("mineCount", 0),
                "theirsCount": detail.get("theirsCount", 0),
                "bothTop": detail.get("bothTop", 0),
                "shared": [
                    {"id": e, "text": data["entries"][e]["text"], "count": counts.get(e, 0),
                     "kind": entry_kind(data["entries"][e]),
                     "level": (min(mine_levels.get(e, 3), their_levels.get(e, 3))
                               if entry_kind(data["entries"][e]) != "main" else 0),
                     "myLevel": mine_levels.get(e, 0), "theirLevel": their_levels.get(e, 0)}
                    for e in sorted(shared, key=hot_key) if e in data["entries"]
                ],
                "otherOnly": [
                    {"id": e, "text": data["entries"][e]["text"], "count": counts.get(e, 0),
                     "kind": entry_kind(data["entries"][e]), "level": their_levels.get(e, 0),
                     "theirLevel": their_levels.get(e, 0)}
                    for e in sorted(their_ids - shared, key=hot_key) if e in data["entries"]
                ],
            })
        # 证据量折算：共同项越少，分数折扣越大（方案 A）
        EVIDENCE_K = 3
        for mm in matches:
            sh = int(mm.get("sharedCount") or 0)
            mm["evidenceScore"] = int(round(mm["similarity"] * sh / (sh + EVIDENCE_K)))
            ev = mm["evidenceScore"]
            mm["label"] = overlap_label(sh, (mm.get("similarity") or 0) / 100.0, int(mm.get("nicheShared") or 0))
            mm["matchPercent"] = match_percent((mm.get("similarity") or 0) / 100.0, sh)

        # 资料 ≤3 项的人单独分区（方案 C），主榜只放资料足够的
        main_list = [m for m in matches if int(m.get("theirsCount") or 0) > 3]
        sparse_list = [m for m in matches if int(m.get("theirsCount") or 0) <= 3]

        if sort_mode == "familiar":
            main_list.sort(key=lambda x: (-x.get("myTopShared", 0), -x["famScore"], -x["sharedCount"], -x["evidenceScore"], x["name"]))
            sparse_list.sort(key=lambda x: (-x.get("myTopShared", 0), -x["famScore"], -x["sharedCount"], x["name"]))
        else:
            # 方案 B：共同项数量优先，再看折算分
            main_list.sort(key=lambda x: (-x["sharedCount"], -x["evidenceScore"], -x["nicheShared"], x["name"]))
            sparse_list.sort(key=lambda x: (-x["sharedCount"], -x["similarity"], x["nicheShared"], x["name"]))
        for idx, mm in enumerate(main_list):
            if idx >= NOTE_TOP_N:
                mm["note"] = ""
        for mm in sparse_list:
            mm["note"] = ""
        return {
            "matches": main_list,
            "sparseMatches": sparse_list,
            "sort": sort_mode,
            "me": member_payload(me),
            "mySelection": [
                {"id": e, "text": data["entries"][e]["text"], "level": mine_levels.get(e, 0),
                 "kind": entry_kind(data["entries"][e])}
                for e in mine_ids if e in data["entries"]
            ],
            "entryCounts": counts,
        }

    # ---------- api: admin ----------
    def require_admin(self, body):
        token = str(body.get("token") or "")
        if not admin_ok(token):
            return False
        return True

    def compute_clusters(self, min_link=40):
        members = [m for m in data["members"].values() if sel_ids(m.get("selection", []))]
        remaining = list(members)
        groups = []
        while remaining:
            seed = max(remaining, key=lambda m: len(sel_ids(m.get("selection", []))))
            remaining.remove(seed)
            group = [seed]
            changed = True
            while changed:
                changed = False
                for m in list(remaining):
                    if any(similarity_pct(m, g) >= min_link for g in group):
                        group.append(m)
                        remaining.remove(m)
                        changed = True
            groups.append(group)
        groups.sort(key=len, reverse=True)
        out = []
        for group in groups:
            if len(group) < 2:
                continue
            tagc = {}
            for m in group:
                for eid in sel_ids(m.get("selection", [])):
                    e = data["entries"].get(eid)
                    if e:
                        tagc[e["text"]] = tagc.get(e["text"], 0) + 1
            tags = sorted(tagc.items(), key=lambda kv: -kv[1])[:6]
            out.append({
                "size": len(group),
                "members": sorted([{"qq": m["qq"], "name": m["name"]} for m in group], key=lambda x: x["name"]),
                "tags": [{"text": t, "count": c} for t, c in tags],
            })
        single_members = []
        for g in groups:
            if len(g) >= 2:
                continue
            for m in g:
                picks = [data["entries"][eid]["text"] for eid in sel_ids(m.get("selection", [])) if eid in data["entries"]]
                single_members.append({
                    "qq": m["qq"],
                    "name": m["name"],
                    "picks": picks[:8],
                    "pickCount": len(picks),
                })
        return {
            "clusters": out[:8],
            "membersWithSelection": len(members),
            "singles": len(single_members),
            "singleMembers": single_members,
            "minLink": min_link,
        }

    def compute_trend(self, limit=TREND_KEEP):
        pts = list(data.get("trend") or [])
        texts = {}
        for eid, e in data.get("entries", {}).items():
            texts[eid] = e.get("text", "")
        counts_now = entry_counts()
        points = []
        for p in pts:
            try:
                points.append({"t": int(p.get("t") or 0), "counts": p.get("counts") or {}})
            except Exception:
                continue
        if not points or points[-1]["counts"] != counts_now:
            points.append({"t": int(time.time()), "counts": counts_now})
        now = time.time()
        cutoff7 = now - 7 * 86400
        recent_entries = sorted(
            data["entries"].values(), key=lambda e: int(e.get("createdAt") or 0), reverse=True
        )[:8]
        recent_members = sorted(
            data["members"].values(), key=lambda m: int(m.get("createdAt") or 0), reverse=True
        )[:8]
        new7_entries = sum(1 for e in data["entries"].values() if int(e.get("createdAt") or 0) > cutoff7)
        new7_members = sum(1 for m in data["members"].values() if int(m.get("createdAt") or 0) > cutoff7)
        return {
            "points": points[-limit:],
            "texts": texts,
            "recentEntries": [
                {
                    "id": e["id"],
                    "text": e["text"],
                    "kind": entry_kind(e),
                    "category": e.get("category") or "其他",
                    "count": counts_now.get(e["id"], 0),
                    "createdAt": int(e.get("createdAt") or 0),
                }
                for e in recent_entries
            ],
            "recentMembers": [
                {
                    "qq": m.get("qq", ""),
                    "name": m.get("name", ""),
                    "createdAt": int(m.get("createdAt") or 0),
                }
                for m in recent_members
            ],
            "new7d": {"entries": new7_entries, "members": new7_members},
            "totals": {"entries": len(data["entries"]), "members": len(data["members"])},
        }

    def api_admin_pin(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        qq = str(body.get("qq") or "").strip()
        pin = str(body.get("pin") or "").strip()
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "没有这个群友"}, 404)
        if not re.match(r"^\d{4,6}$", pin):
            return self.send_json({"error": "口令需为 4-6 位数字"}, 400)
        m["pinHash"] = hash_pin(pin)
        save()
        return self.send_json({"ok": True, "qq": qq})

    def api_admin_member_board(self, body):
        """管理员维护群友的看板用户 id（用于把看板报名数据映射到成分站账号）。"""
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        qq = str(body.get("qq", "")).strip()
        m = data["members"].get(qq)
        if not m:
            return self.send_json({"error": "没有这个群友"}, 404)
        raw = str(body.get("boardUserId", "") or "").strip()
        if len(raw) > 40:
            return self.send_json({"error": "看板用户 id 太长（最多 40 个字符）"}, 400)
        if raw and not re.match(r"^[A-Za-z0-9_.:-]+$", raw):
            return self.send_json({"error": "看板用户 id 只能包含字母、数字和 _ . : -"}, 400)
        m["boardUserId"] = raw
        save()
        return self.send_json({"ok": True, "qq": qq, "boardUserId": raw})

    def api_admin_members(self, body):
        """管理员查看全部群友账号：QQ、名字、口令状态、自建/已选词条（只读）。"""
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        name_counts = {}
        for mm in data["members"].values():
            name_counts[mm.get("name", "")] = name_counts.get(mm.get("name", ""), 0) + 1
        out = []
        for qq, m in data["members"].items():
            picks = []
            for it in norm_selection(m.get("selection", [])):
                e = data["entries"].get(it["id"])
                if not e:
                    continue
                picks.append({
                    "id": it["id"],
                    "text": e["text"],
                    "kind": entry_kind(e),
                    "level": it["level"],
                    "levelLabel": LEVELS.get(it["level"], ""),
                })
            out.append({
                "qq": qq,
                "name": m.get("name", ""),
                "createdAt": m.get("createdAt", 0),
                "hasPin": bool(m.get("pinHash")),
                "createdCount": len(m.get("created", [])),
                "picks": picks,
                "picksCount": len(picks),
                "dupName": name_counts.get(m.get("name", ""), 0) > 1,
                "boardUserId": m.get("boardUserId", ""),
            })
        out.sort(key=lambda x: (-x["picksCount"], x["name"]))
        return self.send_json({"members": out, "total": len(out)})

    def api_admin_member_delete(self, body):
        """删除一个群友账号（他们创建过的词条会转给「管理员」，不会连带删除）。"""
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        if str(body.get("confirm") or "") != "DELETE":
            return self.send_json({"error": "请输入 DELETE 确认"}, 400)
        qq = str(body.get("qq") or "").strip()
        m = data["members"].pop(qq, None)
        if not m:
            return self.send_json({"error": "没有这个群友"}, 404)
        for e in data["entries"].values():
            if e.get("createdBy") == qq:
                e["createdBy"] = "admin"
        save()
        return self.send_json({"ok": True, "qq": qq, "deletedName": m.get("name", ""), "total": len(data["members"])})

    def api_admin_login(self, body):
        prune_tokens()
        pwd = str(body.get("password") or "")
        if sha256(pwd) != data["settings"].get("adminPasswordHash"):
            return self.send_json({"error": "密码不对"}, 401)
        token = secrets.token_hex(16)
        _admin_tokens[token] = time.time() + TOKEN_TTL
        return self.send_json({"ok": True, "token": token, "expiresIn": TOKEN_TTL})

    def api_admin_create(self, body):
        """管理员创建词条（不占用群友的 5 个创建名额）。"""
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        text = clean_text(body.get("text"), MAX_ENTRY_LEN)
        if not text:
            return self.send_json({"error": "词条不能为空"}, 400)
        category = clean_category(body.get("category"))
        kind = str(body.get("kind") or "").strip()
        if kind not in KINDS:
            kind = "main" if category == "领域" else "sub"
        existing = find_entry_by_text(text)
        if existing:
            return self.send_json(
                {
                    "error": f"已经有「{existing['text']}」这个词条了，改那个就行",
                    "existingId": existing["id"],
                },
                409,
            )
        eid = "e" + uuid.uuid4().hex[:8]
        entry = {"id": eid, "text": text, "createdBy": "admin", "category": category, "kind": kind, "createdAt": int(time.time())}
        data["entries"][eid] = entry
        save()
        return self.send_json({"ok": True, "entry": entry_payload(entry), "entries": entries_payload()})

    # ---------- api: wallpaper admin ----------
    def api_admin_walls(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        return self.send_json(walls_payload())

    def api_admin_wall_upload(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        raw = str(body.get("data") or "")
        name = clean_text(body.get("name") or "壁纸", 40)
        m = re.match(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.+)$", raw, re.S)
        if not m:
            return self.send_json({"error": "只支持图片文件（png/jpg/webp/svg）"}, 400)
        sub, b64 = m.group(1).lower(), m.group(2)
        ext = WALL_EXTS.get(sub)
        if not ext:
            return self.send_json({"error": "不支持这种图片格式"}, 400)
        try:
            import base64
            blob = base64.b64decode(b64)
        except Exception:
            return self.send_json({"error": "图片数据损坏"}, 400)
        if not blob:
            return self.send_json({"error": "图片是空的"}, 400)
        if len(blob) > WALL_MAX_BYTES:
            return self.send_json({"error": "图片太大（最多 10MB）"}, 400)
        if ext in ("png", "jpg", "jpeg", "webp"):
            try:
                import io as _io
                from PIL import Image, ImageOps
                im = ImageOps.exif_transpose(Image.open(_io.BytesIO(blob)))
                if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                    bg = Image.new("RGB", im.size, (255, 255, 255))
                    rgba = im.convert("RGBA")
                    bg.paste(rgba, mask=rgba.split()[-1])
                    im = bg
                else:
                    im = im.convert("RGB")
                w, h = im.size
                scale = min(1.0, 1600.0 / float(max(w, h)))
                if scale < 1.0:
                    im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
                buf = _io.BytesIO()
                im.save(buf, "WEBP", quality=76, method=6)
                blob = buf.getvalue()
                ext = "webp"
            except Exception:
                pass
        os.makedirs(WALLS_DIR, exist_ok=True)
        fname = "wall-" + uuid.uuid4().hex[:10] + "." + ext
        with open(os.path.join(WALLS_DIR, fname), "wb") as f:
            f.write(blob)
        mf = load_walls()
        mf["items"].append({"name": name, "src": "/walls/" + fname})
        save_walls(mf)
        return self.send_json({"ok": True, "walls": walls_payload()})

    def api_admin_wall_delete(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        src = str(body.get("src") or "")
        path = wall_safe_path(src)
        if not path:
            return self.send_json({"error": "无效的壁纸路径"}, 400)
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError as exc:
            return self.send_json({"error": f"删除失败: {exc}"}, 500)
        mf = load_walls()
        mf["items"] = [it for it in mf["items"] if str(it.get("src")) != src]
        save_walls(mf)
        return self.send_json({"ok": True, "walls": walls_payload()})

    def api_admin_wall_config(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        try:
            secs = int(body.get("rotateSeconds") or 24)
        except (TypeError, ValueError):
            return self.send_json({"error": "间隔需要是数字"}, 400)
        secs = max(8, min(600, secs))
        mf = load_walls()
        mf["rotateSeconds"] = secs
        save_walls(mf)
        return self.send_json({"ok": True, "walls": walls_payload()})

    def api_admin_wall_toggle(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        src = str(body.get("src") or "")
        if not wall_safe_path(src):
            return self.send_json({"error": "无效的壁纸路径"}, 400)
        mf = load_walls()
        hit = None
        for it in mf.get("items", []):
            if str(it.get("src")) == src:
                it["enabled"] = bool(body.get("enabled"))
                hit = it
                break
        if hit is None:
            return self.send_json({"error": "壁纸不存在"}, 404)
        save_walls(mf)
        return self.send_json({"ok": True, "walls": walls_payload()})

    def api_admin_wall_move(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        src = str(body.get("src") or "")
        try:
            step = int(body.get("dir") or 0)
        except (TypeError, ValueError):
            step = 0
        if step not in (-1, 1):
            return self.send_json({"error": "方向不对"}, 400)
        mf = load_walls()
        items = mf.get("items", [])
        idx = next((i for i, it in enumerate(items) if str(it.get("src")) == src), -1)
        if idx < 0:
            return self.send_json({"error": "壁纸不存在"}, 404)
        j = idx + step
        if 0 <= j < len(items):
            items[idx], items[j] = items[j], items[idx]
            save_walls(mf)
        return self.send_json({"ok": True, "walls": walls_payload()})

    def api_admin_edit(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        eid = str(body.get("entryId") or "")
        entry = data["entries"].get(eid)
        if not entry:
            return self.send_json({"error": "词条不存在"}, 404)
        if "text" in body:
            text = clean_text(body.get("text"), MAX_ENTRY_LEN)
            if not text:
                return self.send_json({"error": "词条不能为空"}, 400)
            other = find_entry_by_text(text)
            if other and other["id"] != eid:
                return self.send_json({"error": "已经有同名词条了"}, 400)
            entry["text"] = text
        if "category" in body:
            entry["category"] = clean_category(body.get("category"))
        if "kind" in body:
            kind = str(body.get("kind") or "").strip()
            if kind in KINDS:
                entry["kind"] = kind
        entry["updatedAt"] = int(time.time())
        save()
        return self.send_json({"ok": True, "entry": entry_payload(entry), "entries": entries_payload()})

    def api_admin_delete(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        eid = str(body.get("entryId") or "")
        if eid not in data["entries"]:
            return self.send_json({"error": "词条不存在"}, 404)
        data["entries"].pop(eid)
        for m in data["members"].values():
            if eid in sel_ids(m.get("selection", [])):
                m["selection"] = [
                    it for it in norm_selection(m.get("selection", [])) if it["id"] != eid
                ]
            if eid in m.get("created", []):
                m["created"].remove(eid)
        save()
        return self.send_json({"ok": True, "entries": entries_payload()})

    def api_admin_merge(self, body):
        """把 fromId 合并进 toId：所有人的选择/创建记录转移过去，然后删掉 fromId。"""
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        from_id = str(body.get("fromId") or "")
        to_id = str(body.get("toId") or "")
        if from_id == to_id:
            return self.send_json({"error": "不能合并到自己"}, 400)
        if from_id not in data["entries"] or to_id not in data["entries"]:
            return self.send_json({"error": "词条不存在"}, 404)
        for m in data["members"].values():
            items = norm_selection(m.get("selection", []))
            if any(it["id"] == from_id for it in items):
                merged = []
                for it in items:
                    if it["id"] == from_id:
                        it = {"id": to_id, "level": it["level"]}
                    if any(x["id"] == it["id"] for x in merged):
                        continue
                    merged.append(it)
                m["selection"] = merged
            cre = m.get("created", [])
            if from_id in cre:
                cre = [to_id if e == from_id else e for e in cre]
                dedup = []
                for e in cre:
                    if e not in dedup:
                        dedup.append(e)
                m["created"] = dedup
        target = data["entries"][to_id]
        aliases = [str(x) for x in (target.get("aliases") or []) if str(x).strip()]
        src = data["entries"][from_id]
        for cand in [src["text"]] + [str(x) for x in (src.get("aliases") or [])]:
            cand = cand.strip()
            if cand and normalize_entry_key(cand) != normalize_entry_key(target["text"]) and normalize_entry_key(cand) not in {normalize_entry_key(x) for x in aliases}:
                aliases.append(cand)
        target["aliases"] = aliases
        data["entries"].pop(from_id)
        save()
        return self.send_json({"ok": True, "entries": entries_payload()})

    def api_admin_reset(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        if str(body.get("confirm") or "") != "RESET":
            return self.send_json({"error": "需要 confirm=RESET 确认"}, 400)
        data["entries"] = {}
        data["members"] = {}
        write_backup(force=True)
        save()
        return self.send_json({"ok": True, "entries": []})

    def api_admin_password(self, body):
        if not self.require_admin(body):
            return self.send_json({"error": "需要管理员登录"}, 401)
        new_pwd = str(body.get("newPassword") or "")
        if len(new_pwd) < 6:
            return self.send_json({"error": "新密码至少 6 位"}, 400)
        data["settings"]["adminPasswordHash"] = sha256(new_pwd)
        save()
        return self.send_json({"ok": True})

    # ---------- static ----------
    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.normpath(os.path.join(PUBLIC, rel))
        if not full.startswith(PUBLIC + os.sep) and full != PUBLIC:
            return self.send_text("forbidden", 403)
        if not os.path.isfile(full):
            return self.send_text("not found", 404)
        with open(full, "rb") as f:
            body = f.read()
        ext = os.path.splitext(full)[1].lower()
        enc = None
        if ext in (".html", ".css", ".js", ".mjs", ".json", ".svg", ".webmanifest", ".txt") and len(body) > 1024:
            if "gzip" in (self.headers.get("Accept-Encoding") or "").lower():
                try:
                    st = os.stat(full)
                    key = (full, st.st_mtime_ns, st.st_size)
                    gz = _GZIP_CACHE.get(key)
                    if gz is None:
                        gz = gzip.compress(body, 6)
                        if len(_GZIP_CACHE) > 64:
                            _GZIP_CACHE.clear()
                        _GZIP_CACHE[key] = gz
                    body = gz
                    enc = "gzip"
                except Exception:
                    enc = None
        self.send_response(200)
        self.send_header("Content-Type", CTYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        if enc:
            self.send_header("Content-Encoding", enc)
            self.send_header("Vary", "Accept-Encoding")
        if rel.startswith("walls" + os.sep) and os.path.basename(rel) != "manifest.json":
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        if rel == "index.html":
            try:
                for it in load_walls().get("items", []):
                    if it.get("enabled") is False:
                        continue
                    src = str(it.get("src") or "")
                    if src:
                        self.send_header("Link", "<%s>; rel=preload; as=image" % src)
                        break
            except Exception:
                pass
        if ext == ".js":
            self.send_header("Service-Worker-Allowed", "/music/")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 安静一点
        pass


QGROUP_BASE = os.environ.get("QGROUP_API_BASE", "https://kanban.danndann.cn/api/public/v1")
QGROUP_KEY_FILE = os.path.join(BASE, "private", "qgroup-api-key.txt")
_qgroup_cache = {}
_qgroup_lock = threading.Lock()


def qgroup_key():
    k = (os.environ.get("QGROUP_API_KEY") or "").strip()
    if k:
        return k
    try:
        with open(QGROUP_KEY_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def qgroup_request(path, params=None):
    key = qgroup_key()
    if not key:
        return {"error": "未配置看板 API 密钥", "status": 503}
    url = QGROUP_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=12) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8", "replace") or "{}")
        except Exception:
            body = {}
        return {"error": body.get("error") or ("看板接口返回 %s" % e.code), "status": e.code}
    except Exception as e:
        return {"error": "看板接口连接失败：%s" % e, "status": 503}


def qgroup_events(limit=20, offset=0, lifecycle=""):
    cache_key = ("events", limit, offset, lifecycle)
    now = time.time()
    with _qgroup_lock:
        hit = _qgroup_cache.get(cache_key)
        if hit and now - hit["at"] < 60:
            return hit["data"]
    data = qgroup_request("/events", {"limit": limit, "offset": offset, "lifecycle": lifecycle})
    if not data.get("error"):
        with _qgroup_lock:
            _qgroup_cache[cache_key] = {"at": now, "data": data}
    return data


def board_member_map():
    out = {}
    duplicates = set()
    for qq, m in (data.get("members") or {}).items():
        uid = str(m.get("boardUserId") or "").strip()
        if uid:
            if uid in out:
                duplicates.add(uid)
            out[uid] = qq
    for uid in duplicates:
        out.pop(uid, None)
    return out


def board_member(qq):
    m = (data.get("members") or {}).get(qq) or {}
    return {
        "qq": qq,
        "name": m.get("name") or qq,
        "count": len(norm_selection(m.get("selection", []))) if m else 0,
    }


def qgroup_event_payload(event_id):
    d = qgroup_request("/events/" + urllib.parse.quote(event_id))
    if d.get("error"):
        return {"error": d["error"], "status": d.get("status", 400)}
    bmap = board_member_map()
    parts = d.get("participants") or []
    out_parts = []
    matched = []
    for p in parts:
        uid = str(p.get("user_id") or "")
        qq = bmap.get(uid) if uid else None
        mm = board_member(qq) if qq and qq in data["members"] else None
        if mm:
            matched.append(qq)
        out_parts.append({
            "attendee_id": p.get("attendee_id"),
            "user_id": uid or None,
            "name": p.get("name"),
            "status": p.get("status"),
            "confirmation_state": p.get("confirmation_state"),
            "qq": qq or "",
            "member_name": (mm or {}).get("name", ""),
            "count": (mm or {}).get("count", 0),
            "matched": bool(mm),
        })
    room_assign = d.get("room_assignments") or {}
    actual = room_assign.get("actual")
    planned = room_assign.get("planned")
    use = actual if actual is not None else planned
    rooms = []
    for r in (use or {}).get("rooms", []):
        qqs = []
        for mem in r.get("members") or []:
            uid = str(mem.get("user_id") or "")
            qq = bmap.get(uid) if uid else None
            if qq and qq in data["members"]:
                qqs.append(qq)
        qqs = list(dict.fromkeys(qqs))
        ana = room_analysis(qqs) if len(qqs) >= 2 else None
        rooms.append({
            "id": r.get("id"),
            "name": r.get("name") or "未命名",
            "members": [board_member(q) for q in qqs],
            "avg": (ana or {}).get("avg"),
            "min": (ana or {}).get("min"),
            "common": ((ana or {}).get("common") or [])[:4],
        })
    analysis = room_analysis(matched) if len(matched) >= 2 else None
    return {
        "api_version": d.get("api_version", 1),
        "event_id": d.get("event_id") or event_id,
        "revision": d.get("revision"),
        "event": d.get("event") or {},
        "participants": out_parts,
        "matched_qqs": matched,
        "rooms_source": ("actual" if actual is not None else ("planned" if planned is not None else "")),
        "rooms": rooms,
        "analysis": {k: analysis[k] for k in ("avg", "min", "worst", "loner", "common")} if analysis else None,
    }


def main():
    load()
    seed_trend_from_backups()
    trend_snapshot(force=True)
    threading.Thread(target=trend_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"日本音乐成分表 running: http://0.0.0.0:{PORT}  data={DATA_FILE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
