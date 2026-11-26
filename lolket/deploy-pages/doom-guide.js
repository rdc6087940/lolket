// ══ 멸망전 가이드 엔진 ══
//   실제 멸망전 화면(doom?demo=…)을 iframe 에 띄우고, 커서가 움직이며 직접 눌러 보여 주는 튜토리얼이에요.
//   window.GUIDE = { title, sub, other:{label,href}, chapters:[{ id, title, desc, role, seed, start, steps:[{ t, d, act:[...], focus, hold }] }] }
//   act: ['click', sel] · ['type', sel, text] · ['select', sel, value] · ['set', sel, value] · ['wait', ms] · ['hash', '#/…'] · ['sim', what] · ['dclick', buttonId] · ['dfocus', cardId]
//   sel: CSS · 'text:글자' · 'CSS@순번' · 'A >> B' (A 안에서 B 찾기) · 디스코드 화면은 'D:버튼ID' / 'DC:카드ID'
(function () {
  var G = window.GUIDE, $ = function (id) { return document.getElementById(id); };
  // 멸망전 페이지에서 ?cid= 로 들어오면 링크에도 그대로 붙여요
  var CIDQ = (function () { var c = new URLSearchParams(location.search).get('cid'); return c ? '?cid=' + encodeURIComponent(c) : ''; })();
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var NATURAL = { w: 1060, h: 780 }, MOB = { w: 420, h: 820 };
  var S = { ci: 0, si: -1, playing: false, mode: 'watch', token: 0, busy: false, target: null, scale: 1, nat: NATURAL, started: false };
  window.GUIDE_UTIL = {
    dt: function (days, hour, min) { var d = new Date(Date.now() + days * 86400000); d.setHours(hour, min || 0, 0, 0); var z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); },
    date: function (days) { var d = new Date(Date.now() + days * 86400000); var z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); },
  };

  // ── 화면 뼈대 ──
  var css = `
:root{--bg:#06080C;--panel:#0F141C;--panel2:#141A24;--line:#1C2430;--line2:#283242;--text:#ECEFF4;--muted:#8A94A6;--dim:#566072;--gold:#F0C661;--gold2:#C89B3C;--gold-s:rgba(240,198,97,.12);--gold-l:rgba(240,198,97,.35);--red:#FF3D57;--ok:#35E08A;--blurple:#5865F2;--ease:cubic-bezier(.2,.8,.2,1)}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Pretendard Variable',Pretendard,system-ui,sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;min-height:100vh}
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(900px 500px at 85% -10%,rgba(255,61,87,.08),transparent 60%),radial-gradient(900px 520px at 0% 0%,rgba(240,198,97,.07),transparent 60%)}
button{font:inherit;color:inherit}
a{color:inherit}
.gh{position:sticky;top:0;z-index:30;background:rgba(6,8,12,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.gh-in{max-width:1480px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.glogo{width:34px;height:34px;display:grid;place-items:center;color:#1A1204;background:linear-gradient(135deg,#FFE29A,var(--gold) 45%,var(--gold2));clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);flex-shrink:0}
.gh h1{margin:0;font-size:18px;font-weight:800;letter-spacing:-.3px}
.gh p{margin:0;font-size:12px;color:var(--muted)}
.gsp{flex:1}
.glink{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 13px;border:1px solid var(--line2);border-radius:8px;background:var(--panel);font-size:12.5px;font-weight:700;text-decoration:none;white-space:nowrap}
.glink:hover{border-color:var(--gold-l)}
.glink.gold{border-color:var(--gold-l);color:var(--gold);background:var(--gold-s)}
.gl{max-width:1480px;margin:0 auto;padding:16px 18px 60px;display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px;align-items:start}
.gside{position:sticky;top:74px;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 90px);overflow:auto}
.gcard{border:1px solid var(--line);background:var(--panel);border-radius:10px}
.gch{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:center;width:100%;padding:10px 12px;border:0;background:none;text-align:left;cursor:pointer;border-bottom:1px solid var(--line);transition:background .15s}
.gch:last-child{border-bottom:0}
.gch:hover{background:rgba(255,255,255,.02)}
.gch i{width:28px;height:28px;display:grid;place-items:center;font:800 12px system-ui;font-style:normal;color:var(--muted);border:1px solid var(--line2);border-radius:50%}
.gch b{display:block;font-size:13.5px}
.gch small{display:block;font-size:11.5px;color:var(--muted)}
.gch.on{background:var(--gold-s)}
.gch.on i{background:var(--gold);color:#1A1204;border-color:var(--gold)}
.gch.done i{background:rgba(53,224,138,.15);color:var(--ok);border-color:rgba(53,224,138,.5)}
.gsteps{padding:6px}
.gst{display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;width:100%;padding:7px 8px;border:0;border-radius:7px;background:none;text-align:left;cursor:pointer;color:var(--muted);font-size:12.5px;line-height:1.45}
.gst:hover{background:rgba(255,255,255,.03);color:var(--text)}
.gst i{font-style:normal;font:700 11px system-ui;color:var(--dim);padding-top:1px}
.gst.past{color:#B8C0CC}
.gst.past i{color:var(--ok)}
.gst.on{background:var(--gold-s);color:var(--text)}
.gst.on i{color:var(--gold)}
.gstage{min-width:0;display:flex;flex-direction:column;gap:10px}
.gbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.gbar .ttl{min-width:0}
.gbar .ttl b{display:block;font-size:15px}
.gbar .ttl small{font-size:11.5px;color:var(--muted)}
.gbtn{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 13px;border:1px solid var(--line2);border-radius:8px;background:var(--panel2);font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;transition:filter .15s,transform .1s}
.gbtn:hover:not(:disabled){filter:brightness(1.15)}
.gbtn:active:not(:disabled){transform:scale(.97)}
.gbtn:disabled{opacity:.4;cursor:not-allowed}
.gbtn.gold{border:0;color:#1A1204;background:linear-gradient(180deg,#FFD978,var(--gold) 50%,var(--gold2))}
.gseg{display:inline-flex;border:1px solid var(--line2);border-radius:8px;overflow:hidden}
.gseg button{height:34px;padding:0 12px;border:0;background:none;color:var(--muted);font-size:12.5px;font-weight:700;cursor:pointer}
.gseg button.on{background:var(--gold);color:#1A1204}
.gscreen{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:10px;align-items:start}
.gscreen.nodc{grid-template-columns:minmax(0,1fr)}
.gframe{border:1px solid var(--line2);border-radius:10px;overflow:hidden;background:#000;box-shadow:0 20px 50px rgba(0,0,0,.45)}
.gframe-top{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;background:#10151E;border-bottom:1px solid var(--line)}
.gframe-top i{width:10px;height:10px;border-radius:50%;background:#3A4250}
.gframe-top i:nth-child(1){background:#FF5F57}.gframe-top i:nth-child(2){background:#FEBC2E}.gframe-top i:nth-child(3){background:#28C840}
.gurl{flex:1;height:22px;margin-left:8px;padding:0 10px;border-radius:6px;background:#0A0E14;color:var(--muted);font-size:11.5px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gurl b{color:var(--ok);font-weight:600}
.gview{position:relative;overflow:hidden}
.gview iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;background:#06080C}
.gdemo{position:absolute;right:10px;bottom:10px;z-index:3;padding:3px 9px;border-radius:99px;background:rgba(240,198,97,.9);color:#1A1204;font-size:11px;font-weight:800;pointer-events:none}
.gcap{padding:14px 16px;border:1px solid var(--gold-l);border-radius:10px;background:linear-gradient(90deg,rgba(240,198,97,.08),transparent 70%)}
.gcap b{display:block;font-size:16px;margin-bottom:4px}
.gcap p{margin:0;color:#C9CFD8;font-size:13.5px;white-space:pre-wrap}
.gcap .hint{margin-top:8px;font-size:12px;color:var(--gold)}
/* 디스코드 */
.gdc{border:1px solid #1E1F22;border-radius:10px;background:#313338;color:#DBDEE1;overflow:hidden;font-family:'Pretendard Variable',Pretendard,system-ui,sans-serif}
.gdc-h{display:flex;align-items:center;gap:8px;height:42px;padding:0 12px;background:#2B2D31;border-bottom:1px solid #1E1F22;font-weight:700;font-size:13.5px}
.gdc-h svg{color:#949BA4}
.gdc-h small{margin-left:auto;font-weight:500;color:#949BA4;font-size:11px}
.gdc-feed{max-height:690px;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
.gdc-empty{padding:30px 10px;text-align:center;color:#949BA4;font-size:12.5px}
.dcm{border-radius:8px;background:#2B2D31;border:1px solid #1E1F22;padding:10px 11px;animation:dcin .35s var(--ease)}
.dcm.flash{animation:dcflash 1.2s var(--ease)}
@keyframes dcin{from{opacity:0;transform:translateY(8px)}}
@keyframes dcflash{0%{box-shadow:0 0 0 2px rgba(240,198,97,.9)}100%{box-shadow:0 0 0 2px rgba(240,198,97,0)}}
.dcm-k{font-size:10.5px;font-weight:700;color:#949BA4;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.dcm-k em{font-style:normal;padding:1px 6px;border-radius:4px;background:#5865F2;color:#fff;font-size:9.5px}
.dcm-k em.eph{background:#4E5058}
.dcm-a{display:flex;gap:9px}
.dcm-av{width:32px;height:32px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;background:linear-gradient(135deg,#FFE29A,#C89B3C);color:#1A1204;font-weight:800;font-size:13px}
.dcm-b{min-width:0;flex:1}
.dcm-n{font-weight:700;font-size:13px;color:#F2F3F5}
.dcm-n span{margin-left:5px;padding:0 4px;border-radius:3px;background:#5865F2;color:#fff;font-size:9.5px;font-weight:700;vertical-align:1px}
.dcm-t{font-size:13px;font-weight:800;color:#F2F3F5;margin-bottom:4px}
.dcm-c{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#DBDEE1}
.dcm-c code{font-family:ui-monospace,monospace;font-size:10.5px;background:#1E1F22;padding:0 3px;border-radius:3px}
.dcm-c b{color:#F2F3F5}
.dcm-btns{display:flex;flex-direction:column;gap:5px;margin-top:8px}
.dcm-row{display:flex;flex-wrap:wrap;gap:5px}
.dcb{height:28px;padding:0 10px;border:0;border-radius:4px;font-size:11.5px;font-weight:600;cursor:pointer;color:#fff;transition:filter .15s}
.dcb:hover:not(:disabled){filter:brightness(1.12)}
.dcb:disabled{opacity:.45;cursor:not-allowed}
.dcb.s1{background:#5865F2}.dcb.s2{background:#4E5058}.dcb.s3{background:#248046}.dcb.s4{background:#DA373C}.dcb.s5{background:#4E5058}
.dcb.s5::after{content:' ↗';opacity:.7}
.dcm .sub{margin-top:8px;padding:8px 9px;border-left:3px solid #4E5058;background:#232428;border-radius:4px}
/* 커서 · 강조 */
.gcur{position:fixed;left:0;top:0;z-index:60;width:26px;height:26px;pointer-events:none;transition:transform .65s var(--ease),opacity .25s;opacity:0;filter:drop-shadow(0 3px 6px rgba(0,0,0,.6))}
.gcur.show{opacity:1}
.gcur .rip{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid var(--gold);opacity:0}
.gcur.tap .rip{animation:rip .5s ease-out}
@keyframes rip{0%{opacity:1;transform:scale(.3)}100%{opacity:0;transform:scale(1.6)}}
.gring{position:fixed;z-index:55;pointer-events:none;border:2px solid var(--gold);border-radius:8px;box-shadow:0 0 0 4000px rgba(0,0,0,.0),0 0 18px rgba(240,198,97,.55);transition:all .35s var(--ease);opacity:0}
.gring.show{opacity:1}
.gring.try{animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(240,198,97,.6),0 0 18px rgba(240,198,97,.5)}50%{box-shadow:0 0 0 8px rgba(240,198,97,0),0 0 18px rgba(240,198,97,.5)}}
.gbub{position:fixed;z-index:58;max-width:280px;padding:8px 11px;border-radius:8px;background:var(--gold);color:#1A1204;font-size:12.5px;font-weight:700;line-height:1.45;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;transition:opacity .25s,transform .35s var(--ease)}
.gbub.show{opacity:1}
.gstart{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(6,8,12,.78);backdrop-filter:blur(3px);text-align:center;padding:20px}
.gstart b{font-size:20px}
.gstart p{margin:0;color:#C9CFD8;max-width:460px}
@media (max-width:1180px){.gscreen{grid-template-columns:1fr}.gdc-feed{max-height:420px}}
@media (max-width:860px){.gh{position:static}.gl{grid-template-columns:1fr;padding:12px 12px 40px}.gside{position:static;max-height:none;order:2}.gsteps{display:none}.gbar .ttl{flex-basis:100%}}
@media (prefers-reduced-motion:reduce){.gcur,.gring,.gbub{transition:none}}
`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var CUR = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.4L16 20l-3 1.4-3.6-7.3L4 18z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg><i class="rip"></i>';
  document.body.insertAdjacentHTML('afterbegin',
    '<header class="gh"><div class="gh-in"><span class="glogo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/></svg></span>' +
    '<div><h1>' + esc(G.title) + '</h1><p>' + esc(G.sub) + '</p></div><span class="gsp"></span>' +
    (G.other ? '<a class="glink" href="' + esc(G.other.href + CIDQ) + '">' + esc(G.other.label) + '</a>' : '') + '<a class="glink gold" href="' + esc((G.doomHref || 'doom') + CIDQ) + '" target="_blank" rel="noopener">멸망전 페이지 열기 ↗</a></div></header>' +
    '<main class="gl"><aside class="gside"><div class="gcard" id="g-chs"></div><div class="gcard gsteps" id="g-steps"></div></aside>' +
    '<section class="gstage"><div class="gbar"><div class="ttl"><b id="g-ttl"></b><small id="g-sub"></small></div><span class="gsp"></span>' +
    '<div class="gseg" title="보기: 커서가 대신 눌러 줘요 · 직접: 강조된 곳을 직접 눌러요"><button id="g-m-watch" class="on" onclick="GUIDE_ENGINE.mode(\'watch\')">보기</button><button id="g-m-try" onclick="GUIDE_ENGINE.mode(\'try\')">직접 해보기</button></div>' +
    '<button class="gbtn" id="g-prev" onclick="GUIDE_ENGINE.prev()">◀ 이전</button><button class="gbtn gold" id="g-play" onclick="GUIDE_ENGINE.toggle()">▶ 자동 재생</button><button class="gbtn" id="g-next" onclick="GUIDE_ENGINE.next()">다음 ▶</button><button class="gbtn" onclick="GUIDE_ENGINE.restart()" title="이 장 처음부터">↺</button></div>' +
    '<div class="gscreen" id="g-screen"><div class="gframe"><div class="gframe-top"><i></i><i></i><i></i><div class="gurl" id="g-url"><b>🔒</b> roonging.com/doom</div></div><div class="gview" id="g-view"><iframe id="g-if" title="멸망전 화면 체험"></iframe><span class="gdemo">체험 화면 · 실제로 저장되지 않아요</span><div class="gstart" id="g-start"></div></div></div>' +
    '<div class="gdc" id="g-dc"><div class="gdc-h"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.7.1 18.2a19.9 19.9 0 0 0 6 3l1.3-2.1a12.9 12.9 0 0 1-2-.9l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 .9l1.3 2.1a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.8-3.6-13.8z"/></svg>디스코드에서 보이는 모습<small>데모 커뮤니티 서버</small></div><div class="gdc-feed" id="g-feed"></div></div></div>' +
    '<div class="gcap" id="g-cap"></div></section></main>' +
    '<div class="gring" id="g-ring"></div><div class="gbub" id="g-bub"></div><div class="gcur" id="g-cur">' + CUR + '</div>');
  var IF = $('g-if');

  // ── iframe 크기 맞추기 (실제 PC 화면 크기로 그리고 줄여서 보여 줘요) ──
  function fit() {
    var w = $('g-view').clientWidth || 800;
    S.nat = w >= 640 ? NATURAL : MOB;
    S.scale = Math.min(1, w / S.nat.w);
    IF.style.width = S.nat.w + 'px'; IF.style.height = S.nat.h + 'px'; IF.style.transform = 'scale(' + S.scale + ')';
    $('g-view').style.height = Math.round(S.nat.h * S.scale) + 'px';
    placeRing();
  }
  window.addEventListener('resize', fit);
  window.addEventListener('scroll', placeRing, { passive: true });

  // ── 디스코드 화면 ──
  var feed = {};
  function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>'); }
  function btnsHtml(rows) {
    if (!rows || !rows.length) return '';
    return '<div class="dcm-btns">' + rows.map(function (r) { return '<div class="dcm-row">' + r.map(function (b) {
      var key = b.id || b.link || (b.thread ? 'thread' : b.label);
      return '<button class="dcb s' + b.style + '" data-bid="' + esc(key) + '"' + (b.disabled ? ' disabled' : '') + ' onclick="GUIDE_ENGINE.dc(this)" data-link="' + esc(b.link || '') + '" data-id="' + esc(b.id || '') + '">' + esc(b.label) + '</button>'; }).join('') + '</div>'; }).join('') + '</div>';
  }
  function dcCard(ev) {
    if (ev.kind === 'post') return '<div class="dcm-k"># 스크림-모집 · 포럼 포스트</div><div class="dcm-t">' + esc(ev.title) + '</div><div class="dcm-a"><span class="dcm-av">룽</span><div class="dcm-b"><div class="dcm-n">룽봇<span>앱</span></div><div class="dcm-c">' + md(ev.content) + '</div>' + btnsHtml(ev.buttons) + '<div class="subs"></div></div></div>';
    if (ev.kind === 'dm') return '<div class="dcm-k"><em>DM</em> 룽봇 → ' + esc(ev.to) + '</div><div class="dcm-a"><span class="dcm-av">룽</span><div class="dcm-b"><div class="dcm-n">룽봇<span>앱</span></div><div class="dcm-c">' + md(ev.content) + '</div>' + btnsHtml(ev.buttons) + '</div></div>';
    if (ev.kind === 'thread') return '<div class="dcm-k"># 스크림-매칭 · 비공개 스레드</div><div class="dcm-t">' + esc(ev.name) + '</div><div class="dcm-a"><span class="dcm-av">룽</span><div class="dcm-b"><div class="dcm-n">룽봇<span>앱</span></div><div class="dcm-c">' + md(ev.content) + '</div><div class="dcm-c" style="margin-top:6px;color:#949BA4">초대된 사람: ' + esc((ev.members || []).join(', ')) + '</div></div></div>';
    if (ev.kind === 'login') return '<div class="dcm-k">디스코드 로그인</div><div class="dcm-c">✅ <b>' + esc(ev.name) + '</b> 님이 디스코드 계정으로 로그인했어요. (멸망전 페이지에서 "디스코드 로그인" → 디스코드 승인 화면 → 다시 멸망전 페이지로 돌아와요)</div>';
    if (ev.kind === 'note') return '<div class="dcm-k">' + esc(ev.head || '안내') + '</div><div class="dcm-c">' + md(ev.content) + '</div>' + btnsHtml(ev.buttons);
    return '';
  }
  function dcPush(ev) {
    var f = $('g-feed'); var em = f.querySelector('.gdc-empty'); if (em) em.remove();
    if (ev.kind === 'post-delete') { var old = feed['post:' + ev.id]; if (old) old.remove(); delete feed['post:' + ev.id]; return; }
    var key = ev.kind === 'post' ? 'post:' + ev.id : null;
    if (key && feed[key]) { var el = feed[key], subs = el.querySelector('.subs'); var keep = subs ? subs.innerHTML : ''; el.innerHTML = dcCard(ev); if (keep) el.querySelector('.subs').innerHTML = keep; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); return; }
    var div = document.createElement('div'); div.className = 'dcm'; div.setAttribute('data-card', key || ev.kind + ':' + Date.now()); div.innerHTML = dcCard(ev);
    if (ev.kind === 'post' && !ev.fresh) f.insertBefore(div, f.firstChild); else f.appendChild(div);
    if (key) feed[key] = div;
    if (ev.kind !== 'post' || ev.fresh) f.scrollTop = f.scrollHeight;
  }
  function dcReset() { feed = {}; $('g-feed').innerHTML = '<div class="gdc-empty">디스코드에 올라가는 포스트, DM, 비공개 스레드가 여기에 나와요.</div>'; }
  window.addEventListener('message', function (e) { if (e.data && e.data.doomDemo) dcPush(e.data.doomDemo); });

  // ── 요소 찾기 ──
  function doc() { try { return IF.contentDocument; } catch (e) { return null; } }
  function win() { try { return IF.contentWindow; } catch (e) { return null; } }
  var CLICKABLE = 'button,a,[onclick],.dcard,.scard,.tab,.role,.lb,.sapp,.pi,.slot,label';
  function visible(el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function pick(list, part) {
    var m = part.match(/^(.*)@(\d+)$/), idx = 0; if (m) { part = m[1]; idx = +m[2]; }
    var out = [];
    list.forEach(function (root) {
      if (part.indexOf('text:') === 0) {
        var t = part.slice(5), c = Array.prototype.slice.call(root.querySelectorAll(CLICKABLE)).filter(function (e) { return visible(e) && (e.textContent || '').replace(/\s+/g, ' ').indexOf(t) >= 0; });
        c.sort(function (a, b) { return a.textContent.length - b.textContent.length; });
        out = out.concat(c);
      } else out = out.concat(Array.prototype.slice.call(root.querySelectorAll(part)).filter(visible));
    });
    return m ? (out[idx] ? [out[idx]] : []) : out;
  }
  function find(sel) {
    if (typeof sel === 'function') sel = sel();
    if (sel.indexOf('D:') === 0) return { dc: true, el: document.querySelector('.dcb[data-bid="' + sel.slice(2).replace(/"/g, '') + '"]') };
    if (sel.indexOf('DC:') === 0) { var cs = document.querySelectorAll('.dcm[data-card^="' + sel.slice(3).replace(/"/g, '') + '"]'); return { dc: true, el: cs[cs.length - 1] || null }; }
    var d = doc(); if (!d) return null;
    var cur = [d];
    sel.split(' >> ').forEach(function (part) { cur = pick(cur, part.trim()); });
    return cur[0] ? { dc: false, el: cur[0] } : null;
  }
  async function waitFind(sel, ms) {
    var end = Date.now() + (ms || 6000);
    while (Date.now() < end) { var f = find(sel); if (f && f.el && visible(f.el)) return f; await sleep(100); }
    return null;
  }
  // 화면(부모 기준) 좌표
  function rectOf(f) {
    var r = f.el.getBoundingClientRect();
    if (f.dc) return { x: r.left, y: r.top, w: r.width, h: r.height };
    var fr = IF.getBoundingClientRect();
    return { x: fr.left + r.left * S.scale, y: fr.top + r.top * S.scale, w: r.width * S.scale, h: r.height * S.scale };
  }
  function placeRing() {
    var ring = $('g-ring'), bub = $('g-bub');
    if (!S.target || !S.target.el || !S.target.el.isConnected) { ring.classList.remove('show'); bub.classList.remove('show'); return; }
    var r = rectOf(S.target), pad = 5;
    ring.style.left = (r.x - pad) + 'px'; ring.style.top = (r.y - pad) + 'px'; ring.style.width = (r.w + pad * 2) + 'px'; ring.style.height = (r.h + pad * 2) + 'px';
    ring.classList.add('show'); ring.classList.toggle('try', S.mode === 'try' && S.waiting);
    if (S.bubble) {
      bub.textContent = S.bubble; bub.classList.add('show');
      var bw = Math.min(280, bub.offsetWidth || 220), bh = bub.offsetHeight || 40, vw = window.innerWidth, vh = window.innerHeight;
      var bx = Math.max(8, Math.min(vw - bw - 8, r.x)), by = r.y + r.h + 12;
      if (by + bh > vh - 8) by = Math.max(8, r.y - bh - 12);
      bub.style.left = bx + 'px'; bub.style.top = by + 'px';
    } else bub.classList.remove('show');
  }
  function setTarget(f, bubble) { S.target = f; S.bubble = bubble || ''; placeRing(); }
  async function bringIntoView(f) {
    if (f.dc) { f.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    else {
      f.el.scrollIntoView({ block: 'center', inline: 'nearest' });
      // iframe 안에서 보이게 한 다음, 바깥 페이지에서도 iframe 의 그 위치가 보이게
      var top = window.innerWidth <= 860 ? 10 : 80, r = rectOf(f);
      if (r.y < top || r.y + r.h > window.innerHeight - 20) window.scrollBy(0, r.y - window.innerHeight / 2);   // 바로 옮겨야 커서 위치가 맞아요
    }
    await sleep(320); placeRing();
  }
  var cur = $('g-cur');
  async function moveCursor(f) {
    var r = rectOf(f); cur.classList.add('show');
    cur.style.transform = 'translate(' + (r.x + Math.min(r.w * 0.5, 60)) + 'px,' + (r.y + r.h * 0.55) + 'px)';
    await sleep(700);
  }
  async function tap() { cur.classList.remove('tap'); void cur.offsetWidth; cur.classList.add('tap'); await sleep(180); }
  function fire(el, type) { var w = el.ownerDocument.defaultView; el.dispatchEvent(new w.Event(type, { bubbles: true })); }
  // 직접 해보기: 강조된 곳을 누를 때까지 기다려요
  function waitUserClick(f, tok) {
    return new Promise(function (res) {
      S.waiting = true; placeRing();
      var root = f.dc ? document : doc();
      var h = function (e) { if (tok !== S.token) { cleanup(); return res(false); } if (f.el === e.target || f.el.contains(e.target)) { cleanup(); res(true); } };
      var iv = setInterval(function () { if (tok !== S.token) { cleanup(); res(false); } }, 200);
      function cleanup() { S.waiting = false; root.removeEventListener('click', h, true); clearInterval(iv); placeRing(); }
      root.addEventListener('click', h, true);
    });
  }

  // ── 동작 실행 ──
  async function run(a, anim, tok) {
    var k = a[0], sel = a[1], val = typeof a[2] === 'function' ? a[2]() : a[2];
    if (tok !== S.token) return false;
    if (k === 'wait') { await sleep(anim ? sel : Math.min(sel, 150)); return true; }
    if (k === 'hash') { var w = win(); if (w) w.location.hash = sel; await sleep(anim ? 600 : 300); return true; }
    if (k === 'sim') { var w2 = win(); if (w2 && w2.DOOM_DEMO) { w2.DOOM_DEMO.sim(sel); w2.__doomReload && w2.__doomReload(); } await sleep(anim ? 700 : 350); return true; }
    var f = await waitFind(sel, 7000);
    if (!f) { console.warn('[guide] 못 찾음', sel); return true; }
    if (k === 'focus' || k === 'dfocus') { if (anim) { await bringIntoView(f); setTarget(f, S.stepBubble); await sleep(400); } return true; }
    if (anim) { await bringIntoView(f); setTarget(f, S.stepBubble); }
    if (k === 'click' || k === 'dclick') {
      if (anim && S.mode === 'try') { var ok = await waitUserClick(f, tok); if (!ok) return false; await sleep(350); return true; }
      if (anim) { await moveCursor(f); await tap(); }
      f.el.click();
      await sleep(anim ? 650 : 260);
      return true;
    }
    if (k === 'type') {
      if (anim) await moveCursor(f);
      f.el.focus && f.el.focus();
      var text = String(val);
      if (anim && f.el.type !== 'datetime-local' && f.el.type !== 'date' && f.el.type !== 'number') { f.el.value = ''; for (var i = 1; i <= text.length; i++) { if (tok !== S.token) return false; f.el.value = text.slice(0, i); fire(f.el, 'input'); await sleep(text.length > 40 ? 18 : 45); } }
      else { f.el.value = text; fire(f.el, 'input'); }
      fire(f.el, 'change'); f.el.blur && f.el.blur();
      await sleep(anim ? 350 : 60); return true;
    }
    if (k === 'select' || k === 'set') {
      if (anim) { await moveCursor(f); await tap(); }
      f.el.value = val; fire(f.el, 'input'); fire(f.el, 'change');
      await sleep(anim ? 550 : 200); return true;
    }
    return true;
  }
  async function runStep(i, anim, tok) {
    var ch = G.chapters[S.ci], step = ch.steps[i]; if (!step) return false;
    S.stepBubble = step.bubble || step.t;
    if (anim) { setTarget(null); renderCap(); }
    var acts = step.act || [];
    for (var j = 0; j < acts.length; j++) { var ok = await run(acts[j], anim, tok); if (ok === false || tok !== S.token) return false; }
    if (anim && step.focus) { var f = await waitFind(step.focus, 5000); if (f) { await bringIntoView(f); setTarget(f, S.stepBubble); } }
    if (anim) cur.classList.remove('show');
    return true;
  }

  // ── 장(챕터) 불러오기 ──
  function loadFrame(ch) {
    return new Promise(function (res) {
      dcReset(); setTarget(null); cur.classList.remove('show');
      IF.onload = async function () {
        var end = Date.now() + 8000;
        while (Date.now() < end) { var w = win(); if (w && w.DOOM_DEMO && doc().querySelector('#app > *:not(.sk)')) break; await sleep(80); }
        await sleep(300);
        var w2 = win();
        if (ch.posts && w2 && w2.DOOM_DEMO) w2.DOOM_DEMO.sim('posts');
        (ch.notes || []).forEach(dcPush);
        w2 && w2.addEventListener('scroll', placeRing, { passive: true });
        try { w2.addEventListener('hashchange', updateUrl); } catch (e) {}
        updateUrl(); res();
      };
      IF.src = (G.doomHref || 'doom') + '?demo=' + encodeURIComponent(ch.role) + '&seed=' + encodeURIComponent(ch.seed) + '&r=' + Date.now() + '#' + (ch.start || '/');
    });
  }
  function updateUrl() { var w = win(), h = ''; try { h = w.location.hash; } catch (e) {} $('g-url').innerHTML = '<b>🔒</b> roonging.com/doom' + esc(h ? '?cid=…' + h : ''); }
  async function openChapter(ci, upto, autoplay) {
    stop(); var tok = ++S.token;
    S.ci = ci; S.si = -1; renderSide(); renderCap();
    $('g-screen').classList.toggle('nodc', !!G.chapters[ci].noDiscord);
    fit();
    await loadFrame(G.chapters[ci]);
    if (tok !== S.token) return;
    for (var i = 0; i < (upto || 0); i++) { if (!(await runStep(i, false, tok))) return; S.si = i; }
    if (tok !== S.token) return;
    S.si = (upto || 0) - 1; renderSide(); renderCap();
    if (autoplay) play();
  }
  function stop() { S.playing = false; $('g-play').textContent = '▶ 자동 재생'; }
  async function play() {
    if (S.busy) return;
    S.playing = true; $('g-play').textContent = '⏸ 멈춤';
    while (S.playing) {
      var ch = G.chapters[S.ci];
      if (S.si >= ch.steps.length - 1) { stop(); renderCap(true); break; }
      var ok = await stepForward(); if (!ok) break;
      var step = ch.steps[S.si];
      await sleep(step.hold != null ? step.hold : 1400 + Math.min(2600, (step.d || '').length * 22));
    }
  }
  async function stepForward() {
    var ch = G.chapters[S.ci]; if (S.si >= ch.steps.length - 1) { renderCap(true); return false; }
    S.busy = true; setBtns();
    var tok = S.token, ni = S.si + 1;
    S.si = ni; renderSide(); renderCap();
    var ok = await runStep(ni, true, tok);
    S.busy = false; setBtns();
    if (tok !== S.token) return false;
    if (ni === ch.steps.length - 1) markDone();
    return ok;
  }
  function markDone() { try { var k = 'doom_guide_done_' + G.id; var d = JSON.parse(localStorage.getItem(k) || '{}'); d[G.chapters[S.ci].id] = 1; localStorage.setItem(k, JSON.stringify(d)); } catch (e) {} renderSide(); }
  function doneMap() { try { return JSON.parse(localStorage.getItem('doom_guide_done_' + G.id) || '{}'); } catch (e) { return {}; } }
  function setBtns() {
    var ch = G.chapters[S.ci];
    $('g-prev').disabled = S.busy || S.si < 0;
    $('g-next').disabled = S.busy || !S.started;
    $('g-next').textContent = S.si >= ch.steps.length - 1 && S.ci < G.chapters.length - 1 ? '다음 장 ▶' : '다음 ▶';
  }
  function renderSide() {
    var dm = doneMap();
    $('g-chs').innerHTML = G.chapters.map(function (c, i) { return '<button class="gch' + (i === S.ci ? ' on' : '') + (dm[c.id] && i !== S.ci ? ' done' : '') + '" onclick="GUIDE_ENGINE.chapter(' + i + ')"><i>' + (dm[c.id] && i !== S.ci ? '✓' : i + 1) + '</i><span><b>' + esc(c.title) + '</b><small>' + esc(c.desc) + '</small></span></button>'; }).join('');
    var ch = G.chapters[S.ci];
    $('g-steps').innerHTML = ch.steps.map(function (s, i) { return '<button class="gst' + (i === S.si ? ' on' : i < S.si ? ' past' : '') + '" onclick="GUIDE_ENGINE.jump(' + i + ')"><i>' + (i < S.si ? '✓' : i + 1) + '</i><span>' + esc(s.t) + '</span></button>'; }).join('');
    $('g-ttl').textContent = (S.ci + 1) + '. ' + ch.title;
    $('g-sub').textContent = (S.si < 0 ? '시작 전' : (S.si + 1) + ' / ' + ch.steps.length + ' 단계') + ' · ' + ch.who;
    setBtns();
  }
  function renderCap(end) {
    var ch = G.chapters[S.ci], s = ch.steps[S.si];
    var c = $('g-cap');
    if (end || (S.si >= ch.steps.length - 1 && S.si >= 0 && !S.busy)) {
      var nx = G.chapters[S.ci + 1];
      c.innerHTML = '<b>🎉 "' + esc(ch.title) + '" 끝!</b><p>' + esc(ch.outro || '이 장에서 보여 드릴 건 여기까지예요.') + '</p>' + (nx ? '<div class="hint">다음 장: ' + esc(nx.title) + ' — "다음 장 ▶"을 누르세요</div>' : '<div class="hint">가이드를 모두 봤어요. 왼쪽에서 다시 보고 싶은 장을 고를 수 있어요.</div>');
      return;
    }
    if (!s) { c.innerHTML = '<b>' + esc(ch.title) + '</b><p>' + esc(ch.intro || ch.desc) + '</p><div class="hint">▶ 자동 재생을 누르면 커서가 직접 눌러 가며 보여 줘요. "직접 해보기"로 바꾸면 강조된 곳을 직접 눌러 볼 수 있어요.</div>'; return; }
    c.innerHTML = '<b>' + (S.si + 1) + '. ' + esc(s.t) + '</b><p>' + esc(s.d || '') + '</p>' + (S.mode === 'try' && (s.act || []).some(function (a) { return a[0] === 'click' || a[0] === 'dclick'; }) ? '<div class="hint">👆 화면에서 노랗게 강조된 곳을 직접 눌러 보세요</div>' : '');
  }

  // ── 시작 화면 ──
  function startOverlay() {
    var ch = G.chapters[S.ci];
    $('g-start').style.display = '';
    $('g-start').innerHTML = '<b>' + esc(G.title) + '</b><p>' + esc(G.intro || '') + '</p><div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="gbtn gold" onclick="GUIDE_ENGINE.begin(\'watch\')">▶ 자동으로 보기</button><button class="gbtn" onclick="GUIDE_ENGINE.begin(\'try\')">👆 직접 해보기</button></div>';
  }

  window.GUIDE_ENGINE = {
    begin: function (mode) { $('g-start').style.display = 'none'; S.started = true; GUIDE_ENGINE.mode(mode); if (mode === 'watch') play(); else stepForward(); setBtns(); },
    toggle: function () { if (!S.started) return GUIDE_ENGINE.begin('watch'); if (S.playing) stop(); else play(); },
    next: async function () {
      if (!S.started) return GUIDE_ENGINE.begin('watch');
      stop(); var ch = G.chapters[S.ci];
      if (S.si >= ch.steps.length - 1) { if (S.ci < G.chapters.length - 1) { await openChapter(S.ci + 1, 0, false); stepForward(); } return; }
      stepForward();
    },
    prev: function () { if (S.si <= 0) return openChapter(S.ci, 0, false); var t = S.si - 1; openChapter(S.ci, t, false).then(function () { stepForward(); }); },
    restart: function () { openChapter(S.ci, 0, false).then(function () { if (S.started && S.mode === 'watch') play(); }); },
    chapter: function (i) { S.started = true; $('g-start').style.display = 'none'; openChapter(i, 0, false).then(function () { if (S.mode === 'watch') play(); else stepForward(); }); },
    jump: function (i) { S.started = true; $('g-start').style.display = 'none'; openChapter(S.ci, i, false).then(function () { stepForward(); }); },
    mode: function (m) { S.mode = m; $('g-m-watch').classList.toggle('on', m === 'watch'); $('g-m-try').classList.toggle('on', m === 'try'); if (m === 'try') stop(); renderCap(); },
    // 디스코드 화면의 버튼
    dc: function (btn) {
      var w = win(), link = btn.getAttribute('data-link'), id = btn.getAttribute('data-id'), card = btn.closest('.dcm');
      if (link) { if (w) { w.location.hash = link.slice(1); } return; }
      if (btn.getAttribute('data-bid') === 'thread') { var th = document.querySelector('.dcm[data-card^="thread"]'); if (th) { th.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); th.classList.remove('flash'); void th.offsetWidth; th.classList.add('flash'); } return; }
      if (!id || !w || !w.DOOM_DEMO) return;
      var r = w.DOOM_DEMO.discordClick(id);
      if (r && r.content) {
        var box = card && card.querySelector('.subs');
        var html = '<div class="sub"><div class="dcm-k"><em class="eph">나만 볼 수 있어요</em> 룽봇 답장</div><div class="dcm-c">' + md(r.content) + '</div>' + btnsHtml(r.buttons) + '</div>';
        if (box) { box.innerHTML = html; } else dcPush({ kind: 'note', head: '나만 볼 수 있어요 · 룽봇 답장', content: r.content, buttons: r.buttons });
      }
      w.__doomReload && w.__doomReload();
    },
  };
  // 자동 점검용: 한 장의 모든 단계를 애니메이션 없이 실행
  window.GUIDE_ENGINE._replay = function (ci) { S.started = true; $('g-start').style.display = 'none'; return openChapter(ci, G.chapters[ci].steps.length, false); };
  // 첫 화면
  fit(); renderSide(); renderCap(); startOverlay();
  openChapter(0, 0, false).then(function () { fit(); });
  new ResizeObserver(fit).observe($('g-view'));
})();
