"""데이터 수집기 (이어받기 가능)

순서
  1) seed      : 멤버 Riot ID 목록 → puuid
  2) ids       : 계정별 매치 ID를 과거로 끝까지 훑음
                 - 내전(커스텀): deeplol API (Riot API는 일반 커스텀 기록을 주지 않음)
                 - 랭크(솔랭·자랭): Riot API
  3) details   : 매치 상세 수집. 커스텀 게임(내전)에서 같이 뛴 사람은 자동으로 수집 대상에 추가(설정)
  4) league    : 티어 스냅샷 (하루 1번)

언제 끊어도(Ctrl+C, 키 만료, PC 종료) 다시 실행하면 이어서 진행한다.
"""
import json
import time
from datetime import datetime

from .db import DB, now_ms
from .riot import Riot
from .deeplol import DeepLol, to_riot, riot_id_key

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


def is_custom_5v5(info):
    """내전(사용자 설정 5:5 소환사의 협곡) 판정"""
    return (
        info.get("queueId") == 0
        and info.get("gameType") in ("CUSTOM_GAME", "CUSTOM")
        and info.get("mapId") == 11
        and len(info.get("participants", [])) == 10
    )


class Collector:
    def __init__(self, cfg, log=print):
        self.cfg = cfg
        self.log = log
        self.db = DB(cfg["db_path"])
        self.riot = Riot(cfg.get("env_path", ".env"), log=log)
        c = cfg.get("collect", {})
        self.days = int(c.get("days", 365))                 # 0 = 끝까지(가능한 모든 기록)
        self.queues = [q for q in (c.get("queues") or [420, 440]) if q != 0]   # Riot 에서 받을 큐 (420=솔랭, 440=자랭)
        self.custom_source = c.get("custom_source", "deeplol")             # 내전 출처: deeplol | riot | none
        if self.custom_source == "riot":
            self.queues = [0] + self.queues
        self.dl = DeepLol(interval_s=float(c.get("deeplol_interval_s", 0.4)), log=log)
        sid = c.get("deeplol_server_ids", [156])
        self.dl_servers = sid if isinstance(sid, list) else [sid]
        self._roster = None
        self.discover = bool(c.get("discover_custom_coplayers", True))
        self.discover_min_games = int(c.get("discover_min_custom_games", 1))
        self.league_every_ms = int(c.get("league_snapshot_hours", 24)) * 3600 * 1000

    # ── deeplol ↔ Riot 계정 연결 ────────────────────────────
    # deeplol 은 puuid 를 자기 API 키로 암호화해서 주기 때문에 내 Riot 키의 puuid 와 값이 다르다.
    # → deeplol 커뮤니티 멤버 목록(닉네임#태그 + deeplol puuid)으로 연결한다.
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

    def dl_puuid_for(self, name, tag):
        return self.roster().get(riot_id_key(name, tag))

    def _names_seen(self, dl_puuid):
        """이 사람(deeplol puuid)이 내전에서 쓴 닉네임#태그 — 최신 경기 순"""
        seen = []
        for (js,) in self.db.conn.execute("SELECT json FROM matches_raw WHERE status=200 AND json LIKE ?", (f"%{dl_puuid}%",)):
            try:
                info = json.loads(js)["info"]
            except Exception:
                continue
            for p in info.get("participants", []):
                if p.get("deeplolPuuid") == dl_puuid:
                    seen.append((info.get("gameStartTimestamp", 0), p.get("riotIdGameName"), p.get("riotIdTagline")))
        seen.sort(reverse=True)
        return [(n, t) for _, n, t in seen]

    def riot_puuid_for_dl(self, dl_puuid, name=None, tag=None, retry=False):
        """deeplol 참가자 → 내 키 Riot puuid.

        사람 구분은 puuid 로 한다(닉네임이 바뀌어도 deeplol puuid 는 그대로).
        닉네임#태그는 두 puuid 를 처음 한 번 이어줄 때만 쓰고, 이후엔 puuid 로 캐시된 연결을 쓴다.
        이어줄 때는 최신 닉네임부터 시도: deeplol 커뮤니티 목록의 현재 닉네임 → 이 경기의 닉네임 → 예전 경기의 닉네임.
        끝까지 못 찾으면 'dl:<deeplol puuid>' (같은 사람끼리는 계속 같은 ID라 내전 기록은 정상 집계됨).
        """
        r = self.db.one("SELECT riot_puuid FROM puuid_map WHERE dl_puuid=?", (dl_puuid,))
        if r and (r["riot_puuid"] or not retry):
            return r["riot_puuid"] or "dl:" + dl_puuid
        a = self.db.one("SELECT puuid, game_name, tag_line FROM accounts WHERE dl_puuid=? AND puuid NOT LIKE 'dl:%'", (dl_puuid,))
        if a:
            self.db.x("INSERT OR REPLACE INTO puuid_map VALUES(?,?,?,?,?)", (dl_puuid, a["puuid"], a["game_name"], a["tag_line"], 200))
            return a["puuid"]
        self.roster()
        cands = []
        for c in [self._roster_names.get(dl_puuid), (name, tag)] + (self._names_seen(dl_puuid) if retry else []):
            if c and c[0] and c[1] and riot_id_key(*c) not in {riot_id_key(*x) for x in cands}:
                cands.append(c)
        st, rp, used = 0, None, (name, tag)
        for n, t in cands[:4]:
            st, acc = self.riot.account_by_riot_id(n, t)
            if st == 200 and acc and acc.get("puuid"):
                rp, used = acc["puuid"], (acc.get("gameName"), acc.get("tagLine"))
                break
        self.db.x("INSERT OR REPLACE INTO puuid_map VALUES(?,?,?,?,?)", (dl_puuid, rp, used[0], used[1], st))
        return rp or "dl:" + dl_puuid

    def retry_unmapped(self):
        """Riot 계정을 못 찾았던 참가자를 다른(예전/최신) 닉네임으로 다시 시도"""
        rows = self.db.q("SELECT dl_puuid FROM puuid_map WHERE riot_puuid IS NULL")
        if not rows:
            return 0
        fixed = 0
        for r in rows:
            rp = self.riot_puuid_for_dl(r["dl_puuid"], retry=True)
            if not rp.startswith("dl:"):
                fixed += 1
                self._promote_account("dl:" + r["dl_puuid"], rp)
        self.db.commit()
        self.log(f"닉네임 변경 등으로 못 이은 참가자 {len(rows)}명 재시도 → {fixed}명 연결")
        return fixed

    def _promote_account(self, old, rp):
        """Riot 계정을 못 찾아 'dl:' 로 등록했던 멤버가 나중에 연결되면 Riot puuid 로 바꾸고 랭크 수집을 시작"""
        a = self.db.one("SELECT * FROM accounts WHERE puuid=?", (old,))
        if not a:
            return
        if self.db.one("SELECT 1 FROM accounts WHERE puuid=?", (rp,)):
            self.db.x("UPDATE accounts SET dl_puuid=COALESCE(dl_puuid, ?), dl_done=MAX(dl_done, ?) WHERE puuid=?", (a["dl_puuid"], a["dl_done"], rp))
            self.db.x("DELETE FROM accounts WHERE puuid=?", (old,))
        else:
            self.db.x("UPDATE accounts SET puuid=?, ids_done_until=0, backfill_done=0, oldest_scanned=NULL, last_league_at=0 WHERE puuid=?", (rp, old))
        m = self.db.one("SELECT name, tag FROM puuid_map WHERE riot_puuid=?", (rp,))
        if m and m["name"]:
            self.db.x("UPDATE accounts SET game_name=?, tag_line=? WHERE puuid=?", (m["name"], m["tag"], rp))
        self.db.x("UPDATE OR IGNORE account_matches SET puuid=? WHERE puuid=?", (rp, old))
        self.db.x("DELETE FROM account_matches WHERE puuid=?", (old,))

    # ── 1) 시드 ──────────────────────────────────────────────
    def seed(self, members_file):
        """members.txt 등록. 한 줄에 한 명:
             deeplol puuid (권장, 닉네임이 바뀌어도 안전) — 'python -m lab members' 로 자동 생성
             또는 닉네임#태그
        """
        lines = [l.strip() for l in open(members_file, encoding="utf-8-sig") if l.strip() and not l.lstrip().startswith("#")]
        total, ok, partial, fail = len(lines), 0, 0, 0
        t0 = time.time()
        self.log(f"멤버 등록 시작: {total}명")
        for i, line in enumerate(lines, 1):
            kind, a1, a2 = parse_member_line(line)
            label = line
            if kind == "dl":
                dlp = a1
                self.roster()
                nn, tt = self._roster_names.get(dlp) or (None, None)   # deeplol 의 현재 닉네임 우선
                if not nn and a2 and "#" in a2:                         # 없으면 줄 뒤 메모의 닉네임#태그
                    nn, tt = [x.strip() for x in a2.split("(")[0].rsplit("#", 1)]
                label = f"{nn}#{tt}" if nn else dlp[:12] + "…"
                ex = self.db.one("SELECT puuid FROM accounts WHERE dl_puuid=?", (dlp,))
                if ex and not ex["puuid"].startswith("dl:"):
                    ok += 1
                    msg = "이미 등록됨"
                else:
                    rp = self.riot_puuid_for_dl(dlp, nn, tt, retry=bool(ex))
                    if rp.startswith("dl:"):
                        partial += 1
                        msg = "⚠️ Riot 계정 못 찾음 → 내전 기록만 수집 (랭크 제외, 나중에 자동 재시도)"
                    else:
                        ok += 1
                        msg = "✅"
                        if ex:
                            self._promote_account(ex["puuid"], rp)
                    self.db.x(
                        "INSERT INTO accounts(puuid, game_name, tag_line, source, added_at, dl_puuid) VALUES(?,?,?,?,?,?) "
                        "ON CONFLICT(puuid) DO UPDATE SET source='seed', dl_puuid=excluded.dl_puuid, "
                        "game_name=COALESCE(excluded.game_name, accounts.game_name), tag_line=COALESCE(excluded.tag_line, accounts.tag_line)",
                        (rp, nn, tt, "seed", now_ms(), dlp))
            elif kind == "id":
                st, acc = self.riot.account_by_riot_id(a1, a2)
                if st != 200 or not acc:
                    fail += 1
                    msg = f"❌ 계정 없음 ({st})"
                else:
                    dlp = self.dl_puuid_for(acc.get("gameName"), acc.get("tagLine")) if self.custom_source == "deeplol" else None
                    self.db.x(
                        "INSERT INTO accounts(puuid, game_name, tag_line, source, added_at, dl_puuid) VALUES(?,?,?,?,?,?) "
                        "ON CONFLICT(puuid) DO UPDATE SET game_name=excluded.game_name, tag_line=excluded.tag_line, source='seed', "
                        "dl_puuid=COALESCE(excluded.dl_puuid, accounts.dl_puuid)",
                        (acc["puuid"], acc.get("gameName"), acc.get("tagLine"), "seed", now_ms(), dlp))
                    if dlp:
                        self.db.x("INSERT OR REPLACE INTO puuid_map VALUES(?,?,?,?,?)", (dlp, acc["puuid"], acc.get("gameName"), acc.get("tagLine"), 200))
                        ok += 1
                        msg = "✅"
                    elif self.custom_source == "deeplol":
                        partial += 1
                        msg = "⚠️ deeplol 커뮤니티 목록에 없음 → 랭크만 수집"
                    else:
                        ok += 1
                        msg = "✅"
            else:
                fail += 1
                msg = "❌ 형식 오류 (deeplol puuid 또는 닉네임#태그)"
            if i % 20 == 0:
                self.db.commit()
            el = time.time() - t0
            eta = el / i * (total - i)
            self.log(f"  [{i}/{total}] {_bar(i / total, 12)} {label} {msg}  (남은 약 {_dur(eta)})")
            _set_title(f"내전 랩 · 멤버 등록 {i}/{total} ({i * 100 // total}%)")
        self.db.commit()
        self.log(f"멤버 등록 완료: 정상 {ok} · 내전만 {partial} · 실패 {fail} (총 {total}) · {_dur(time.time() - t0)}")

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

    # ── 2) 매치 ID ───────────────────────────────────────────
    def _enqueue(self, mid, priority):
        """상세를 아직 안 받은 경기만 대기열에 추가"""
        self.db.x("INSERT OR IGNORE INTO fetch_queue(match_id, priority, added_at) "
                  "SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM matches_raw WHERE match_id=?)",
                  (mid, priority, now_ms(), mid))

    def _queue_priority(self, q):
        return 1 if q == 0 else (3 if q in (420, 440) else 6)

    # priority 0 = deeplol 내전 (상세도 deeplol 에서 받음)
    def _scan_custom_deeplol(self, puuid, dl_puuid, target_start, full):
        """deeplol 내전 ID: 최신부터 내려가며, 이미 아는 ID만 나오는 페이지(증분) 또는 기간 끝(백필)에서 멈춤"""
        offset, added = 0, 0
        while True:
            st, lst = self.dl.custom_ids(dl_puuid, offset=offset, count=20)
            if st != 200 or not lst:
                break
            stop, new_in_page = False, 0
            for it in lst:
                mid = it.get("match_id")
                t = int(it.get("match_creation_time") or 0) * 1000
                if target_start and t and t < target_start:
                    stop = True
                    break
                if not mid:
                    continue
                cur = self.db.conn.execute("INSERT OR IGNORE INTO account_matches(puuid, match_id) VALUES(?,?)", (puuid, mid))
                if cur.rowcount:
                    new_in_page += 1
                self._enqueue(mid, 0)
            added += new_in_page
            self.db.commit()
            if stop or len(lst) < 20 or (not full and new_in_page == 0):
                break
            offset += 20
        return added

    def scan_ids(self, puuid):
        acc = self.db.one("SELECT * FROM accounts WHERE puuid=?", (puuid,))
        now = now_ms()
        target_start = (now - self.days * DAY) if self.days > 0 else None
        added = 0
        self._last_custom = 0
        if self.custom_source == "deeplol":
            dlp = acc["dl_puuid"] or self.dl_puuid_for(acc["game_name"], acc["tag_line"])
            if dlp:
                if not acc["dl_puuid"]:
                    self.db.x("UPDATE accounts SET dl_puuid=? WHERE puuid=?", (dlp, puuid))
                    self.db.x("INSERT OR REPLACE INTO puuid_map VALUES(?,?,?,?,?)", (dlp, puuid, acc["game_name"], acc["tag_line"], 200))
                self._last_custom = self._scan_custom_deeplol(puuid, dlp, target_start, full=not acc["dl_done"])
                added += self._last_custom
                self.db.x("UPDATE accounts SET dl_done=1 WHERE puuid=?", (puuid,))
        queues = (self.queues if self.queues else [None]) if not puuid.startswith("dl:") else []
        for q in queues:
            # (a) 새 경기: 마지막으로 훑은 시각 이후
            since = acc["ids_done_until"] or 0
            if since:
                added += self._page_ids(puuid, q, start_time=since, end_time=None)
            # (b) 과거 백필: 아직 끝까지 안 내려갔으면
            if not acc["backfill_done"]:
                end_time = acc["oldest_scanned"] or now
                added += self._page_ids(puuid, q, start_time=target_start, end_time=end_time, backfill=True)
        self.db.x("UPDATE accounts SET ids_done_until=?, backfill_done=1, oldest_scanned=COALESCE(oldest_scanned, ?) WHERE puuid=?",
                  (now, target_start or 0, puuid))
        self.db.commit()
        return added

    def _page_ids(self, puuid, q, start_time=None, end_time=None, backfill=False):
        start, added = 0, 0
        while True:
            st, ids = self.riot.match_ids(puuid, start=start, count=100, start_time=start_time, end_time=end_time, queue=q)
            if st != 200 or not ids:
                break
            for mid in ids:
                self.db.x("INSERT OR IGNORE INTO account_matches(puuid, match_id) VALUES(?,?)", (puuid, mid))
                self._enqueue(mid, self._queue_priority(q))
                added += 1
            self.db.commit()
            if len(ids) < 100:
                break
            start += 100
            if start >= 10000:   # API 안전장치
                break
        return added

    # ── 3) 매치 상세 ─────────────────────────────────────────
    def fetch_details(self, limit=None, time_budget_s=None):
        t0 = time.time()
        done = 0
        while True:
            rows = self.db.q(
                "SELECT f.match_id, f.priority FROM fetch_queue f LEFT JOIN matches_raw m ON m.match_id=f.match_id "
                "WHERE m.match_id IS NULL ORDER BY f.priority, f.added_at LIMIT 50")
            if not rows:
                break
            for r in rows:
                mid = r["match_id"]
                if r["priority"] == 0:
                    st, raw = self.dl.match(mid)
                    data = to_riot(raw, self.dl.champ_names()) if st == 200 and raw else None
                    if data:
                        for p in data["info"]["participants"]:
                            p["deeplolPuuid"] = p["puuid"]
                            p["puuid"] = self.riot_puuid_for_dl(p["puuid"], p.get("riotIdGameName"), p.get("riotIdTagline"))
                    if st == 200 and data is None:
                        st = 204   # 다시하기·10명 아님 → 학습 제외
                else:
                    st, data = self.riot.match(mid)
                self.db.x("INSERT OR REPLACE INTO matches_raw(match_id, fetched_at, status, json) VALUES(?,?,?,?)",
                          (mid, now_ms(), st, json.dumps(data, ensure_ascii=False) if data else None))
                self.db.x("DELETE FROM fetch_queue WHERE match_id=?", (mid,))
                if st == 200 and data and self.discover and is_custom_5v5(data.get("info", {})):
                    self._discover_from_custom(data)
                done += 1
                if done % 25 == 0:
                    self.db.commit()
                    self._progress(done, t0)
                if limit and done >= limit:
                    self.db.commit()
                    return done
                if time_budget_s and time.time() - t0 > time_budget_s:
                    self.db.commit()
                    return done
            self.db.commit()
        if done and done % 25:
            self._progress(done, t0)
        return done

    def _discover_from_custom(self, data):
        """내전에서 같이 뛴 사람을 수집 대상으로 추가 (커뮤니티 멤버 자동 확장)"""
        for p in data["info"]["participants"]:
            puuid = p.get("puuid")
            if not puuid or puuid == "BOT" or puuid.startswith("dl:"):
                continue
            exists = self.db.one("SELECT 1 FROM accounts WHERE puuid=?", (puuid,))
            if exists:
                continue
            if self.discover_min_games > 1:
                n = self.db.one(
                    "SELECT COUNT(*) c FROM matches_raw WHERE status=200 AND json LIKE ? AND json LIKE '%\"queueId\": 0%'",
                    (f"%{puuid}%",))["c"]
                if n < self.discover_min_games:
                    continue
            self.db.x("INSERT OR IGNORE INTO accounts(puuid, game_name, tag_line, source, added_at, dl_puuid) VALUES(?,?,?,?,?,?)",
                      (puuid, p.get("riotIdGameName"), p.get("riotIdTagline"), "discovered", now_ms(), p.get("deeplolPuuid")))
            self.log(f"  ＋ 내전 참가자 발견: {p.get('riotIdGameName')}#{p.get('riotIdTagline')}")

    def _progress(self, done, t0):
        q = {r["k"]: r["c"] for r in self.db.q(
            "SELECT CASE WHEN priority=0 THEN 'c' ELSE 'r' END k, COUNT(*) c FROM fetch_queue GROUP BY k")}
        left = q.get("c", 0) + q.get("r", 0)
        rate = done / max(1, time.time() - t0)
        frac = done / max(1, done + left)
        eta = left / rate if rate else 0
        self.log(f"  상세 {_bar(frac)} {frac * 100:4.1f}%  받음 {done} · 남음 {left} (내전 {q.get('c', 0)} · 랭크 {q.get('r', 0)}) "
                 f"· {rate * 60:.0f}건/분 · 남은 약 {_dur(eta)}")
        _set_title(f"내전 랩 · 상세 {frac * 100:.0f}% · 남은 {_dur(eta)}")

    def status(self):
        """지금까지 수집 현황"""
        one = lambda q, a=(): self.db.one(q, a)["c"]
        acc = one("SELECT COUNT(*) c FROM accounts")
        seed = one("SELECT COUNT(*) c FROM accounts WHERE source='seed'")
        dlonly = one("SELECT COUNT(*) c FROM accounts WHERE puuid LIKE 'dl:%'")
        dl_done = one("SELECT COUNT(*) c FROM accounts WHERE dl_done=1")
        rk_done = one("SELECT COUNT(*) c FROM accounts WHERE backfill_done=1 AND puuid NOT LIKE 'dl:%'")
        rk_total = acc - dlonly
        customs = one("SELECT COUNT(*) c FROM matches_raw WHERE status=200 AND json LIKE '%\"source\": \"deeplol\"%'")
        allm = one("SELECT COUNT(*) c FROM matches_raw WHERE status=200")
        left = one("SELECT COUNT(*) c FROM fetch_queue")
        self.log("── 수집 현황 ─────────────────────────────")
        self.log(f"  계정      {acc}명 (members.txt {seed} · 내전에서 발견 {acc - seed} · Riot 미연결 {dlonly})")
        self.log(f"  내전 목록 {_bar(dl_done / max(1, acc))} {dl_done}/{acc}명 훑음")
        self.log(f"  랭크 목록 {_bar(rk_done / max(1, rk_total))} {rk_done}/{rk_total}명 훑음")
        self.log(f"  경기 상세 내전 {customs}건 · 랭크 {allm - customs}건 받음 · 대기 {left}건")
        self.log("──────────────────────────────────────────")

    # ── 4) 티어 스냅샷 ───────────────────────────────────────
    def league_snapshots(self):
        now = now_ms()
        rows = self.db.q("SELECT puuid FROM accounts WHERE last_league_at < ? AND puuid NOT LIKE 'dl:%'", (now - self.league_every_ms,))
        if rows:
            self.log(f"티어 스냅샷 {len(rows)}명…")
        for i, r in enumerate(rows, 1):
            if i % 50 == 0:
                self.log(f"  티어 {i}/{len(rows)} {_bar(i / len(rows), 12)}")
                _set_title(f"내전 랩 · 티어 {i}/{len(rows)}")
            st, entries = self.riot.league_by_puuid(r["puuid"])
            if st == 200 and entries is not None:
                for e in entries:
                    self.db.x("INSERT OR REPLACE INTO league_snapshots VALUES(?,?,?,?,?,?,?,?)",
                              (r["puuid"], now, e.get("queueType"), e.get("tier"), e.get("rank"),
                               e.get("leaguePoints"), e.get("wins"), e.get("losses")))
                self.db.x("UPDATE accounts SET last_league_at=? WHERE puuid=?", (now, r["puuid"]))
        self.db.commit()

    # ── 전체 루프 ────────────────────────────────────────────
    def run(self, rounds=None):
        self.status()
        r = 0
        while True:
            r += 1
            accs = self.db.q("SELECT puuid, game_name, tag_line, source FROM accounts ORDER BY source='seed' DESC, added_at")
            n_acc = len(accs)
            self.log(f"[{datetime.now():%H:%M}] 라운드 {r}: 계정 {n_acc}명 경기 목록 확인 (내전=deeplol · 랭크=Riot)")
            t0 = time.time()
            for i, a in enumerate(accs, 1):
                n = self.scan_ids(a["puuid"])
                c = self._last_custom
                el = time.time() - t0
                eta = el / i * (n_acc - i)
                note = f"새 경기 {n} (내전 {c} · 랭크 {n - c})" if n else "새 경기 없음"
                self.log(f"[계정 {i}/{n_acc}] {_bar(i / n_acc, 12)} {i * 100 / n_acc:4.1f}%  {a['game_name']}#{a['tag_line']} — {note}  "
                         f"(경과 {_dur(el)} · 목록 단계 남은 약 {_dur(eta)})")
                _set_title(f"내전 랩 · 라운드 {r} · 계정 {i}/{n_acc} ({i * 100 // n_acc}%)")
                # 내전 상세는 계정마다 바로 받아서 같이 뛴 사람을 빨리 발견
                self.fetch_details(time_budget_s=60)
            self.league_snapshots()
            self.log("남은 경기 상세 수집 중…")
            self.fetch_details()
            if self.custom_source == "deeplol":
                self.retry_unmapped()
            self.status()
            new_accs = self.db.one("SELECT COUNT(*) c FROM accounts WHERE ids_done_until=0")["c"]
            if new_accs == 0 and (rounds is None or r >= rounds):
                break
            self.log(f"새로 추가된 계정 {new_accs}명 → 다음 라운드")
        _set_title("내전 랩 · 수집 완료")
        self.log(f"수집 완료. 호출 Riot {self.riot.calls}회 · deeplol {self.dl.calls}회")

    # ── 점검 ────────────────────────────────────────────────
    def doctor(self, riot_id):
        """키 정상 여부 + Riot이 이 계정의 커스텀 게임을 주는지 확인"""
        self.log("1) API 키 확인…")
        name, tag = riot_id.rsplit("#", 1)
        st, acc = self.riot.account_by_riot_id(name, tag)
        if st != 200:
            self.log(f"   ❌ 계정 조회 실패 ({st}). 키 또는 Riot ID 확인")
            return
        self.log(f"   ✅ {acc['gameName']}#{acc['tagLine']}")
        self.log("2) 내전 기록 (deeplol) 확인…")
        dlp = self.dl_puuid_for(acc["gameName"], acc["tagLine"])
        if not dlp:
            self.log(f"   ⚠️ deeplol 커뮤니티 {self.dl_servers} 멤버 목록에서 {acc['gameName']}#{acc['tagLine']} 을 못 찾았습니다.\n"
                     "      → config.yaml 의 collect.deeplol_server_ids 확인 (롤하냥 = 156)")
            return
        self.log(f"   deeplol 계정 연결 ✅")
        st, lst = self.dl.custom_ids(dlp, count=20)
        self.log(f"   결과 {st}, 최근 내전 {len(lst)}개")
        shown = 0
        for it in lst[:3]:
            st2, raw = self.dl.match(it["match_id"])
            m = to_riot(raw, self.dl.champ_names()) if st2 == 200 and raw else None
            if m:
                info = m["info"]
                when = datetime.fromtimestamp(info["gameStartTimestamp"] / 1000)
                me = next((p for p in info["participants"] if p["puuid"] == dlp), {})
                self.log(f"   {it['match_id']} {when:%Y-%m-%d %H:%M} {info.get('tournamentName') or ''} "
                         f"{me.get('teamPosition')} {me.get('championName')} {me.get('kills')}/{me.get('deaths')}/{me.get('assists')} "
                         f"{'승' if me.get('win') else '패'}")
                shown += 1
        if shown:
            self.log("   ✅ deeplol 에서 내전 기록을 받을 수 있습니다 → seed / collect 진행하세요.")
        else:
            self.log("   ⚠️ deeplol 에서 이 계정의 내전 기록을 받지 못했습니다 (내전 기록이 없거나 API 변경/차단).")
        if self.custom_source != "riot":
            return
        self.log("3) Riot 사용자 설정 게임(queue=0) 조회…")
        st, ids = self.riot.match_ids(acc["puuid"], count=20, queue=0)
        self.log(f"   결과 {st}, {len(ids or [])}개")
        found = 0
        for mid in (ids or [])[:5]:
            st2, m = self.riot.match(mid)
            if st2 == 200 and m:
                info = m["info"]
                c = is_custom_5v5(info)
                found += c
                when = datetime.fromtimestamp(info.get("gameStartTimestamp", 0) / 1000)
                self.log(f"   {mid} {when:%Y-%m-%d %H:%M} queue={info.get('queueId')} type={info.get('gameType')} "
                         f"인원={len(info.get('participants', []))} → {'내전(5:5 커스텀) ✅' if c else '내전 아님'}")
        if not ids:
            self.log("   ⚠️ Riot이 이 계정의 사용자 설정 게임 기록을 주지 않았습니다.\n"
                     "      → 최근 내전이 없거나, Riot API가 일반 커스텀 게임을 제공하지 않는 경우입니다.\n"
                     "      → 이 경우 '정답' 데이터는 토너먼트 코드로 연 내전이나 룽잉닷컴 내전 결과로 바꿔야 합니다 (docs/ARCHITECTURE.md 참고).")
        elif found:
            self.log(f"   ✅ 커스텀 내전 {found}건 확인 — 이 방식으로 학습 정답을 모을 수 있습니다.")
