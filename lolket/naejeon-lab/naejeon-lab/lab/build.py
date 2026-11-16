"""원본(Riot 상세 + Riot 타임라인 + deeplol 상세) → 분석용 표 재생성

경기마다 Riot 상세를 기본으로 쓰고, 같은 경기의 deeplol 상세에서 '경기 당시 티어 · AI 점수 · 라인전 AI · 승률 흐름'을
챔피언(팀+챔피언 ID)으로 짝지어 합친다. Riot 이 없으면 deeplol 상세만으로 만든다(예전 방식).

games         : 경기 1건 (승패, 길이, 패치, 첫 킬·포탑·용·전령·바론, 팀별 오브젝트 수, 골드, 15분 상황)
game_players  : 선수 × 경기 (최종·라인전 스탯, 딜/골드 비중, 시야, AI 점수, 솔로킬, 초반 킬/데스, 오브젝트 관여,
                룬·스펠·아이템·스킬순서·핑 등 — deeplol 이 주는 거의 모든 값)
game_events   : 킬·오브젝트·포탑·아이템(전령의 눈 등) 이벤트 하나하나 (시각·좌표·관여자·승률 변화)
game_timeline : 분 단위 라인별 점수 흐름과 오브젝트
+ 같은 10명이 이어서 한 경기를 시리즈로 묶음
"""
import hashlib
import json

ROLE = {"Top": "TOP", "Jungle": "JUNGLE", "Middle": "MIDDLE", "Mid": "MIDDLE", "Bot": "BOTTOM", "Bottom": "BOTTOM",
        "ADC": "BOTTOM", "Supporter": "UTILITY", "Support": "UTILITY", "Utility": "UTILITY"}
CODE = {"TOP": "Top", "JUNGLE": "Jun", "MIDDLE": "Mid", "BOTTOM": "Bot", "UTILITY": "Sup"}
TIER_BASE = {"IRON": 0, "BRONZE": 4, "SILVER": 8, "GOLD": 12, "PLATINUM": 16, "EMERALD": 20, "DIAMOND": 24,
             "MASTER": 28, "GRANDMASTER": 29, "CHALLENGER": 30}
SKILL = {1: "Q", 2: "W", 3: "E", 4: "R"}
EARLY_MIN = 15


def tier_score(tier, division):
    """경기 당시 티어 → 점수 (아이언4=0 … 다이아1=27, 마스터 28, 그마 29, 챌린저 30). 언랭크 = None"""
    t = str(tier or "").upper()
    if t not in TIER_BASE:
        return None
    if t in ("MASTER", "GRANDMASTER", "CHALLENGER"):
        return float(TIER_BASE[t])
    d = int(division or 4)
    return float(TIER_BASE[t] + (4 - min(max(d, 1), 4)))


def _f(v, d=0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def _events(raw):
    """concat_events_dict → 시간순 이벤트 목록 [{event..., win_rate, win_rate_delta}]"""
    out = []
    ev = ((raw.get("time_analysis") or {}).get("concat_events_dict")) or {}
    for _, bucket in ev.items():
        if not isinstance(bucket, dict):
            continue
        for k, v in bucket.items():
            if not str(k).isdigit() or not isinstance(v, dict) or not isinstance(v.get("event"), dict):
                continue
            e = dict(v["event"])
            e["_wr"] = v.get("win_rate")
            e["_wrd"] = v.get("win_rate_delta")
            out.append(e)
    out.sort(key=lambda e: _f(e.get("timestamp")))
    return out


def _side_of(code):
    return "BLUE" if str(code).startswith("B_") else ("RED" if str(code).startswith("R_") else None)


def parse_match(mid, raw, champ_names=None):
    """deeplol 상세 원본 1건 → (game dict, [player dict], [event row], [timeline row]) 또는 None"""
    champ_names = champ_names or {}
    mb = raw.get("match_basic_dict") or {}
    ps = raw.get("participants_list") or []
    if len(ps) != 10:
        return None
    start = int(_f(mb.get("creation_timestamp")) * 1000)
    dur = int(_f(mb.get("game_duration")))
    mins = max(dur / 60.0, 1.0)
    blue_win = 1 if mb.get("blue_win") else 0

    code2puuid, players = {}, []
    team_kills = {100: 0, 200: 0}
    team_dmg = {100: 0, 200: 0}
    team_gold = {100: 0, 200: 0}
    for p in ps:
        team = 100 if str(p.get("side", "")).upper() == "BLUE" else 200
        role = ROLE.get(p.get("position"), None)
        if role:
            code2puuid[("B_" if team == 100 else "R_") + CODE[role]] = p.get("puu_id")
        fs = p.get("final_stat_dict") or {}
        a, b = _f(p.get("total_damage_dealt")), _f(p.get("total_damage_dealt_to_champion"))
        dmg = min(a, b) if a and b else (a or b)          # deeplol 은 두 값이 뒤바뀌어 오는 경우가 있음
        team_kills[team] += int(_f(fs.get("kills")))
        team_dmg[team] += dmg
        team_gold[team] += _f(p.get("total_gold"))

    # 이벤트로 선수별 솔로킬·초반 킬/데스·오브젝트 관여, 팀별 오브젝트
    evs = _events(raw)
    per = {pu: {"solo_kills": 0, "solo_deaths": 0, "first_blood": 0, "early_kills": 0, "early_deaths": 0,
                "monster_kills": 0, "tower_kills": 0, "obj_assists": 0} for pu in code2puuid.values()}
    g_obj = {k: {"BLUE": 0, "RED": 0} for k in ("dragons", "barons", "heralds", "grubs", "towers", "inhibs")}
    firsts = {}
    ev_rows = []
    wr15 = None
    for i, e in enumerate(evs):
        typ = e.get("type")
        actor = e.get("killer") or e.get("user")
        side = e.get("side") or _side_of(actor)
        target = e.get("target")
        assists = e.get("assists") or []
        minute = _f(e.get("minute_float"), _f(e.get("minute")))
        if minute <= EARLY_MIN and e.get("_wr") is not None:
            wr15 = _f(e.get("_wr"))
        ap = code2puuid.get(actor)
        tp = code2puuid.get(target) if typ == "Champion" else None
        if typ == "Champion":
            if "blood" not in firsts:
                firsts["blood"] = side
                if ap in per:
                    per[ap]["first_blood"] = 1
            if not assists:
                if ap in per:
                    per[ap]["solo_kills"] += 1
                if tp in per:
                    per[tp]["solo_deaths"] += 1
            if minute <= EARLY_MIN:
                if ap in per:
                    per[ap]["early_kills"] += 1
                if tp in per:
                    per[tp]["early_deaths"] += 1
        elif typ in ("Monster", "Tower", "Inhibitor", "Building"):
            tgt = str(target or "").upper()
            key = None
            if typ == "Monster":
                key = ("dragons" if "DRAGON" in tgt else "barons" if "BARON" in tgt else
                       "heralds" if "HERALD" in tgt else "grubs" if "HORDE" in tgt or "GRUB" in tgt else None)
                if ap in per:
                    per[ap]["monster_kills"] += 1
            elif typ == "Tower" or "TOWER" in tgt:
                key = "towers"
                if ap in per:
                    per[ap]["tower_kills"] += 1
            elif "INHIB" in tgt or typ == "Inhibitor":
                key = "inhibs"
            for a_ in assists:
                if code2puuid.get(a_) in per:
                    per[code2puuid[a_]]["obj_assists"] += 1
            if key and side in ("BLUE", "RED"):
                g_obj[key][side] += 1
                fk = {"dragons": "dragon", "barons": "baron", "heralds": "herald", "grubs": "grub", "towers": "tower"}.get(key)
                if fk and fk not in firsts:
                    firsts[fk] = side
        co = e.get("coordinates") or {}
        ev_rows.append((mid, i, _f(e.get("timestamp")) / 1000.0, int(_f(e.get("minute"))), typ, actor, ap, side,
                        target, tp, json.dumps(assists, ensure_ascii=False),
                        _f(co.get("x_scaled"), None) if co.get("x_scaled") not in (None, "None") else None,
                        _f(co.get("y_scaled"), None) if co.get("y_scaled") not in (None, "None") else None,
                        e.get("_wr"), e.get("_wrd")))

    # 타임라인 (분 단위 라인별 점수)
    tl_rows, ai15 = [], (None, None)
    seq = ((raw.get("time_analysis") or {}).get("concat_seq_dict")) or {}
    best15 = -1
    for k, v in seq.items():
        if not str(k).isdigit() or not isinstance(v, dict):
            continue
        m = int(k)
        tl_rows.append((mid, m, v.get("B_Top"), v.get("B_Jun"), v.get("B_Mid"), v.get("B_Bot"), v.get("B_Sup"),
                        v.get("R_Top"), v.get("R_Jun"), v.get("R_Mid"), v.get("R_Bot"), v.get("R_Sup"),
                        v.get("B_Avg"), v.get("R_Avg"), json.dumps(v.get("B_Obj") or [], ensure_ascii=False),
                        json.dumps(v.get("R_Obj") or [], ensure_ascii=False)))
        if best15 < m <= EARLY_MIN:
            best15, ai15 = m, (v.get("B_Avg"), v.get("R_Avg"))

    for p in ps:
        team = 100 if str(p.get("side", "")).upper() == "BLUE" else 200
        role = ROLE.get(p.get("position"))
        fs = p.get("final_stat_dict") or {}
        ls = p.get("lane_stat_dict") or {}
        a, b = _f(p.get("total_damage_dealt")), _f(p.get("total_damage_dealt_to_champion"))
        dmg = min(a, b) if a and b else (a or b)
        k, d, a_ = int(_f(fs.get("kills"))), int(_f(fs.get("deaths"))), int(_f(fs.get("assists")))
        gold = _f(p.get("total_gold"))
        cw = int(_f(fs.get("vision_wards_bought")))
        wp, wk = int(_f(fs.get("wards_placed"))), int(_f(fs.get("wards_killed")))
        rd = p.get("rune_detail_dict") or {}
        sp = p.get("spell_id_dict") or {}
        sk = p.get("skill_seq_list") or []
        first3 = "".join(SKILL.get(int(_f(s.get("skill_id"))), "?") for s in sk[:3])
        cid = p.get("champion_id")
        e = per.get(p.get("puu_id"), {})
        players.append({
            "match_id": mid, "puuid": p.get("puu_id"), "game_start": start, "duration": dur,
            "name": p.get("riot_id_name"), "tag": p.get("riot_id_tag_line"), "team": team, "role": role,
            "win": 1 if ((team == 100) == bool(blue_win)) else 0,
            "champion_id": cid, "champion": champ_names.get(str(cid), str(cid)),
            "tier": p.get("tier"), "division": p.get("division"), "tier_score": tier_score(p.get("tier"), p.get("division")),
            "kills": k, "deaths": d, "assists": a_, "kda": (k + a_) / max(d, 1),
            "kill_part": _f(fs.get("kill_point")) / 100.0,
            "cs": int(_f(fs.get("cs"))), "cspm": _f(fs.get("cspm")), "level": int(_f(fs.get("champion_level"))),
            "gold": int(gold), "gpm": gold / mins,
            "dmg": int(dmg), "dpm": dmg / mins, "dmg_total": int(max(a, b)), "dmg_taken": int(_f(p.get("total_damage_taken"))),
            "dtpm": _f(p.get("total_damage_taken")) / mins,
            "dmg_share": dmg / team_dmg[team] if team_dmg[team] else None,
            "gold_share": gold / team_gold[team] if team_gold[team] else None,
            "wards_placed": wp, "wards_killed": wk, "control_wards": cw, "vision": (wp + wk + cw) / mins,
            "ai_score": _f(p.get("ai_score"), None), "ai_rank": fs.get("ai_score_rank"),
            "mvp": 1 if p.get("mvp") else 0, "ace": 1 if p.get("ace") else 0,
            "doubles": p.get("double_kills"), "triples": p.get("triple_kills"),
            "quadras": p.get("quadra_kills"), "pentas": p.get("penta_kills"),
            "lane_kills": ls.get("kills"), "lane_deaths": ls.get("deaths"), "lane_assists": ls.get("assists"),
            "lane_cs": ls.get("cs"), "lane_cspm": ls.get("cspm"), "lane_ai": ls.get("ai_score"),
            "lane_ai_rank": ls.get("ai_score_rank"), "lane_kp": _f(ls.get("kill_point")) / 100.0,
            "lane_level": ls.get("champion_level"), "lane_wards_placed": ls.get("wards_placed"),
            "lane_wards_killed": ls.get("wards_killed"),
            **{k2: e.get(k2, 0) for k2 in ("solo_kills", "solo_deaths", "first_blood", "early_kills", "early_deaths",
                                           "monster_kills", "tower_kills", "obj_assists")},
            "spell1": sp.get("spell_1"), "spell2": sp.get("spell_2"), "smite": p.get("smite"),
            "rune_primary": rd.get("perk_primary_style"), "rune_sub": rd.get("perk_sub_style"), "keystone": rd.get("perk_0"),
            "skill_first3": first3, "pings": (p.get("total_pings_dict") or {}).get("total_pings"),
            "profile_icon": p.get("profile_icon"),
            "runes_json": json.dumps(rd), "items_json": json.dumps(p.get("final_item_dict") or {}),
            "item_build_json": json.dumps(p.get("item_seq_list") or []), "skill_seq_json": json.dumps(sk),
            "pings_json": json.dumps(p.get("total_pings_dict") or {}),
            "ai_detail_json": json.dumps({"lane": p.get("lane_ai_score_detail_dict"), "final": p.get("final_ai_score_detail_dict")},
                                         ensure_ascii=False),
        })

    game = {
        "match_id": mid, "game_start": start, "duration": dur, "patch": str(mb.get("game_version") or ""),
        "blue_win": blue_win, "tournament": mb.get("tournament_name"), "dl_queue_id": mb.get("queue_id"),
        "avg_tier": mb.get("avg_tier"), "avg_division": mb.get("avg_division"), "is_custom": 1,
        "blue_kills": team_kills[100], "red_kills": team_kills[200],
        "first_blood": firsts.get("blood"), "first_tower": firsts.get("tower"), "first_dragon": firsts.get("dragon"),
        "first_herald": firsts.get("herald"), "first_baron": firsts.get("baron"), "first_grub": firsts.get("grub"),
        "blue_dragons": g_obj["dragons"]["BLUE"], "red_dragons": g_obj["dragons"]["RED"],
        "blue_barons": g_obj["barons"]["BLUE"], "red_barons": g_obj["barons"]["RED"],
        "blue_heralds": g_obj["heralds"]["BLUE"], "red_heralds": g_obj["heralds"]["RED"],
        "blue_grubs": g_obj["grubs"]["BLUE"], "red_grubs": g_obj["grubs"]["RED"],
        "blue_towers": g_obj["towers"]["BLUE"], "red_towers": g_obj["towers"]["RED"],
        "blue_inhibs": g_obj["inhibs"]["BLUE"], "red_inhibs": g_obj["inhibs"]["RED"],
        "blue_gold": int(team_gold[100]), "red_gold": int(team_gold[200]),
        "blue_ai15": ai15[0], "red_ai15": ai15[1], "win_rate15": wr15,
    }
    return game, players, ev_rows, tl_rows


# ══════════════ Riot 상세 + 타임라인 ══════════════
RIOT_ROLE = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "BOTTOM": "BOTTOM", "UTILITY": "UTILITY"}
_PING_KEYS = ("allInPings", "assistMePings", "basicPings", "commandPings", "dangerPings", "enemyMissingPings",
              "enemyVisionPings", "getBackPings", "holdPings", "needVisionPings", "onMyWayPings", "pushPings",
              "retreatPings", "visionClearedPings")
_MONSTER = {"DRAGON": "dragons", "ELDER_DRAGON": "dragons", "BARON_NASHOR": "barons", "RIFTHERALD": "heralds",
            "HORDE": "grubs", "ATAKHAN": "atakhan"}


def _tl_frames(tl):
    return ((tl or {}).get("info") or {}).get("frames") or []


def _frame_at(frames, minute):
    """minute 분 시점 프레임 (경기가 더 짧으면 None)"""
    if not frames:
        return None
    for fr in frames:
        if int(_f(fr.get("timestamp")) // 60000) == minute:
            return fr
    return None


def parse_riot(mid, m, tl=None, dl_raw=None, champ_names=None, riot2dl=None):
    """Riot 상세(+타임라인, +deeplol 상세) 1건 → (game, players, events, timeline) 또는 None"""
    champ_names = champ_names or {}
    riot2dl = riot2dl or {}
    info = m.get("info") or {}
    ps = info.get("participants") or []
    if len(ps) != 10:
        return None
    start = int(_f(info.get("gameStartTimestamp") or info.get("gameCreation")))
    dur = int(_f(info.get("gameDuration")))
    if dur > 100000:          # 예전 형식(밀리초)
        dur //= 1000
    mins = max(dur / 60.0, 1.0)
    teams = {t.get("teamId"): t for t in info.get("teams") or []}
    blue_win = 1 if (teams.get(100) or {}).get("win") else 0

    # deeplol 상세와 짝짓기 (팀, 챔피언 ID)
    dl_res = None
    dl_by = {}
    if dl_raw:
        try:
            dl_res = parse_match(mid, dl_raw, champ_names)
        except Exception:
            dl_res = None
        if dl_res:
            dl_by = {(q["team"], int(_f(q["champion_id"]))): q for q in dl_res[1]}

    pid2 = {}          # participantId → 선수 정보
    for p in ps:
        dq = dl_by.get((p.get("teamId"), int(_f(p.get("championId")))), {})
        canon = riot2dl.get(p.get("puuid")) or dq.get("puuid") or ("riot:" + str(p.get("puuid")))
        role = RIOT_ROLE.get(p.get("teamPosition")) or RIOT_ROLE.get(p.get("individualPosition")) or dq.get("role")
        pid2[p.get("participantId")] = {"p": p, "dq": dq, "puuid": canon, "team": p.get("teamId"), "role": role,
                                        "code": ("B_" if p.get("teamId") == 100 else "R_") + CODE.get(role, "?")}

    team_kills = {100: 0, 200: 0}
    team_dmg = {100: 0, 200: 0}
    team_gold = {100: 0, 200: 0}
    team_taken = {100: 0, 200: 0}
    for x in pid2.values():
        p = x["p"]
        team_kills[x["team"]] += int(_f(p.get("kills")))
        team_dmg[x["team"]] += _f(p.get("totalDamageDealtToChampions"))
        team_gold[x["team"]] += _f(p.get("goldEarned"))
        team_taken[x["team"]] += _f(p.get("totalDamageTaken"))

    # 타임라인: 10·15분 골드/CS/경험치, 이벤트
    frames = _tl_frames(tl)
    snap = {}
    for mm in (10, 15):
        fr = _frame_at(frames, mm)
        if not fr:
            continue
        for k, v in (fr.get("participantFrames") or {}).items():
            snap.setdefault(int(k), {})[mm] = (int(_f(v.get("totalGold"))),
                                               int(_f(v.get("minionsKilled")) + _f(v.get("jungleMinionsKilled"))),
                                               int(_f(v.get("xp"))))
    per = {pid: {"solo_deaths": 0, "early_kills": 0, "early_deaths": 0, "items": [], "skills": []} for pid in pid2}
    ev_rows, plates = [], {100: 0, 200: 0}
    firsts = {}
    for fr in frames:
        for e in fr.get("events") or []:
            typ = e.get("type")
            ts = _f(e.get("timestamp")) / 1000.0
            minute = ts / 60.0
            if typ == "ITEM_PURCHASED" and e.get("participantId") in per:
                per[e["participantId"]]["items"].append({"t": ts, "item": e.get("itemId")})
            elif typ == "SKILL_LEVEL_UP" and e.get("participantId") in per:
                per[e["participantId"]]["skills"].append({"t": ts, "skill_id": e.get("skillSlot")})
            elif typ == "TURRET_PLATE_DESTROYED":
                lost = e.get("teamId")
                if lost in plates:
                    plates[300 - lost] += 1
            if typ not in ("CHAMPION_KILL", "ELITE_MONSTER_KILL", "BUILDING_KILL"):
                continue
            killer, victim = e.get("killerId"), e.get("victimId")
            assists = e.get("assistingParticipantIds") or []
            kx = pid2.get(killer)
            if typ == "CHAMPION_KILL":
                vx = pid2.get(victim)
                side = "BLUE" if (vx and vx["team"] == 200) else "RED"
                if not assists and victim in per:
                    per[victim]["solo_deaths"] += 1
                if minute <= EARLY_MIN:
                    if killer in per:
                        per[killer]["early_kills"] += 1
                    if victim in per:
                        per[victim]["early_deaths"] += 1
                etype, target, tp = "Champion", vx["code"] if vx else None, vx["puuid"] if vx else None
            elif typ == "ELITE_MONSTER_KILL":
                team = e.get("killerTeamId") or (kx["team"] if kx else None)
                side = "BLUE" if team == 100 else "RED"
                etype, target, tp = "Monster", e.get("monsterType") + (("_" + e["monsterSubType"]) if e.get("monsterSubType") else ""), None
            else:
                lost = e.get("teamId")
                side = "BLUE" if lost == 200 else "RED"
                bt = e.get("buildingType") or ""
                etype = "Tower" if "TOWER" in bt else "Inhibitor"
                target, tp = (e.get("laneType") or "") + "_" + bt, None
                if etype == "Inhibitor" and "inhib" not in firsts:
                    firsts["inhib"] = side
            pos = e.get("position") or {}
            ev_rows.append([mid, 0, ts, int(minute), etype, kx["code"] if kx else None, kx["puuid"] if kx else None, side,
                            target, tp, json.dumps([pid2[a]["code"] for a in assists if a in pid2]),
                            pos.get("x"), pos.get("y"), None, None])
    for i, r in enumerate(ev_rows):
        r[1] = i

    # 맞라인 상대
    opp = {}
    for pid, x in pid2.items():
        o = next((q for q2, q in pid2.items() if q["team"] != x["team"] and q["role"] and q["role"] == x["role"]), None)
        opp[pid] = o
    opp_pid = {pid: next((k for k, v in pid2.items() if v is o), None) for pid, o in opp.items()}

    def snapv(pid, mm, i):
        v = snap.get(pid, {}).get(mm)
        return v[i] if v else None

    def diff(pid, mm, i):
        a, o = snapv(pid, mm, i), snapv(opp_pid.get(pid), mm, i) if opp_pid.get(pid) else None
        return (a - o) if (a is not None and o is not None) else None

    players = []
    for pid, x in pid2.items():
        p, dq, team = x["p"], x["dq"], x["team"]
        ch = p.get("challenges") or {}
        k, d, a_ = int(_f(p.get("kills"))), int(_f(p.get("deaths"))), int(_f(p.get("assists")))
        cs = int(_f(p.get("totalMinionsKilled")) + _f(p.get("neutralMinionsKilled")))
        gold = _f(p.get("goldEarned"))
        dmg = _f(p.get("totalDamageDealtToChampions"))
        wp, wk, cw = int(_f(p.get("wardsPlaced"))), int(_f(p.get("wardsKilled"))), int(_f(p.get("detectorWardsPlaced")))
        styles = (p.get("perks") or {}).get("styles") or [{}, {}]
        prim = styles[0] if styles else {}
        sub = styles[1] if len(styles) > 1 else {}
        e = per.get(pid, {})
        mon = int(_f(p.get("dragonKills")) + _f(p.get("baronKills")))
        tow = int(_f(p.get("turretKills")))
        take = _f(ch.get("dragonTakedowns")) + _f(ch.get("baronTakedowns")) + _f(ch.get("riftHeraldTakedowns")) + _f(p.get("turretTakedowns"))
        pings = {kk: p.get(kk) for kk in _PING_KEYS if p.get(kk) is not None}
        sk = e.get("skills") or []
        items_seq = e.get("items") or []
        cid = p.get("championId")
        row = {
            "match_id": mid, "puuid": x["puuid"], "riot_puuid": p.get("puuid"), "game_start": start, "duration": dur,
            "name": p.get("riotIdGameName") or dq.get("name"), "tag": p.get("riotIdTagline") or dq.get("tag"),
            "team": team, "role": x["role"], "win": 1 if p.get("win") else 0,
            "champion_id": cid, "champion": champ_names.get(str(cid)) or p.get("championName") or str(cid),
            # deeplol 에서만 알 수 있는 값
            "tier": dq.get("tier"), "division": dq.get("division"), "tier_score": dq.get("tier_score"),
            "ai_score": dq.get("ai_score"), "ai_rank": dq.get("ai_rank"), "mvp": dq.get("mvp", 0), "ace": dq.get("ace", 0),
            **{kk: dq.get(kk) for kk in ("lane_kills", "lane_deaths", "lane_assists", "lane_cs", "lane_cspm", "lane_ai",
                                          "lane_ai_rank", "lane_kp", "lane_level", "lane_wards_placed", "lane_wards_killed",
                                          "ai_detail_json")},
            # Riot 기본 스탯
            "kills": k, "deaths": d, "assists": a_, "kda": (k + a_) / max(d, 1),
            "kill_part": _f(ch.get("killParticipation"), (k + a_) / max(team_kills[team], 1)),
            "cs": cs, "cspm": cs / mins, "level": int(_f(p.get("champLevel"))),
            "gold": int(gold), "gpm": gold / mins,
            "dmg": int(dmg), "dpm": dmg / mins, "dmg_total": int(_f(p.get("totalDamageDealt"))),
            "dmg_taken": int(_f(p.get("totalDamageTaken"))), "dtpm": _f(p.get("totalDamageTaken")) / mins,
            "dmg_share": _f(ch.get("teamDamagePercentage"), dmg / team_dmg[team] if team_dmg[team] else None),
            "gold_share": gold / team_gold[team] if team_gold[team] else None,
            "dmg_taken_share": _f(ch.get("damageTakenOnTeamPercentage"),
                                  _f(p.get("totalDamageTaken")) / team_taken[team] if team_taken[team] else None),
            "wards_placed": wp, "wards_killed": wk, "control_wards": cw, "vision": (wp + wk + cw) / mins,
            "vision_score": _f(p.get("visionScore")), "vspm": _f(ch.get("visionScorePerMinute"), _f(p.get("visionScore")) / mins),
            "doubles": p.get("doubleKills"), "triples": p.get("tripleKills"), "quadras": p.get("quadraKills"),
            "pentas": p.get("pentaKills"),
            "solo_kills": int(_f(ch.get("soloKills"))), "solo_deaths": e.get("solo_deaths", 0),
            "first_blood": 1 if p.get("firstBloodKill") else 0,
            "early_kills": e.get("early_kills", 0) if frames else dq.get("early_kills", 0),
            "early_deaths": e.get("early_deaths", 0) if frames else dq.get("early_deaths", 0),
            "monster_kills": mon, "tower_kills": tow, "obj_assists": max(0, int(take) - mon - tow),
            "first_tower": 1 if (p.get("firstTowerKill") or p.get("firstTowerAssist")) else 0,
            # 타임라인
            "gold10": snapv(pid, 10, 0), "cs10": snapv(pid, 10, 1), "xp10": snapv(pid, 10, 2),
            "gold15": snapv(pid, 15, 0), "cs15": snapv(pid, 15, 1), "xp15": snapv(pid, 15, 2),
            "gd10": diff(pid, 10, 0), "csd10": diff(pid, 10, 1), "xpd10": diff(pid, 10, 2),
            "gd15": diff(pid, 15, 0), "csd15": diff(pid, 15, 1), "xpd15": diff(pid, 15, 2),
            # challenges
            "plates": ch.get("turretPlatesTaken"), "cc_time": p.get("timeCCingOthers"),
            "ccpm": _f(p.get("timeCCingOthers")) / mins, "skill_hit": ch.get("skillshotsHit"),
            "skill_dodge": ch.get("skillshotsDodged"), "lane_minions10": ch.get("laneMinionsFirst10Minutes"),
            "jungle_cs10": ch.get("jungleCsBefore10Minutes"), "early_adv": ch.get("earlyLaningPhaseGoldExpAdvantage"),
            "laning_adv": ch.get("laningPhaseGoldExpAdvantage"), "max_cs_adv": ch.get("maxCsAdvantageOnLaneOpponent"),
            "max_lvl_lead": ch.get("maxLevelLeadLaneOpponent"), "vision_adv": ch.get("visionScoreAdvantageLaneOpponent"),
            "takedowns_early": ch.get("takedownsFirstXMinutes"), "dmg_mitigated": p.get("damageSelfMitigated"),
            "heal_shield": ch.get("effectiveHealAndShielding"), "obj_dmg": p.get("damageDealtToObjectives"),
            "turret_dmg": p.get("damageDealtToTurrets"), "dragon_takedowns": ch.get("dragonTakedowns"),
            "herald_takedowns": ch.get("riftHeraldTakedowns"), "baron_takedowns": ch.get("baronTakedowns"),
            "pick_kills": ch.get("pickKillWithAlly"), "save_ally": ch.get("saveAllyFromDeath"),
            "immobilizations": ch.get("enemyChampionImmobilizations"), "enemy_jungle": ch.get("enemyJungleMonsterKills"),
            "time_dead": p.get("totalTimeSpentDead"), "longest_alive": p.get("longestTimeSpentLiving"),
            # 빌드
            "spell1": p.get("summoner1Id"), "spell2": p.get("summoner2Id"),
            "smite": dq.get("smite"),
            "rune_primary": prim.get("style"), "rune_sub": sub.get("style"),
            "keystone": ((prim.get("selections") or [{}])[0]).get("perk"),
            "skill_first3": "".join(SKILL.get(int(_f(s_.get("skill_id"))), "?") for s_ in sk[:3]) or dq.get("skill_first3"),
            "pings": sum(int(_f(v)) for v in pings.values()), "profile_icon": p.get("profileIcon"),
            "runes_json": json.dumps(p.get("perks") or {}),
            "items_json": json.dumps({f"item{i}": p.get(f"item{i}") for i in range(7)}),
            "item_build_json": json.dumps(items_seq) if items_seq else dq.get("item_build_json", "[]"),
            "skill_seq_json": json.dumps(sk) if sk else dq.get("skill_seq_json", "[]"),
            "pings_json": json.dumps(pings),
            "challenges_json": json.dumps(ch, ensure_ascii=False),
        }
        players.append(row)

    def obj(team, key):
        return int(_f(((teams.get(team) or {}).get("objectives") or {}).get(key, {}).get("kills")))

    def first(key):
        for t in (100, 200):
            if (((teams.get(t) or {}).get("objectives") or {}).get(key) or {}).get("first"):
                return "BLUE" if t == 100 else "RED"
        return None

    def tgold(team, mm):
        vals = [snapv(pid, mm, 0) for pid, x in pid2.items() if x["team"] == team]
        return int(sum(vals)) if vals and all(v is not None for v in vals) else None

    dg = dl_res[0] if dl_res else {}
    game = {
        "match_id": mid, "game_start": start, "duration": dur, "patch": str(info.get("gameVersion") or ""),
        "blue_win": blue_win, "tournament": dg.get("tournament"), "dl_queue_id": info.get("queueId"),
        "avg_tier": dg.get("avg_tier"), "avg_division": dg.get("avg_division"), "is_custom": 1,
        "src": "riot+dl" if dl_res else "riot", "tournament_code": info.get("tournamentCode"),
        "bans_json": json.dumps({t: (teams.get(t) or {}).get("bans") for t in (100, 200)}),
        "blue_kills": team_kills[100], "red_kills": team_kills[200],
        "first_blood": first("champion"), "first_tower": first("tower"), "first_dragon": first("dragon"),
        "first_herald": first("riftHerald"), "first_baron": first("baron"), "first_grub": first("horde"),
        "first_inhib": first("inhibitor") or firsts.get("inhib"),
        "blue_dragons": obj(100, "dragon"), "red_dragons": obj(200, "dragon"),
        "blue_barons": obj(100, "baron"), "red_barons": obj(200, "baron"),
        "blue_heralds": obj(100, "riftHerald"), "red_heralds": obj(200, "riftHerald"),
        "blue_grubs": obj(100, "horde"), "red_grubs": obj(200, "horde"),
        "blue_towers": obj(100, "tower"), "red_towers": obj(200, "tower"),
        "blue_inhibs": obj(100, "inhibitor"), "red_inhibs": obj(200, "inhibitor"),
        "blue_atakhan": obj(100, "atakhan"), "red_atakhan": obj(200, "atakhan"),
        "blue_gold": int(team_gold[100]), "red_gold": int(team_gold[200]),
        "blue_gold10": tgold(100, 10), "red_gold10": tgold(200, 10),
        "blue_gold15": tgold(100, 15), "red_gold15": tgold(200, 15),
        "blue_plates": plates[100] if frames else None, "red_plates": plates[200] if frames else None,
        "surrender": 1 if any(p.get("gameEndedInSurrender") for p in ps) else 0,
        "blue_ai15": dg.get("blue_ai15"), "red_ai15": dg.get("red_ai15"), "win_rate15": dg.get("win_rate15"),
    }
    # 이벤트: deeplol 것(승률 변화 포함)이 있으면 그것, 없으면 Riot 타임라인
    events = dl_res[2] if (dl_res and dl_res[2]) else [tuple(r) for r in ev_rows]
    tl_rows = dl_res[3] if dl_res else []
    return game, players, events, tl_rows


def _insert(db, table, rows):
    if not rows:
        return
    cols = list(dict.fromkeys(c for r in rows for c in r))     # Riot·deeplol 행의 칸이 달라도 합쳐서
    db.many(f"INSERT OR REPLACE INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
            [tuple(r.get(c) for c in cols) for r in rows])


def build(db, log=print, series_gap_h=3):
    for t in ("games", "game_players", "game_events", "game_timeline"):
        db.x(f"DELETE FROM {t}")
    champ = db.get_meta("champ_names", {}) or {}
    riot2dl = {r["riot_puuid"]: r["puuid"] for r in db.q("SELECT puuid, riot_puuid FROM members WHERE riot_puuid IS NOT NULL")}
    # 커뮤니티 내전 = Riot 상세가 내전으로 판정한 경기 + (Riot 상세가 없는) deeplol 판정 내전
    ids = [r["match_id"] for r in db.q(
        "SELECT match_id FROM riot_raw WHERE status=200 AND json IS NOT NULL UNION "
        "SELECT d.match_id FROM matches_raw d LEFT JOIN riot_raw r ON r.match_id=d.match_id "
        "WHERE d.status=200 AND d.json IS NOT NULL AND (r.match_id IS NULL OR r.status NOT IN (200, 204))")]
    n = n_riot = n_tl = 0
    bg, bp, be, bt = [], [], [], []
    for mid in ids:
        rr = db.one("SELECT json FROM riot_raw WHERE match_id=? AND status=200", (mid,))
        dr = db.one("SELECT json FROM matches_raw WHERE match_id=? AND json IS NOT NULL", (mid,))
        try:
            if rr and rr["json"]:
                tr = db.one("SELECT json FROM riot_tl WHERE match_id=? AND status=200", (mid,))
                res = parse_riot(mid, json.loads(rr["json"]), json.loads(tr["json"]) if tr else None,
                                 json.loads(dr["json"]) if dr else None, champ, riot2dl)
                n_riot += 1
                n_tl += bool(tr)
            else:
                res = parse_match(mid, json.loads(dr["json"]), champ)
        except Exception as e:
            log(f"  {mid} 해석 실패: {e}")
            continue
        if not res:
            continue
        g, ps, ev, tl = res
        bg.append(g)
        bp += ps
        be += ev
        bt += tl
        n += 1
        if len(bg) >= 300:
            _insert(db, "games", bg); _insert(db, "game_players", bp)
            db.many("INSERT OR REPLACE INTO game_events VALUES(" + ",".join("?" * 15) + ")", be)
            db.many("INSERT OR REPLACE INTO game_timeline VALUES(" + ",".join("?" * 16) + ")", bt)
            bg, bp, be, bt = [], [], [], []
    _insert(db, "games", bg)
    _insert(db, "game_players", bp)
    if be:
        db.many("INSERT OR REPLACE INTO game_events VALUES(" + ",".join("?" * 15) + ")", be)
    if bt:
        db.many("INSERT OR REPLACE INTO game_timeline VALUES(" + ",".join("?" * 16) + ")", bt)
    db.commit()
    _group_series(db, series_gap_h)
    ne = db.one("SELECT COUNT(*) c FROM game_events")["c"]
    ns = db.one("SELECT COUNT(DISTINCT series_id) c FROM games")["c"]
    log(f"정리 완료: 커뮤니티 내전 {n}경기 (Riot 상세 {n_riot} · 타임라인 {n_tl} · deeplol 만 {n - n_riot}) "
        f"· 시리즈 {ns}개 · 이벤트 {ne}건")
    return n


def _group_series(db, gap_h):
    """같은 10명이 gap_h 시간 안에 연달아 한 경기 → 한 시리즈"""
    rows = db.q("SELECT g.match_id, g.game_start, GROUP_CONCAT(p.puuid) ps FROM games g "
                "JOIN game_players p ON p.match_id=g.match_id GROUP BY g.match_id ORDER BY g.game_start")
    last = {}
    for r in rows:
        key = ",".join(sorted((r["ps"] or "").split(",")))
        prev = last.get(key)
        if prev and r["game_start"] - prev["t"] <= gap_h * 3600 * 1000:
            sid, idx = prev["sid"], prev["idx"] + 1
        else:
            sid, idx = hashlib.md5((key + str(r["game_start"])).encode()).hexdigest()[:12], 1
        last[key] = {"t": r["game_start"], "sid": sid, "idx": idx}
        db.x("UPDATE games SET series_id=?, series_idx=? WHERE match_id=?", (sid, idx, r["match_id"]))
    db.commit()
