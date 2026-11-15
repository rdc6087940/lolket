"""가짜 데이터 생성기 — API 키 없이 학습·화면 동작 확인용

숨은 '실력'을 가진 선수들이 랭크·내전을 했다고 가정하고 match-v5 와 같은 형식의 JSON을 만든다.
(실제 데이터 아님. demo.sqlite / output_demo 에만 저장)
"""
import json
import random
import time

import numpy as np

from .db import DB, now_ms
from .build import build

ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
CHAMPS = {"TOP": ["Aatrox", "Darius", "Ornn", "Renekton", "KSante"], "JUNGLE": ["LeeSin", "Vi", "Hecarim", "Zac", "Viego"],
          "MIDDLE": ["Ahri", "Syndra", "Viktor", "Zoe", "Taliyah"], "BOTTOM": ["Jhin", "Kalista", "Ezreal", "Xayah", "Zeri"],
          "UTILITY": ["Nami", "Lulu", "Rakan", "Braum", "Renata"]}
TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER"]
NAMES = ["룽", "포로", "누룽지", "짱구", "덕냥", "현냥", "밀키", "니집", "꾸팡", "예성", "두부", "주사위", "과거", "소나무", "정민"]


def make_demo(cfg, n_players=60, n_games=1200, log=print, seed=7):
    rng = random.Random(seed)
    np.random.seed(seed)
    import os
    if os.path.exists(cfg["db_path"]):
        os.remove(cfg["db_path"])
    db = DB(cfg["db_path"])
    players = []
    for i in range(n_players):
        skill = np.random.normal(0, 1)
        main = ROLES[i % 5]
        role_skill = {r: skill + (0.6 if r == main else np.random.normal(-0.5, 0.4)) for r in ROLES}
        tier_idx = int(np.clip(round(4.5 + skill * 1.4 + np.random.normal(0, 0.8)), 0, 7))
        p = {"puuid": f"demo-{i:03d}", "name": f"{rng.choice(NAMES)}{i}", "tag": "KR1", "skill": skill,
             "role_skill": role_skill, "main": main, "tier": TIERS[tier_idx], "rank": rng.choice(["I", "II", "III", "IV"]),
             "lp": rng.randint(0, 99) if tier_idx < 7 else rng.randint(0, 900)}
        players.append(p)
        db.x("INSERT INTO accounts(puuid, game_name, tag_line, source, added_at, ids_done_until, backfill_done) VALUES(?,?,?,?,?,?,1)",
             (p["puuid"], p["name"], p["tag"], "seed", now_ms(), now_ms()))
        db.x("INSERT INTO league_snapshots VALUES(?,?,?,?,?,?,?,?)",
             (p["puuid"], now_ms() - 400 * 86400000, "RANKED_SOLO_5x5", p["tier"], p["rank"], p["lp"], 100, 90))
    now = now_ms()
    start = now - 365 * 86400000
    mid = 0

    def participant(p, team, role, win, t):
        perf = p["role_skill"][role]
        return {"puuid": p["puuid"], "riotIdGameName": p["name"], "riotIdTagline": p["tag"], "teamId": team,
                "teamPosition": role, "championName": rng.choice(CHAMPS[role]), "win": win,
                "kills": max(0, int(np.random.normal(5 + perf * 1.5 + (2 if win else 0), 2))),
                "deaths": max(0, int(np.random.normal(5 - perf + (0 if win else 2), 2))),
                "assists": max(0, int(np.random.normal(7 + perf, 3))),
                "totalMinionsKilled": max(0, int(np.random.normal(180 + perf * 20 if role not in ("UTILITY", "JUNGLE") else 40, 20))),
                "neutralMinionsKilled": 120 if role == "JUNGLE" else 0, "goldEarned": int(11000 + perf * 900 + (1500 if win else 0)),
                "totalDamageDealtToChampions": int(18000 + perf * 3000), "visionScore": int(25 + (30 if role == "UTILITY" else 0) + perf * 3)}

    def add_match(ps_roles, t, queue, custom):
        nonlocal mid
        mid += 1
        blue = ps_roles[:5]
        red = ps_roles[5:]
        sb = sum(p["role_skill"][r] for p, r in blue)
        sr = sum(p["role_skill"][r] for p, r in red)
        pb = 1 / (1 + np.exp(-(sb - sr) / 2.2 - 0.08))
        bw = bool(np.random.rand() < pb)
        parts = [participant(p, 100, r, bw, t) for p, r in blue] + [participant(p, 200, r, not bw, t) for p, r in red]
        info = {"gameStartTimestamp": t, "gameDuration": rng.randint(1300, 2200), "queueId": queue,
                "gameType": "CUSTOM_GAME" if custom else "MATCHED_GAME", "mapId": 11, "gameVersion": "15.22.1",
                "participants": parts, "teams": [{"teamId": 100, "win": bool(bw)}, {"teamId": 200, "win": not bw}]}
        m_id = f"KR_DEMO{mid}"
        db.x("INSERT INTO matches_raw VALUES(?,?,?,?)", (m_id, now_ms(), 200, json.dumps({"metadata": {"matchId": m_id}, "info": info})))

    # 랭크 기록 (선수당 ~150판, 상대는 가상의 랜덤 선수)
    ghosts = [{"puuid": f"ghost-{i}", "name": "x", "tag": "x", "role_skill": {r: np.random.normal(0, 1) for r in ROLES}}
              for i in range(40)]
    for p in players:
        for _ in range(150):
            t = rng.randint(start, now)
            role = p["main"] if rng.random() < 0.7 else rng.choice(ROLES)
            others = rng.sample(ghosts, 9)
            roles = [r for r in ROLES if r != role]
            team = [(p, role)] + [(g, r) for g, r in zip(others[:4], roles)]
            opp = [(g, r) for g, r in zip(others[4:], ROLES)]
            add_match(team + opp, t, 420, False)
    # 내전 (같은 10명이 2~3판 시리즈)
    t = start + 30 * 86400000
    made = 0
    while made < n_games and t < now:
        ten = rng.sample(players, 10)
        rng.shuffle(ten)
        a, b = ten[:5], ten[5:]
        for g in range(rng.choice([2, 3])):
            ra, rb = ROLES[:], ROLES[:]
            rng.shuffle(ra) if rng.random() < 0.3 else None
            ps = [(p, r) for p, r in zip(a, ra)] + [(p, r) for p, r in zip(b, rb)]
            if g % 2:
                ps = ps[5:] + ps[:5]
            add_match(ps, t, 0, True)
            t += 35 * 60000
            made += 1
        t += rng.randint(2, 30) * 3600000
    db.commit()
    build(db, log=log)
    log(f"데모 데이터: 선수 {n_players}명 · 내전 {made}경기")
