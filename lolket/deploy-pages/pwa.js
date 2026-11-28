/* 룽잉닷컴 앱 설치 (PWA)
   - 서비스 워커 등록
   - 안드로이드 · PC 크롬: 브라우저가 설치 가능하다고 알려 주면 "앱 설치" 버튼을 띄워요
   - 아이폰 · 아이패드: "공유 → 홈 화면에 추가" 안내를 띄워요
   - 이미 앱으로 열었거나, 닫기(×)를 누른 뒤 7일 동안은 안 띄워요
   - 페이지에 자체 설치 버튼(#btn-pwa-install)이 있으면 그 버튼을 쓰고 떠 있는 버튼은 안 띄워요 */
(function () {
  'use strict';
  if (window.RGPWA) return;
  var inFrame = false; try { inFrame = window.top !== window.self; } catch (e) { inFrame = true; }
  if ('serviceWorker' in navigator && !inFrame) navigator.serviceWorker.register('/sw.js').catch(function () {});

  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isKakao = /KAKAOTALK/i.test(ua);
  var inApp = isKakao || /Instagram|FBAN|FBAV|Line\/|NAVER|DaumApps|everytimeApp|Whale\/[\d.]+ Mobile.*inapp/i.test(ua);
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var KEY = 'rg_pwa_hide_until', prompt = null, pill = null;

  function hidden() { try { return Number(localStorage.getItem(KEY) || 0) > Date.now(); } catch (e) { return false; } }
  function snooze() { try { localStorage.setItem(KEY, String(Date.now() + 7 * 864e5)); } catch (e) {} }
  function ownBtn() { return document.getElementById('btn-pwa-install'); }

  var css = '' +
    '.rgp-pill{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:2147483000;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 8px;border-radius:999px;' +
      'background:rgba(18,16,30,.94);border:1px solid rgba(146,112,240,.55);box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 4px rgba(120,86,224,.12);color:#F2EEFF;font:600 13px/1.2 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;' +
      '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transform:translateY(140%);opacity:0;transition:transform .5s cubic-bezier(.2,.9,.25,1.15),opacity .35s}' +
    '.rgp-pill.on{transform:none;opacity:1}' +
    '.rgp-pill img{width:30px;height:30px;border-radius:8px;flex-shrink:0}' +
    '.rgp-go{display:flex;align-items:center;gap:10px;background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0 4px 0 0}' +
    '.rgp-go span{display:flex;flex-direction:column;text-align:left}.rgp-go small{font-weight:500;font-size:11px;color:#A99BD6;margin-top:2px}' +
    '.rgp-x{width:28px;height:28px;border-radius:50%;border:0;background:rgba(255,255,255,.07);color:#A99BD6;font-size:16px;line-height:1;cursor:pointer;flex-shrink:0;transition:background .2s}' +
    '.rgp-x:hover{background:rgba(255,255,255,.16);color:#fff}' +
    '.rgp-ov{position:fixed;inset:0;z-index:2147483001;background:rgba(4,4,10,.55);display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .3s}' +
    '.rgp-ov.on{opacity:1}' +
    '.rgp-sh{width:100%;max-width:460px;margin:0 10px calc(10px + env(safe-area-inset-bottom,0px));padding:22px 20px 18px;border-radius:22px;background:#15131F;border:1px solid rgba(146,112,240,.35);color:#EEEAFB;' +
      'font:14px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;transform:translateY(40px);transition:transform .45s cubic-bezier(.2,.9,.25,1.1);box-shadow:0 -10px 40px rgba(0,0,0,.4)}' +
    '.rgp-ov.on .rgp-sh{transform:none}' +
    '.rgp-hd{display:flex;align-items:center;gap:12px;margin-bottom:16px}.rgp-hd img{width:52px;height:52px;border-radius:13px}' +
    '.rgp-hd b{display:block;font-size:17px}.rgp-hd span{font-size:12px;color:#A99BD6}' +
    '.rgp-st{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}' +
    '.rgp-st li{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:12px;background:rgba(255,255,255,.04)}' +
    '.rgp-st em{font-style:normal;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:#7856E0;color:#fff;font-size:12px;font-weight:700;flex-shrink:0}' +
    '.rgp-st svg{vertical-align:-4px;margin:0 2px;color:#5AA2FF}' +
    '.rgp-btns{display:flex;gap:8px;margin-top:14px}' +
    '.rgp-btns button{flex:1;height:44px;border-radius:12px;border:0;font:600 14px system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;cursor:pointer}' +
    '.rgp-ok{background:#7856E0;color:#fff}.rgp-no{background:rgba(255,255,255,.07);color:#C9BFEA}' +
    '.rgp-arrow{position:fixed;left:50%;bottom:calc(2px + env(safe-area-inset-bottom,0px));z-index:2147483002;transform:translateX(-50%);color:#9C84F5;font-size:22px;animation:rgpb 1.1s ease-in-out infinite}' +
    '@keyframes rgpb{50%{transform:translate(-50%,6px)}}' +
    '@media (prefers-reduced-motion:reduce){.rgp-pill,.rgp-sh,.rgp-ov{transition:none}.rgp-arrow{animation:none}}';
  function addCss() { if (document.getElementById('rgp-css')) return; var s = document.createElement('style'); s.id = 'rgp-css'; s.textContent = css; document.head.appendChild(s); }

  var SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>';
  var PLUS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

  function openExternal() {   // 카카오톡 인앱 브라우저 → 기본 브라우저(사파리 · 크롬)로 열기
    location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
  }

  function iosGuide() {
    addCss();
    var old = document.querySelector('.rgp-ov'); if (old) old.remove();
    var ov = document.createElement('div'); ov.className = 'rgp-ov';
    var steps = inApp
      ? '<li><em>1</em><span>지금은 앱 안의 브라우저라 홈 화면에 추가할 수 없어요. <b>Safari로 열어</b> 주세요.</span></li>' +
        '<li><em>2</em><span>Safari에서 아래쪽 공유 버튼' + SHARE + '을 누르고</span></li>' +
        '<li><em>3</em><span><b>홈 화면에 추가</b>' + PLUS + ' → 오른쪽 위 <b>추가</b></span></li>'
      : '<li><em>1</em><span>' + (/iPad/.test(ua) || !/iPhone|iPod/.test(ua) ? '위쪽' : '아래쪽') + ' 공유 버튼' + SHARE + '을 누르세요<br><small style="color:#A99BD6">안 보이면 <b>···</b> 버튼 → 공유</small></span></li>' +
        '<li><em>2</em><span>목록을 내려서 <b>홈 화면에 추가</b>' + PLUS + '를 고르세요</span></li>' +
        '<li><em>3</em><span>오른쪽 위 <b>추가</b>를 누르면 끝!</span></li>';
    ov.innerHTML = '<div class="rgp-sh" role="dialog" aria-modal="true" aria-label="룽잉닷컴 앱 설치 안내">' +
      '<div class="rgp-hd"><img src="/apple-touch-icon.png" alt=""><div><b>룽잉닷컴을 홈 화면에 추가</b><span>앱처럼 전체 화면으로 바로 열 수 있어요</span></div></div>' +
      '<ul class="rgp-st">' + steps + '</ul>' +
      '<div class="rgp-btns">' + (isKakao ? '<button class="rgp-ok" data-a="ext">Safari로 열기</button>' : '') + '<button class="' + (isKakao ? 'rgp-no' : 'rgp-ok') + '" data-a="close">확인</button></div></div>' +
      (!inApp && /iPhone|iPod/.test(ua) ? '<div class="rgp-arrow" aria-hidden="true">▼</div>' : '');
    document.body.appendChild(ov);
    requestAnimationFrame(function () { requestAnimationFrame(function () { ov.classList.add('on'); }); });
    var close = function () { ov.classList.remove('on'); setTimeout(function () { ov.remove(); }, 320); };
    ov.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-a]');
      if (e.target === ov || (a && a.getAttribute('data-a') === 'close')) close();
      else if (a && a.getAttribute('data-a') === 'ext') openExternal();
    });
  }

  function install() {
    if (prompt) {
      var p = prompt; prompt = null;
      p.prompt();
      p.userChoice.then(function (r) { if (r && r.outcome === 'accepted') hidePill(); }).catch(function () {});
      return;
    }
    if (isIOS) { iosGuide(); return; }
    if (isKakao) { openExternal(); return; }
  }

  function hidePill() { if (!pill) return; var p = pill; pill = null; p.classList.remove('on'); setTimeout(function () { p.remove(); }, 400); }
  function showPill() {
    if (pill || standalone || inFrame || hidden()) return;
    var own = ownBtn();
    if (own) {   // 자체 버튼이 있는 페이지 (내 페이지 · 전적): 그 버튼을 보여 줘요
      own.style.display = 'flex';
      var m = document.getElementById('mobile-btn-pwa-install'); if (m) m.style.display = '';
      return;
    }
    addCss();
    pill = document.createElement('div'); pill.className = 'rgp-pill';
    pill.innerHTML = '<button class="rgp-go" type="button"><img src="/icon-192.png" alt=""><span>룽잉닷컴 앱 설치<small>' + (isIOS ? '홈 화면에 추가하는 방법' : '홈 화면에서 바로 열기') + '</small></span></button>' +
      '<button class="rgp-x" type="button" aria-label="닫기">×</button>';
    document.body.appendChild(pill);
    pill.querySelector('.rgp-go').addEventListener('click', install);
    pill.querySelector('.rgp-x').addEventListener('click', function () { snooze(); hidePill(); });
    requestAnimationFrame(function () { requestAnimationFrame(function () { if (pill) pill.classList.add('on'); }); });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    if (ownBtn()) return;   // 자체 버튼이 있는 페이지는 그 페이지 코드가 처리해요
    e.preventDefault(); prompt = e;
    if (document.body) showPill(); else document.addEventListener('DOMContentLoaded', showPill);
  });
  window.addEventListener('appinstalled', function () { prompt = null; hidePill(); });

  // 아이폰 · 아이패드, 카카오톡 인앱(안드로이드)은 설치 신호가 안 와서 직접 띄워요
  if (!standalone && !inFrame && (isIOS || isKakao)) {
    var go = function () { setTimeout(showPill, 1500); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }

  window.RGPWA = { isIOS: isIOS, standalone: standalone, iosGuide: iosGuide, install: install };
})();
