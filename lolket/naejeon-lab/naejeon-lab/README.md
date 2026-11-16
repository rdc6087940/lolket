# 내전 분석 랩 (Windows)

커뮤니티 멤버들끼리 한 **내전 기록만** deeplol 에서 바닥까지 긁어서(솔로랭크 기록은 사용 안 함)
내전 승률 예측 수식과 선수 분석값을 학습하고,
로컬 페이지로 조회하고, 결과 JSON을 GitHub에 올리는 프로그램입니다. 구조는 `docs/ARCHITECTURE.md`.

## 0. 준비물
- Python 3.11 이상 (설치할 때 **Add python.exe to PATH** 체크)
- (선택) Ollama — 무료 로컬 LLM 조언용 (아래 "LLM 조언 설정")
- (선택) git — GitHub 업로드용

## 1. 설치 (한 번)
폴더에서 `setup.bat` 더블클릭
→ 가상환경(.venv) 생성, 패키지 설치, `config.yaml` / `.env` / `members.txt` 생성

## 2. 키 없이 화면 먼저 보기 (선택)
`demo.bat` → 가짜 데이터로 학습 후 `serve_demo.bat` → 브라우저에서 http://127.0.0.1:8787

## 3. 설정
- Riot API 키는 필요 없습니다.
- `members.txt` : `members.bat` 실행 → deeplol 롤하냥 멤버를 **puuid**로 자동 작성 (닉네임이 바뀌어도 안전).
  내전 N판 이상만 넣으려면 실행할 때 숫자 입력 (예: 20). 직접 쓸 때는 한 줄에 `puuid` 또는 `닉네임#태그`
- `config.yaml` : `collect.days` (0 = 가능한 전부, 365 = 1년)

**내전 판정**: 10명 전원이 members.txt 에 있는 경기만 커뮤니티 내전으로 수집·학습합니다.

예전 버전(솔랭 수집)으로 모은 데이터가 있으면 처음 실행할 때 `data/lab.old-날짜.sqlite` 로 자동 보관하고 새로 시작합니다.

## 4. 실행 순서
| 순서 | 파일 | 하는 일 |
|---|---|---|
| ⓪ | `members.bat` | deeplol 커뮤니티 멤버 → members.txt (puuid) |
| ① | `doctor.bat` | deeplol 접속·멤버 확인 + 최근 내전이 **커뮤니티 내전(10명 전원 멤버)으로 판정되는지** 점검 |
| ② | `collect.bat` | 등록 → 멤버별 내전 목록 → 10명 전원 멤버인 경기 상세 받기. 진행 막대·남은 시간·창 제목에 % (창 닫아도 다시 켜면 이어서) |
|  | `status.bat` | 지금까지 수집 현황 (수집 중에도 따로 열어서 확인 가능) |
| ③ | `cycle.bat` | 정리 → 학습(최적화) → LLM 조언 → 재학습 → 내보내기 |
| ④ | `serve.bat` | 조회 페이지 열기 |
| ⑤ | `publish.bat` | GitHub 업로드 |

명령어로 직접:
```
.venv\Scripts\activate
python -m lab doctor 닉네임#태그
python -m lab seed
python -m lab collect
python -m lab cycle --trials 80 --loops 2
python -m lab serve
python -m lab publish
```

## 5. GitHub 업로드 설정 (config.yaml → github)
- 방법 1 (git): 저장소를 clone 해두고 `repo_dir: C:/dev/naejeon-model`
- 방법 2 (git 없이): `repo: owner/name` + `.env`의 `GITHUB_TOKEN` (repo contents 쓰기 권한)

올라가는 파일: `model/latest.json`, `model/players.json`
룽잉닷컴 연동 방법은 `docs/ARCHITECTURE.md` 5장.

## LLM 조언 설정 (무료 · 선택)
1. https://ollama.com/download 에서 Windows용 설치 (설치하면 백그라운드에서 자동 실행)
2. 명령 프롬프트에서 모델 받기: `ollama pull qwen2.5:7b` (약 4.7GB, 한국어 잘함 · RAM 16GB 권장)
   - PC가 약하면 `qwen2.5:3b` (RAM 8GB), 강하면 `qwen2.5:14b` (RAM 32GB / VRAM 12GB+)
   - 바꾼 모델명은 `.env`의 `OLLAMA_MODEL`에 적기
3. `cycle.bat` 실행 시 자동으로 사용. Ollama가 꺼져 있으면 조언만 건너뛰고 학습은 그대로 진행

인터넷·API 키·요금 없이 내 PC에서만 돌아갑니다. 조언 품질은 유료 모델보다 낮을 수 있지만,
제안은 항상 교차검증 점수로 채택 여부가 결정되므로 엉뚱한 제안이 모델을 망치지는 않습니다.

## 수집하는 데이터 (경기마다 원본 통째로 보관 + 분석용 표)
- **경기**: 승패, 길이, 패치, 첫 킬·첫 포탑·첫 용·첫 유충·첫 전령·첫 바론, 팀별 킬·용·바론·전령·유충·포탑·억제기·골드, 15분 시점 팀 점수/승률 지표, 시리즈
- **선수**: 라인, 챔피언, 경기 당시 티어, K/D/A·KDA·킬관여, CS·분당 CS, 골드·분당 골드·골드 비중, 챔피언 피해·분당 피해·피해 비중, 받은 피해, 와드 설치/제거·제어와드, deeplol AI 점수·순위, MVP/ACE, 멀티킬,
  라인전(15분) K/D/A·CS·AI 점수·킬관여·레벨·와드, 솔로킬/솔로데스, 선취점, 15분 전 킬/데스, 오브젝트·포탑 관여,
  스펠·강타 종류·룬(메인/보조/핵심)·최종 아이템·아이템 구매 순서·스킬 순서·핑 종류별 횟수·AI 점수 세부
- **이벤트**: 킬·용·바론·전령·유충·포탑·전령의 눈 사용 하나하나 (시각, 좌표, 관여자, 승률 변화)
- **타임라인**: 분 단위 라인별 점수 흐름과 팀 오브젝트

## 결과 보는 법
- 콘솔: 점수 기준선 vs AI 정답률, 시리즈 정답률, 가중치
- `output/runs/<실행ID>/` : report.json, best_params.json, predictions.json, advice.md, suggestions.json
- `output/model/` : 룽잉닷컴용 최종 결과
