"""특징(변수) 생성 — 반드시 '그 경기 시작 전' 기록만 사용 (미래 정보 누수 금지)

선수 1명의 특징(player features)을 만들고, 팀은 평균을 낸 뒤 '블루 − 레드' 차이를 모델 입력으로 쓴다.
선형 모델이면 이 구조 덕분에 선수마다 '전력 점수'가 하나로 떨어져서(가산적), 룽잉닷컴에서
팀 밸런스/승률 계산을 그대로 할 수 있다.
"""
import math
from dataclasses import dataclass, asdict, field

import numpy as np

ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
ROLE_KO = {"TOP": "탑", "JUNGLE": "정글", "MIDDLE": "미드", "BOTTOM": "원딜", "UTILITY": "서폿"}
DAY = 86400 * 1000

# 티어 → 점수 (아이언4=0 … 다이아1=27, 마스터 이상은 LP 반영)
TIER_BASE = {"IRON": 0, "BRONZE": 4, "SILVER": 8, "GOLD": 12, "PLATINUM": 16, "EMERALD": 20, "DIAMOND": 24,
             "MASTER": 28, "GRANDMASTER": 28, "CHALLENGER": 28}
DIV = {"IV": 0, "III": 1, "II": 2, "I": 3}


def tier_score(tier, rank, lp):
    if not tier or tier not in TIER_BASE:
        return None
    if tier in ("MASTER", "GRANDMASTER", "CHALLENGER"):
        return 28 + min(lp or 0, 1500) / 100.0   # 마스터 0LP=28, 100LP마다 +1
    return TIER_BASE[tier] + DIV.get(rank, 0) + (lp or 0) / 100.0


@dataclass
class FeatureParams:
    """학습(최적화) 대상이 되는 특징 생성 파라미터"""
    window_days: int = 365        # 이 기간 기록만 사용
    half_life_days: float = 90.0  # 최근 경기에 가중치 (반감기)
    prior_games: float = 20.0     # 승률을 50%쪽으로 당기는 강도 (표본 적을 때 과대평가 방지)
    recent_n: int = 20            # 최근 폼 경기 수
    elo_k: float = 24.0           # 내전 Elo 변화 폭
    use_snapshot_tier: bool = True

    def to_dict(self):
        return asdict(self)


# 선수 특징 정의 (이름, 설명) — 웹·리포트·LLM 조언에 그대로 쓰임
PLAYER_FEATURES = [
    ("tier", "솔랭 티어 점수 (아이언4=0, 다이아1=27, 마스터부터 100LP당 +1)"),
    ("custom_elo", "내전 Elo (이전 내전 결과로 계산, 시작 1500)"),
    ("custom_wr", "내전 승률 (표본 보정)"),
    ("custom_games", "내전 경험 log(1+판수)"),
    ("wr", "솔랭·자랭 승률 (최근 가중, 표본 보정)"),
    ("role_wr", "이번에 맡은 라인 승률 (최근 가중, 표본 보정)"),
    ("role_share", "이번 라인 플레이 비중 (낮으면 오프 라인)"),
    ("games", "랭크 경험 log(1+판수)"),
    ("form", "최근 N판 승률"),
    ("kda", "KDA (최근 가중)"),
    ("cspm", "분당 CS (라인별)"),
    ("dpm", "분당 챔피언 피해량"),
    ("gpm", "분당 골드"),
    ("vspm", "분당 시야 점수"),
    ("champ_games", "이번 챔피언 숙련 log(1+판수)"),
]
FEATURE_NAMES = [f for f, _ in PLAYER_FEATURES]


class History:
    """선수별 랭크 경기 기록 배열 (시간 정렬)"""

    def __init__(self, db, queues=(420, 440)):
        self.by_player = {}
        qmarks = ",".join("?" * len(queues))
        rows = db.q(
            f"SELECT puuid, game_start, win, role, champion, kills, deaths, assists, cs, gold, dmg, vision, duration "
            f"FROM game_players WHERE queue_id IN ({qmarks}) AND duration > 300 ORDER BY puuid, game_start", tuple(queues))
        cur, buf = None, []
        for r in rows:
            if r["puuid"] != cur:
                if cur:
                    self._store(cur, buf)
                cur, buf = r["puuid"], []
            buf.append(tuple(r))
        if cur:
            self._store(cur, buf)
        # 티어 스냅샷
        self.tiers = {}
        for r in db.q("SELECT puuid, taken_at, tier, rank, lp FROM league_snapshots WHERE queue='RANKED_SOLO_5x5' ORDER BY taken_at"):
            s = tier_score(r["tier"], r["rank"], r["lp"])
            if s is not None:
                self.tiers.setdefault(r["puuid"], []).append((r["taken_at"], s))

    def _store(self, puuid, rows):
        a = np.array([(r[1], r[2], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]) for r in rows], dtype=float)
        self.by_player[puuid] = {
            "t": a[:, 0], "win": a[:, 1], "k": a[:, 2], "d": a[:, 3], "a": a[:, 4], "cs": a[:, 5],
            "gold": a[:, 6], "dmg": a[:, 7], "vis": a[:, 8], "min": np.maximum(a[:, 9] / 60.0, 1.0),
            "role": np.array([r[3] or "" for r in rows]), "champ": np.array([r[4] or "" for r in rows]),
        }

    def tier_at(self, puuid, t):
        snaps = self.tiers.get(puuid)
        if not snaps:
            return None
        before = [s for (ts, s) in snaps if ts <= t]
        return before[-1] if before else snaps[0][1]   # 스냅샷이 경기 이후뿐이면 가장 이른 값 사용


def _shrunk_rate(wins_w, total_w, prior):
    return (wins_w + 0.5 * prior) / (total_w + prior)


def player_features(hist, puuid, t, role, champ, P: FeatureParams, custom_state=None):
    """시각 t 직전까지의 기록으로 선수 특징 계산"""
    f = {}
    cs = (custom_state or {}).get(puuid, {"elo": 1500.0, "g": 0, "w": 0})
    f["custom_elo"] = cs["elo"]
    f["custom_wr"] = _shrunk_rate(cs["w"], cs["g"], P.prior_games)
    f["custom_games"] = math.log1p(cs["g"])
    ts = hist.tier_at(puuid, t) if P.use_snapshot_tier else None
    f["tier"] = ts if ts is not None else np.nan

    h = hist.by_player.get(puuid)
    if h is None or not len(h["t"]):
        for k in ("wr", "role_wr", "role_share", "games", "form", "kda", "cspm", "dpm", "gpm", "vspm", "champ_games"):
            f[k] = np.nan
        f["games"] = 0.0
        return f
    hi = np.searchsorted(h["t"], t, side="left")          # t 이전 경기만
    lo = np.searchsorted(h["t"], t - P.window_days * DAY, side="left")
    sl = slice(lo, hi)
    tt = h["t"][sl]
    if len(tt) == 0:
        for k in ("wr", "role_wr", "role_share", "form", "kda", "cspm", "dpm", "gpm", "vspm", "champ_games"):
            f[k] = np.nan
        f["games"] = 0.0
        return f
    w = np.power(0.5, (t - tt) / (P.half_life_days * DAY))
    win = h["win"][sl]
    roles = h["role"][sl]
    f["wr"] = _shrunk_rate((w * win).sum(), w.sum(), P.prior_games)
    f["games"] = math.log1p(len(tt))
    rm = roles == (role or "")
    f["role_share"] = float(rm.mean()) if role else np.nan
    f["role_wr"] = _shrunk_rate((w * win * rm).sum(), (w * rm).sum(), P.prior_games) if role else np.nan
    n = P.recent_n
    f["form"] = float(win[-n:].mean()) if len(win) else np.nan
    mins = h["min"][sl]
    # 라인 기록이 충분하면 라인 기준, 아니면 전체
    use = rm if (role and rm.sum() >= 10) else np.ones_like(rm, dtype=bool)
    ww = w * use
    sw = ww.sum() or 1.0
    k_, d_, a_ = h["k"][sl], h["d"][sl], h["a"][sl]
    f["kda"] = float((ww * (k_ + a_) / np.maximum(d_, 1)).sum() / sw)
    f["cspm"] = float((ww * h["cs"][sl] / mins).sum() / sw)
    f["dpm"] = float((ww * h["dmg"][sl] / mins).sum() / sw)
    f["gpm"] = float((ww * h["gold"][sl] / mins).sum() / sw)
    f["vspm"] = float((ww * h["vis"][sl] / mins).sum() / sw)
    f["champ_games"] = math.log1p(int((h["champ"][sl] == (champ or "")).sum())) if champ else np.nan
    return f


def build_dataset(db, P: FeatureParams, log=print):
    """내전 1경기 = 1행. X = 블루평균 − 레드평균, y = 블루 승"""
    hist = History(db)
    games = db.q("SELECT match_id, game_start, blue_win, series_id, series_idx FROM games "
                 "WHERE is_custom=1 AND blue_win IS NOT NULL ORDER BY game_start")
    gp = {}
    for r in db.q("SELECT match_id, puuid, team, role, champion, win FROM game_players "
                  "WHERE match_id IN (SELECT match_id FROM games WHERE is_custom=1)"):
        gp.setdefault(r["match_id"], []).append(dict(r))
    state = {}   # 내전 Elo 상태 (시간순으로 갱신)
    X, y, meta, per_player = [], [], [], []
    for g in games:
        ps = gp.get(g["match_id"], [])
        if len(ps) != 10:
            continue
        feats = {}
        for p in ps:
            feats[p["puuid"]] = player_features(hist, p["puuid"], g["game_start"], p["role"], p["champion"], P, state)
        blue = [p for p in ps if p["team"] == 100]
        red = [p for p in ps if p["team"] == 200]
        row = {}
        for fn in FEATURE_NAMES:
            b = np.nanmean([feats[p["puuid"]][fn] for p in blue]) if any(not _isnan(feats[p["puuid"]][fn]) for p in blue) else np.nan
            r = np.nanmean([feats[p["puuid"]][fn] for p in red]) if any(not _isnan(feats[p["puuid"]][fn]) for p in red) else np.nan
            row[fn] = b - r if not (_isnan(b) or _isnan(r)) else np.nan
        X.append([row[fn] for fn in FEATURE_NAMES])
        y.append(g["blue_win"])
        meta.append({"match_id": g["match_id"], "t": g["game_start"], "series_id": g["series_id"],
                     "series_idx": g["series_idx"]})
        for p in ps:
            per_player.append({"match_id": g["match_id"], "puuid": p["puuid"], "team": p["team"], "role": p["role"],
                               "win": p["win"], **{k: feats[p["puuid"]][k] for k in FEATURE_NAMES}})
        # Elo 갱신 (경기 후)
        eb = np.mean([state.get(p["puuid"], {"elo": 1500.0})["elo"] for p in blue])
        er = np.mean([state.get(p["puuid"], {"elo": 1500.0})["elo"] for p in red])
        exp_b = 1 / (1 + 10 ** ((er - eb) / 400))
        res_b = float(g["blue_win"])
        for p in ps:
            s = state.setdefault(p["puuid"], {"elo": 1500.0, "g": 0, "w": 0})
            delta = P.elo_k * ((res_b - exp_b) if p["team"] == 100 else ((1 - res_b) - (1 - exp_b)))
            s["elo"] += delta
            s["g"] += 1
            s["w"] += p["win"]
    log(f"학습 데이터: 내전 {len(y)}경기 · 변수 {len(FEATURE_NAMES)}개")
    return np.array(X, dtype=float), np.array(y, dtype=float), meta, per_player, hist, state


def current_profiles(db, hist, state, P: FeatureParams, accounts):
    """지금 시점 선수별·라인별 특징 (룽잉닷컴 내보내기용)"""
    import time
    now = int(time.time() * 1000)
    out = {}
    for a in accounts:
        roles = {}
        for role in ROLES:
            roles[role] = player_features(hist, a["puuid"], now, role, None, P, state)
        out[a["puuid"]] = roles
    return out


def _isnan(v):
    return v is None or (isinstance(v, float) and math.isnan(v))
