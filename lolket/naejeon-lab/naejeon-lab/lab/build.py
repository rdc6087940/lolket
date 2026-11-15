"""원본 매치 JSON → 분석용 테이블(games, game_players) 재생성 + 내전 시리즈 묶기"""
import hashlib
import json

from .collect import is_custom_5v5

ROLE_FIX = {"": None, "Invalid": None, "NONE": None, "BOTTOM": "BOTTOM", "UTILITY": "UTILITY",
            "TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "MID": "MIDDLE", "SUPPORT": "UTILITY", "ADC": "BOTTOM"}


def _role(p):
    for k in ("teamPosition", "individualPosition", "lane"):
        r = ROLE_FIX.get(p.get(k) or "", None)
        if r:
            return r
    return None


def build(db, log=print, series_gap_h=3):
    db.x("DELETE FROM games")
    db.x("DELETE FROM game_players")
    n = 0
    # deeplol 참가자: 저장 당시 못 이었더라도 지금 연결돼 있으면 Riot puuid 로 통일 (puuid 기준, 닉네임 무관)
    dlmap = {r["dl_puuid"]: r["riot_puuid"] for r in db.q("SELECT dl_puuid, riot_puuid FROM puuid_map WHERE riot_puuid IS NOT NULL")}
    cur = db.conn.execute("SELECT match_id, json FROM matches_raw WHERE status=200 AND json IS NOT NULL")
    batch_g, batch_p = [], []
    for mid, js in cur:
        try:
            m = json.loads(js)
            info = m["info"]
        except Exception:
            continue
        parts = info.get("participants", [])
        if not parts:
            continue
        start = info.get("gameStartTimestamp") or info.get("gameCreation") or 0
        dur = info.get("gameDuration") or 0
        if dur and dur > 100000:  # 예전 형식(ms)
            dur //= 1000
        custom = 1 if is_custom_5v5(info) else 0
        blue_win = None
        for t in info.get("teams", []):
            if t.get("teamId") == 100:
                blue_win = 1 if t.get("win") else 0
        patch = ".".join(str(info.get("gameVersion", "")).split(".")[:2])
        batch_g.append((mid, start, dur, info.get("queueId"), custom, patch, blue_win, None, None))
        for p in parts:
            puuid = p.get("puuid")
            if p.get("deeplolPuuid"):
                puuid = dlmap.get(p["deeplolPuuid"]) or puuid
            if not puuid or puuid == "BOT":
                continue
            batch_p.append((mid, puuid, p.get("teamId"), _role(p), p.get("championName"), 1 if p.get("win") else 0,
                            p.get("kills", 0), p.get("deaths", 0), p.get("assists", 0),
                            (p.get("totalMinionsKilled", 0) or 0) + (p.get("neutralMinionsKilled", 0) or 0),
                            p.get("goldEarned", 0), p.get("totalDamageDealtToChampions", 0), p.get("visionScore", 0),
                            start, dur, info.get("queueId")))
        n += 1
        if len(batch_g) >= 2000:
            db.conn.executemany("INSERT OR REPLACE INTO games VALUES(?,?,?,?,?,?,?,?,?)", batch_g)
            db.conn.executemany("INSERT OR REPLACE INTO game_players VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch_p)
            batch_g, batch_p = [], []
    db.conn.executemany("INSERT OR REPLACE INTO games VALUES(?,?,?,?,?,?,?,?,?)", batch_g)
    db.conn.executemany("INSERT OR REPLACE INTO game_players VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch_p)
    db.commit()
    _group_series(db, series_gap_h)
    c = db.one("SELECT COUNT(*) c FROM games WHERE is_custom=1")["c"]
    log(f"정리 완료: 경기 {n}건 (내전 {c}건)")


def _group_series(db, gap_h):
    """같은 10명이 짧은 간격으로 연달아 한 내전 = 한 시리즈 (팀이 섞여도 같은 10명이면 같은 시리즈)"""
    rows = db.q("SELECT match_id, game_start, duration FROM games WHERE is_custom=1 ORDER BY game_start")
    roster = {}
    for r in db.q("SELECT match_id, puuid FROM game_players WHERE match_id IN (SELECT match_id FROM games WHERE is_custom=1)"):
        roster.setdefault(r["match_id"], set()).add(r["puuid"])
    open_series = {}   # roster key → (series_id, last_end, idx)
    for r in rows:
        key = "|".join(sorted(roster.get(r["match_id"], [])))
        last = open_series.get(key)
        start = r["game_start"]
        if last and start - last[1] <= gap_h * 3600 * 1000:
            sid, idx = last[0], last[2] + 1
        else:
            sid, idx = hashlib.md5(f"{key}{start}".encode()).hexdigest()[:12], 1
        open_series[key] = (sid, start + (r["duration"] or 0) * 1000, idx)
        db.x("UPDATE games SET series_id=?, series_idx=? WHERE match_id=?", (sid, idx, r["match_id"]))
    db.commit()
