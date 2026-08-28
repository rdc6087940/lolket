# 롤 내전 매니저 — 모바일 앱 초기 프로젝트

기존에 운영 중인 롤 내전 관리 / 전적 통계 웹사이트를 [Capacitor](https://capacitorjs.com)로 감싸서
Android(Google Play)와 iOS(App Store)에서 동시에 동작하는 앱으로 만드는 초기 스캐폴드입니다.

동봉된 전체 절차 가이드(스토어 등록 로드맵)와 함께 참고하세요.

## 구조

```
lol-scrim-app/
├── capacitor.config.ts   ← 앱 ID, 앱 이름, 사이트 주소를 여기서 설정
├── package.json
├── www/                  ← server.url 이 비어있을 때만 쓰이는 로컬 대체 화면
├── android/              ← Android Studio로 여는 네이티브 프로젝트 (자동 생성됨)
└── ios/                  ← Xcode로 여는 네이티브 프로젝트 (자동 생성됨, macOS 필요)
```

## 1. 내 사이트 정보로 바꾸기

`capacitor.config.ts` 를 열어 아래 3곳을 수정하세요.

```ts
appId: 'com.yourdomain.scrimmanager',   // 스토어 등록용 고유 ID (배포 후 변경 불가)
appName: '롤 내전 매니저',                // 스토어에 노출될 앱 이름
server: {
  url: 'https://your-scrim-site.example.com', // 실제 운영 중인 사이트 주소 (https 필수)
}
```

수정 후 아래 명령으로 네이티브 프로젝트에 반영합니다.

```bash
npm install
npx cap sync
```

## 2. Android에서 실행해보기

Android Studio 설치 후:

```bash
npx cap open android
```

Android Studio가 열리면 상단의 ▶ 버튼으로 에뮬레이터 또는 USB로 연결한 실기기에서 바로 실행됩니다.

## 3. iOS에서 실행해보기 (macOS 필요)

macOS + Xcode + CocoaPods가 설치된 환경에서:

```bash
cd ios/App
pod install
cd ../..
npx cap open ios
```

Xcode가 열리면 좌측 상단에서 시뮬레이터를 선택하고 ▶ 버튼으로 실행합니다.
**macOS가 없다면** Codemagic, Ionic Appflow 같은 클라우드 빌드 서비스를 이용해 iOS 빌드·서명을 진행할 수 있습니다.

## 4. 앱 아이콘 / 스플래시 이미지 넣기

1. 1024×1024 PNG 아이콘 원본과 2732×2732 PNG 스플래시 원본을 준비합니다.
2. `resources/icon.png`, `resources/splash.png` 로 저장합니다.
3. 아래 명령으로 모든 사이즈를 자동 생성합니다.

```bash
npm install @capacitor/assets --save-dev
npx capacitor-assets generate
npx cap sync
```

## 5. 다음으로 할 일 (가이드 Phase 03 참고)

- [ ] Android 하드웨어 뒤로가기 버튼을 웹페이지 히스토리와 연결
      (`@capacitor/app` 의 `App.addListener('backButton', ...)` 를 사이트의 공통 JS에 추가)
- [ ] 오프라인 상태일 때 흰 화면 대신 안내 화면 표시
- [ ] 상태바/스플래시 색상을 실제 브랜드 색상에 맞게 `capacitor.config.ts` 에서 조정
- [ ] (iOS 심사 통과를 위해 권장) 푸시 알림 등 최소 1개의 실제 네이티브 기능 추가

## 참고 링크

- Capacitor 공식 문서: https://capacitorjs.com/docs
- Google Play Console: https://play.google.com/console
- App Store Connect: https://appstoreconnect.apple.com
