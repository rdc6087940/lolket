"""deeplol API 클라이언트 — 내전(커스텀) 기록의 유일한 출처

Riot API는 일반 커스텀 게임 기록을 정책상 주지 않는다(토너먼트 코드 게임만 예외).
룽잉닷컴 stats 페이지와 같은 deeplol API에서 커뮤니티 멤버 목록·내전 목록·내전 상세를 받는다.
상세는 받은 그대로(타임라인·이벤트·아이템·룬·스킬·핑 등 전부) 저장한다.

※ 비공식 API: 예고 없이 바뀌거나 막힐 수 있다. 요청 간격을 두고 천천히 받는다.
"""
import time

import requests

BASE = "https://b2c-api-cdn.deeplol.gg"


def riot_id_key(name, tag):
    """닉네임#태그 비교용 키 (대소문자·공백 무시)"""
    return (str(name or "") + "#" + str(tag or "")).lower().replace(" ", "")


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

    def custom_ids(self, puuid, offset=0, count=20):
        """계정의 커스텀 경기 ID (최신순, 20개씩) → [{match_id, match_creation_time}]"""
        st, j = self.get("/match/matches", {"puu_id": puuid, "platform_id": "KR", "offset": offset, "count": count,
                                            "queue_type": "CUSTOM", "champion_id": 0, "only_list": 1,
                                            "last_updated_at": 1})
        if st != 200 or not j:
            return st, []
        return st, j.get("match_id_list") or []

    def match(self, match_id):
        """경기 상세 원본 (match_basic_dict, participants_list, time_analysis)"""
        return self.get("/match/match-cached", {"match_id": match_id, "platform_id": "KR"})

    def server_members(self, server_id):
        """deeplol 커뮤니티(서버) 멤버 목록 → [{puu_id, riot_name, riot_tag, cnt, ...}]"""
        st, j = self.get("/tournament/server_info", {"server_id": server_id})
        if st != 200 or not j:
            return st, []
        ts = j.get("tournament_stats") or {}
        return st, ts.get("tournament_stats_all_list") or []

    def champ_names(self):
        """championId → 영문 ID (Data Dragon). 실패하면 빈 dict → 숫자 ID를 이름으로 사용"""
        if self._champ is None:
            self._champ = {}
            try:
                v = requests.get("https://ddragon.leagueoflegends.com/api/versions.json", timeout=15).json()[0]
                d = requests.get(f"https://ddragon.leagueoflegends.com/cdn/{v}/data/ko_KR/champion.json", timeout=15).json()
                self._champ = {int(c["key"]): c["id"] for c in d["data"].values()}
            except Exception:
                pass
        return self._champ
