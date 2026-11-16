"""특징(변수) 생성 — 커뮤니티 내전 기록만, 반드시 '그 경기 시작 전' 기록만 사용 (미래 정보 누수 금지)

솔로랭크 기록은 쓰지 않는다. 예외: '경기 당시 티어'는 그 내전 기록에 함께 저장된 값(경기 전에 알 수 있는 값).

선수 1명의 특징을 만들고, 팀은 평균을 낸 뒤 '블루 − 레드' 차이를 모델 입력으로 쓴다.
선형 모델이면 선수마다 '전력 점수'가 하나로 떨어져서(가산적) 룽잉닷컴에서 바로 쓸 수 있다.
"""
import math
from dataclasses import dataclass, asdict

import numpy as np

ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
ROLE_KO = {"TOP": "탑", "JUNGLE": "정글", "MIDDLE": "미드", "BOTTOM": "원딜", "UTILITY": "서폿"}
DAY = 86400 * 1000


@dataclass
class FeatureParams:
    """학습(최적화) 대상이 되는 특징 생성 파라미터"""
    window_days: int = 365        # 이 기간 기록만 사용
    half_life_days: float = 90.0  # 최근 경기에 가중치 (반감기)
    prior_games: float = 20.0     # 승률을 50%쪽으로 당기는 강도 (표본 적을 때 과대평가 방지)
    recent_n: int = 20            # 최근 폼 경기 수
    elo_k: float = 24.0           # 내전 Elo 변화 폭
    elo_tier_scale: float = 25.0  # 첫 내전의 Elo 시작값 = 1500 + 이 값 × (경기 당시 티어 점수 − 20)  (신규 선수 냉시작 보정)
    stat_prior: float = 8.0       # 기록이 적은 선수의 지표를 라인 평균 쪽으로 당기는 강도 (판수 n → n/(n+이 값))
    use_snapshot_tier: bool = True  # (호환용, 경기 당시 티어 사용)

    def to_dict(self):
        return asdict(self)


# 선수 특징 정의 (이름, 설명) — 웹·리포트·LLM 조언에 그대로 쓰임
PLAYER_FEATURES = [
    ("tier", "경기 당시 티어 점수 (내전 기록에 저장된 값, 아이언4=0 … 다이아1=27, 마스터 28)"),
    ("elo", "내전 Elo (이전 내전 결과로 계산, 시작값은 첫 경기 티어로 보정)"),
    ("role_elo", "이번 라인 전용 내전 Elo (라인마다 따로, 판수 적을 때 변화 폭 큼)"),
    ("wr", "내전 승률 (최근 가중, 표본 보정)"),
    ("games", "내전 경험 log(1+판수)"),
    ("role_wr", "이번에 맡은 라인의 내전 승률 (최근 가중, 표본 보정)"),
    ("role_share", "이번 라인 플레이 비중 (낮으면 오프 라인)"),
    ("form", "최근 N판 내전 승률"),
    ("ai", "deeplol AI 점수 평균 (라인 기준)"),
    ("lane_ai", "라인전(15분까지) AI 점수 평균"),
    ("kda", "KDA (라인 기준, 최근 가중)"),
    ("kp", "킬 관여율"),
    ("cspm", "분당 CS"),
    ("dpm", "분당 챔피언 피해량"),
    ("gpm", "분당 골드"),
    ("dtpm", "분당 받은 피해량 (탱킹)"),
    ("vision", "분당 와드 설치·제거·제어와드"),
    ("dmg_share", "팀 내 피해량 비중"),
    ("gold_share", "팀 내 골드 비중"),
    ("early_death", "15분 전 데스 수 (적을수록 안정적)"),
    ("solo_kill", "솔로킬 수"),
    ("obj", "오브젝트·포탑 관여 수"),
    ("champ_games", "이번 챔피언 내전 숙련 log(1+판수)"),
    ("champ_wr", "이번 챔피언 내전 승률 (표본 보정)"),
    ("duo", "이번 팀원들과 같은 팀일 때 승률 (쌍별, 표본 보정, −0.5)"),
    ("lane_vs", "이번 맞라인 상대와의 상대전적 승률 (표본 보정, −0.5)"),
]
FEATURE_NAMES = [f for f, _ in PLAYER_FEATURES]

_STAT_COLS = ["ai_score", "lane_ai", "kda", "kill_part", "cspm", "dpm", "gpm", "dtpm", "vision", "dmg_share",
              "gold_share", "early_deaths", "solo_kills", "obj"]
_STAT_FEAT = {"ai_score": "ai", "lane_ai": "lane_ai", "kda": "kda", "kill_part": "kp", "cspm": "cspm", "dpm": "dpm",
              "gpm": "gpm", "dtpm": "dtpm", "vision": "vision", "dmg_share": "dmg_share", "gold_share": "gold_share",
              "early_deaths": "early_death", "solo_kills": "solo_kill", "obj": "obj"}


class History:
    """선수별 커뮤니티 내전 기록 배열 (시간 정렬)"""

    def __init__(self, db):
        self.by_player = {}
        self.last_tier = {}
        rows = db.q(
            "SELECT puuid, game_start, win, role, champion, tier_score, ai_score, lane_ai, kda, kill_part, cspm, dpm, gpm, "
            "dtpm, vision, dmg_share, gold_share, early_deaths, solo_kills, "
            "(COALESCE(monster_kills,0)+COALESCE(tower_kills,0)+COALESCE(obj_assists,0)) obj "
            "FROM game_players WHERE duration > 300 ORDER BY puuid, game_start")
        cur, buf = None, []
        for r in rows:
            if r["puuid"] != cur:
                if cur:
                    self._store(cur, buf)
                cur, buf = r["puuid"], []
            buf.append(r)
        if cur:
            self._store(cur, buf)
        # 라인별·전체 평균 (표본 적은 선수 보정용 기준값)
        self.role_mean, self.global_mean = {}, {}
        for c in _STAT_COLS:
            vals = {}
            for r in rows:
                if r[c] is not None:
                    vals.setdefault(r["role"] or "", []).append(float(r[c]))
            allv = [v for L in vals.values() for v in L]
            self.global_mean[c] = float(np.mean(allv)) if allv else 0.0
            for role, L in vals.items():
                self.role_mean.setdefault(role, {})[c] = float(np.mean(L))

    def _store(self, puuid, rows):
        def col(k):
            return np.array([np.nan if r[k] is None else float(r[k]) for r in rows], dtype=float)
        h = {"t": col("game_start"), "win": col("win"),
             "role": np.array([r["role"] or "" for r in rows]), "champ": np.array([r["champion"] or "" for r in rows])}
        for c in _STAT_COLS:
            h[c] = col(c)
        self.by_player[puuid] = h
        ts = [r["tier_score"] for r in rows if r["tier_score"] is not None]
        if ts:
            self.last_tier[puuid] = float(ts[-1])


def _shrunk_rate(wins_w, total_w, prior):
    return (wins_w + 0.5 * prior) / (total_w + prior)


def _wmean(w, v):
    m = ~np.isnan(v)
    if not m.any():
        return np.nan
    sw = w[m].sum()
    return float((w[m] * v[m]).sum() / sw) if sw > 0 else np.nan


def player_features(hist, puuid, t, role, champ, P: FeatureParams, state=None, tier=None, mates=(), opp=None):
    """시각 t 직전까지의 커뮤니티 내전 기록으로 선수 특징 계산"""
    st = (state or {}).get(puuid)
    f = {fn: np.nan for fn in FEATURE_NAMES}
    f["elo"] = st["elo"] if st else _elo_init(tier, P)
    re_ = (state or {}).get("__role__", {}).get((puuid, role)) if role else None
    f["role_elo"] = re_["elo"] if re_ else f["elo"]
    f["tier"] = tier if tier is not None else np.nan
    pairs = (state or {}).get("__pairs__", {})
    vs = (state or {}).get("__vs__", {})
    if mates:
        vals = []
        for m in mates:
            w_, g_ = pairs.get(tuple(sorted((puuid, m))), (0, 0))
            vals.append(_shrunk_rate(w_, g_, P.prior_games) - 0.5)
        f["duo"] = float(np.mean(vals))
    if opp:
        w_, g_ = vs.get((puuid, opp), (0, 0))
        f["lane_vs"] = _shrunk_rate(w_, g_, P.prior_games) - 0.5

    h = hist.by_player.get(puuid)
    if h is None:
        f["games"] = 0.0
        return f
    hi = np.searchsorted(h["t"], t, side="left")          # t 이전 경기만
    lo = np.searchsorted(h["t"], t - P.window_days * DAY, side="left")
    if hi <= lo:
        f["games"] = 0.0
        return f
    sl = slice(lo, hi)
    tt = h["t"][sl]
    w = np.power(0.5, (t - tt) / (P.half_life_days * DAY))
    win = h["win"][sl]
    roles = h["role"][sl]
    f["wr"] = _shrunk_rate((w * win).sum(), w.sum(), P.prior_games)
    f["games"] = math.log1p(len(tt))
    f["form"] = float(win[-P.recent_n:].mean())
    if role:
        rm = roles == role
        f["role_share"] = float(rm.mean())
        f["role_wr"] = _shrunk_rate((w * win * rm).sum(), (w * rm).sum(), P.prior_games)
        use = rm if rm.sum() >= 5 else np.ones_like(rm, dtype=bool)   # 라인 기록이 적으면 전체 기록
    else:
        use = np.ones(len(tt), dtype=bool)
    ww = w * use
    n_use = float(use.sum())
    prior_src = hist.role_mean.get(role or "", hist.global_mean) if role else hist.global_mean
    shrink = n_use / (n_use + P.stat_prior) if P.stat_prior > 0 else 1.0
    for c in _STAT_COLS:
        v = _wmean(ww, h[c][sl])
        pv = prior_src.get(c, hist.global_mean.get(c, 0.0))
        f[_STAT_FEAT[c]] = (shrink * v + (1 - shrink) * pv) if not _isnan(v) else pv
    if champ:
        cm = h["champ"][sl] == champ
        f["champ_games"] = math.log1p(int(cm.sum()))
        f["champ_wr"] = _shrunk_rate((w * win * cm).sum(), (w * cm).sum(), P.prior_games)
    return f


def build_dataset(db, P: FeatureParams, log=print):
    """내전 1경기 = 1행. X = 블루평균 − 레드평균, y = 블루 승"""
    hist = History(db)
    games = db.q("SELECT match_id, game_start, blue_win, series_id, series_idx FROM games "
                 "WHERE blue_win IS NOT NULL AND duration > 300 ORDER BY game_start")
    gp = {}
    for r in db.q("SELECT match_id, puuid, team, role, champion, win, tier_score FROM game_players"):
        gp.setdefault(r["match_id"], []).append(dict(r))
    state = {"__pairs__": {}, "__vs__": {}, "__role__": {}}
    X, y, meta, per_player = [], [], [], []
    for g in games:
        ps = gp.get(g["match_id"], [])
        if len(ps) != 10:
            continue
        blue = [p for p in ps if p["team"] == 100]
        red = [p for p in ps if p["team"] == 200]
        opp_of = {}
        for p in blue:
            o = next((q for q in red if q["role"] and q["role"] == p["role"]), None)
            if o:
                opp_of[p["puuid"]], opp_of[o["puuid"]] = o["puuid"], p["puuid"]
        feats = {}
        for p in ps:
            team = blue if p["team"] == 100 else red
            mates = [q["puuid"] for q in team if q["puuid"] != p["puuid"]]
            feats[p["puuid"]] = player_features(hist, p["puuid"], g["game_start"], p["role"], p["champion"], P, state,
                                                tier=p["tier_score"] if P.use_snapshot_tier else None,
                                                mates=mates, opp=opp_of.get(p["puuid"]))
        row = {}
        for fn in FEATURE_NAMES:
            bv = [feats[p["puuid"]][fn] for p in blue if not _isnan(feats[p["puuid"]][fn])]
            rv = [feats[p["puuid"]][fn] for p in red if not _isnan(feats[p["puuid"]][fn])]
            row[fn] = (np.mean(bv) - np.mean(rv)) if (bv and rv) else np.nan
        X.append([row[fn] for fn in FEATURE_NAMES])
        y.append(g["blue_win"])
        meta.append({"match_id": g["match_id"], "t": g["game_start"], "series_id": g["series_id"],
                     "series_idx": g["series_idx"]})
        for p in ps:
            per_player.append({"match_id": g["match_id"], "puuid": p["puuid"], "team": p["team"], "role": p["role"],
                               "win": p["win"], **{k: feats[p["puuid"]][k] for k in FEATURE_NAMES}})
        # 경기 후 상태 갱신: Elo(전체·라인별) · 팀원 쌍 · 맞라인 상대전적
        for p in ps:
            if p["puuid"] not in state:
                state[p["puuid"]] = {"elo": _elo_init(p["tier_score"], P), "g": 0, "w": 0}
            rk = (p["puuid"], p["role"])
            if p["role"] and rk not in state["__role__"]:
                state["__role__"][rk] = {"elo": state[p["puuid"]]["elo"], "g": 0}
        res_b = float(g["blue_win"])
        eb = np.mean([state[p["puuid"]]["elo"] for p in blue])
        er = np.mean([state[p["puuid"]]["elo"] for p in red])
        exp_b = 1 / (1 + 10 ** ((er - eb) / 400))
        rb = np.mean([state["__role__"].get((p["puuid"], p["role"]), state[p["puuid"]])["elo"] for p in blue])
        rr = np.mean([state["__role__"].get((p["puuid"], p["role"]), state[p["puuid"]])["elo"] for p in red])
        rexp_b = 1 / (1 + 10 ** ((rr - rb) / 400))
        for p in ps:
            s = state[p["puuid"]]
            sign = 1 if p["team"] == 100 else -1
            s["elo"] += P.elo_k * sign * (res_b - exp_b)
            s["g"] += 1
            s["w"] += p["win"]
            r_ = state["__role__"].get((p["puuid"], p["role"]))
            if r_ is not None:
                k_eff = P.elo_k * (1 + 2.0 / (1 + r_["g"]))       # 라인 판수가 적을수록 빨리 움직임
                r_["elo"] += k_eff * sign * (res_b - rexp_b)
                r_["g"] += 1
        for team in (blue, red):
            for i in range(len(team)):
                for j in range(i + 1, len(team)):
                    k = tuple(sorted((team[i]["puuid"], team[j]["puuid"])))
                    w_, g_ = state["__pairs__"].get(k, (0, 0))
                    state["__pairs__"][k] = (w_ + team[i]["win"], g_ + 1)
        for a, b in opp_of.items():
            w_, g_ = state["__vs__"].get((a, b), (0, 0))
            win_a = next(p["win"] for p in ps if p["puuid"] == a)
            state["__vs__"][(a, b)] = (w_ + win_a, g_ + 1)
    log(f"학습 데이터: 커뮤니티 내전 {len(y)}경기 · 변수 {len(FEATURE_NAMES)}개")
    return np.array(X, dtype=float), np.array(y, dtype=float), meta, per_player, hist, state


def current_profiles(db, hist, state, P: FeatureParams, accounts):
    """지금 시점 선수별·라인별 특징 (룽잉닷컴 내보내기용). 팀원·상대에 따라 달라지는 duo/lane_vs 는 비움"""
    import time
    now = int(time.time() * 1000)
    out = {}
    for a in accounts:
        pu = a["puuid"]
        h = hist.by_player.get(pu)
        t = now
        # 최근 window_days 동안 내전이 없으면 '마지막 내전 직후' 기준으로 계산 (쉬는 사람도 점수가 비지 않게)
        if h is not None and len(h["t"]) and h["t"][-1] < now - P.window_days * DAY:
            t = int(h["t"][-1]) + 1
        out[pu] = {role: player_features(hist, pu, t, role, None, P, state, tier=hist.last_tier.get(pu))
                   for role in ROLES}
    return out


def _elo_init(tier_score, P):
    if tier_score is None or _isnan(tier_score):
        return 1500.0
    return 1500.0 + P.elo_tier_scale * (float(tier_score) - 20.0)


def _isnan(v):
    return v is None or (isinstance(v, float) and math.isnan(v))
