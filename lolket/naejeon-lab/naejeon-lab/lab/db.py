"""SQLite 저장소.

원본(raw) JSON은 그대로 보관하고(재가공 가능), 분석용 테이블은 build 단계에서 다시 만든다.
"""
import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;

-- 수집 대상 계정 (시드 + 커스텀 게임에서 발견된 공동 참가자)
CREATE TABLE IF NOT EXISTS accounts (
  puuid        TEXT PRIMARY KEY,
  game_name    TEXT,
  tag_line     TEXT,
  source       TEXT,            -- seed | discovered
  added_at     INTEGER,
  ids_done_until INTEGER DEFAULT 0,  -- 매치 ID 목록을 이 시각(ms)까지 훑었음
  oldest_scanned INTEGER,            -- 지금까지 내려간 가장 오래된 시각(ms)
  backfill_done INTEGER DEFAULT 0,   -- 목표 기간 끝까지 다 내려갔는지
  last_league_at INTEGER DEFAULT 0
);

-- 계정별 매치 ID (어느 계정 기록에서 나왔는지)
CREATE TABLE IF NOT EXISTS account_matches (
  puuid    TEXT,
  match_id TEXT,
  PRIMARY KEY (puuid, match_id)
);

-- 매치 원본 (match-v5 상세 JSON)
CREATE TABLE IF NOT EXISTS matches_raw (
  match_id   TEXT PRIMARY KEY,
  fetched_at INTEGER,
  status     INTEGER,      -- HTTP 상태 (200 정상, 404 등은 다시 받지 않음)
  json       TEXT
);

-- 매치 상세를 받아야 할 대기열 (우선순위: 커스텀 후보 먼저)
CREATE TABLE IF NOT EXISTS fetch_queue (
  match_id TEXT PRIMARY KEY,
  priority INTEGER DEFAULT 5,
  added_at INTEGER
);

-- 티어 스냅샷 (league-v4는 '현재'만 주므로 수집할 때마다 쌓아서 시계열로 사용)
CREATE TABLE IF NOT EXISTS league_snapshots (
  puuid      TEXT,
  taken_at   INTEGER,
  queue      TEXT,
  tier       TEXT,
  rank       TEXT,
  lp         INTEGER,
  wins       INTEGER,
  losses     INTEGER,
  PRIMARY KEY (puuid, taken_at, queue)
);

-- build 단계 산출물 -------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
  match_id   TEXT PRIMARY KEY,
  game_start INTEGER,
  duration   INTEGER,
  queue_id   INTEGER,
  is_custom  INTEGER,
  patch      TEXT,
  blue_win   INTEGER,
  series_id  TEXT,
  series_idx INTEGER
);

CREATE TABLE IF NOT EXISTS game_players (
  match_id   TEXT,
  puuid      TEXT,
  team       INTEGER,   -- 100 블루 / 200 레드
  role       TEXT,      -- TOP JUNGLE MIDDLE BOTTOM UTILITY
  champion   TEXT,
  win        INTEGER,
  kills INTEGER, deaths INTEGER, assists INTEGER,
  cs INTEGER, gold INTEGER, dmg INTEGER, vision INTEGER,
  game_start INTEGER, duration INTEGER, queue_id INTEGER,
  PRIMARY KEY (match_id, puuid)
);
CREATE INDEX IF NOT EXISTS ix_gp_puuid ON game_players(puuid, game_start);

-- deeplol 은 puuid 를 자기 키로 암호화해서 준다 → Riot(내 키) puuid 와 다름. 둘을 이어주는 표
CREATE TABLE IF NOT EXISTS puuid_map (
  dl_puuid   TEXT PRIMARY KEY,
  riot_puuid TEXT,
  name       TEXT,
  tag        TEXT,
  status     INTEGER          -- 200 성공, 그 외 실패(재시도 안 함)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
"""


def now_ms():
    return int(time.time() * 1000)


class DB:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), timeout=60, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(accounts)")}
        if "dl_puuid" not in cols:
            self.conn.execute("ALTER TABLE accounts ADD COLUMN dl_puuid TEXT")
        if "dl_done" not in cols:
            self.conn.execute("ALTER TABLE accounts ADD COLUMN dl_done INTEGER DEFAULT 0")
        self.conn.commit()

        self.lock = threading.RLock()  # 조회 서버는 여러 스레드에서 같은 연결을 씀

    def q(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def one(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchone()

    def x(self, sql, args=()):
        with self.lock:
            self.conn.execute(sql, args)

    def commit(self):
        with self.lock:
            self.conn.commit()

    # ── meta ─────────────────────────
    def get_meta(self, k, default=None):
        r = self.one("SELECT v FROM meta WHERE k=?", (k,))
        return json.loads(r["v"]) if r else default

    def set_meta(self, k, v):
        self.x("INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)", (k, json.dumps(v, ensure_ascii=False)))
        self.commit()
