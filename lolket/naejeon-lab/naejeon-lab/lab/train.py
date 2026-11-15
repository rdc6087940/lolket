"""학습 · 최적화

모델 3종을 같은 시간순 검증으로 비교한다.
  1) score  : 티어 점수 차이만 쓰는 기준선 (jkdice의 '점수 승률'에 해당)
  2) linear : 표준화된 변수 차이 × 가중치 → 로지스틱  ← 룽잉닷컴으로 내보내는 '수식'
  3) gbm    : LightGBM (정확도 상한 확인 + 변수 중요도 → 다음 실험 힌트)

Optuna가 linear 모델의 정규화 강도·변수 선택·특징 생성 파라미터(반감기, 표본 보정 등)를
교차검증 log-loss 기준으로 함께 최적화한다. (미래 경기로 과거를 맞히는 누수를 막기 위해 시간순 분할)
"""
import json
import math
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss, brier_score_loss, roc_auc_score

from .features import FeatureParams, FEATURE_NAMES, build_dataset

try:
    import lightgbm as lgb
except Exception:  # 선택 의존성
    lgb = None


def _prep(X, mask, mean=None, std=None):
    Xs = X[:, mask]
    if mean is None:
        mean = np.nanmean(Xs, axis=0)
        std = np.nanstd(Xs, axis=0)
        mean = np.where(np.isnan(mean), 0, mean)
        std = np.where((std == 0) | np.isnan(std), 1, std)
    Z = (Xs - mean) / std
    Z = np.where(np.isnan(Z), 0.0, Z)   # 정보 없음 = 차이 0
    return Z, mean, std


def time_folds(n, k=5, min_train=0.4):
    """시간순 확장 창 검증: [0..a) 학습 → [a..b) 검증"""
    start = int(n * min_train)
    if n - start < k * 5:
        k = max(1, (n - start) // 5)
    edges = np.linspace(start, n, k + 1).astype(int)
    return [(np.arange(0, edges[i]), np.arange(edges[i], edges[i + 1])) for i in range(k) if edges[i + 1] > edges[i]]


def metrics(y, p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    out = {"n": int(len(y)), "acc": float(accuracy_score(y, p > 0.5)), "logloss": float(log_loss(y, p, labels=[0, 1])),
           "brier": float(brier_score_loss(y, p))}
    try:
        out["auc"] = float(roc_auc_score(y, p))
    except Exception:
        out["auc"] = None
    return out


def calibration(y, p, bins=10):
    out = []
    edges = np.linspace(0, 1, bins + 1)
    for i in range(bins):
        m = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= 1)
        if m.sum():
            out.append({"pred": float(p[m].mean()), "actual": float(y[m].mean()), "n": int(m.sum())})
    return out


def series_accuracy(meta, per_player, prob):
    """시리즈 승자 예측 정답률: 시리즈 안 경기들의 예측을 '같은 5명 팀' 기준으로 평균 → 실제 시리즈 승자와 비교"""
    teams = {}
    for r in per_player:
        teams.setdefault(r["match_id"], {}).setdefault(r["team"], set()).add(r["puuid"])
    by_series = {}
    for i, m in enumerate(meta):
        by_series.setdefault(m["series_id"], []).append(i)
    correct = total = 0
    for sid, idxs in by_series.items():
        if not sid or len(idxs) < 2:
            continue
        score, pred = {}, {}
        for i in idxs:
            t = teams.get(meta[i]["match_id"], {})
            if 100 not in t or 200 not in t:
                continue
            b, r = frozenset(t[100]), frozenset(t[200])
            yb = meta[i]["y"]
            score[b] = score.get(b, 0) + yb
            score[r] = score.get(r, 0) + (1 - yb)
            pred[b] = pred.get(b, []) + [prob[i]]
            pred[r] = pred.get(r, []) + [1 - prob[i]]
        if len(score) != 2:
            continue
        a, b = list(score)
        if score[a] == score[b]:
            continue
        actual = a if score[a] > score[b] else b
        favored = a if np.mean(pred[a]) >= np.mean(pred[b]) else b
        correct += int(actual == favored)
        total += 1
    return {"correct": correct, "total": total, "rate": (correct / total) if total else None}


class Trainer:
    def __init__(self, db, cfg, log=print):
        self.db, self.cfg, self.log = db, cfg, log
        self.cache = {}
        self.out_dir = Path(cfg.get("output_dir", "output"))

    def dataset(self, P):
        key = tuple(sorted(asdict(P).items()))
        if key not in self.cache:
            self.cache[key] = build_dataset(self.db, P, log=lambda *_: None)
            if len(self.cache) > 12:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[key]

    # ── 교차검증 점수 ───────────────────────────────────────
    def cv_linear(self, X, y, mask, C):
        ps, ys = [], []
        for tr, va in time_folds(len(y)):
            if len(set(y[tr])) < 2:
                continue
            Ztr, mu, sd = _prep(X[tr], mask)
            Zva, _, _ = _prep(X[va], mask, mu, sd)
            m = LogisticRegression(C=C, max_iter=2000)
            m.fit(Ztr, y[tr])
            ps.append(m.predict_proba(Zva)[:, 1])
            ys.append(y[va])
        if not ps:
            return None
        return np.concatenate(ys), np.concatenate(ps)

    def cv_score_baseline(self, X, y):
        i = FEATURE_NAMES.index("tier")
        mask = np.zeros(len(FEATURE_NAMES), bool)
        mask[i] = True
        return self.cv_linear(X, y, mask, 1.0)

    def cv_gbm(self, X, y, params=None):
        if lgb is None:
            return None
        ps, ys = [], []
        for tr, va in time_folds(len(y)):
            if len(set(y[tr])) < 2:
                continue
            m = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.03, num_leaves=15, min_child_samples=20,
                                   subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, **(params or {}))
            m.fit(X[tr], y[tr])
            ps.append(m.predict_proba(X[va])[:, 1])
            ys.append(y[va])
        if not ps:
            return None
        return np.concatenate(ys), np.concatenate(ps)

    # ── 최적화 ──────────────────────────────────────────────
    def optimize(self, n_trials=40, suggestions=None):
        import optuna
        optuna.logging.set_verbosity(optuna.logging.WARNING)
        sugg = suggestions or {}
        locked_off = set(sugg.get("disable_features", []))

        def objective(trial):
            P = FeatureParams(
                window_days=trial.suggest_categorical("window_days", [90, 180, 365, 540, 730]),
                half_life_days=trial.suggest_float("half_life_days", 14, 365, log=True),
                prior_games=trial.suggest_float("prior_games", 3, 80, log=True),
                recent_n=trial.suggest_categorical("recent_n", [10, 20, 40]),
                elo_k=trial.suggest_float("elo_k", 8, 48),
            )
            X, y, meta, pp, _, _ = self.dataset(P)
            if len(y) < 30:
                raise optuna.TrialPruned()
            mask = np.array([
                (fn not in locked_off) and trial.suggest_categorical(f"use_{fn}", [True, False])
                for fn in FEATURE_NAMES])
            if mask.sum() == 0:
                raise optuna.TrialPruned()
            C = trial.suggest_float("C", 1e-3, 10, log=True)
            res = self.cv_linear(X, y, mask, C)
            if res is None:
                raise optuna.TrialPruned()
            yy, pp_ = res
            return log_loss(yy, np.clip(pp_, 1e-4, 1 - 1e-4), labels=[0, 1])

        study = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=42))
        # 이전 최적값/LLM 제안을 첫 시도로 넣음
        for seed in sugg.get("try_params", []) or []:
            try:
                study.enqueue_trial(seed)
            except Exception:
                pass
        study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
        self.log(f"최적화 완료: 최고 CV log-loss {study.best_value:.4f}")
        return study

    # ── 최종 학습 + 리포트 ──────────────────────────────────
    def fit_final(self, best):
        P = FeatureParams(window_days=best["window_days"], half_life_days=best["half_life_days"],
                          prior_games=best["prior_games"], recent_n=best["recent_n"], elo_k=best["elo_k"])
        X, y, meta, per_player, hist, state = self.dataset(P)
        for i, m in enumerate(meta):
            m["y"] = int(y[i])
        mask = np.array([best.get(f"use_{fn}", True) for fn in FEATURE_NAMES])
        C = best["C"]
        n = len(y)
        cut = int(n * 0.8)
        report = {"n_games": n, "params": P.to_dict(), "C": C, "features": [fn for fn, m in zip(FEATURE_NAMES, mask) if m]}

        # 홀드아웃(마지막 20%) 성능
        Ztr, mu, sd = _prep(X[:cut], mask)
        Zte, _, _ = _prep(X[cut:], mask, mu, sd)
        lin = LogisticRegression(C=C, max_iter=2000).fit(Ztr, y[:cut])
        p_lin = lin.predict_proba(Zte)[:, 1]
        report["holdout_linear"] = metrics(y[cut:], p_lin)
        bmask = np.array([fn == "tier" for fn in FEATURE_NAMES])
        Btr, bmu, bsd = _prep(X[:cut], bmask)
        Bte, _, _ = _prep(X[cut:], bmask, bmu, bsd)
        base = LogisticRegression(C=1.0, max_iter=1000).fit(Btr, y[:cut])
        report["holdout_score"] = metrics(y[cut:], base.predict_proba(Bte)[:, 1])
        if lgb is not None and cut > 50:
            g = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.03, num_leaves=15, min_child_samples=20,
                                   subsample=0.8, colsample_bytree=0.8, verbose=-1).fit(X[:cut], y[:cut])
            report["holdout_gbm"] = metrics(y[cut:], g.predict_proba(X[cut:])[:, 1])
            report["gbm_importance"] = {fn: int(v) for fn, v in zip(FEATURE_NAMES, g.booster_.feature_importance("gain"))}

        # 전체 경기 '그 시점 예측' (시간순 검증 예측) — 웹 화면의 경기별 적중/이변 표시용
        res = self.cv_linear(X, y, mask, C)
        oof = np.full(n, np.nan)
        oof_score = np.full(n, np.nan)
        folds = time_folds(n)
        if res is not None:
            k = 0
            for tr, va in folds:
                Ztr2, mu2, sd2 = _prep(X[tr], mask)
                m2 = LogisticRegression(C=C, max_iter=2000).fit(Ztr2, y[tr])
                oof[va] = m2.predict_proba(_prep(X[va], mask, mu2, sd2)[0])[:, 1]
                B2, bm2, bs2 = _prep(X[tr], bmask)
                b2 = LogisticRegression(C=1.0, max_iter=1000).fit(B2, y[tr])
                oof_score[va] = b2.predict_proba(_prep(X[va], bmask, bm2, bs2)[0])[:, 1]
        valid = ~np.isnan(oof)
        if valid.any():
            report["cv_linear"] = metrics(y[valid], oof[valid])
            report["cv_score"] = metrics(y[valid], oof_score[valid])
            report["calibration"] = calibration(y[valid], oof[valid])
            sub_meta = [meta[i] for i in np.where(valid)[0]]
            report["series_linear"] = series_accuracy(sub_meta, per_player, oof[valid])
            report["series_score"] = series_accuracy(sub_meta, per_player, oof_score[valid])

        # 최종 수식: 전체 데이터로 다시 학습
        Zall, mu_all, sd_all = _prep(X, mask)
        final = LogisticRegression(C=C, max_iter=2000).fit(Zall, y)
        w = dict(zip([fn for fn, m in zip(FEATURE_NAMES, mask) if m], final.coef_[0].tolist()))
        formula = {
            "type": "logistic_team_mean_diff",
            "intercept": float(final.intercept_[0]),
            "features": [{"name": fn, "mean": float(mu_all[i]), "std": float(sd_all[i]), "weight": float(w[fn])}
                         for i, fn in enumerate([f for f, m in zip(FEATURE_NAMES, mask) if m])],
        }
        report["formula"] = formula
        # 경기별 예측 저장 (웹 조회용)
        preds = [{"match_id": meta[i]["match_id"], "p_ai": None if np.isnan(oof[i]) else float(oof[i]),
                  "p_score": None if np.isnan(oof_score[i]) else float(oof_score[i]), "y": int(y[i])} for i in range(n)]
        return report, P, preds, hist, state

    def run(self, n_trials=40, suggestions=None):
        t0 = time.time()
        study = self.optimize(n_trials=n_trials, suggestions=suggestions)
        report, P, preds, hist, state = self.fit_final(study.best_params)
        report["best_cv_logloss"] = study.best_value
        report["trials"] = len(study.trials)
        report["trained_at"] = int(time.time() * 1000)
        report["elapsed_s"] = round(time.time() - t0, 1)
        run_id = time.strftime("%Y%m%d-%H%M%S")
        rd = self.out_dir / "runs" / run_id
        rd.mkdir(parents=True, exist_ok=True)
        (rd / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        (rd / "best_params.json").write_text(json.dumps(study.best_params, ensure_ascii=False, indent=2), encoding="utf-8")
        (rd / "predictions.json").write_text(json.dumps(preds), encoding="utf-8")
        hist_log = self.db.get_meta("runs", [])
        hist_log.append({"run_id": run_id, "trained_at": report["trained_at"], "n": report["n_games"],
                         "cv_linear": report.get("cv_linear"), "cv_score": report.get("cv_score"),
                         "holdout_linear": report.get("holdout_linear"), "holdout_gbm": report.get("holdout_gbm"),
                         "series_linear": report.get("series_linear"), "features": report["features"]})
        self.db.set_meta("runs", hist_log)
        self.db.set_meta("latest_run", run_id)
        self.log(f"학습 결과 저장: {rd}")
        return run_id, report, P, preds, hist, state
