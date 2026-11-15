"""deeplol API — 내전(커스텀) 기록 출처

Riot API는 일반 커스텀 게임 기록을 정책상 주지 않는다(토너먼트 코드 게임만 예외).
룽잉닷컴 stats 페이지와 같은 deeplol API에서 내전 목록·상세를 받아
Riot match-v5 와 같은 모양으로 바꿔 저장한다 → 이후 정리·학습은 그대로 동작.

※ 비공식 API: 예고 없이 바뀌거나 막힐 수 있다. 요청 간격을 두고 천천히 받는다.
"""
import time

import requests

BASE = "https://b2c-api-cdn.deeplol.gg"
POS = {"Top": "TOP", "Jungle": "JUNGLE", "Middle": "MIDDLE", "Mid": "MIDDLE", "Bot": "BOTTOM", "Bottom": "BOTTOM",
       "ADC": "BOTTOM", "Supporter": "UTILITY", "Support": "UTILITY", "Utility": "UTILITY"}


class DeepLol:
    def __init__(self, interval_s=0.4, log=print):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": "Mozilla/5.0 naejeon-lab", "Accept": "application/json",
                               "Origin": "https://roonging.com", "Referer": "https://roonging.com/"})
        self.interval = interval_s
        self.last = 0.0
        self.calls = 0
        self.log = log
        self._champ = None

    def get(self, path, params):
        for attempt in range(6):
            wait = self.interval - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = self.s.get(BASE + path, params=params, timeout=30)
            except requests.RequestException as e:
                self.log(f"  deeplol 연결 오류 ({e.__class__.__name__}) — {5 * (attempt + 1)}초 후 재시도")
                time.sleep(5 * (attempt + 1))
                continue
            self.calls += 1
            if r.status_code == 200:
                try:
                    return 200, r.json()
                except ValueError:
                    return 200, None
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(int(r.headers.get("Retry-After", 0) or 0) or 5 * (attempt + 1))
                continue
            return r.status_code, None
        return 0, None

    # 계정의 커스텀 경기 ID (최신순, 20개씩)
    def custom_ids(self, puuid, offset=0, count=20):
        st, j = self.get("/match/matches", {"puu_id": puuid, "platform_id": "KR", "offset": offset, "count": count,
                                            "queue_type": "CUSTOM", "champion_id": 0, "only_list": 1,
                                            "last_updated_at": 1})
        if st != 200 or not j:
            return st, []
        return st, j.get("match_id_list") or []

    def match(self, match_id):
        return self.get("/match/match-cached", {"match_id": match_id, "platform_id": "KR"})

    def server_members(self, server_id):
        """deeplol 커뮤니티(서버) 멤버 목록 → [{puu_id, riot_name, riot_tag, ...}]  (deeplol puuid)"""
        st, j = self.get("/tournament/server_info", {"server_id": server_id})
        if st != 200 or not j:
            return st, []
        ts = j.get("tournament_stats") or {}
        return st, ts.get("tournament_stats_all_list") or []

    def champ_names(self):
        """championId → 이름 (Data Dragon). 실패하면 빈 dict → 숫자 ID를 이름으로 사용"""
        if self._champ is None:
            self._champ = {}
            try:
                v = requests.get("https://ddragon.leagueoflegends.com/api/versions.json", timeout=15).json()[0]
                d = requests.get(f"https://ddragon.leagueoflegends.com/cdn/{v}/data/ko_KR/champion.json", timeout=15).json()
                self._champ = {int(c["key"]): c["id"] for c in d["data"].values()}
            except Exception:
                pass
        return self._champ


def riot_id_key(name, tag):
    """닉네임#태그 비교용 키 (대소문자·공백 무시)"""
    return (str(name or "") + "#" + str(tag or "")).lower().replace(" ", "")


def to_riot(d, champ=None):
    """deeplol match-cached → match-v5 모양. 다시하기(remake)·10명 아님은 None"""
    champ = champ or {}
    mb = d.get("match_basic_dict") or {}
    ps = d.get("participants_list") or []
    if mb.get("is_remake") or len(ps) != 10:
        return None
    blue_win = bool(mb.get("blue_win"))
    parts = []
    for p in ps:
        fs = p.get("final_stat_dict") or {}
        team = 100 if str(p.get("side", "")).upper() == "BLUE" else 200
        a, b = p.get("total_damage_dealt") or 0, p.get("total_damage_dealt_to_champion") or 0
        cid = p.get("champion_id")
        parts.append({
            "puuid": p.get("puu_id"),
            "riotIdGameName": p.get("riot_id_name"),
            "riotIdTagline": p.get("riot_id_tag_line"),
            "teamId": team,
            "teamPosition": POS.get(p.get("position"), ""),
            "championId": cid,
            "championName": champ.get(cid, str(cid)),
            "win": bool(p["is_win"]) if p.get("is_win") is not None else (team == 100) == blue_win,
            "kills": fs.get("kills", 0), "deaths": fs.get("deaths", 0), "assists": fs.get("assists", 0),
            "totalMinionsKilled": fs.get("cs", 0), "neutralMinionsKilled": 0,
            "goldEarned": p.get("total_gold", 0),
            # deeplol 은 두 값이 뒤바뀌어 오는 경우가 있어 작은 쪽을 '챔피언에게 준 피해'로 사용
            "totalDamageDealtToChampions": min(a, b) if a and b else (a or b),
            "totalDamageTaken": p.get("total_damage_taken", 0),
            "visionScore": 0,
            "wardsPlaced": fs.get("wards_placed", 0), "wardsKilled": fs.get("wards_killed", 0),
            "visionWardsBoughtInGame": fs.get("vision_wards_bought", 0),
            "deeplolTier": p.get("tier"), "deeplolDivision": p.get("division"),
            "deeplolAiScore": p.get("ai_score"),
        })
    return {
        "metadata": {"matchId": mb.get("match_id"), "source": "deeplol"},
        "info": {
            "gameStartTimestamp": int(float(mb.get("creation_timestamp") or 0) * 1000),
            "gameDuration": mb.get("game_duration", 0),
            "queueId": 0, "gameType": "CUSTOM_GAME", "mapId": mb.get("map_id", 11),
            "gameVersion": str(mb.get("game_version", "")),
            "tournamentName": mb.get("tournament_name"),
            "deeplolQueueId": mb.get("queue_id"),
            "participants": parts,
            "teams": [{"teamId": 100, "win": blue_win}, {"teamId": 200, "win": not blue_win}],
        },
    }
