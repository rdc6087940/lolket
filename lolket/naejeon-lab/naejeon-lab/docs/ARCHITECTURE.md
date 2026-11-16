# 내전 분석 랩 — 구조 설계

룽잉닷컴과 완전히 분리된 **로컬 전용 데이터 수집·학습 프로그램**입니다.
**커뮤니티 멤버들끼리 한 내전 기록만** 사용합니다 (솔로랭크 기록·Riot API 사용 안 함).
결과물(수식 + 선수 점수)만 GitHub에 올리고, 룽잉닷컴은 그 JSON을 읽어서 씁니다.

```
 members.txt (deeplol puuid) ──seed──▶ members
                                        │
 deeplol ◀──collect── 멤버별 커스텀 경기 목록(바닥까지) → member_matches
                       │  10명 전원이 멤버인 경기만 = 커뮤니티 내전
                       └→ 내전 상세 원본 통째로 → matches_raw
                                        ▼
                                     build ── games / game_players / game_events / game_timeline / 시리즈
                                        ▼
   ┌────────────── train (학습 루프) ──────────────┐
   │ features: 그 경기 "이전" 커뮤니티 내전 기록만으로 변수 계산 │
   │ Optuna: 변수 계산 방식 + 변수 선택 + 규제 탐색     │
   │ 시간순 교차검증 (미래 정보 누설 없음)               │
   │ 최종 수식 = 로지스틱(팀 평균 차이) → 가중치 확정    │
   │ LightGBM = 비교용 기준                            │
   └──────────────┬───────────────────────────────┘
                  ▼
        advisor (Ollama 로컬 LLM, 무료·선택) ── 결과 해석 + 다음 실험 제안 → 다음 train 첫 시도
                  ▼
   export → output/model/latest.json + players.json
                  │
        serve(로컬 조회 페이지)    publish → GitHub → 룽잉닷컴이 raw URL로 읽음
```

## 1. 수집 (lab/collect.py, lab/deeplol.py)

| 단계 | 내용 |
|---|---|
| members | deeplol 커뮤니티 멤버 목록(`/tournament/server_info?server_id=156`) → members.txt (deeplol puuid) |
| seed | members.txt → members 표. 사람 구분은 deeplol puuid (닉네임이 바뀌어도 그대로) |
| 목록 | 멤버마다 `/match/matches?queue_type=CUSTOM` 을 20개씩 `collect.days`(0=끝)까지 내려가며 member_matches 에 기록. 다음 실행부터는 새 경기만 |
| 내전 판정 | **멤버 10명의 목록에 모두 나온 경기**만 후보 → 상세에서 10명 전원이 멤버인지 다시 확인 (`community_min_members: 10`) |
| 상세 | `/match/match-cached` 원본을 통째로 matches_raw 에 저장 (참가자 전 스탯·룬·아이템·스킬·핑·AI 점수 세부, 이벤트, 분 단위 타임라인) |

- Riot API는 일반 커스텀 게임 기록을 정책상 주지 않아(토너먼트 코드 게임만 예외) deeplol 을 씁니다. 비공식 API라 예고 없이 바뀌거나 막힐 수 있어 요청 간격(`deeplol_interval_s`, 기본 0.4초)을 둡니다.
- 외부인이 섞인 경기는 상세를 아예 받지 않습니다(요청 절약).
- 언제 끊어도 다시 실행하면 이어서 합니다.

## 2. 정리 (lab/build.py)
- `games`: 승패, 길이, 패치, 첫 킬/포탑/용/유충/전령/바론, 팀별 킬·용·바론·전령·유충·포탑·억제기·골드, 15분 팀 점수·승률 지표, 시리즈
- `game_players`: 라인, 챔피언, 경기 당시 티어, 최종·라인전(15분) 스탯, 분당 수치, 딜·골드 비중, 시야, AI 점수, 솔로킬/데스, 선취점, 15분 전 킬/데스, 오브젝트 관여, 룬·스펠·아이템·스킬·핑(JSON 포함)
- `game_events`: 킬·오브젝트·포탑·아이템 이벤트 (시각·좌표·관여자·승률 변화)
- `game_timeline`: 분 단위 라인별 점수와 오브젝트
- 시리즈: 같은 10명이 `series_gap_hours`(기본 3시간) 안에 이어서 한 경기

## 3. 변수 (lab/features.py)
경기 시각 t 직전까지의 **커뮤니티 내전 기록만**으로 선수 × 라인 지표를 계산합니다 (point-in-time).

| 변수 | 의미 |
|---|---|
| tier | 경기 당시 티어 (그 내전 기록에 함께 저장된 값 — 경기 전에 알 수 있음) |
| elo / wr / games / form | 내전 Elo, 승률(표본 보정), 경험, 최근 N판 승률 |
| role_wr / role_share | 이번 라인 승률, 라인 비중 |
| ai / lane_ai | deeplol AI 점수, 라인전 AI 점수 |
| kda / kp / cspm / dpm / gpm / dtpm / vision | 라인 기준 시간 감쇠 평균 |
| dmg_share / gold_share | 팀 내 비중 |
| early_death / solo_kill / obj | 15분 전 데스, 솔로킬, 오브젝트 관여 |
| champ_games / champ_wr | 이번 챔피언 숙련·승률 |
| duo | 이번 팀원들과 같은 팀일 때 승률 (쌍별) |
| lane_vs | 이번 맞라인 상대와의 상대전적 |

**변수를 "어떻게 계산할지"도 학습 대상**: 반감기, 기간, 표본 보정 강도, 최근 폼 판수, Elo K.
입력 X = (블루 5명 평균) − (레드 5명 평균), 정답 y = 블루 승. 점수 기준선 = 경기 당시 티어만 쓴 모델.

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
lab/deeplol.py   deeplol API (멤버·내전 목록·상세)
lab/collect.py   수집 / 내전 판정 / doctor
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
