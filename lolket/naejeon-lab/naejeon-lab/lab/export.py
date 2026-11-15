"""학습 결과 → 룽잉닷컴이 읽을 수 있는 JSON (model/latest.json, model/players.json)

선수 전력 점수(score)는 선형 모델을 선수 단위로 쪼갠 값이라 그대로 더하고 뺄 수 있다.

    승률(A팀) = sigmoid( bias + (ΣA팀 score − ΣB팀 score) / 5 )

bias 는 기본 0(진영 모를 때). 블루/레드를 알면 side_bias 를 더한다.
"""
import json
import math
import time
from pathlib import Path

import numpy as np

from .features import ROLES, FEATURE_NAMES, PLAYER_FEATURES, current_profiles

SCHEMA = "naejeon-lab/model@1"


def _norm_id(name, tag):
    return f"{(name or '').strip()}#{(tag or '').strip()}".lower()


def export(db, report, P, hist, state, run_id, out_dir="output", log=print):
    out = Path(out_dir) / "model"
    out.mkdir(parents=True, exist_ok=True)
    f = report["formula"]
    feats = f["features"]
    accounts = [dict(a) for a in db.q("SELECT puuid, game_name, tag_line, source FROM accounts")]
    profiles = current_profiles(db, hist, state, P, accounts)

    # 결측 보정용: 현재 선수들 평균값 (없으면 0 기여)
    pop = {}
    for ft in feats:
        vals = [profiles[a["puuid"]][r][ft["name"]] for a in accounts for r in ROLES
                if not _nan(profiles[a["puuid"]][r][ft["name"]])]
        pop[ft["name"]] = float(np.mean(vals)) if vals else 0.0

    def score(feat_row):
        s, parts = 0.0, {}
        for ft in feats:
            v = feat_row.get(ft["name"])
            v = pop[ft["name"]] if _nan(v) else v
            c = ft["weight"] * (v - pop[ft["name"]]) / ft["std"]     # 평균 선수 = 0점 기준
            parts[ft["name"]] = round(c, 4)
            s += c
        return s, parts

    players = {}
    for a in accounts:
        pr = profiles[a["puuid"]]
        roles = {}
        for r in ROLES:
            s, parts = score(pr[r])
            roles[r] = {"score": round(s, 4), "role_share": _r(pr[r].get("role_share")),
                        "role_wr": _r(pr[r].get("role_wr")), "parts": parts}
        main = max(ROLES, key=lambda r: (pr[r].get("role_share") or 0))
        cs = state.get(a["puuid"], {"elo": 1500.0, "g": 0, "w": 0})
        key = _norm_id(a["game_name"], a["tag_line"])
        players[key] = {
            "name": f"{a['game_name']}#{a['tag_line']}", "puuid": a["puuid"], "source": a["source"],
            "main_role": main, "best_role": max(ROLES, key=lambda r: roles[r]["score"]),
            "tier": _r(pr[main].get("tier")), "custom_elo": round(cs["elo"], 1), "custom_games": cs["g"],
            "custom_wins": cs["w"], "roles": roles,
        }

    # 진영 보정: 학습 데이터 평균 차이가 0이 아닐 수 있어 절편에 흡수된 부분 분리
    side_bias = f["intercept"] - sum(ft["weight"] * ft["mean"] / ft["std"] for ft in feats)
    model = {
        "schema": SCHEMA,
        "version": run_id,
        "trained_at": report["trained_at"],
        "games": report["n_games"],
        "how_to_use": "A팀 승률 = 1/(1+exp(-(bias + (sum(A팀 선수 roles[라인].score) - sum(B팀 ...)) / 5))). "
                      "bias: 진영 모르면 0, A팀이 블루면 side_bias, 레드면 -side_bias. 명단에 없는 선수는 score 0.",
        "side_bias": round(side_bias, 4),
        "players_per_team": 5,
        "formula": f,
        "feature_params": P.to_dict(),
        "feature_docs": {k: v for k, v in PLAYER_FEATURES},
        "metrics": {k: report.get(k) for k in ("cv_linear", "cv_score", "holdout_linear", "holdout_score", "holdout_gbm",
                                               "series_linear", "series_score", "best_cv_logloss")},
        "players_file": "players.json",
        "players_count": len(players),
    }
    (out / "latest.json").write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "players.json").write_text(json.dumps({"schema": SCHEMA, "version": run_id, "players": players},
                                                 ensure_ascii=False), encoding="utf-8")
    log(f"내보내기 완료: {out / 'latest.json'} · 선수 {len(players)}명")
    return model


def _nan(v):
    return v is None or (isinstance(v, float) and math.isnan(v))


def _r(v, d=4):
    return None if _nan(v) else round(float(v), d)
