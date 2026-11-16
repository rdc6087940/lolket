"""명령어

  python -m lab doctor 닉네임#태그     deeplol 접속·멤버·내전 기록 점검 (deeplol puuid 도 가능)
  python -m lab members [--min-games N] deeplol 커뮤니티 멤버 → members.txt (puuid)
  python -m lab seed                   members.txt → 수집 대상 등록
  python -m lab status                 수집 현황
  python -m lab collect                커뮤니티 내전 수집 (deeplol, 10명 전원 멤버인 경기만 · 언제 끊어도 이어서)
  python -m lab build                  원본 → 분석 테이블(경기·선수·이벤트·타임라인) + 시리즈 묶기
  python -m lab train [--trials N] [--advise]   최적화·학습·내보내기 (+ LLM 조언)
  python -m lab cycle [--trials N]     build → train → (LLM 조언 반영 재학습) → 내보내기 한 번에
  python -m lab serve                  조회 페이지 열기 (http://127.0.0.1:8787)
  python -m lab publish                GitHub 업로드
  python -m lab demo                   가짜 데이터로 화면/학습 미리보기 (키 없이)
"""
import argparse
import json
import sys
from pathlib import Path

import yaml


def load_cfg(path="config.yaml"):
    p = Path(path)
    if not p.exists():
        p = Path("config.example.yaml")
    cfg = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    cfg.setdefault("db_path", "data/lab.sqlite")
    cfg.setdefault("collect", {})
    cfg.setdefault("output_dir", "output")
    cfg.setdefault("env_path", ".env")
    return cfg


def log(*a):
    print(*a, flush=True)


def cmd_train(cfg, trials, advise, use_suggestions=True):
    from .db import DB
    from .train import Trainer
    from .export import export
    db = DB(cfg["db_path"])
    tr = Trainer(db, cfg, log=log)
    # 직전 실행의 LLM 제안이 있으면 이번 최적화의 첫 시도로 사용
    sugg = None
    last = db.get_meta("latest_run")
    if use_suggestions and last:
        sp = Path(cfg["output_dir"]) / "runs" / last / "suggestions.json"
        if sp.exists():
            sugg = json.loads(sp.read_text(encoding="utf-8"))
            log(f"이전 LLM 제안 반영: 시도 {len(sugg.get('try_params', []))}개")
    prev = db.get_meta("best_params")
    if prev:
        sugg = sugg or {}
        sugg.setdefault("try_params", []).insert(0, prev)
    run_id, report, P, preds, hist, state = tr.run(n_trials=trials, suggestions=sugg)
    best = json.loads((Path(cfg["output_dir"]) / "runs" / run_id / "best_params.json").read_text(encoding="utf-8"))
    db.set_meta("best_params", best)
    _print_report(report)
    export(db, report, P, hist, state, run_id, cfg["output_dir"], log=log)
    if advise:
        from .advisor import advise as _adv
        _adv(report, Path(cfg["output_dir"]) / "runs" / run_id, log=log)
    return report


def _print_report(r):
    def pct(m):
        return f"{m['acc']*100:.1f}% (n={m['n']}, logloss {m['logloss']:.3f})" if m else "-"
    log("── 결과 ─────────────────────────")
    log(f"  점수 기준선(티어) 정답률 : {pct(r.get('cv_score'))}")
    log(f"  AI(선형 수식) 정답률     : {pct(r.get('cv_linear'))}")
    if r.get("holdout_linear"):
        log(f"  ★ 최종 확인(최근 20%, 최적화에 안 쓴 경기) : AI {pct(r.get('holdout_linear'))} · 점수 기준선 {pct(r.get('holdout_score'))}")
    if r.get("holdout_gbm"):
        log(f"  LightGBM(참고) 홀드아웃  : {pct(r.get('holdout_gbm'))}")
    s = r.get("series_linear") or {}
    if s.get("total"):
        log(f"  시리즈 정답률            : {s['rate']*100:.1f}% ({s['correct']}/{s['total']})")
    log("  가중치: " + ", ".join(f"{f['name']} {f['weight']:+.3f}" for f in r["formula"]["features"]))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="lab", description="내전 분석 랩")
    ap.add_argument("--config", default="config.yaml")
    sub = ap.add_subparsers(dest="cmd")
    d = sub.add_parser("doctor"); d.add_argument("riot_id")
    s = sub.add_parser("seed"); s.add_argument("--file", default="members.txt")
    mb = sub.add_parser("members"); mb.add_argument("--out", default="members.txt"); mb.add_argument("--min-games", type=int, default=0)
    sub.add_parser("status")
    c = sub.add_parser("collect"); c.add_argument("--rounds", type=int, default=None)
    sub.add_parser("build")
    t = sub.add_parser("train"); t.add_argument("--trials", type=int, default=60); t.add_argument("--advise", action="store_true")
    cy = sub.add_parser("cycle"); cy.add_argument("--trials", type=int, default=60); cy.add_argument("--loops", type=int, default=2)
    sv = sub.add_parser("serve"); sv.add_argument("--port", type=int, default=8787)
    sub.add_parser("publish")
    dm = sub.add_parser("demo"); dm.add_argument("--players", type=int, default=60); dm.add_argument("--games", type=int, default=1200)
    a = ap.parse_args(argv)
    cfg = load_cfg(a.config)

    if a.cmd == "doctor":
        from .collect import Collector
        Collector(cfg, log=log).doctor(a.riot_id)
    elif a.cmd == "seed":
        from .collect import Collector
        Collector(cfg, log=log).seed(a.file)
    elif a.cmd == "members":
        from .collect import Collector
        Collector(cfg, log=log).write_members(a.out, a.min_games)
    elif a.cmd == "status":
        from .collect import Collector
        Collector(cfg, log=log).status()
    elif a.cmd == "collect":
        from .collect import Collector
        try:
            Collector(cfg, log=log).run(rounds=a.rounds)
        except KeyboardInterrupt:
            log("\n중단됨 — 다시 실행하면 이어서 진행합니다.")
    elif a.cmd == "build":
        from .db import DB
        from .build import build
        build(DB(cfg["db_path"]), log=log, series_gap_h=cfg.get("series_gap_hours", 3))
    elif a.cmd == "train":
        cmd_train(cfg, a.trials, a.advise)
    elif a.cmd == "cycle":
        from .db import DB
        from .build import build
        build(DB(cfg["db_path"]), log=log, series_gap_h=cfg.get("series_gap_hours", 3))
        for i in range(a.loops):
            log(f"=== 학습 루프 {i+1}/{a.loops} ===")
            cmd_train(cfg, a.trials, advise=True)
    elif a.cmd == "serve":
        from .server import serve
        log(f"조회 페이지: http://127.0.0.1:{a.port}  (끄려면 Ctrl+C)")
        serve(cfg, port=a.port)
    elif a.cmd == "publish":
        from .publish import publish
        publish(cfg, log=log)
    elif a.cmd == "demo":
        from .demo import make_demo
        demo_cfg = dict(cfg, db_path="data/demo.sqlite", output_dir="output_demo")
        make_demo(demo_cfg, n_players=a.players, n_games=a.games, log=log)
        cmd_train(demo_cfg, trials=20, advise=False, use_suggestions=False)
        log("미리보기: python -m lab --config config.demo.yaml serve")
        Path("config.demo.yaml").write_text(yaml.safe_dump(demo_cfg, allow_unicode=True), encoding="utf-8")
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
