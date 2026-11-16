"""SQLite 저장소 (커뮤니티 내전 전용)

- members        : members.txt 의 커뮤니티 멤버 (deeplol puuid 기준 + 연결된 Riot puuid)
- member_matches : 멤버별 경기 목록 (Riot 토너먼트 목록 + deeplol 커스텀 목록 합집합, 내전 판정용)
- riot_raw       : Riot match-v5 상세 원본 JSON 그대로 (challenges 포함)
- riot_tl        : Riot match-v5 타임라인 원본 JSON (분 단위 골드·CS·경험치, 이벤트)
- matches_raw    : deeplol 경기 상세 원본 JSON 그대로 (경기 당시 티어, AI 점수 — 재가공 가능)
- games / game_players / game_events / game_timeline : build 단계에서 원본으로부터 다시 만드는 분석용 표
"""
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA_VERSION = 3
COMPATIBLE_VERSIONS = (2, 3)   # 2 → 3 은 데이터 그대로 두고 칸만 추가

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
  scanned_at  INTEGER DEFAULT 0,
  riot_puuid  TEXT,                  -- Riot API 키로 본 puuid (deeplol puuid 와 다름)
  riot_status INTEGER DEFAULT 0,     -- 0 아직 · 200 연결됨 · 404 닉네임으로 못 찾음(경기 상세에서 자동 연결 시도)
  riot_scan_done INTEGER DEFAULT 0,
  riot_list_count INTEGER DEFAULT 0,
  riot_scanned_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_matches (
  puuid    TEXT,
  match_id TEXT,
  t_ms     INTEGER,
  src      TEXT DEFAULT 'dl',        -- dl = deeplol 목록 · riot = Riot 토너먼트 목록
  PRIMARY KEY (puuid, match_id)
);
CREATE INDEX IF NOT EXISTS ix_mm_match ON member_matches(match_id);

CREATE TABLE IF NOT EXISTS matches_raw (
  match_id   TEXT PRIMARY KEY,
  fetched_at INTEGER,
  status     INTEGER,             -- 200 정상, 204 다시하기·10명 아님, 그 외 오류
  json       TEXT
);

CREATE TABLE IF NOT EXISTS riot_raw (
  match_id   TEXT PRIMARY KEY,
  fetched_at INTEGER,
  status     INTEGER,             -- 200 커뮤니티 내전, 204 내전 아님(외부인·다시하기·칼바람 등), 404 Riot에 없음
  json       TEXT
);

CREATE TABLE IF NOT EXISTS riot_tl (
  match_id   TEXT PRIMARY KEY,
  fetched_at INTEGER,
  status     INTEGER,
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


# v3 에서 추가된 칸 (예전 DB 에도 자동으로 추가됨)
EXTRA_COLS = {
    "members": {"riot_puuid": "TEXT", "riot_status": "INTEGER DEFAULT 0", "riot_scan_done": "INTEGER DEFAULT 0",
                "riot_list_count": "INTEGER DEFAULT 0", "riot_scanned_at": "INTEGER DEFAULT 0"},
    "member_matches": {"src": "TEXT DEFAULT 'dl'"},
    "games": {"src": "TEXT", "tournament_code": "TEXT", "bans_json": "TEXT",
              "blue_atakhan": "INTEGER", "red_atakhan": "INTEGER", "first_inhib": "TEXT",
              "blue_gold10": "INTEGER", "red_gold10": "INTEGER", "blue_gold15": "INTEGER", "red_gold15": "INTEGER",
              "blue_plates": "INTEGER", "red_plates": "INTEGER", "surrender": "INTEGER"},
    "game_players": {
        "riot_puuid": "TEXT", "vision_score": "REAL", "vspm": "REAL",
        # 타임라인: 10·15분 골드/CS/경험치와 맞라인 상대와의 차이
        "gold10": "INTEGER", "cs10": "INTEGER", "xp10": "INTEGER", "gold15": "INTEGER", "cs15": "INTEGER", "xp15": "INTEGER",
        "gd10": "REAL", "csd10": "REAL", "xpd10": "REAL", "gd15": "REAL", "csd15": "REAL", "xpd15": "REAL",
        # Riot challenges
        "plates": "REAL", "cc_time": "REAL", "ccpm": "REAL", "skill_hit": "REAL", "skill_dodge": "REAL",
        "lane_minions10": "REAL", "jungle_cs10": "REAL", "early_adv": "REAL", "laning_adv": "REAL",
        "max_cs_adv": "REAL", "max_lvl_lead": "REAL", "vision_adv": "REAL", "takedowns_early": "REAL",
        "dmg_mitigated": "REAL", "heal_shield": "REAL", "obj_dmg": "REAL", "turret_dmg": "REAL",
        "dragon_takedowns": "REAL", "herald_takedowns": "REAL", "baron_takedowns": "REAL",
        "pick_kills": "REAL", "save_ally": "REAL", "immobilizations": "REAL", "enemy_jungle": "REAL",
        "time_dead": "REAL", "longest_alive": "REAL", "first_tower": "INTEGER", "dmg_taken_share": "REAL",
        "challenges_json": "TEXT",
    },
}


def _migrate(conn):
    for table, cols in EXTRA_COLS.items():
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for c, typ in cols.items():
            if c not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {c} {typ}")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_members_riot ON members(riot_puuid)")
    # 경기 ID 를 Riot 형식(KR_숫자)으로 통일 (deeplol 목록이 숫자만 줬던 경우)
    for t in ("member_matches", "matches_raw"):
        conn.execute(f"UPDATE OR IGNORE {t} SET match_id='KR_'||match_id WHERE match_id GLOB '[0-9]*'")


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
        return bool(tables) and ver not in COMPATIBLE_VERSIONS
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
        _migrate(self.conn)
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
