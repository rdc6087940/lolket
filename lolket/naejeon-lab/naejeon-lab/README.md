# 내전 분석 랩 (Windows)

커뮤니티 멤버들의 Riot 기록을 바닥까지 긁어서 내전 승률 예측 수식과 선수 분석값을 학습하고,
로컬 페이지로 조회하고, 결과 JSON을 GitHub에 올리는 프로그램입니다. 구조는 `docs/ARCHITECTURE.md`.

## 0. 준비물
- Python 3.11 이상 (설치할 때 **Add python.exe to PATH** 체크)
- Riot 개발 키: https://developer.riotgames.com (24시간마다 재발급)
- (선택) Ollama — 무료 로컬 LLM 조언용 (아래 "LLM 조언 설정")
- (선택) git — GitHub 업로드용

## 1. 설치 (한 번)
폴더에서 `setup.bat` 더블클릭
→ 가상환경(.venv) 생성, 패키지 설치, `config.yaml` / `.env` / `members.txt` 생성

## 2. 키 없이 화면 먼저 보기 (선택)
`demo.bat` → 가짜 데이터로 학습 후 `serve_demo.bat` → 브라우저에서 http://127.0.0.1:8787

## 3. 설정
- `.env` : `RIOT_API_KEY=RGAPI-...` (만료되면 이 줄만 바꿔 저장 → 수집 중이어도 자동으로 이어짐)
- `members.txt` : `members.bat` 실행 → deeplol 롤하냥 멤버를 **puuid**로 자동 작성 (닉네임이 바뀌어도 안전).
  내전 N판 이상만 넣으려면 실행할 때 숫자 입력 (예: 20). 직접 쓸 때는 한 줄에 `puuid` 또는 `닉네임#태그`
- `config.yaml` : `collect.days` (365 = 1년, 0 = 가능한 전부)

## 4. 실행 순서
| 순서 | 파일 | 하는 일 |
|---|---|---|
| ⓪ | `members.bat` | deeplol 커뮤니티 멤버 → members.txt (puuid) |
| ① | `doctor.bat` | Riot 키 확인 + **deeplol에서 내전 기록이 받아지는지 점검** — 꼭 먼저 |
| ② | `collect.bat` | 등록 + 수집. 진행 막대·남은 시간·창 제목에 % 표시 (오래 걸림. 창 닫아도 다시 켜면 이어서) |
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

## 결과 보는 법
- 콘솔: 점수 기준선 vs AI 정답률, 시리즈 정답률, 가중치
- `output/runs/<실행ID>/` : report.json, best_params.json, predictions.json, advice.md, suggestions.json
- `output/model/` : 룽잉닷컴용 최종 결과
