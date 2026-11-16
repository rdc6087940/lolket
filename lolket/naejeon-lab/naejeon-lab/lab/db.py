"""SQLite 저장소 (커뮤니티 내전 전용)

- members        : members.txt 의 커뮤니티 멤버 (deeplol puuid 기준)
- member_matches : 멤버별 deeplol 커스텀 경기 목록 (내전 판정용: 10명 전원이 멤버인 경기)
- matches_raw    : deeplol 경기 상세 원본 JSON 그대로 (재가공 가능, 아무것도 버리지 않음)
- games / game_players / game_events / game_timeline : build 단계에서 원본으로부터 다시 만드는 분석용 표
"""
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA_VERSION = 2

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS members (
  puuid       TEXT PRIMARY KEY,      -- deeplol puuid
  game_name   TEXT,
  tag_line    TEXT,
  note        TEXT,
  source      TEXT DEFAULT 'seed',
  added_at    INTEGER,
  scan_done   INTEGER DEFAULT 0,     -- 과거 끝까지(또는 기간 끝까지) 한 번 다 훑었는지
  newest_ms   INTEGER DEFAULT 0,     -- 목록에서 본 가장 최근 경기 시각
  oldest_ms   INTEGER,               -- 목록에서 본 가장 오래된 경기 시각
  list_count  INTEGER DEFAULT 0,     -- 목록에서 본 경기 수
  scanned_at  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_matches (
  puuid    TEXT,
  match_id TEXT,
  t_ms     INTEGER,
  PRIMARY KEY (puuid, match_id)
);
CREATE INDEX IF NOT EXISTS ix_mm_match ON member_matches(match_id);

CREATE TABLE IF NOT EXISTS matches_raw (
  match_id   TEXT PRIMARY KEY,
  fetched_at INTEGER,
  status     INTEGER,             -- 200 정상, 204 다시하기·10명 아님, 그 외 오류
  json       TEXT
);

CREATE TABLE IF NOT EXISTS games (
  match_id TEXT PRIMARY KEY,
  game_start INTEGER, duration INTEGER, patch TEXT, blue_win INTEGER,
  tournament TEXT, dl_queue_id INTEGER, avg_tier TEXT, avg_division INTEGER,
  is_custom INTEGER DEFAULT 1,     -- (호환용) 이 DB 의 경기는 모두 커뮤니티 내전
  series_id TEXT, series_idx INTEGER,
  blue_kills INTEGER, red_kills INTEGER,
  first_blood TEXT, first_tower TEXT, first_dragon TEXT, first_herald TEXT, first_baron TEXT, first_grub TEXT,
  blue_dragons INTEGER, red_dragons INTEGER, blue_barons INTEGER, red_barons INTEGER,
  blue_heralds INTEGER, red_heralds INTEGER, blue_grubs INTEGER, red_grubs INTEGER,
  blue_towers INTEGER, red_towers INTEGER, blue_inhibs INTEGER, red_inhibs INTEGER,
  blue_gold INTEGER, red_gold INTEGER,
  blue_ai15 REAL, red_ai15 REAL,   -- 15분 시점 deeplol 팀 평균 점수
  win_rate15 REAL                  -- 15분 시점 deeplol 승률 지표(+면 블루 유리)
);
CREATE INDEX IF NOT EXISTS ix_games_start ON games(game_start);

CREATE TABLE IF NOT EXISTS game_players (
  match_id TEXT, puuid TEXT, game_start INTEGER, duration INTEGER,
  name TEXT, tag TEXT, team INTEGER, role TEXT, win INTEGER,
  champion_id INTEGER, champion TEXT, tier TEXT, division INTEGER, tier_score REAL,
  kills INTEGER, deaths INTEGER, assists INTEGER, kda REAL, kill_part REAL,
  cs INTEGER, cspm REAL, level INTEGER, gold INTEGER, gpm REAL,
  dmg INTEGER, dpm REAL, dmg_total INTEGER, dmg_taken INTEGER, dtpm REAL, dmg_share REAL, gold_share REAL,
  wards_placed INTEGER, wards_killed INTEGER, control_wards INTEGER, vision REAL,
  ai_score REAL, ai_rank INTEGER, mvp INTEGER, ace INTEGER,
  doubles INTEGER, triples INTEGER, quadras INTEGER, pentas INTEGER,
  lane_kills INTEGER, lane_deaths INTEGER, lane_assists INTEGER, lane_cs INTEGER, lane_cspm REAL,
  lane_ai REAL, lane_ai_rank INTEGER, lane_kp REAL, lane_level INTEGER, lane_wards_placed INTEGER, lane_wards_killed INTEGER,
  solo_kills INTEGER, solo_deaths INTEGER, first_blood INTEGER, early_kills INTEGER, early_deaths INTEGER,
  monster_kills INTEGER, tower_kills INTEGER, obj_assists INTEGER,
  spell1 INTEGER, spell2 INTEGER, smite TEXT, rune_primary INTEGER, rune_sub INTEGER, keystone INTEGER,
  skill_first3 TEXT, pings INTEGER, profile_icon INTEGER,
  runes_json TEXT, items_json TEXT, item_build_json TEXT, skill_seq_json TEXT, pings_json TEXT,
  ai_detail_json TEXT,
  PRIMARY KEY (match_id, puuid)
);
CREATE INDEX IF NOT EXISTS ix_gp_puuid ON game_players(puuid, game_start);

CREATE TABLE IF NOT EXISTS game_events (
  match_id TEXT, idx INTEGER, t_s REAL, minute INTEGER, type TEXT,
  actor TEXT, actor_puuid TEXT, side TEXT, target TEXT, target_puuid TEXT,
  assists_json TEXT, x REAL, y REAL, win_rate REAL, win_rate_delta REAL,
  PRIMARY KEY (match_id, idx)
);

CREATE TABLE IF NOT EXISTS game_timeline (
  match_id TEXT, minute INTEGER,
  b_top REAL, b_jun REAL, b_mid REAL, b_bot REAL, b_sup REAL,
  r_top REAL, r_jun REAL, r_mid REAL, r_bot REAL, r_sup REAL,
  b_avg REAL, r_avg REAL, b_obj TEXT, r_obj TEXT,
  PRIMARY KEY (match_id, minute)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
"""


def now_ms():
    return int(time.time() * 1000)


def _old_schema(path):
    """예전(솔랭 수집 버전) DB 인지 확인"""
    if not os.path.exists(path):
        return False
    try:
        c = sqlite3.connect(str(path))
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        ver = None
        if "meta" in tables:
            r = c.execute("SELECT v FROM meta WHERE k='schema_version'").fetchone()
            ver = json.loads(r[0]) if r else None
        c.close()
        return bool(tables) and ver != SCHEMA_VERSION
    except Exception:
        return False


class DB:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        if _old_schema(path):
            # 예전 버전 데이터는 지우지 않고 옆에 보관 → 새로 시작
            bak = str(path).replace(".sqlite", "") + f".old-{time.strftime('%Y%m%d-%H%M%S')}.sqlite"
            for suf in ("", "-wal", "-shm"):
                if os.path.exists(str(path) + suf):
                    os.replace(str(path) + suf, bak + suf)
            print(f"예전 형식의 데이터를 보관하고 새로 시작합니다: {bak}")
        self.conn = sqlite3.connect(str(path), timeout=60, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('schema_version', ?)", (json.dumps(SCHEMA_VERSION),))
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
            return self.conn.execute(sql, args)

    def many(self, sql, rows):
        with self.lock:
            self.conn.executemany(sql, rows)

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
