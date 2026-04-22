# Cloudflare Workers 배포 가이드 (완전 무료)

## 방법 1: 대시보드에서 직접 붙여넣기 (가장 쉬움, CLI 불필요)

1. https://dash.cloudflare.com 접속 → 회원가입/로그인
2. 좌측 메뉴 **Workers & Pages** 클릭
3. **Create** → **Create Worker** 클릭
4. 기본 코드를 전부 지우고 worker.js 내용을 붙여넣기
5. **Deploy** 클릭
6. 배포 후 상단 **Settings** → **Variables and Secrets** → **Add**
   - Variable name: `RIOT_API_KEY`
   - Value: `RGAPI-새로발급받은키`
   - **Encrypt** 체크 (보안)
   - **Save** 클릭
7. Worker URL 복사 (예: https://lolket-riot-proxy.계정명.workers.dev)

## 방법 2: CLI (wrangler)

```bash
npm install -g wrangler
wrangler login
cd cloudflare-worker
wrangler deploy
wrangler secret put RIOT_API_KEY
# 키 입력 후 엔터
```

## 배포 후

worker.js URL을 앱 코드의 RIOT_PROXY_URL에 입력:
예) https://lolket-riot-proxy.계정명.workers.dev
