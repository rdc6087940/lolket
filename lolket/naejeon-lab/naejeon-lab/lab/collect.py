"""커뮤니티 내전 수집기 (Riot API 중심 + deeplol 보조 · 솔로랭크 사용 안 함)

멤버는 members.txt 의 deeplol puuid 그대로 쓴다 (사람 구분 기준). Riot puuid 는 자동으로 연결한다.

  1) seed       : members.txt (deeplol puuid 또는 닉네임#태그) → members
  2) 닉네임     : deeplol 커뮤니티 목록에서 멤버의 '현재' 닉네임#태그 갱신 (닉변 대응)
  3) Riot 연결  : 닉네임#태그 → Riot puuid (account-v1). 못 찾은 사람은 경기 상세에서 챔피언·닉네임으로 자동 연결
  4) Riot 목록  : 멤버마다 Riot 토너먼트 경기 목록(type=tourney)을 과거 끝까지(또는 collect.days 까지)
  5) deeplol 목록: (보조) deeplol 커스텀 목록 — Riot 목록에서 빠진 경기·Riot 미연결 멤버 보완
  6) 내전 판정  : 두 목록 합쳐서 멤버 N명(candidate_min_lists) 이상 나온 경기만 상세 확인
                 → Riot 상세의 10명 전원이 멤버인 경기 = 커뮤니티 내전
  7) 상세       : Riot 상세(challenges 포함) + Riot 타임라인(분 단위 골드·CS·경험치) + deeplol 상세(경기 당시 티어·AI 점수)

언제 끊어도 다시 실행하면 이어서 진행한다. 개발 키가 만료되면 .env 의 키만 바꾸면 자동으로 이어간다.
"""
import json
import time
from datetime import datetime

from .db import DB, now_ms
from .deeplol import DeepLol, riot_id_key, norm_mid
from .riot import Riot

DAY = 86400 * 1000


def _set_title(text):
    """Windows 콘솔 창 제목에 진행률 표시 (다른 OS는 무시)"""
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleTitleW(text)
    except Exception:
        pass


def _bar(frac, width=20):
    frac = max(0.0, min(1.0, frac))
    n = int(round(frac * width))
    return "█" * n + "░" * (width - n)


def _dur(sec):
    sec = int(max(0, sec))
    if sec >= 3600:
        return f"{sec // 3600}시간 {sec % 3600 // 60}분"
    if sec >= 60:
        return f"{sec // 60}분"
    return f"{sec}초"


def parse_member_line(line):
    """members.txt 한 줄 → ('dl', deeplol_puuid, 메모) 또는 ('id', 닉네임, 태그)
    puuid 줄: 'puuid' 또는 'puuid<탭/공백>닉네임#태그(메모)'"""
    tok = line.split(None, 1)
    first = tok[0] if tok else ""
    if len(first) >= 40 and "#" not in first:
        note = tok[1].strip() if len(tok) > 1 else ""
        return ("dl", first, note)
    if "#" in line:
        n, t = line.rsplit("#", 1)
        return ("id", n.strip(), t.strip())
    return (None, line, None)


def is_community_match(raw, member_set, min_members=10):
    """deeplol 상세 원본이 커뮤니티 내전인지: 소환사의 협곡 5:5, 다시하기 아님, min_members 명 이상이 멤버"""
    mb = (raw or {}).get("match_basic_dict") or {}
    ps = (raw or {}).get("participants_list") or []
    if len(ps) != 10 or mb.get("is_remake") or (mb.get("map_id") not in (None, 11)):
        return False
    return sum(1 for p in ps if p.get("puu_id") in member_set) >= min_members


def riot_shape_ok(m):
    """Riot 상세가 소환사의 협곡 5:5 정상 경기인지 (칼바람·다시하기 제외)"""
    info = (m or {}).get("info") or {}
    ps = info.get("participants") or []
    if len(ps) != 10 or info.get("mapId") not in (None, 11):
        return False
    if any(p.get("gameEndedInEarlySurrender") for p in ps):
        return False
    return True


class Collector:
    def __init__(self, cfg, log=print):
        self.cfg = cfg
        self.log = log
        self.db = DB(cfg["db_path"])
        c = cfg.get("collect", {})
        self.days = int(c.get("days", 0))                                   # 0 = 끝까지
        self.min_members = int(c.get("community_min_members", 10))          # 10명 전원이 멤버여야 내전
        self.cand_min = int(c.get("candidate_min_lists", 8))                # 목록에 N명 이상 나온 경기만 상세 확인
        sid = c.get("deeplol_server_ids", [156])
        self.dl_servers = sid if isinstance(sid, list) else [sid]
        self.dl = DeepLol(interval_s=float(c.get("deeplol_interval_s", 0.4)), log=log)
        self.use_riot = bool(c.get("use_riot", True))
        self.riot_type = c.get("riot_list_type", "tourney") or None         # tourney = 토너먼트 코드 게임
        self.riot_queue = c.get("riot_list_queue", None)                    # 예: 3130 (비우면 사용 안 함)
        self.riot_timeline = bool(c.get("riot_timeline", True))
        self.use_dl_list = bool(c.get("use_deeplol_list", True))
        self.dl_detail = bool(c.get("deeplol_detail", True))
        self.riot = Riot(cfg.get("env_path", ".env"), log=log) if self.use_riot else None
        if self.riot and not self.riot.key():
            log("⚠️ .env 에 RIOT_API_KEY 가 없어 deeplol 만으로 수집합니다 (정확도↓). 키를 넣으면 다음 실행부터 Riot 사용")
            self.riot = None
        self._roster = None
        self._roster_names = {}

    # ── deeplol 커뮤니티 멤버 목록 ──────────────────────────
    def roster(self):
        if self._roster is None:
            self._roster, self._roster_names = {}, {}
            for sid in self.dl_servers:
                st, mem = self.dl.server_members(sid)
                self.log(f"  deeplol 커뮤니티 {sid} 멤버 {len(mem)}명 (상태 {st})")
                for m in mem:
                    if m.get("puu_id"):
                        self._roster[riot_id_key(m.get("riot_name"), m.get("riot_tag"))] = m["puu_id"]
                        self._roster_names[m["puu_id"]] = (m.get("riot_name"), m.get("riot_tag"))
        return self._roster

    def member_set(self):
        return {r["puuid"] for r in self.db.q("SELECT puuid FROM members")}

    def write_members(self, out="members.txt", min_games=0):
        """deeplol 커뮤니티 멤버 목록 → members.txt (deeplol puuid + 닉네임 메모, 내전 많이 한 순)"""
        rows = []
        for sid in self.dl_servers:
            st, mem = self.dl.server_members(sid)
            self.log(f"deeplol 커뮤니티 {sid}: 멤버 {len(mem)}명 (상태 {st})")
            rows += mem
        seen, lines = set(), []
        for m in sorted(rows, key=lambda m: -(m.get("cnt") or 0)):
            pu = m.get("puu_id")
            if not pu or pu in seen or (m.get("cnt") or 0) < min_games:
                continue
            seen.add(pu)
            lines.append(f"{pu}\t{m.get('riot_name')}#{m.get('riot_tag')} (내전 {m.get('cnt') or 0}판)")
        if not lines:
            self.log("멤버를 받지 못했습니다. config.yaml 의 collect.deeplol_server_ids 확인")
            return 0
        with open(out, "w", encoding="utf-8") as f:
            f.write("# deeplol puuid<탭>닉네임#태그 (메모) — 닉네임은 참고용, 등록은 puuid 기준\n")
            f.write("\n".join(lines) + "\n")
        self.log(f"{out} 저장: {len(lines)}명" + (f" (내전 {min_games}판 이상)" if min_games else ""))
        return len(lines)

    # ── 1) 멤버 등록 ─────────────────────────────────────────
    def seed(self, members_file):
        lines = [l.strip() for l in open(members_file, encoding="utf-8-sig") if l.strip() and not l.lstrip().startswith("#")]
        total, ok, fail = len(lines), 0, 0
        if any(parse_member_line(l)[0] == "id" for l in lines):
            self.roster()
        self.log(f"멤버 등록: {total}명")
        for i, line in enumerate(lines, 1):
            kind, a1, a2 = parse_member_line(line)
            if kind == "dl":
                nn, tt = None, None
                if a2 and "#" in a2:
                    nn, tt = [x.strip() for x in a2.split("(")[0].rsplit("#", 1)]
                self.db.x("INSERT INTO members(puuid, game_name, tag_line, note, source, added_at) VALUES(?,?,?,?,?,?) "
                          "ON CONFLICT(puuid) DO UPDATE SET game_name=COALESCE(excluded.game_name, members.game_name), "
                          "tag_line=COALESCE(excluded.tag_line, members.tag_line), note=excluded.note",
                          (a1, nn, tt, a2, "seed", now_ms()))
                ok += 1
            elif kind == "id":
                dlp = self._roster.get(riot_id_key(a1, a2))
                if not dlp:
                    fail += 1
                    self.log(f"  ❌ deeplol 커뮤니티 멤버 목록에 없음: {line}")
                    continue
                self.db.x("INSERT INTO members(puuid, game_name, tag_line, source, added_at) VALUES(?,?,?,?,?) "
                          "ON CONFLICT(puuid) DO UPDATE SET game_name=excluded.game_name, tag_line=excluded.tag_line",
                          (dlp, a1, a2, "seed", now_ms()))
                ok += 1
            else:
                fail += 1
                self.log(f"  ❌ 형식 오류 (deeplol puuid 또는 닉네임#태그): {line}")
            if i % 200 == 0:
                self.db.commit()
        self.db.commit()
        n = self.db.one("SELECT COUNT(*) c FROM members")["c"]
        self.log(f"멤버 등록 완료: 정상 {ok} · 실패 {fail} (DB 멤버 {n}명)")

    # ── 2) 현재 닉네임 갱신 (deeplol 커뮤니티 목록) ──────────
    def refresh_names(self):
        self.roster()
        n = 0
        for pu, (nm, tg) in self._roster_names.items():
            if not nm:
                continue
            r = self.db.one("SELECT game_name, tag_line, riot_status FROM members WHERE puuid=?", (pu,))
            if r and (r["game_name"], r["tag_line"]) != (nm, tg):
                # 닉네임이 바뀌었으면 Riot 연결을 못 했던 사람은 다시 시도
                self.db.x("UPDATE members SET game_name=?, tag_line=?, "
                          "riot_status=CASE WHEN riot_status=404 THEN 0 ELSE riot_status END WHERE puuid=?", (nm, tg, pu))
                n += 1
        self.db.commit()
        if n:
            self.log(f"  닉네임 갱신 {n}명")

    # ── 3) Riot puuid 연결 ───────────────────────────────────
    def link_riot(self, dl_puuid, riot_puuid):
        """deeplol 멤버 ↔ Riot puuid 연결 (아직 연결 안 된 경우만)"""
        if not riot_puuid:
            return False
        if self.db.one("SELECT 1 FROM members WHERE riot_puuid=?", (riot_puuid,)):
            return False
        cur = self.db.x("UPDATE members SET riot_puuid=?, riot_status=200 WHERE puuid=? AND riot_puuid IS NULL",
                        (riot_puuid, dl_puuid))
        return bool(cur.rowcount)

    def resolve_riot(self):
        todo = self.db.q("SELECT puuid, game_name, tag_line FROM members "
                         "WHERE riot_puuid IS NULL AND COALESCE(riot_status,0)=0 AND game_name IS NOT NULL")
        total = len(todo)
        if not total:
            return
        self.log(f"  Riot 계정 연결: {total}명")
        ok = miss = 0
        t0 = time.time()
        for i, m in enumerate(todo, 1):
            st, acc = self.riot.account_by_riot_id(m["game_name"], m["tag_line"] or "KR1")
            if st == 200 and acc and acc.get("puuid"):
                if self.link_riot(m["puuid"], acc["puuid"]):
                    ok += 1
                else:
                    self.db.x("UPDATE members SET riot_status=404 WHERE puuid=?", (m["puuid"],))
                    miss += 1
            elif st in (400, 404):
                self.db.x("UPDATE members SET riot_status=404 WHERE puuid=?", (m["puuid"],))
                miss += 1
            if i % 25 == 0 or i == total:
                self.db.commit()
                el = time.time() - t0
                self.log(f"  계정 {_bar(i / total, 12)} {i}/{total} · 연결 {ok} · 못 찾음 {miss} · 남은 약 {_dur(el / i * (total - i))}")
                _set_title(f"내전 랩 · Riot 계정 연결 {i * 100 // total}%")
        self.db.commit()
        if miss:
            self.log(f"  못 찾은 {miss}명은 경기 상세를 받을 때 챔피언·닉네임으로 자동 연결합니다.")

    # ── 4) Riot 토너먼트 경기 목록 ───────────────────────────
    def scan_riot(self, m):
        rp = m["riot_puuid"]
        full = not m["riot_scan_done"]
        start_time = (now_ms() - self.days * DAY) if self.days > 0 else None
        start, added = 0, 0
        while True:
            st, ids = self.riot.match_ids(rp, start=start, count=100, start_time=start_time,
                                          queue=self.riot_queue, type_=self.riot_type)
            if st == 400:
                # 다른 API 키로 만든 puuid (키 종류를 바꾼 경우) → 다시 연결
                self.db.x("UPDATE members SET riot_puuid=NULL, riot_status=0, riot_scan_done=0 WHERE puuid=?", (m["puuid"],))
                self.db.commit()
                return added
            if st != 200 or ids is None:
                self.log(f"    Riot 목록 오류 {st} — 다음 실행 때 다시 시도")
                self.db.commit()
                return added
            if not ids:
                break
            new = 0
            for mid in ids:
                cur = self.db.x("INSERT OR IGNORE INTO member_matches(puuid, match_id, t_ms, src) VALUES(?,?,?,?)",
                                (m["puuid"], mid, 0, "riot"))
                new += cur.rowcount
            added += new
            if len(ids) < 100 or (not full and new == 0):
                break
            start += 100
        cnt = self.db.one("SELECT COUNT(*) c FROM member_matches WHERE puuid=? AND src='riot'", (m["puuid"],))["c"]
        self.db.x("UPDATE members SET riot_scan_done=1, riot_list_count=?, riot_scanned_at=? WHERE puuid=?",
                  (cnt, now_ms(), m["puuid"]))
        self.db.commit()
        return added

    # ── 5) deeplol 커스텀 경기 목록 (보조) ───────────────────
    def scan_member(self, puuid):
        """새로 본 경기 수 반환. 처음엔 기간 끝(또는 과거 끝)까지, 이후엔 새 경기만"""
        m = self.db.one("SELECT * FROM members WHERE puuid=?", (puuid,))
        full = not m["scan_done"]
        target_start = (now_ms() - self.days * DAY) if self.days > 0 else None
        offset, added, newest, oldest = 0, 0, m["newest_ms"] or 0, m["oldest_ms"]
        while True:
            st, lst = self.dl.custom_ids(puuid, offset=offset, count=20)
            if st != 200:
                self.log(f"    deeplol 목록 오류 {st} (offset {offset}) — 다음 실행 때 다시 시도")
                self.db.commit()
                return added
            if not lst:
                break
            stop, new_in_page = False, 0
            for it in lst:
                mid = norm_mid(it.get("match_id"))
                t = int(float(it.get("match_creation_time") or 0) * 1000)
                if target_start and t and t < target_start:
                    stop = True
                    break
                if not mid:
                    continue
                cur = self.db.x("INSERT OR IGNORE INTO member_matches(puuid, match_id, t_ms, src) VALUES(?,?,?,?)",
                                (puuid, mid, t, "dl"))
                if cur.rowcount:
                    new_in_page += 1
                else:
                    self.db.x("UPDATE member_matches SET t_ms=? WHERE puuid=? AND match_id=? AND COALESCE(t_ms,0)=0",
                              (t, puuid, mid))
                newest = max(newest, t)
                oldest = t if oldest is None else min(oldest, t)
            added += new_in_page
            if stop or len(lst) < 20 or (not full and new_in_page == 0):
                break
            offset += 20
        cnt = self.db.one("SELECT COUNT(*) c FROM member_matches WHERE puuid=?", (puuid,))["c"]
        self.db.x("UPDATE members SET scan_done=1, newest_ms=?, oldest_ms=?, list_count=?, scanned_at=? WHERE puuid=?",
                  (newest, oldest, cnt, now_ms(), puuid))
        self.db.commit()
        return added

    # ── 6) 상세 받을 후보 ────────────────────────────────────
    def candidates(self):
        """두 목록 합쳐 멤버 cand_min 명 이상이 나온 경기 중 아직 확정 안 된 것"""
        if self.riot:
            done = ("(COALESCE(r.status, 0) IN (200, 204) OR (COALESCE(r.status, 0) = 404 AND d.match_id IS NOT NULL) "
                    "OR (r.match_id IS NULL AND COALESCE(d.status, 0) = 204))")
        else:
            done = "(d.match_id IS NOT NULL)"
        return self.db.q(
            "SELECT x.match_id, x.t, x.c FROM (SELECT match_id, MAX(t_ms) t, COUNT(DISTINCT puuid) c FROM member_matches "
            "GROUP BY match_id HAVING c >= ?) x "
            "LEFT JOIN riot_raw r ON r.match_id = x.match_id LEFT JOIN matches_raw d ON d.match_id = x.match_id "
            f"WHERE NOT {done} ORDER BY x.match_id DESC", (self.cand_min if self.riot else self.min_members,))

    # ── 7) 상세 ──────────────────────────────────────────────
    def _maps(self):
        rows = self.db.q("SELECT puuid, riot_puuid, game_name, tag_line FROM members")
        riot2dl = {r["riot_puuid"]: r["puuid"] for r in rows if r["riot_puuid"]}
        name2dl = {riot_id_key(r["game_name"], r["tag_line"]): r["puuid"] for r in rows if r["game_name"]}
        return riot2dl, name2dl, {r["puuid"] for r in rows}

    def _dl_raw(self, mid):
        r = self.db.one("SELECT status, json FROM matches_raw WHERE match_id=?", (mid,))
        if r and r["json"]:
            return json.loads(r["json"])
        if r:   # 예전에 실패로 저장됨
            return None
        st, raw = self.dl.match(mid)
        if st == 200 and raw:
            return raw
        if st in (400, 404):
            self.db.x("INSERT OR REPLACE INTO matches_raw VALUES(?,?,?,?)", (mid, now_ms(), st, None))
        return None

    def _process_riot(self, mid, m, maps):
        """Riot 상세 1건 → 커뮤니티 내전이면 True. 멤버 연결도 여기서 보완"""
        riot2dl, name2dl, members = maps
        ps = (m.get("info") or {}).get("participants") or []
        shape = riot_shape_ok(m)
        who = {}
        for p in ps:
            dl = riot2dl.get(p.get("puuid"))
            if not dl:
                dl = name2dl.get(riot_id_key(p.get("riotIdGameName"), p.get("riotIdTagline")))
                if dl and self.link_riot(dl, p.get("puuid")):
                    riot2dl[p["puuid"]] = dl
            who[p.get("puuid")] = dl
        n_in = sum(1 for v in who.values() if v)
        dl_raw = None
        if shape and self.dl_detail and n_in >= self.cand_min:
            dl_raw = self._dl_raw(mid)
            if dl_raw and n_in < self.min_members:
                # deeplol 상세와 챔피언으로 짝지어서 연결 안 된 멤버 찾기
                pair = {(100 if str(q.get("side", "")).upper() == "BLUE" else 200, q.get("champion_id")): q.get("puu_id")
                        for q in dl_raw.get("participants_list") or []}
                for p in ps:
                    if who.get(p.get("puuid")):
                        continue
                    dl = pair.get((p.get("teamId"), p.get("championId")))
                    if dl in members:
                        self.link_riot(dl, p.get("puuid"))
                        riot2dl[p["puuid"]] = dl
                        who[p["puuid"]] = dl
                n_in = sum(1 for v in who.values() if v)
        good = shape and n_in >= self.min_members
        self.db.x("INSERT OR REPLACE INTO riot_raw VALUES(?,?,?,?)",
                  (mid, now_ms(), 200 if good else 204, json.dumps(m, ensure_ascii=False)))
        if good:
            if dl_raw is None and self.dl_detail:
                dl_raw = self._dl_raw(mid)
            if dl_raw is not None and not self.db.one("SELECT 1 FROM matches_raw WHERE match_id=? AND json IS NOT NULL", (mid,)):
                self.db.x("INSERT OR REPLACE INTO matches_raw VALUES(?,?,?,?)",
                          (mid, now_ms(), 200, json.dumps(dl_raw, ensure_ascii=False)))
            if self.riot_timeline and not self.db.one("SELECT 1 FROM riot_tl WHERE match_id=? AND status=200", (mid,)):
                st, tl = self.riot.timeline(mid)
                if st == 200 and tl:
                    self.db.x("INSERT OR REPLACE INTO riot_tl VALUES(?,?,?,?)",
                              (mid, now_ms(), 200, json.dumps(tl, ensure_ascii=False)))
                elif st in (400, 404):
                    self.db.x("INSERT OR REPLACE INTO riot_tl VALUES(?,?,?,?)", (mid, now_ms(), st, None))
        return good

    def _process_dl_only(self, mid, members):
        """Riot 에 없는 경기(또는 Riot 미사용) → deeplol 상세로 판정 (예전 방식)"""
        old = self.db.one("SELECT status, json FROM matches_raw WHERE match_id=?", (mid,))
        if old and old["json"]:
            return old["status"] == 200, True
        st, raw = self.dl.match(mid)
        if st == 200 and raw:
            good = is_community_match(raw, members, self.min_members)
            self.db.x("INSERT OR REPLACE INTO matches_raw VALUES(?,?,?,?)",
                      (mid, now_ms(), 200 if good else 204, json.dumps(raw, ensure_ascii=False)))
            return good, True
        if st in (400, 404):
            self.db.x("INSERT OR REPLACE INTO matches_raw VALUES(?,?,?,?)", (mid, now_ms(), st, None))
            return False, True
        return False, False

    def fetch_details(self):
        todo = self.candidates()
        total = len(todo)
        if not total:
            self.log("받을 내전 상세 없음 (모두 받음)")
            return 0
        champ = self.dl.champ_names()
        if champ:
            self.db.set_meta("champ_names", {str(k): v for k, v in champ.items()})
        maps = self._maps()
        per = (2 if self.riot_timeline else 1) if self.riot else 0
        self.log(f"내전 상세 받기: {total}경기 후보" + (f" (Riot 요청 약 {total * per}회 예상)" if self.riot else ""))
        t0, ok, skip = time.time(), 0, 0
        for i, r in enumerate(todo, 1):
            mid = r["match_id"]
            if self.riot:
                st, m = self.riot.match(mid)
                if st == 200 and m:
                    good = self._process_riot(mid, m, maps)
                elif st == 404:
                    self.db.x("INSERT OR REPLACE INTO riot_raw VALUES(?,?,?,?)", (mid, now_ms(), 404, None))
                    good, _ = self._process_dl_only(mid, maps[2])
                else:
                    self.log(f"  {mid} Riot 상세 오류 {st} — 다음 실행 때 다시 시도")
                    good = False
            else:
                good, _ = self._process_dl_only(mid, maps[2])
            ok += good
            skip += (not good)
            if i % 10 == 0 or i == total:
                self.db.commit()
                el = time.time() - t0
                rate = i / max(1e-6, el)
                eta = (total - i) / rate if rate else 0
                self.log(f"  상세 {_bar(i / total)} {i * 100 / total:5.1f}%  {i}/{total} · 내전 {ok} · 제외 {skip} "
                         f"· {rate * 60:.0f}건/분 · 남은 약 {_dur(eta)}")
                _set_title(f"내전 랩 · 상세 {i * 100 // total}% · 남은 {_dur(eta)}")
        self.db.commit()
        return ok

    # ── 현황 ─────────────────────────────────────────────────
    def status(self):
        one = lambda q, a=(): self.db.one(q, a)["c"]
        mem = one("SELECT COUNT(*) c FROM members")
        linked = one("SELECT COUNT(*) c FROM members WHERE riot_puuid IS NOT NULL")
        rscan = one("SELECT COUNT(*) c FROM members WHERE riot_scan_done=1")
        scanned = one("SELECT COUNT(*) c FROM members WHERE scan_done=1")
        listed = one("SELECT COUNT(DISTINCT match_id) c FROM member_matches")
        l_riot = one("SELECT COUNT(DISTINCT match_id) c FROM member_matches WHERE src='riot'")
        cand_all = one("SELECT COUNT(*) c FROM (SELECT match_id FROM member_matches GROUP BY match_id "
                       "HAVING COUNT(DISTINCT puuid) >= ?)", (self.min_members,))
        r_ok = one("SELECT COUNT(*) c FROM riot_raw WHERE status=200")
        r_tl = one("SELECT COUNT(*) c FROM riot_tl WHERE status=200")
        d_ok = one("SELECT COUNT(*) c FROM matches_raw WHERE status=200")
        total = one("SELECT COUNT(*) c FROM (SELECT match_id FROM riot_raw WHERE status=200 UNION "
                    "SELECT d.match_id FROM matches_raw d LEFT JOIN riot_raw r ON r.match_id=d.match_id "
                    "WHERE d.status=200 AND (r.status IS NULL OR r.status NOT IN (204)))")
        left = len(self.candidates())
        self.log("── 수집 현황 ─────────────────────────────")
        self.log(f"  멤버       {mem}명 · Riot 연결 {_bar(linked / max(1, mem), 12)} {linked}/{mem}")
        self.log(f"  목록       Riot 훑음 {rscan}/{mem} · deeplol 훑음 {scanned}/{mem}")
        self.log(f"  경기 목록  합계 {listed}경기 (Riot 목록 {l_riot}) → 멤버 10명 모두 나온 경기 {cand_all}")
        self.log(f"  내전 상세  커뮤니티 내전 {total}경기 (Riot 상세 {r_ok} · 타임라인 {r_tl} · deeplol 상세 {d_ok}) · 남음 {left}")
        self.log("──────────────────────────────────────────")
        return {"members": mem, "linked": linked, "listed": listed, "community": total, "left": left}

    # ── 전체 실행 ────────────────────────────────────────────
    def run(self, rounds=None):
        self.status()
        steps = (["names", "riot_link", "riot_list"] if self.riot else []) + (["dl_list"] if self.use_dl_list or not self.riot else []) + ["detail"]
        N = len(steps)
        k = 0
        if self.riot:
            k += 1
            self.log(f"[{datetime.now():%H:%M}] {k}/{N} 멤버 현재 닉네임 갱신 (deeplol 커뮤니티 목록)")
            self.refresh_names()
            k += 1
            self.log(f"[{datetime.now():%H:%M}] {k}/{N} Riot 계정 연결")
            self.resolve_riot()
            mem = self.db.q("SELECT * FROM members WHERE riot_puuid IS NOT NULL ORDER BY riot_scan_done, added_at")
            n = len(mem)
            k += 1
            self.log(f"[{datetime.now():%H:%M}] {k}/{N} Riot 토너먼트 경기 목록 ({n}명)")
            t0 = time.time()
            for i, m in enumerate(mem, 1):
                added = self.scan_riot(m)
                el = time.time() - t0
                name = f"{m['game_name']}#{m['tag_line']}" if m["game_name"] else m["puuid"][:12] + "…"
                self.log(f"[Riot 목록 {i}/{n}] {_bar(i / n, 12)} {i * 100 / n:5.1f}%  {name} — 새 경기 {added}  "
                         f"(남은 약 {_dur(el / i * (n - i))} · Riot {self.riot.calls}회)")
                _set_title(f"내전 랩 · Riot 목록 {i}/{n} ({i * 100 // n}%)")
        if "dl_list" in steps:
            mem = self.db.q("SELECT puuid, game_name, tag_line, scan_done FROM members ORDER BY scan_done, added_at")
            n = len(mem)
            if not n:
                self.log("멤버가 없습니다. members.txt 를 넣고 seed 하세요.")
                return
            k += 1
            self.log(f"[{datetime.now():%H:%M}] {k}/{N} deeplol 커스텀 경기 목록 (보조, {n}명)")
            t0 = time.time()
            for i, m in enumerate(mem, 1):
                added = self.scan_member(m["puuid"])
                el = time.time() - t0
                name = f"{m['game_name']}#{m['tag_line']}" if m["game_name"] else m["puuid"][:12] + "…"
                self.log(f"[deeplol 목록 {i}/{n}] {_bar(i / n, 12)} {i * 100 / n:5.1f}%  {name} — 새 경기 {added}  "
                         f"(남은 약 {_dur(el / i * (n - i))} · deeplol {self.dl.calls}회)")
                _set_title(f"내전 랩 · deeplol 목록 {i}/{n} ({i * 100 // n}%)")
        k += 1
        self.log(f"[{datetime.now():%H:%M}] {k}/{N} 커뮤니티 내전(10명 전원 멤버) 상세 받기")
        self.fetch_details()
        self.status()
        _set_title("내전 랩 · 수집 완료")
        self.log(f"수집 완료. Riot {self.riot.calls if self.riot else 0}회 · deeplol {self.dl.calls}회 → 다음: cycle (정리·학습)")

    # ── 점검 ─────────────────────────────────────────────────
    def doctor(self, who):
        self.log(f"deeplol 커뮤니티 {self.dl_servers} 확인…")
        roster = self.roster()
        if not roster:
            self.log("❌ deeplol 커뮤니티 멤버 목록을 받지 못했습니다 (서버 번호 확인 또는 접근 차단).")
            return
        kind, a1, a2 = parse_member_line(who)
        dlp = a1 if kind == "dl" else roster.get(riot_id_key(a1, a2))
        if not dlp:
            self.log(f"❌ 커뮤니티 멤버 목록에서 '{who}' 를 찾지 못했습니다. (닉네임#태그 또는 deeplol puuid)")
            return
        name = self._roster_names.get(dlp, (a1, a2))
        self.log(f"✅ 멤버 확인: {name[0]}#{name[1]}")
        members = self.member_set() or set(self._roster_names)
        if not self.riot:
            self.log("⚠️ Riot API 키 없음 → deeplol 만 점검합니다.")
            st, lst = self.dl.custom_ids(dlp, count=20)
            self.log(f"deeplol 최근 커스텀 경기 목록: 상태 {st}, {len(lst)}개")
            return

        # Riot 계정 / 목록 / 상세 점검
        st, acc = self.riot.account_by_riot_id(name[0], name[1])
        if st != 200 or not acc:
            self.log(f"❌ Riot 계정 조회 실패 (상태 {st}) — 닉네임#태그가 바뀌었을 수 있음")
            return
        rp = acc["puuid"]
        self.log(f"✅ Riot 계정 연결: {acc.get('gameName')}#{acc.get('tagLine')}")
        tests = [("type=tourney", {"type_": "tourney"}), ("queue=3130", {"queue": 3130}), ("필터 없음", {})]
        found = {}
        for label, kw in tests:
            st, ids = self.riot.match_ids(rp, start=0, count=20, **kw)
            found[label] = ids or []
            self.log(f"  Riot 목록 {label:12s}: 상태 {st}, {len(ids or [])}개" + (f" (최근 {ids[0]})" if ids else ""))
        ids = found["type=tourney"] or found["queue=3130"]
        if not ids:
            self.log("❌ Riot 목록에 토너먼트(내전) 경기가 없습니다. → config.yaml 의 collect.use_riot: false 로 두고 deeplol 만 사용하세요.")
            return
        st, lst = self.dl.custom_ids(dlp, count=20)
        dl_ids = {norm_mid(x.get("match_id")) for x in lst}
        both = len(dl_ids & set(ids))
        self.log(f"  deeplol 최근 커스텀 {len(dl_ids)}개 중 Riot 목록에도 있는 경기 {both}개")
        maps = self._maps()
        if not self.db.q("SELECT 1 FROM members LIMIT 1"):
            maps = (maps[0], {k: v for k, v in roster.items()}, set(self._roster_names))
        for mid in ids[:3]:
            st, m = self.riot.match(mid)
            if st != 200 or not m:
                self.log(f"  {mid} Riot 상세 실패 {st}")
                continue
            info = m["info"]
            ps = info["participants"]
            inside = sum(1 for p in ps if maps[0].get(p["puuid"]) or
                         maps[1].get(riot_id_key(p.get("riotIdGameName"), p.get("riotIdTagline"))))
            me = next((p for p in ps if p["puuid"] == rp), {})
            when = datetime.fromtimestamp(info.get("gameCreation", 0) / 1000)
            self.log(f"  {mid} {when:%Y-%m-%d %H:%M} queue {info.get('queueId')} {me.get('teamPosition')} {me.get('championName')} "
                     f"{me.get('kills')}/{me.get('deaths')}/{me.get('assists')} {'승' if me.get('win') else '패'} "
                     f"· challenges {'있음' if me.get('challenges') else '없음'} · 멤버(닉네임 기준) {inside}/10")
        if self.riot_timeline:
            st, tl = self.riot.timeline(ids[0])
            fr = len(((tl or {}).get("info") or {}).get("frames") or [])
            self.log(f"  타임라인: 상태 {st}, {fr}분 분량")
        self.log("→ collect.bat 진행하세요.")
