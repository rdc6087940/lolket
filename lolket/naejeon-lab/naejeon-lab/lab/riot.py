"""Riot API 클라이언트.

- 개발 키(24시간 만료)를 전제로 설계: 요청마다 .env 를 다시 읽어서, 실행 중에 키를 바꿔 넣어도 이어서 동작
- 응답 헤더(X-App-Rate-Limit / X-Method-Rate-Limit)를 읽어 한도에 맞춰 스스로 속도 조절
- 429면 Retry-After 만큼 쉬고 재시도, 401/403(키 만료)이면 새 키를 기다림
"""
import os
import time
import threading
from collections import deque
from urllib.parse import quote

import requests
from dotenv import dotenv_values

REGIONAL = "https://asia.api.riotgames.com"   # account-v1, match-v5 (KR)
PLATFORM = "https://kr.api.riotgames.com"     # league-v4, summoner-v4


class KeyExpired(Exception):
    pass


class _Window:
    """'n회 / s초' 하나를 관리하는 슬라이딩 윈도"""
    def __init__(self, n, s):
        self.n, self.s = n, s
        self.t = deque()

    def wait_time(self, now):
        while self.t and now - self.t[0] >= self.s:
            self.t.popleft()
        if len(self.t) < self.n:
            return 0.0
        return self.s - (now - self.t[0]) + 0.05

    def hit(self, now):
        self.t.append(now)


class RateLimiter:
    def __init__(self, spec="20:1,100:120", safety=0.9):
        self.lock = threading.Lock()
        self.safety = safety
        self.set_spec(spec)

    def set_spec(self, spec):
        wins = []
        for part in str(spec).split(","):
            if ":" not in part:
                continue
            n, s = part.split(":")
            n = max(1, int(int(n) * self.safety))
            wins.append(_Window(n, int(s)))
        self.windows = wins or [_Window(18, 1), _Window(90, 120)]

    def acquire(self):
        while True:
            with self.lock:
                now = time.monotonic()
                w = max(win.wait_time(now) for win in self.windows)
                if w <= 0:
                    for win in self.windows:
                        win.hit(now)
                    return
            time.sleep(min(w, 5))


class Riot:
    def __init__(self, env_path=".env", log=print):
        self.env_path = env_path
        self.log = log
        self.limiter = RateLimiter()
        self.session = requests.Session()
        self.calls = 0
        self._spec_seen = None

    def key(self):
        vals = dotenv_values(self.env_path) if os.path.exists(self.env_path) else {}
        return (vals.get("RIOT_API_KEY") or os.environ.get("RIOT_API_KEY") or "").strip()

    def get(self, url, params=None, allow_404=True, max_retry=8):
        """GET → (status, json|None). 키 만료면 새 키가 들어올 때까지 대기."""
        retry = 0
        while True:
            k = self.key()
            if not k:
                raise KeyExpired("RIOT_API_KEY 가 비어 있습니다 (.env 확인)")
            self.limiter.acquire()
            try:
                r = self.session.get(url, params=params, headers={"X-Riot-Token": k}, timeout=20)
            except requests.RequestException as e:
                retry += 1
                if retry > max_retry:
                    raise
                self.log(f"  네트워크 오류, 재시도 {retry}: {e}")
                time.sleep(min(30, 2 ** retry))
                continue
            self.calls += 1
            spec = r.headers.get("X-App-Rate-Limit")
            if spec and spec != self._spec_seen:
                self._spec_seen = spec
                self.limiter.set_spec(spec)
                self.log(f"  레이트 리밋 감지: {spec}")
            if r.status_code == 200:
                return 200, r.json()
            if r.status_code == 404 and allow_404:
                return 404, None
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", "10"))
                self.log(f"  429 한도 초과 → {wait}초 대기")
                time.sleep(wait + 1)
                continue
            if r.status_code in (401, 403):
                self.log("  🔑 API 키가 만료/거부되었습니다. .env 의 RIOT_API_KEY 를 새 키로 바꾸면 자동으로 이어갑니다… (60초마다 확인)")
                old = k
                while self.key() == old:
                    time.sleep(60)
                continue
            if r.status_code >= 500:
                retry += 1
                if retry > max_retry:
                    return r.status_code, None
                time.sleep(min(60, 2 ** retry))
                continue
            return r.status_code, None

    # ── 엔드포인트 ───────────────────────────────────────────
    def account_by_riot_id(self, name, tag):
        return self.get(f"{REGIONAL}/riot/account/v1/accounts/by-riot-id/{quote(name)}/{quote(tag)}")

    def account_by_puuid(self, puuid):
        return self.get(f"{REGIONAL}/riot/account/v1/accounts/by-puuid/{puuid}")

    def match_ids(self, puuid, start=0, count=100, start_time=None, end_time=None, queue=None, type_=None):
        p = {"start": start, "count": count}
        if start_time:
            p["startTime"] = int(start_time // 1000)
        if end_time:
            p["endTime"] = int(end_time // 1000)
        if queue is not None:
            p["queue"] = queue
        if type_:
            p["type"] = type_
        return self.get(f"{REGIONAL}/lol/match/v5/matches/by-puuid/{puuid}/ids", params=p)

    def match(self, match_id):
        return self.get(f"{REGIONAL}/lol/match/v5/matches/{match_id}")

    def league_by_puuid(self, puuid):
        return self.get(f"{PLATFORM}/lol/league/v4/entries/by-puuid/{puuid}")
