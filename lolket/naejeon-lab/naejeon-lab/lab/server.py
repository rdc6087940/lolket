"""로컬 조회 서버 — http://127.0.0.1:8787

화면: 지표 / 사용자 / 내전 / 팀뽑 / 모델  (web/index.html)
데이터: SQLite + output/model/*.json + output/runs/<최신>/
"""
import itertools
import json
import math
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .db import DB
from .features import ROLES, ROLE_KO

ROOT = Path(__file__).resolve().parent.parent


def create_app(cfg):
    app = FastAPI(title="내전 분석 랩")
    db = DB(cfg["db_path"])
    out = Path(cfg.get("output_dir", "output"))

    def model():
        p = out / "model" / "latest.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def players_json():
        p = out / "model" / "players.json"
        return json.loads(p.read_text(encoding="utf-8"))["players"] if p.exists() else {}

    def latest_run():
        rid = db.get_meta("latest_run")
        if not rid:
            return None, None, {}
        rd = out / "runs" / rid
        rep = json.loads((rd / "report.json").read_text(encoding="utf-8")) if (rd / "report.json").exists() else None
        preds = {}
        if (rd / "predictions.json").exists():
            preds = {p["match_id"]: p for p in json.loads((rd / "predictions.json").read_text(encoding="utf-8"))}
        return rid, rep, preds

    def names():
        return {r["puuid"]: f"{r['game_name']}#{r['tag_line']}" for r in db.q("SELECT puuid, game_name, tag_line FROM accounts")}

    def custom_players():
        nm = names()
        for r in db.q("SELECT DISTINCT puuid FROM game_players WHERE match_id IN (SELECT match_id FROM games WHERE is_custom=1)"):
            nm.setdefault(r["puuid"], None)
        return nm

    @app.get("/")
    def index():
        return FileResponse(ROOT / "web" / "index.html")

    @app.get("/api/summary")
    def summary():
        rid, rep, preds = latest_run()
        g = db.one("SELECT COUNT(*) n, SUM(blue_win) bw, MIN(game_start) a, MAX(game_start) b FROM games WHERE is_custom=1")
        p = db.one("SELECT COUNT(DISTINCT puuid) n FROM game_players WHERE match_id IN (SELECT match_id FROM games WHERE is_custom=1)")
        acc = db.one("SELECT COUNT(*) n, SUM(source='seed') s FROM accounts")
        raw = db.one("SELECT COUNT(*) n FROM matches_raw WHERE status=200")
        queue = db.one("SELECT COUNT(*) n FROM fetch_queue")
        bins = {}
        balanced = 0
        for pr in preds.values():
            ps = pr.get("p_score")
            if ps is None:
                continue
            fav = max(ps, 1 - ps)
            if fav < 0.6:
                balanced += 1
            b = min(int((fav - 0.5) * 20), 4)  # 50~55,55~60,...,70+
            d = bins.setdefault(b, {"n": 0, "fav_win": 0})
            d["n"] += 1
            d["fav_win"] += int((ps > 0.5) == bool(pr["y"]))
        tiers = {}
        for v in players_json().values():
            t = v.get("tier")
            if t is not None:
                k = _tier_label(t)
                tiers[k] = tiers.get(k, 0) + 1
        return {
            "games": g["n"], "blue_win_rate": (g["bw"] / g["n"]) if g["n"] else None,
            "first": g["a"], "last": g["b"], "players": p["n"], "accounts": acc["n"], "seeds": acc["s"],
            "raw_matches": raw["n"], "queue": queue["n"], "run_id": rid,
            "accuracy": {k: rep.get(k) for k in ("cv_linear", "cv_score", "series_linear", "series_score", "holdout_gbm")} if rep else None,
            "balanced_ratio": (balanced / len(preds)) if preds else None,
            "fav_bins": [{"from": 50 + 5 * k, "n": v["n"], "fav_win": v["fav_win"]} for k, v in sorted(bins.items())],
            "tiers": tiers,
        }

    @app.get("/api/daily")
    def daily(month: str):
        y, m = map(int, month.split("-"))
        a = int(datetime(y, m, 1).timestamp() * 1000)
        b = int(datetime(y + (m == 12), m % 12 + 1, 1).timestamp() * 1000)
        rows = db.q("SELECT game_start FROM games WHERE is_custom=1 AND game_start>=? AND game_start<?", (a, b))
        days = {}
        for r in rows:
            d = datetime.fromtimestamp(r["game_start"] / 1000).day
            days[d] = days.get(d, 0) + 1
        return days

    @app.get("/api/matches")
    def matches(day: str):
        y, m, d = map(int, day.split("-"))
        a = int(datetime(y, m, d).timestamp() * 1000)
        b = a + 86400 * 1000
        _, _, preds = latest_run()
        nm = names()
        gs = db.q("SELECT * FROM games WHERE is_custom=1 AND game_start>=? AND game_start<? ORDER BY game_start", (a, b))
        series = {}
        for g in gs:
            ps = db.q("SELECT * FROM game_players WHERE match_id=?", (g["match_id"],))
            pr = preds.get(g["match_id"], {})
            series.setdefault(g["series_id"] or g["match_id"], []).append({
                "match_id": g["match_id"], "start": g["game_start"], "duration": g["duration"], "patch": g["patch"],
                "blue_win": g["blue_win"], "p_ai": pr.get("p_ai"), "p_score": pr.get("p_score"),
                "players": [{"puuid": p["puuid"], "name": nm.get(p["puuid"]) or p["puuid"][:8], "team": p["team"],
                             "role": p["role"], "champion": p["champion"], "k": p["kills"], "d": p["deaths"], "a": p["assists"]}
                            for p in sorted(ps, key=lambda p: (p["team"], ROLES.index(p["role"]) if p["role"] in ROLES else 9))],
            })
        return [{"series_id": k, "games": v} for k, v in series.items()]

    @app.get("/api/players")
    def players():
        pj = players_json()
        by_puuid = {v["puuid"]: v for v in pj.values()}
        nm = custom_players()
        stats = {r["puuid"]: dict(r) for r in db.q(
            "SELECT puuid, COUNT(*) g, SUM(win) w, MAX(game_start) last FROM game_players "
            "WHERE match_id IN (SELECT match_id FROM games WHERE is_custom=1) GROUP BY puuid")}
        ranked = {r["puuid"]: r["g"] for r in db.q("SELECT puuid, COUNT(*) g FROM game_players WHERE queue_id IN (420,440) GROUP BY puuid")}
        out_ = []
        for puuid, name in nm.items():
            s = stats.get(puuid, {})
            pj_ = by_puuid.get(puuid, {})
            out_.append({"puuid": puuid, "name": name or pj_.get("name") or puuid[:8], "custom_games": s.get("g", 0),
                         "custom_wins": s.get("w", 0), "last": s.get("last"), "ranked_games": ranked.get(puuid, 0),
                         "tier": pj_.get("tier"), "tier_label": _tier_label(pj_.get("tier")) if pj_.get("tier") is not None else None,
                         "elo": pj_.get("custom_elo"), "main_role": pj_.get("main_role"),
                         "score": (pj_.get("roles", {}).get(pj_.get("main_role") or "", {}) or {}).get("score")})
        out_.sort(key=lambda x: -(x["custom_games"] or 0))
        return out_

    @app.get("/api/player/{puuid}")
    def player(puuid: str):
        pj = {v["puuid"]: v for v in players_json().values()}.get(puuid)
        nm = names()
        roles = {r["role"] or "?": dict(r) for r in db.q(
            "SELECT role, COUNT(*) g, SUM(win) w, AVG((kills+assists)*1.0/MAX(deaths,1)) kda, AVG(cs*60.0/MAX(duration,1)) cspm "
            "FROM game_players WHERE puuid=? AND queue_id IN (420,440) AND duration>300 GROUP BY role", (puuid,))}
        champs = [dict(r) for r in db.q(
            "SELECT champion, COUNT(*) g, SUM(win) w, AVG((kills+assists)*1.0/MAX(deaths,1)) kda FROM game_players "
            "WHERE puuid=? AND duration>300 GROUP BY champion ORDER BY g DESC LIMIT 15", (puuid,))]
        monthly = [dict(r) for r in db.q(
            "SELECT strftime('%Y-%m', game_start/1000, 'unixepoch', 'localtime') ym, COUNT(*) g, SUM(win) w, "
            "SUM(queue_id=0) cg FROM game_players WHERE puuid=? GROUP BY ym ORDER BY ym", (puuid,))]
        # 내전 동료 시너지 (같은 팀일 때 승률)
        mates = {}
        for r in db.q(
                "SELECT b.puuid mate, a.win FROM game_players a JOIN game_players b ON a.match_id=b.match_id AND a.team=b.team "
                "AND b.puuid<>a.puuid WHERE a.puuid=? AND a.queue_id=0", (puuid,)):
            d = mates.setdefault(r["mate"], [0, 0])
            d[0] += 1
            d[1] += r["win"]
        mate_list = sorted([{"name": nm.get(k) or k[:8], "g": v[0], "w": v[1]} for k, v in mates.items() if v[0] >= 3],
                           key=lambda x: -x["w"] / x["g"])
        customs = [dict(r) for r in db.q(
            "SELECT g.match_id, g.game_start, p.role, p.champion, p.win, p.kills, p.deaths, p.assists FROM game_players p "
            "JOIN games g ON g.match_id=p.match_id WHERE p.puuid=? AND g.is_custom=1 ORDER BY g.game_start DESC LIMIT 50", (puuid,))]
        return {"puuid": puuid, "name": nm.get(puuid), "model": pj, "roles": roles, "champions": champs,
                "monthly": monthly, "mates_best": mate_list[:5], "mates_worst": mate_list[-5:][::-1], "customs": customs}

    class PredictIn(BaseModel):
        a: list   # [{"name": "닉#태그", "role": "TOP"}] 5명
        b: list
        a_side: str | None = None   # blue | red | None

    def _score(pj, name, role):
        p = pj.get((name or "").strip().lower())
        if not p:
            return 0.0, False
        r = role if role in ROLES else p.get("main_role")
        return (p["roles"].get(r) or {}).get("score", 0.0), True

    @app.post("/api/predict")
    def predict(inp: PredictIn):
        md, pj = model(), players_json()
        if not md:
            raise HTTPException(400, "학습된 모델이 없습니다")
        sa = [_score(pj, x.get("name"), x.get("role")) for x in inp.a]
        sb = [_score(pj, x.get("name"), x.get("role")) for x in inp.b]
        bias = md["side_bias"] if inp.a_side == "blue" else (-md["side_bias"] if inp.a_side == "red" else 0)
        z = bias + (sum(s for s, _ in sa) - sum(s for s, _ in sb)) / 5
        return {"p_a": 1 / (1 + math.exp(-z)), "unknown": [x.get("name") for x, (_, ok) in zip(inp.a + inp.b, sa + sb) if not ok]}

    class BalanceIn(BaseModel):
        players: list  # ["닉#태그", ...] 10명

    @app.post("/api/balance")
    def balance(inp: BalanceIn):
        pj = players_json()
        ps = [x.strip() for x in inp.players if x and x.strip()][:10]
        if len(ps) != 10:
            raise HTTPException(400, "10명이 필요합니다")

        def best_roles(team):
            best = None
            for perm in itertools.permutations(ROLES):
                s = sum(_score(pj, n, r)[0] for n, r in zip(team, perm))
                if best is None or s > best[0]:
                    best = (s, perm)
            return best

        results = []
        for combo in itertools.combinations(range(10), 5):
            if 0 not in combo:
                continue
            a = [ps[i] for i in combo]
            b = [ps[i] for i in range(10) if i not in combo]
            sa, ra = best_roles(a)
            sb, rb = best_roles(b)
            p = 1 / (1 + math.exp(-(sa - sb) / 5))
            results.append({"p_a": p, "a": [{"name": n, "role": r} for n, r in zip(a, ra)],
                            "b": [{"name": n, "role": r} for n, r in zip(b, rb)]})
        results.sort(key=lambda r: abs(r["p_a"] - 0.5))
        return results[:5]

    @app.get("/api/model")
    def model_info():
        rid, rep, _ = latest_run()
        runs = db.get_meta("runs", [])
        adv = None
        if rid and (out / "runs" / rid / "advice.md").exists():
            adv = (out / "runs" / rid / "advice.md").read_text(encoding="utf-8")
        return {"model": model(), "report": rep, "runs": runs[-30:], "advice": adv}

    return app


def _tier_label(score):
    if score is None:
        return None
    names = [("아이언", 0), ("브론즈", 4), ("실버", 8), ("골드", 12), ("플래티넘", 16), ("에메랄드", 20), ("다이아", 24)]
    if score >= 28:
        return "마스터+"
    for n, b in reversed(names):
        if score >= b:
            return f"{n} {4 - int(score - b)}"
    return "아이언 4"


def serve(cfg, host="127.0.0.1", port=8787):
    import uvicorn
    uvicorn.run(create_app(cfg), host=host, port=port, log_level="warning")
