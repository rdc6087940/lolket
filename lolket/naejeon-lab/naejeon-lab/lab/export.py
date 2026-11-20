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
    # 내전 기록이 있는 멤버 (닉네임은 가장 최근 내전 기록의 닉네임)
    accounts = [dict(a) for a in db.q(
        "SELECT p.puuid, p.name game_name, p.tag tag_line, COALESCE(m.source, 'member') source FROM game_players p "
        "JOIN (SELECT puuid, MAX(game_start) t FROM game_players GROUP BY puuid) l ON l.puuid=p.puuid AND l.t=p.game_start "
        "LEFT JOIN members m ON m.puuid=p.puuid GROUP BY p.puuid")]
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

    extra = _custom_extras(db, accounts)

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
            "name": f"{a['game_name']}#{a['tag_line']}", "puuid": a["puuid"], "puuid_source": "deeplol", "source": a["source"],
            "main_role": main, "best_role": max(ROLES, key=lambda r: roles[r]["score"]),
            "tier": _r(pr[main].get("tier")), "custom_elo": round(cs["elo"], 1), "custom_games": cs["g"],
            "custom_wins": cs["w"], "roles": roles,
        }
        ex = extra.get(a["puuid"])
        if ex:
            players[key].update(ex)

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


# ── 룽잉닷컴 표시용: 챔피언 내전 성적 · 팀원 궁합 · 맞라인 상대전적 (전체 내전 기록) ──
#   champs: [[챔피언, 판, 승, 킬합, 데스합, 어시합, 주 라인], ...]  판수 많은 순 최대 CHAMP_MAX 개
#   duo:    [[팀원 키(닉네임#태그 소문자), 같이 한 판, 승], ...]     DUO_MIN 판 이상, 승률 높은/낮은 순 각 DUO_MAX 개
#   vs:     [[맞라인 상대 키, 판, 승], ...]                          VS_MIN 판 이상, 판수 많은 순 VS_MAX 개
#   vs_champ: [[맞라인 상대 챔피언, 판, 승], ...]                    VS_MIN 판 이상, 판수 많은 순 VS_MAX 개
#   recent: [[시각(ms), 라인, 챔피언, 승(1/0), 킬, 데스, 어시], ...]  최근 RECENT_MAX 판
CHAMP_MAX, DUO_MIN, DUO_MAX, VS_MIN, VS_MAX, RECENT_MAX = 15, 3, 6, 2, 10, 10


def _custom_extras(db, accounts):
    want = {a["puuid"] for a in accounts}
    keyof = {a["puuid"]: _norm_id(a["game_name"], a["tag_line"]) for a in accounts}
    rows = db.q("SELECT match_id, puuid, game_start, team, role, win, champion, kills, deaths, assists "
                "FROM game_players ORDER BY game_start")
    by_match = {}
    for r in rows:
        by_match.setdefault(r[0], []).append(r)
    champ, duo, vs, vsc, recent = {}, {}, {}, {}, {}
    for mid, ps in by_match.items():
        for (_, pu, t, team, role, win, ch, k, d, a) in ps:
            if pu not in want:
                continue
            w = 1 if win else 0
            c = champ.setdefault(pu, {}).setdefault(ch or "?", [0, 0, 0, 0, 0, {}])
            c[0] += 1; c[1] += w; c[2] += k or 0; c[3] += d or 0; c[4] += a or 0
            c[5][role] = c[5].get(role, 0) + 1
            recent.setdefault(pu, []).append([int(t or 0), role, ch, w, k or 0, d or 0, a or 0])
            for (_, pu2, _t, team2, role2, _w, ch2, *_r) in ps:
                if pu2 == pu or not pu2:
                    continue
                if team2 == team:
                    x = duo.setdefault(pu, {}).setdefault(pu2, [0, 0]); x[0] += 1; x[1] += w
                elif role and role2 == role:
                    x = vs.setdefault(pu, {}).setdefault(pu2, [0, 0]); x[0] += 1; x[1] += w
                    if ch2:
                        x = vsc.setdefault(pu, {}).setdefault(ch2, [0, 0]); x[0] += 1; x[1] += w
    # 상대 키: 명단에 있으면 닉네임#태그, 없으면 그 경기 기록의 닉네임
    names = {r[0]: _norm_id(r[1], r[2]) for r in db.q(
        "SELECT p.puuid, p.name, p.tag FROM game_players p JOIN (SELECT puuid, MAX(game_start) t FROM game_players GROUP BY puuid) l "
        "ON l.puuid=p.puuid AND l.t=p.game_start GROUP BY p.puuid")}
    names.update(keyof)
    out = {}
    for pu in want:
        e = {}
        cm = champ.get(pu)
        if cm:
            lst = sorted(cm.items(), key=lambda kv: (-kv[1][0], -kv[1][1]))[:CHAMP_MAX]
            e["champs"] = [[ch, v[0], v[1], v[2], v[3], v[4], max(v[5], key=v[5].get) if v[5] else None] for ch, v in lst]
        dm = duo.get(pu)
        if dm:
            ok = [(names.get(p2, p2), g, w) for p2, (g, w) in dm.items() if g >= DUO_MIN]
            best = sorted(ok, key=lambda x: (-(x[2] / x[1]), -x[1]))[:DUO_MAX]
            worst = sorted(ok, key=lambda x: ((x[2] / x[1]), -x[1]))[:DUO_MAX]
            seen, lst = set(), []
            for x in best + worst:
                if x[0] not in seen:
                    seen.add(x[0]); lst.append(list(x))
            if lst:
                e["duo"] = lst
        vm = vs.get(pu)
        if vm:
            lst = sorted(((names.get(p2, p2), g, w) for p2, (g, w) in vm.items() if g >= VS_MIN), key=lambda x: -x[1])[:VS_MAX]
            if lst:
                e["vs"] = [list(x) for x in lst]
        vc = vsc.get(pu)
        if vc:
            lst = sorted(((c2, g, w) for c2, (g, w) in vc.items() if g >= VS_MIN), key=lambda x: -x[1])[:VS_MAX]
            if lst:
                e["vs_champ"] = [list(x) for x in lst]
        rc = recent.get(pu)
        if rc:
            e["recent"] = rc[-RECENT_MAX:][::-1]
        if e:
            out[pu] = e
    return out


def _nan(v):
    return v is None or (isinstance(v, float) and math.isnan(v))


def _r(v, d=4):
    return None if _nan(v) else round(float(v), d)
