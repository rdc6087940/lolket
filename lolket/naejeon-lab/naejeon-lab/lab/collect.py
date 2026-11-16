"""커뮤니티 내전 수집기 (deeplol 전용 · Riot API·솔로랭크 사용 안 함)

  1) seed     : members.txt (deeplol puuid 또는 닉네임#태그) → members
  2) 목록     : 멤버마다 deeplol 커스텀 경기 목록을 과거 끝까지(또는 collect.days 까지) 훑어 member_matches 에 기록
  3) 내전 판정: 10명 전원이 members 에 있는 경기 = 커뮤니티 내전
               (목록 단계에서 '멤버 10명의 목록에 모두 나온 경기'만 상세를 받음 → 쓸데없는 요청 없음)
  4) 상세     : 내전 상세 원본을 통째로 저장(matches_raw) → 상세에서 10명 전원 멤버인지 다시 확인

언제 끊어도 다시 실행하면 이어서 진행한다.
"""
import json
import time
from datetime import datetime

from .db import DB, now_ms
from .deeplol import DeepLol, riot_id_key

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


class Collector:
    def __init__(self, cfg, log=print):
        self.cfg = cfg
        self.log = log
        self.db = DB(cfg["db_path"])
        c = cfg.get("collect", {})
        self.days = int(c.get("days", 0))                                   # 0 = 끝까지
        self.min_members = int(c.get("community_min_members", 10))          # 10명 전원이 멤버여야 내전
        sid = c.get("deeplol_server_ids", [156])
        self.dl_servers = sid if isinstance(sid, list) else [sid]
        self.dl = DeepLol(interval_s=float(c.get("deeplol_interval_s", 0.4)), log=log)
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

    # ── 2) 멤버별 경기 목록 ──────────────────────────────────
    def scan_member(self, puuid):
        """새로 본 경기 수 반환. 처음엔 기간 끝(또는 과거 끝)까지, 이후엔 새 경기만"""
        m = self.db.one("SELECT * FROM members WHERE puuid=?", (puuid,))
        full = not m["scan_done"]
        target_start = (now_ms() - self.days * DAY) if self.days > 0 else None
        offset, added, newest, oldest = 0, 0, m["newest_ms"] or 0, m["oldest_ms"]
        while True:
            st, lst = self.dl.custom_ids(puuid, offset=offset, count=20)
            if st != 200:
                self.log(f"    목록 오류 {st} (offset {offset}) — 다음 실행 때 다시 시도")
                self.db.commit()
                return added
            if not lst:
                break
            stop, new_in_page = False, 0
            for it in lst:
                mid = it.get("match_id")
                t = int(float(it.get("match_creation_time") or 0) * 1000)
                if target_start and t and t < target_start:
                    stop = True
                    break
                if not mid:
                    continue
                cur = self.db.x("INSERT OR IGNORE INTO member_matches(puuid, match_id, t_ms) VALUES(?,?,?)", (puuid, mid, t))
                if cur.rowcount:
                    new_in_page += 1
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

    # ── 3) 내전 후보 = 멤버 10명의 목록에 모두 나온 경기 ──────
    def candidates(self):
        return self.db.q(
            "SELECT mm.match_id, MAX(mm.t_ms) t, COUNT(DISTINCT mm.puuid) c FROM member_matches mm "
            "LEFT JOIN matches_raw r ON r.match_id = mm.match_id WHERE r.match_id IS NULL "
            "GROUP BY mm.match_id HAVING c >= ? ORDER BY t DESC", (self.min_members,))

    # ── 4) 상세 ──────────────────────────────────────────────
    def fetch_details(self):
        todo = self.candidates()
        total = len(todo)
        if not total:
            self.log("받을 내전 상세 없음 (모두 받음)")
            return 0
        champ = self.dl.champ_names()
        if champ:
            self.db.set_meta("champ_names", {str(k): v for k, v in champ.items()})
        members = self.member_set()
        self.log(f"내전 상세 받기: {total}경기")
        t0, ok, skip = time.time(), 0, 0
        for i, r in enumerate(todo, 1):
            mid = r["match_id"]
            st, raw = self.dl.match(mid)
            if st == 200 and raw:
                good = is_community_match(raw, members, self.min_members)
                self.db.x("INSERT OR REPLACE INTO matches_raw VALUES(?,?,?,?)",
                          (mid, now_ms(), 200 if good else 204, json.dumps(raw, ensure_ascii=False)))
                ok += good
                skip += (not good)
            elif st in (400, 404):
                self.db.x("INSERT OR REPLACE INTO matches_raw VALUES(?,?,?,?)", (mid, now_ms(), st, None))
            else:
                self.log(f"  {mid} 상세 오류 {st} — 다음 실행 때 다시 시도")
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
        scanned = one("SELECT COUNT(*) c FROM members WHERE scan_done=1")
        listed = one("SELECT COUNT(DISTINCT match_id) c FROM member_matches")
        cand_all = one("SELECT COUNT(*) c FROM (SELECT match_id FROM member_matches GROUP BY match_id "
                       "HAVING COUNT(DISTINCT puuid) >= ?)", (self.min_members,))
        got = one("SELECT COUNT(*) c FROM matches_raw WHERE status=200")
        excl = one("SELECT COUNT(*) c FROM matches_raw WHERE status<>200")
        left = len(self.candidates())
        self.log("── 수집 현황 ─────────────────────────────")
        self.log(f"  멤버       {mem}명 · 목록 훑음 {_bar(scanned / max(1, mem), 12)} {scanned}/{mem}")
        self.log(f"  경기 목록  멤버 목록에 나온 커스텀 {listed}경기 → 10명 전원 멤버 {cand_all}경기")
        self.log(f"  내전 상세  받음 {got} · 제외 {excl} · 남음 {left}")
        self.log("──────────────────────────────────────────")
        return {"members": mem, "scanned": scanned, "listed": listed, "community": cand_all, "fetched": got, "left": left}

    # ── 전체 실행 ────────────────────────────────────────────
    def run(self, rounds=None):
        self.status()
        mem = self.db.q("SELECT puuid, game_name, tag_line, scan_done FROM members ORDER BY scan_done, added_at")
        n = len(mem)
        if not n:
            self.log("멤버가 없습니다. members.txt 를 넣고 seed 하세요.")
            return
        self.log(f"[{datetime.now():%H:%M}] 1/2 멤버 {n}명의 내전 목록 확인 (deeplol)")
        t0 = time.time()
        for i, m in enumerate(mem, 1):
            added = self.scan_member(m["puuid"])
            el = time.time() - t0
            eta = el / i * (n - i)
            name = f"{m['game_name']}#{m['tag_line']}" if m["game_name"] else m["puuid"][:12] + "…"
            self.log(f"[멤버 {i}/{n}] {_bar(i / n, 12)} {i * 100 / n:5.1f}%  {name} — 새 경기 {added}  "
                     f"(경과 {_dur(el)} · 남은 약 {_dur(eta)} · deeplol {self.dl.calls}회)")
            _set_title(f"내전 랩 · 목록 {i}/{n} ({i * 100 // n}%)")
        self.log(f"[{datetime.now():%H:%M}] 2/2 커뮤니티 내전(10명 전원 멤버) 상세 받기")
        self.fetch_details()
        self.status()
        _set_title("내전 랩 · 수집 완료")
        self.log(f"수집 완료. deeplol 호출 {self.dl.calls}회 → 다음: cycle (정리·학습)")

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
        st, lst = self.dl.custom_ids(dlp, count=20)
        self.log(f"최근 커스텀 경기 목록: 상태 {st}, {len(lst)}개")
        if not lst:
            self.log("⚠️ 이 계정의 커스텀 경기 목록이 비었습니다.")
            return
        mset = self.member_set()
        members = mset or set(self._roster_names)
        src = "members.txt" if mset else "deeplol 커뮤니티 목록"
        for it in lst[:3]:
            st2, raw = self.dl.match(it["match_id"])
            if st2 != 200 or not raw:
                self.log(f"  {it['match_id']} 상세 실패 {st2}")
                continue
            mb = raw.get("match_basic_dict", {})
            ps = raw.get("participants_list", [])
            inside = sum(1 for p in ps if p.get("puu_id") in members)
            me = next((p for p in ps if p.get("puu_id") == dlp), {})
            fs = me.get("final_stat_dict", {})
            when = datetime.fromtimestamp(float(mb.get("creation_timestamp") or 0))
            nev = sum(len([k for k in v if k.isdigit()]) for v in (raw.get("time_analysis") or {}).get("concat_events_dict", {}).values())
            self.log(f"  {it['match_id']} {when:%Y-%m-%d %H:%M} {me.get('position')} 챔피언 {me.get('champion_id')} "
                     f"{fs.get('kills')}/{fs.get('deaths')}/{fs.get('assists')} {'승' if me.get('is_win') else '패'} "
                     f"· 이벤트 {nev}개 · {src} 멤버 {inside}/10 → {'커뮤니티 내전 ✅' if inside >= self.min_members else '제외'}")
        self.log("→ collect.bat 진행하세요.")
