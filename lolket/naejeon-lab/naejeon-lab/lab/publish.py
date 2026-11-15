"""학습 결과를 GitHub 저장소에 올림 → 룽잉닷컴이 raw URL로 읽음

방법 1) 로컬에 clone 해둔 저장소 폴더(github.repo_dir)에 복사 후 git commit/push  (권장, git 필요)
방법 2) GitHub API + 토큰(GITHUB_TOKEN)으로 파일 직접 업로드 (git 없어도 됨)
"""
import base64
import json
import os
import shutil
import subprocess
from pathlib import Path

import requests
from dotenv import dotenv_values

FILES = ["latest.json", "players.json"]


def publish(cfg, log=print):
    gh = cfg.get("github", {})
    src = Path(cfg.get("output_dir", "output")) / "model"
    if not (src / "latest.json").exists():
        log("output/model/latest.json 이 없습니다. 먼저 train 을 실행하세요.")
        return False
    version = json.loads((src / "latest.json").read_text(encoding="utf-8"))["version"]
    sub = gh.get("path", "model")
    if gh.get("repo_dir"):
        repo = Path(gh["repo_dir"])
        dst = repo / sub
        dst.mkdir(parents=True, exist_ok=True)
        for f in FILES:
            shutil.copy2(src / f, dst / f)
        def git(*a):
            return subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True)
        git("add", sub)
        r = git("commit", "-m", f"model {version}")
        if "nothing to commit" in (r.stdout + r.stderr):
            log("변경 사항 없음 (이미 최신)")
            return True
        p = git("push")
        if p.returncode != 0:
            log("push 실패:\n" + p.stderr)
            return False
        log(f"GitHub 업로드 완료 (git): {sub}/ · {version}")
        return True

    vals = dotenv_values(".env") if os.path.exists(".env") else {}
    token = vals.get("GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
    repo = gh.get("repo")  # "owner/name"
    branch = gh.get("branch", "main")
    if not (token and repo):
        log("config.yaml 의 github.repo_dir 또는 (github.repo + .env GITHUB_TOKEN) 이 필요합니다.")
        return False
    H = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    for f in FILES:
        url = f"https://api.github.com/repos/{repo}/contents/{sub}/{f}"
        cur = requests.get(url, headers=H, params={"ref": branch}, timeout=30)
        sha = cur.json().get("sha") if cur.status_code == 200 else None
        body = {"message": f"model {version}", "branch": branch,
                "content": base64.b64encode((src / f).read_bytes()).decode()}
        if sha:
            body["sha"] = sha
        r = requests.put(url, headers=H, json=body, timeout=60)
        if r.status_code not in (200, 201):
            log(f"{f} 업로드 실패: {r.status_code} {r.text[:200]}")
            return False
    log(f"GitHub 업로드 완료 (API): https://raw.githubusercontent.com/{repo}/{branch}/{sub}/latest.json")
    return True
