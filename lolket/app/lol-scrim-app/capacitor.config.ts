import type { CapacitorConfig } from '@capacitor/cli';

// ─────────────────────────────────────────────────────────────
// 아래 3개 값만 여러분의 서비스에 맞게 바꾸면 됩니다.
//   appId    : 스토어에 등록할 고유 패키지/번들 ID (배포 후 변경 불가)
//   appName  : 앱 이름 (스토어 노출용, 나중에도 수정 가능)
//   server.url : 실제 운영 중인 웹사이트 주소 (반드시 https)
// ─────────────────────────────────────────────────────────────
const config: CapacitorConfig = {
  appId: 'com.roonging.scrimmanager',
  appName: '룽잉닷컴',
  webDir: 'www.roonging.com',
  server: {
    url: 'https://roonging.com',
    cleartext: false,
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#0D141C',
  },
  ios: {
    backgroundColor: '#0D141C',
    contentInset: 'automatic',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#0D141C',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
    },
  },
};

export default config;
