"""LLM 보조 (로컬 오픈소스 LLM · Ollama) — 무료, 선택 기능

ML이 가중치·보정치를 계산하고, LLM은 '사람 분석가' 역할을 한다.
  - 학습 결과(정답률, 가중치, 중요도, 보정 곡선, 이변 경기 통계)를 읽고
  - 해석 리포트(markdown)와
  - 다음 학습에서 시도할 설정(JSON, 허용된 항목만)을 제안한다.

안전장치: LLM이 코드를 쓰거나 실행하지 않는다. 제안 JSON은 허용 목록으로 검증한 뒤
'다음 학습의 첫 시도'로만 들어가고, 실제 채택 여부는 교차검증 점수가 결정한다.
"""
import json
import os
import re
from pathlib import Path

import requests
from dotenv import dotenv_values

from .features import FEATURE_NAMES, PLAYER_FEATURES

ALLOWED_PARAM_RANGES = {
    "window_days": [90, 180, 365, 540, 730],
    "half_life_days": (14, 365),
    "prior_games": (3, 80),
    "recent_n": [10, 20, 40],
    "elo_k": (8, 48),
    "C": (1e-3, 10),
}

SYSTEM = """너는 리그 오브 레전드 내전(커스텀 5:5) 승률 예측 모델을 개선하는 데이터 분석가다.
입력으로 학습 리포트가 주어진다. 다음을 한국어로 작성하라.
1) 현재 모델 요약: 정답률(점수 기준선 대비), 보정(예측 확률이 실제와 맞는지), 신뢰할 수 있는지
2) 가중치 해석: 어떤 변수가 승패를 가장 잘 설명하는지, 직관과 다른 점
3) 의심되는 문제: 과적합, 표본 부족, 누수 가능성, 데이터 편향
4) 다음 실험 제안: 새 변수 아이디어(수집 데이터로 계산 가능한 것만), 파라미터 조정 방향
마지막에 반드시 ```json 블록 하나로 다음 형식의 제안을 넣어라:
{"try_params": [{"window_days":365,"half_life_days":60,"prior_games":20,"recent_n":20,"elo_k":24,"C":0.3,
  "use_<변수>": true|false ...}], "disable_features": ["변수명"], "new_feature_ideas": [{"name":"...","definition":"...","why":"..."}]}
try_params 값은 허용 범위 안에서만: """ + json.dumps(ALLOWED_PARAM_RANGES, ensure_ascii=False) + \
    "\n변수명 목록: " + ", ".join(FEATURE_NAMES)


def _ollama_cfg():
    vals = dotenv_values(".env") if os.path.exists(".env") else {}
    host = (vals.get("OLLAMA_HOST") or os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")
    if not host.startswith("http"):
        host = "http://" + host
    model = vals.get("OLLAMA_MODEL") or os.environ.get("OLLAMA_MODEL") or "qwen2.5:7b"
    return host, model


def _chat(host, model, system, user, log):
    """Ollama /api/chat 호출. 실패 시 (None, 이유)"""
    try:
        tags = requests.get(host + "/api/tags", timeout=5).json()
    except Exception:
        return None, f"Ollama 에 연결할 수 없습니다 ({host}). Ollama 를 설치·실행했는지 확인하세요."
    names = [m.get("name", "") for m in tags.get("models", [])]
    if not any(n == model or n.split(":")[0] == model for n in names):
        return None, f"모델 '{model}' 이 없습니다. 명령 프롬프트에서: ollama pull {model}"
    log(f"LLM 조언 생성 중… (Ollama · {model}, PC 사양에 따라 1~5분)")
    r = requests.post(host + "/api/chat", json={
        "model": model, "stream": False,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "options": {"temperature": 0.3, "num_ctx": 16384},
    }, timeout=1800)
    if r.status_code != 200:
        return None, f"Ollama 오류 {r.status_code}: {r.text[:200]}"
    return r.json().get("message", {}).get("content", ""), None


def _extract_json(text):
    m = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if m:
        return m[-1]
    i, j = text.rfind('{"try_params"'), text.rfind("}")
    return text[i:j + 1] if i >= 0 and j > i else None


def _validate(s):
    ok = {"try_params": [], "disable_features": [], "new_feature_ideas": []}
    for tp in (s.get("try_params") or [])[:3]:
        clean = {}
        for k, v in tp.items():
            if k.startswith("use_") and k[4:] in FEATURE_NAMES:
                clean[k] = bool(v)
            elif k in ALLOWED_PARAM_RANGES:
                rng = ALLOWED_PARAM_RANGES[k]
                if isinstance(rng, list):
                    if v in rng:
                        clean[k] = v
                else:
                    try:
                        clean[k] = min(max(float(v), rng[0]), rng[1])
                    except Exception:
                        pass
        if clean:
            ok["try_params"].append(clean)
    ok["disable_features"] = [f for f in (s.get("disable_features") or []) if f in FEATURE_NAMES]
    ok["new_feature_ideas"] = (s.get("new_feature_ideas") or [])[:10]
    return ok


def advise(report, run_dir, log=print):
    host, model = _ollama_cfg()
    slim = {k: report.get(k) for k in ("n_games", "params", "C", "features", "cv_linear", "cv_score", "holdout_linear",
                                       "holdout_score", "holdout_gbm", "gbm_importance", "calibration",
                                       "series_linear", "series_score", "formula", "best_cv_logloss")}
    slim["feature_docs"] = dict(PLAYER_FEATURES)
    user = "학습 리포트:\n```json\n" + json.dumps(slim, ensure_ascii=False) + "\n```"
    try:
        text, err = _chat(host, model, SYSTEM, user, log)
    except Exception as e:
        text, err = None, f"Ollama 호출 실패: {e}"
    if err:
        log(f"LLM 조언 건너뜀 — {err}")
        return None
    Path(run_dir, "advice.md").write_text(text, encoding="utf-8")
    raw = _extract_json(text)
    sugg = None
    if raw:
        try:
            sugg = _validate(json.loads(raw))
            Path(run_dir, "suggestions.json").write_text(json.dumps(sugg, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            log(f"제안 JSON 해석 실패 (조언 글은 저장됨): {e}")
    else:
        log("제안 JSON 이 없어 조언 글만 저장했습니다")
    log(f"LLM 조언 저장: {Path(run_dir, 'advice.md')}")
    return sugg
