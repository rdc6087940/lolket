# 내전 분석 랩 — 구조 설계

룽잉닷컴과 완전히 분리된 **로컬 전용 데이터 수집·학습 프로그램**입니다.
결과물(수식 + 선수 점수)만 GitHub에 올리고, 룽잉닷컴은 그 JSON을 읽어서 씁니다.

```
 members.txt ──seed──▶ accounts
                          │
  deeplol(내전) + Riot API(랭크) ◀──collect── 매치 ID 전부(바닥까지) → 매치 상세 원본(matches_raw)
                          │          └ 내전 같이 뛴 사람 자동 추가(discover)
                          ▼
                       build ── games / game_players / 시리즈 묶기
                          │
                          ▼
   ┌────────────── train (학습 루프) ──────────────┐
   │ features: 그 경기 "이전" 기록만으로 선수 지표 계산 │
   │ Optuna: 변수 계산 방식 + 변수 선택 + 규제 탐색     │
   │ 시간순 교차검증으로 평가 (미래 정보 누설 없음)      │
   │ 최종 수식 = 로지스틱(팀 평균 차이) → 가중치 확정    │
   │ LightGBM = 비교용 기준 (수식이 얼마나 놓치는지)    │
   └──────────────┬───────────────────────────────┘
                  │ report.json
                  ▼
        advisor (Ollama 로컬 LLM, 무료·선택) ── 결과 해석 + 다음 실험 제안(JSON)
                  │                     └ 다음 train 의 첫 시도로 자동 투입
                  ▼
   export → output/model/latest.json + players.json
                  │
        serve(로컬 조회 페이지)    publish → GitHub → 룽잉닷컴이 raw URL로 읽음
```

## 1. 수집 (lab/collect.py, lab/riot.py)

| 단계 | 내용 |
|---|---|
| seed | `members.txt`의 `닉네임#태그` → account-v1(asia)로 puuid 확인 |
| scan_ids | 내전: deeplol 목록을 `days`까지 과거로 내려감 · 랭크: match-v5 `by-puuid/ids`를 큐별(420 솔랭·440 자랭)로 100개씩. 처음엔 백필, 이후엔 새로 생긴 것만 |
| fetch_details | 상세 대기열에서 **내전 우선**으로 받아 `matches_raw`에 원본 JSON 그대로 저장 |
| discover | 내전에서 같이 뛴 10명 중 아직 없는 사람을 수집 대상에 자동 추가 |
| league | league-v4(kr)로 티어 스냅샷을 주기적으로 기록 (시점별 티어용) |

- **개발 키 24시간 만료**: 매 요청마다 `.env`를 다시 읽습니다. 401/403이 나면 멈춰서 기다리고, `.env`의 키만 새 걸로 저장하면 그 자리에서 이어집니다.
- **속도 제한**: 응답 헤더 `X-App-Rate-Limit`을 읽어 창(1초/2분)별로 90%까지만 씁니다. 429면 `Retry-After`만큼 쉼.
- 언제 끊어도 됩니다. 모든 진행 상태가 SQLite(`data/lab.sqlite`)에 있어서 다시 실행하면 이어서 합니다.
- 개발 키 한도(약 100회/2분) 기준 매치 상세 1건 = 요청 1회 → **시간당 약 3,000경기**. 50명 × 1년(랭크 포함) 수만 경기면 하루 이상 걸릴 수 있습니다.

### 내전(정답) 데이터 출처 = deeplol API
Riot API는 **일반 사용자 설정 게임(커스텀) 기록을 정책상 제공하지 않습니다** (토너먼트 코드로 연 게임만 예외).
그래서 내전 기록은 룽잉닷컴 stats 페이지와 같은 **deeplol API**에서 받습니다 (`lab/deeplol.py`).

| 용도 | 출처 |
|---|---|
| 내전 목록 | `b2c-api-cdn.deeplol.gg/match/matches?puu_id=…&queue_type=CUSTOM` (20개씩, 최신순) |
| 내전 상세 | `/match/match-cached?match_id=…` → match-v5 모양으로 변환해 `matches_raw`에 저장 |
| 랭크 기록·티어 | Riot API (match-v5, league-v4) |

- **계정 연결**: deeplol 은 puuid 를 자기 키로 암호화해서 주므로 내 Riot 키의 puuid 와 값이 다릅니다.
  deeplol 커뮤니티 멤버 목록(`/tournament/server_info?server_id=156`의 닉네임#태그 + deeplol puuid)으로 계정을 찾고,
  내전 참가자는 닉네임#태그로 Riot 계정을 조회해 내 키 puuid 로 바꿔 저장합니다(`puuid_map` 캐시).
  Riot에서 못 찾은 참가자(닉네임 변경 등)는 `dl:<deeplol puuid>`로 구분해 내전 기록만 사용합니다.
- 다시하기(remake)·10명이 아닌 경기는 제외
- 상세 대기열에서 우선순위 0 = deeplol 내전, 3 = Riot 랭크
- 비공식 API라 예고 없이 바뀌거나 막힐 수 있음 → 요청 간격 `collect.deeplol_interval_s`(기본 0.4초)
- `config.yaml`의 `collect.custom_source`: `deeplol`(기본) / `riot`(토너먼트 코드 등 Riot에 기록이 있는 경우) / `none`
- `doctor`로 deeplol에서 그 계정의 최근 내전이 받아지는지 먼저 확인

## 2. 정리 (lab/build.py)
- `games`: 경기 1건 (블루 승 여부, 내전 여부, 패치, 시리즈 번호)
- `game_players`: 선수 1명 × 경기 (라인 = teamPosition → individualPosition → lane 순서로 판단, KDA·CS·골드·딜·시야)
- 시리즈: 같은 10명이 `series_gap_hours`(기본 3시간) 안에 이어서 한 경기들을 묶음

## 3. 변수 (lab/features.py)
경기 시각 t 직전까지의 기록만으로 선수 × 라인 지표를 계산합니다 (point-in-time, 누설 없음).

| 변수 | 의미 |
|---|---|
| tier | 그 시점 티어 점수 (스냅샷 또는 최근 경기 기준) |
| custom_elo / custom_wr / custom_games | 내전 Elo, 내전 승률(베이즈 보정), 내전 판수 |
| wr / role_wr / role_share | 랭크 승률, 그 라인 승률, 그 라인 비중 |
| form | 최근 N판 승률 |
| kda / cspm / dpm / gpm / vspm | 그 라인 기준 지표 (시간 감쇠 가중 평균) |
| champ_games | 그 챔피언 숙련도 |

**변수를 "어떻게 계산할지"도 학습 대상**입니다: 반감기(half_life_days), 기간(window_days), 베이즈 사전 판수(prior_games), 최근 폼 판수(recent_n), Elo K, 티어 스냅샷 사용 여부.

입력 X = (블루팀 5명 평균) − (레드팀 5명 평균), 정답 y = 블루 승.

## 4. 학습 루프 (lab/train.py, lab/advisor.py)
1. Optuna(TPE)가 한 번 시도할 때마다: 변수 계산 방식 + 어떤 변수를 쓸지 + 규제 강도 C 를 고름
2. 시간순 5-fold 교차검증(항상 과거로 학습 → 미래 예측)으로 log-loss 측정
3. 가장 좋은 설정으로 최종 수식 학습 → 마지막 20%를 홀드아웃으로 별도 검증
4. 비교 지표: 점수 기준선(티어만) / AI 수식 / LightGBM / 시리즈 정답률 / 보정 곡선
5. (선택) `--advise`: 로컬 오픈소스 LLM(Ollama, 기본 qwen2.5:7b)이 report.json을 읽고 `advice.md` + `suggestions.json` 작성
   - 제안은 허용된 범위(ALLOWED_PARAM_RANGES)만 통과
   - 다음 `train`에서 Optuna의 **첫 시도로 자동 투입** → 좋으면 채택, 나쁘면 버려짐 (LLM이 수식을 직접 정하지 않고, 항상 검증 점수로 판정)
6. 직전 최적 설정도 다음 실행의 첫 시도로 들어가서, 데이터가 쌓일수록 점진적으로 개선

`cycle` = build → (train → 조언) × loops

## 5. 결과물 계약 — 룽잉닷컴이 읽는 형식

`model/latest.json` (schema `naejeon-lab/model@1`)
```json
{
  "version": "20261115-092215",
  "side_bias": -0.0089,
  "formula": {"type": "logistic_team_mean_diff", "intercept": 0.03,
              "features": [{"name": "role_wr", "mean": 0.0019, "std": 0.028, "weight": 0.354}, ...]},
  "metrics": {...}, "feature_params": {...}, "feature_docs": {...}
}
```

`model/players.json`
```json
{"schema": "...", "version": "...",
 "players": {"닉네임#태그(소문자)": {"name": "...", "main_role": "MIDDLE", "best_role": "MIDDLE",
             "custom_elo": 1522, "roles": {"TOP": {"score": -1.03, ...}, "MIDDLE": {"score": 1.55, ...}}}}}
```

**룽잉닷컴 쪽 계산 (선수 점수가 이미 가중치·표준화를 다 반영한 값이라 더하기만 하면 됨)**
```js
const score = (name, role) => players[name.toLowerCase()]?.roles?.[role]?.score ?? 0;
const sumA = teamA.reduce((s, p) => s + score(p.name, p.role), 0);
const sumB = teamB.reduce((s, p) => s + score(p.name, p.role), 0);
const bias = side === 'blue' ? model.side_bias : side === 'red' ? -model.side_bias : 0;
const pA = 1 / (1 + Math.exp(-(bias + (sumA - sumB) / 5)));   // A팀 승률
```
- 명단에 없는 사람은 0점(평균)으로 처리
- 읽는 주소 예: `https://raw.githubusercontent.com/<owner>/<repo>/main/model/latest.json`
- `version`이 바뀌면 캐시 갱신

## 6. 조회 페이지 (lab/server.py, web/index.html)
`python -m lab serve` → http://127.0.0.1:8787

| 탭 | 내용 |
|---|---|
| 지표 | 점수 vs AI 정답률(경기·시리즈), 경기·사용자 수, 균형 판 비율, 팀별 승률, 우세도별 실제 승률, 티어 분포 |
| 사용자 | 전체 목록(정렬·검색) → 상세: 라인별 성적·전력 점수, 점수 구성, 월별 추이, 챔피언, 팀 궁합, 최근 내전 |
| 내전 | 달력 → 날짜별 시리즈, 경기마다 점수/AI 예측과 적중 여부 |
| 팀뽑 | 10명 입력 → 126개 팀 조합 × 120개 라인 배치를 전부 계산해 50%에 가까운 순으로 제안 |
| 모델 | 가중치, 보정 곡선, 학습 기록, LLM 조언 |

## 7. 파일
```
lab/db.py        SQLite 스키마
lab/riot.py      Riot API + 속도 제한 + 키 자동 재로딩
lab/collect.py   수집 / doctor
lab/build.py     정리 + 시리즈
lab/features.py  시점별 변수
lab/train.py     최적화·학습·검증
lab/advisor.py   LLM 조언
lab/export.py    latest.json / players.json
lab/publish.py   GitHub 업로드
lab/server.py    조회 API
lab/demo.py      가짜 데이터 (키 없이 미리보기)
web/index.html   조회 페이지
```
