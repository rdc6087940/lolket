"""원본(deeplol 상세) → 분석용 표 재생성

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


def _insert(db, table, rows):
    if not rows:
        return
    cols = list(rows[0].keys())
    db.many(f"INSERT OR REPLACE INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
            [tuple(r[c] for c in cols) for r in rows])


def build(db, log=print, series_gap_h=3):
    for t in ("games", "game_players", "game_events", "game_timeline"):
        db.x(f"DELETE FROM {t}")
    champ = db.get_meta("champ_names", {}) or {}
    n = 0
    cur = db.conn.execute("SELECT match_id, json FROM matches_raw WHERE status=200 AND json IS NOT NULL")
    bg, bp, be, bt = [], [], [], []
    for mid, js in cur.fetchall():
        try:
            res = parse_match(mid, json.loads(js), champ)
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
    log(f"정리 완료: 커뮤니티 내전 {n}경기 · 시리즈 {ns}개 · 이벤트 {ne}건")
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
