# Firebase Functions 배포 가이드 (v2)

## 1. 사전 준비
```bash
npm install -g firebase-tools
firebase login
```

## 2. API Key 설정
`.env` 파일을 열어서 아래처럼 수정:
```
RIOT_API_KEY=RGAPI-여기에-실제-키-입력
```
⚠ .env 파일은 절대 git에 올리지 마세요.

## 3. 패키지 설치 및 배포
```bash
cd functions-proxy
npm install
firebase deploy --only functions
```

## 4. 배포 완료 후 URL
```
https://asia-northeast3-lolket-55fc7.cloudfunctions.net/riotproxy
```
(v2는 함수명이 소문자로 변환됨: riotProxy → riotproxy)

앱 코드의 RIOT_PROXY_URL이 이미 이 URL로 설정되어 있습니다.
