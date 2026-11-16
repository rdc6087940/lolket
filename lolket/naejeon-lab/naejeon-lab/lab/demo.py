"""가짜 데이터 생성기 — 키·인터넷 없이 학습·화면 동작 확인용

숨은 '라인별 실력'을 가진 멤버들이 커뮤니티 내전을 했다고 가정하고,
deeplol 경기 상세(match-cached) + Riot match-v5 상세·타임라인과 같은 모양의 원본 JSON을 만든다. (실제 데이터 아님)
"""
import json
import os
import random

import numpy as np

from .db import DB, now_ms
from .build import build

POS = ["Top", "Jungle", "Middle", "Bot", "Supporter"]
CODE = {"Top": "Top", "Jungle": "Jun", "Middle": "Mid", "Bot": "Bot", "Supporter": "Sup"}
CHAMPS = {"Top": [266, 122, 516, 58, 897], "Jungle": [64, 254, 120, 154, 234], "Middle": [103, 134, 112, 142, 163],
          "Bot": [202, 429, 81, 498, 221], "Supporter": [267, 117, 497, 201, 888]}
CHAMP_NAMES = {266: "Aatrox", 122: "Darius", 516: "Ornn", 58: "Renekton", 897: "KSante", 64: "LeeSin", 254: "Vi",
               120: "Hecarim", 154: "Zac", 234: "Viego", 103: "Ahri", 134: "Syndra", 112: "Viktor", 142: "Zoe",
               163: "Taliyah", 202: "Jhin", 429: "Kalista", 81: "Ezreal", 498: "Xayah", 221: "Zeri", 267: "Nami",
               117: "Lulu", 497: "Rakan", 201: "Braum", 888: "Renata"}
TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER"]
NAMES = ["룽", "포로", "누룽지", "짱구", "덕냥", "현냥", "밀키", "니집", "꾸팡", "예성", "두부", "주사위", "과거", "소나무", "정민"]


def make_demo(cfg, n_players=60, n_games=1200, log=print, seed=7):
    rng = random.Random(seed)
    np.random.seed(seed)
    if os.path.exists(cfg["db_path"]):
        os.remove(cfg["db_path"])
    db = DB(cfg["db_path"])
    players = []
    for i in range(n_players):
        skill = np.random.normal(0, 1)
        main = POS[i % 5]
        role_skill = {r: skill + (0.6 if r == main else np.random.normal(-0.5, 0.4)) for r in POS}
        ti = int(np.clip(round(4.5 + skill * 1.4 + np.random.normal(0, 0.8)), 0, 7))
        p = {"puuid": f"demo{i:03d}" + "x" * 70, "name": f"{rng.choice(NAMES)}{i}", "tag": "KR1", "role_skill": role_skill,
             "tier": TIERS[ti], "div": 0 if ti == 7 else rng.randint(1, 4)}
        players.append(p)
        p["riot"] = f"riot{i:03d}" + "y" * 70
        db.x("INSERT INTO members(puuid, game_name, tag_line, source, added_at, scan_done, riot_puuid, riot_status, riot_scan_done) "
             "VALUES(?,?,?,?,?,1,?,200,1)", (p["puuid"], p["name"], p["tag"], "seed", now_ms(), p["riot"]))
    db.set_meta("champ_names", {str(k): v for k, v in CHAMP_NAMES.items()})
    t = now_ms() - 365 * 86400000
    made, mid = 0, 8000000000
    while made < n_games:
        ten = rng.sample(players, 10)
        a, b = ten[:5], ten[5:]
        for g in range(rng.choice([2, 3])):
            ra, rb = POS[:], POS[:]
            if rng.random() < 0.3:
                rng.shuffle(ra)
            blue, red = (list(zip(a, ra)), list(zip(b, rb))) if g % 2 == 0 else (list(zip(b, rb)), list(zip(a, ra)))
            sb = sum(p["role_skill"][r] for p, r in blue)
            sr = sum(p["role_skill"][r] for p, r in red)
            bw = bool(np.random.rand() < 1 / (1 + np.exp(-(sb - sr) / 2.2 - 0.08)))
            mid += 1
            raw = _match(f"KR_{mid}", t, blue, red, bw, rng)
            db.x("INSERT INTO matches_raw VALUES(?,?,?,?)", (f"KR_{mid}", now_ms(), 200, json.dumps(raw, ensure_ascii=False)))
            if rng.random() < 0.85:      # 대부분은 Riot 상세·타임라인도 있음
                rm, tl = _riot(f"KR_{mid}", t, raw, {p["puuid"]: p for p, _ in blue + red}, rng)
                db.x("INSERT INTO riot_raw VALUES(?,?,?,?)", (f"KR_{mid}", now_ms(), 200, json.dumps(rm, ensure_ascii=False)))
                db.x("INSERT INTO riot_tl VALUES(?,?,?,?)", (f"KR_{mid}", now_ms(), 200, json.dumps(tl)))
            for p, _ in blue + red:
                db.x("INSERT OR IGNORE INTO member_matches(puuid, match_id, t_ms, src) VALUES(?,?,?,?)", (p["puuid"], f"KR_{mid}", t, "riot"))
            t += 35 * 60000
            made += 1
        t += rng.randint(2, 30) * 3600000
    db.commit()
    build(db, log=log)
    log(f"데모 데이터: 멤버 {n_players}명 · 내전 {made}경기")


def _match(mid, t, blue, red, bw, rng):
    dur = rng.randint(1300, 2200)
    mins = dur / 60
    parts = []
    for side, team, win in (("BLUE", blue, bw), ("RED", red, not bw)):
        for p, pos in team:
            perf = p["role_skill"][pos] + (0.6 if win else -0.6) + np.random.normal(0, 0.5)
            k = max(0, int(np.random.normal(5 + perf * 1.5, 2)))
            d = max(0, int(np.random.normal(5 - perf, 2)))
            a = max(0, int(np.random.normal(7 + perf, 3)))
            cs = max(10, int((7 + perf * 0.6) * mins)) if pos not in ("Supporter",) else int(1.2 * mins)
            dmg = int((18000 + perf * 3000) * mins / 30)
            ai = float(np.clip(50 + perf * 9 + np.random.normal(0, 4), 5, 99))
            parts.append({
                "puu_id": p["puuid"], "champion_id": rng.choice(CHAMPS[pos]), "side": side, "position": pos,
                "tier": p["tier"], "division": p["div"], "total_damage_dealt": dmg * 6,
                "total_damage_dealt_to_champion": dmg, "total_damage_taken": int((15000 - perf * 1000) * mins / 30 + 9000),
                "total_gold": int((380 + perf * 25) * mins),
                "lane_stat_dict": {"ai_score": round(ai + np.random.normal(0, 5), 2), "ai_score_rank": 5, "champion_level": 10,
                                   "kills": k // 2, "deaths": d // 2, "assists": a // 2, "cs": cs // 2,
                                   "cspm": round(cs / mins, 2), "kill_point": 40, "vision_wards_bought": 1,
                                   "wards_killed": 1, "wards_placed": 5},
                "final_stat_dict": {"ai_score": round(ai, 2), "ai_score_rank": 5, "champion_level": 16, "kills": k,
                                    "deaths": d, "assists": a, "cs": cs, "cspm": round(cs / mins, 2),
                                    "kill_point": float(np.clip(50 + perf * 8, 10, 95)), "vision_wards_bought": 3,
                                    "wards_killed": 4 + (6 if pos == "Supporter" else 0),
                                    "wards_placed": 10 + (25 if pos == "Supporter" else 0)},
                "spell_id_dict": {"spell_1": 4, "spell_2": 11 if pos == "Jungle" else 14}, "smite": "G",
                "rune_detail_dict": {"perk_0": 8010, "perk_primary_style": 8000, "perk_sub_style": 8400},
                "skill_seq_list": [{"minute": 1, "skill_id": 1, "type": "NORMAL"}, {"minute": 2, "skill_id": 3, "type": "NORMAL"},
                                   {"minute": 3, "skill_id": 2, "type": "NORMAL"}],
                "item_seq_list": [{"minute": 1, "item_id": 1055, "type": "ITEM_PURCHASED"}],
                "final_item_dict": {"item_0": 3031, "item_1": 3006}, "total_pings_dict": {"total_pings": rng.randint(0, 40)},
                "is_win": win, "mvp": False, "ace": False, "ai_score": round(ai, 2),
                "double_kills": k // 4, "triple_kills": 0, "quadra_kills": 0, "penta_kills": 0,
                "profile_icon": 29, "riot_id_name": p["name"], "riot_id_tag_line": p["tag"]})
    # 이벤트·타임라인 (간단히)
    codes = [("B_" if s == "BLUE" else "R_") + CODE[pos] for s, team in (("BLUE", blue), ("RED", red)) for _, pos in team]
    ev, seq = {}, {}
    n = 0
    for m in range(0, int(mins), 2):
        side_b = rng.random() < (0.6 if bw else 0.4)
        kc = rng.choice(codes[:5] if side_b else codes[5:])
        tc = rng.choice(codes[5:] if side_b else codes[:5])
        n += 1
        bucket = {str(1): {"event": {"timestamp": (m * 60 + 30) * 1000, "minute": m, "minute_float": m + 0.5, "type": "Champion",
                                     "killer": kc, "side": "BLUE" if side_b else "RED", "target": tc,
                                     "assists": [] if rng.random() < 0.3 else [rng.choice(codes[:5] if side_b else codes[5:])],
                                     "coordinates": {"x_scaled": rng.uniform(0, 250), "y_scaled": rng.uniform(0, 250)}},
                           "time": m + 0.5, "win_rate": rng.uniform(-5, 5), "win_rate_delta": rng.uniform(-2, 2)}}
        if m in (8, 14, 20):
            bucket["2"] = {"event": {"timestamp": (m * 60 + 50) * 1000, "minute": m, "minute_float": m + 0.8, "type": "Monster",
                                     "killer": "B_Jun" if side_b else "R_Jun", "side": "BLUE" if side_b else "RED",
                                     "target": "FIRE_DRAGON", "assists": [], "coordinates": {}}, "win_rate": 0, "win_rate_delta": 0}
        if m in (12, 18):
            bucket["3"] = {"event": {"timestamp": (m * 60 + 55) * 1000, "minute": m, "minute_float": m + 0.9, "type": "Tower",
                                     "killer": "B_Top" if side_b else "R_Top", "side": "BLUE" if side_b else "RED",
                                     "target": "TOP_OUTER_TOWER", "assists": [], "coordinates": {}}, "win_rate": 0, "win_rate_delta": 0}
        ev[str(m)] = bucket
        seq[str(m)] = {"B_Obj": [], "R_Obj": [], **{c: round(rng.uniform(40, 60), 2) for c in codes},
                       "B_Avg": round(rng.uniform(45, 55) + (2 if bw else -2), 2), "R_Avg": round(rng.uniform(45, 55), 2)}
    return {"match_basic_dict": {"match_id": mid, "queue_id": 3130, "creation_timestamp": t / 1000, "game_duration": dur,
                                 "avg_tier": "EMERALD III", "avg_division": 3, "blue_win": bw, "is_remake": False,
                                 "map_id": 11, "game_version": "16.22", "tournament_name": "데모"},
            "participants_list": parts,
            "time_analysis": {"concat_events_dict": ev, "concat_seq_dict": seq, "concat_participants_dict": {}}}


R_POS = {"Top": "TOP", "Jungle": "JUNGLE", "Middle": "MIDDLE", "Bot": "BOTTOM", "Supporter": "UTILITY"}


def _riot(mid, t, raw, pmap, rng):
    """deeplol 모양 가짜 경기 → Riot match-v5 상세 + 타임라인 모양"""
    dur = raw["match_basic_dict"]["game_duration"]
    mins = dur / 60
    bw = raw["match_basic_dict"]["blue_win"]
    parts, pf = [], {}
    for i, q in enumerate(raw["participants_list"], 1):
        p = pmap[q["puu_id"]]
        perf = (q["ai_score"] - 50) / 9.0
        fs = q["final_stat_dict"]
        team = 100 if q["side"] == "BLUE" else 200
        lane = perf + np.random.normal(0, 0.6)
        parts.append({
            "participantId": i, "puuid": p["riot"], "riotIdGameName": p["name"], "riotIdTagline": p["tag"],
            "teamId": team, "teamPosition": R_POS[q["position"]], "individualPosition": R_POS[q["position"]],
            "championId": q["champion_id"], "championName": CHAMP_NAMES.get(q["champion_id"], ""),
            "win": bool(q["is_win"]), "kills": fs["kills"], "deaths": fs["deaths"], "assists": fs["assists"],
            "totalMinionsKilled": fs["cs"], "neutralMinionsKilled": 0, "champLevel": 16,
            "goldEarned": q["total_gold"], "totalDamageDealtToChampions": q["total_damage_dealt_to_champion"],
            "totalDamageDealt": q["total_damage_dealt"], "totalDamageTaken": q["total_damage_taken"],
            "wardsPlaced": fs["wards_placed"], "wardsKilled": fs["wards_killed"], "detectorWardsPlaced": 3,
            "visionScore": int((0.8 + (1.6 if q["position"] == "Supporter" else 0) + perf * 0.1) * mins),
            "timeCCingOthers": max(0, int(20 + perf * 5 + rng.uniform(0, 20))),
            "totalTimeSpentDead": int(fs["deaths"] * rng.uniform(15, 40)), "longestTimeSpentLiving": 600,
            "dragonKills": 0, "baronKills": 0, "turretKills": rng.randint(0, 2), "turretTakedowns": rng.randint(0, 4),
            "firstBloodKill": False, "firstTowerKill": False, "doubleKills": q["double_kills"], "tripleKills": 0,
            "quadraKills": 0, "pentaKills": 0, "summoner1Id": 4, "summoner2Id": 14, "profileIcon": 29,
            "perks": {"styles": [{"style": 8000, "selections": [{"perk": 8010}]}, {"style": 8400}]},
            "challenges": {"killParticipation": fs["kill_point"] / 100, "soloKills": max(0, int(perf + rng.uniform(0, 2))),
                           "teamDamagePercentage": None, "visionScorePerMinute": None,
                           "turretPlatesTaken": max(0, int(1.5 + lane + rng.uniform(-1, 1))),
                           "laningPhaseGoldExpAdvantage": 1 if lane > 0.3 else 0, "dragonTakedowns": 1, "baronTakedowns": 0,
                           "riftHeraldTakedowns": 0, "skillshotsHit": 30, "skillshotsDodged": 10},
        })
        pf[i] = lane
    for x in parts:
        for k in ("teamDamagePercentage", "visionScorePerMinute"):
            x["challenges"].pop(k)
    frames = []
    for m in range(int(mins) + 1):
        fr = {"timestamp": m * 60000, "participantFrames": {}, "events": []}
        for i in pf:
            g = int(500 + m * (330 + pf[i] * 25))
            fr["participantFrames"][str(i)] = {"totalGold": g, "minionsKilled": int(m * (6.5 + pf[i] * 0.5)),
                                               "jungleMinionsKilled": 0, "xp": int(m * (420 + pf[i] * 20)), "level": min(18, 1 + m // 2)}
        if m and m % 3 == 0:
            k, v = (rng.randint(1, 5), rng.randint(6, 10)) if rng.random() < (0.6 if bw else 0.4) else (rng.randint(6, 10), rng.randint(1, 5))
            fr["events"].append({"type": "CHAMPION_KILL", "timestamp": m * 60000 + 5000, "killerId": k, "victimId": v,
                                 "assistingParticipantIds": [] if rng.random() < 0.3 else [k % 5 + 1 if k <= 5 else (k % 5) + 6],
                                 "position": {"x": rng.randint(0, 14000), "y": rng.randint(0, 14000)}})
        frames.append(fr)
    tb = sum(1 for q in raw["participants_list"] if q["side"] == "BLUE")
    teams = [{"teamId": 100, "win": bool(bw), "bans": [], "objectives": {"champion": {"first": True, "kills": 20},
                                                                         "tower": {"first": bw, "kills": 7 if bw else 3},
                                                                         "dragon": {"first": bw, "kills": 3 if bw else 1}}},
             {"teamId": 200, "win": not bw, "bans": [], "objectives": {"champion": {"first": False, "kills": 18},
                                                                       "tower": {"first": not bw, "kills": 3 if bw else 7},
                                                                       "dragon": {"first": not bw, "kills": 1 if bw else 3}}}]
    m = {"metadata": {"matchId": mid, "participants": [x["puuid"] for x in parts]},
         "info": {"gameCreation": int(t), "gameStartTimestamp": int(t) + 20000, "gameDuration": dur, "queueId": 3130,
                  "mapId": 11, "gameVersion": "16.22.1", "tournamentCode": "KR04-DEMO", "participants": parts, "teams": teams}}
    return m, {"info": {"frames": frames}}
