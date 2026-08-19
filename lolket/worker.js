
// ── Cloudflare Cache API 헬퍼 ──
async function cachedFetch(cacheKey, fetchFn, ttlSeconds) {
  try {
    const cache = caches.default;
    const req = new Request('https://cache.roonging.com/' + cacheKey);
    const cached = await cache.match(req);
    if (cached) {
      console.log('[cache] HIT:', cacheKey);
      return await cached.json();
    }
    console.log('[cache] MISS:', cacheKey);
    const data = await fetchFn();
    const res = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttlSeconds}`
      }
    });
    await cache.put(req, res);
    return data;
  } catch(e) {
    console.log('[cache] ERROR:', e.message, '- falling back to direct fetch');
    return await fetchFn();
  }
}

async function invalidateCache(cacheKey) {
  const cache = caches.default;
  const req = new Request('https://cache.roonging.com/' + cacheKey);
  await cache.delete(req);
}

const REGIONS = {
  KR:  { platform: 'kr',   regional: 'asia'     },
  NA:  { platform: 'na1',  regional: 'americas' },
  EUW: { platform: 'euw1', regional: 'europe'   },
  JP:  { platform: 'jp1',  regional: 'asia'     },
};
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token',
};

// 세션 토큰 → 역할 매핑 (KV 대신 메모리 캐시, Worker 재시작 시 초기화됨)
// 실운영에서는 Cloudflare KV 사용 권장
const _sessions = new Map(); // token → session
const _idToToken = new Map(); // id → token (중복 로그인 감지)
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8시간

function genToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

function getSession(token) {
  if (!token) return null;
  const s = _sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    _sessions.delete(token);
    _idToToken.delete(s.id);
    return null;
  }
  return s;
}

// 기존 세션 무효화 후 새 세션 발급
function issueSession(id, data) {
  // 같은 id로 기존 세션이 있으면 무효화 (중복 로그인 방지)
  const oldToken = _idToToken.get(id);
  const displaced = !!(oldToken && _sessions.has(oldToken));
  if (oldToken) {
    _sessions.delete(oldToken);
  }
  const token = genToken();
  _sessions.set(token, { ...data, id, createdAt: Date.now() });
  _idToToken.set(id, token);
  return { token, displaced };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url  = new URL(request.url);
    const path = url.pathname;

    // 크롤러가 stats 페이지 요청 시 동적 OG HTML 반환
    if (path === '/stats' || path === '/stats.html') {
      const ua = request.headers.get('User-Agent') || '';
      if (isCrawler(ua)) return handleOgProxy(request, env);
      return fetch(request);
    }

    // 디스코드 Interactions
    if (path === '/discord' && request.method === 'POST') {
      return handleDiscordInteraction(request, env, ctx);
    }
    // ── 어드민 API ──
    if (path === '/admin-login' && request.method === 'POST') return handleLogin(request, env);
    if (path === '/admin-list' && request.method === 'POST') return handleAdminList(request, env);
    if (path === '/admin-add' && request.method === 'POST') return handleAdminAdd(request, env);
    if (path === '/admin-remove' && request.method === 'POST') return handleAdminRemove(request, env);
    if (path === '/admin-change-pw' && request.method === 'POST') return handleAdminChangePw(request, env);
    if (path === '/system-setting-write' && request.method === 'POST') return handleSystemSettingWrite(request, env);

    if (path === '/riot.txt') {
      return new Response('e8781c6a-562d-45db-903d-d54ad00da76c', {
        status: 200, headers: { 'Content-Type': 'text/plain', ...CORS },
      });
    }

    if (path === '/firebase-config') {
      const config = {
        apiKey:            env.FB_API_KEY,
        authDomain:        env.FB_AUTH_DOMAIN,
        databaseURL:       env.FB_DATABASE_URL,
        projectId:         env.FB_PROJECT_ID,
        storageBucket:     env.FB_STORAGE_BUCKET,
        messagingSenderId: env.FB_MESSAGING_SENDER_ID,
        appId:             env.FB_APP_ID,
      };
      return new Response(JSON.stringify(config), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    if (path === '/contact-info') {
      return new Response(JSON.stringify({ email: env.ADMIN_EMAIL || '' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    if (path === '/auth-salt') {
      return new Response(JSON.stringify({ salt: env.PW_SALT || '' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // 로그인 — 세션 토큰 발급
    if (path === '/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // 버그/피드백/문의 Discord 포럼 포스트
    if (path === '/report' && request.method === 'POST') {
      try {
        const data = await request.json();
        const result = await sendDiscordReport(env, data);
        return json(result);
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // Discord 채널 이미지/메시지 전송
    if (path === '/discord-send' && request.method === 'POST') {
      try {
        const data = await request.json();
        const result = await sendDiscordToChannel(env, data);
        return json(result);
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // 세션 유효성 확인용 ping
    if (path === '/session-ping' && request.method === 'POST') {
      const token = request.headers.get('X-Session-Token');
      const session = getSession(token);
      if (!session) return json({ ok: false, error: '로그인이 필요합니다' }, 401);
      return json({ ok: true, role: session.role, communityId: session.communityId || null, id: session.id || null });
    }

    // 외부 API 프록시 — 커뮤니티 개발자 설정에서 등록한 API 호출
    if (path === '/external-api-call' && request.method === 'POST') {
      const token = request.headers.get('X-Session-Token');
      const session = getSession(token);
      if (!session) return json({ ok: false, error: '로그인이 필요합니다' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
      const { url, method = 'POST', headers = {}, body: reqBody } = body;
      if (!url) return json({ ok: false, error: 'url 누락' }, 400);
      // 기본 보안: http(s) 스킴만 허용
      if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: '허용되지 않는 URL 형식' }, 400);
      try {
        const fetchOpts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
        if (reqBody && !['GET','HEAD'].includes(method.toUpperCase())) fetchOpts.body = reqBody;
        const res = await fetch(url, fetchOpts);
        let resBody;
        const ct = res.headers.get('content-type') || '';
        try { resBody = ct.includes('application/json') ? await res.json() : await res.text(); } catch { resBody = null; }
        return json({ ok: res.ok, status: res.status, body: resBody });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // 잘못 생성된 match_index 데이터 정리 (마스터 전용, 1회용)
    if (path === '/cleanup-match-index' && request.method === 'POST') {
      const token = request.headers.get('X-Session-Token');
      const session = getSession(token);
      if (!session || session.role !== 'master') return json({ ok: false, error: '마스터 권한 필요' }, 403);
      try {
        const dbUrl = env.FB_DATABASE_URL;
        const authQ = env.FB_DB_SECRET ? '?auth=' + env.FB_DB_SECRET : '';
        // communities 전체 조회
        const commRes = await fetch(dbUrl + '/communities.json' + authQ);
        const communities = await commRes.json();
        let cleaned = 0;
        if (communities) {
          for (const [cid, commData] of Object.entries(communities)) {
            if (!commData || !commData.matches) continue;
            for (const matchId of Object.keys(commData.matches)) {
              // match_index 로 시작하는 잘못된 키 삭제
              if (matchId.startsWith('match_index')) {
                await fetch(dbUrl + '/communities/' + cid + '/matches/' + matchId + '.json' + authQ, { method: 'DELETE' });
                cleaned++;
              }
            }
          }
        }
        return json({ ok: true, cleaned });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // 알람 체크 수동 트리거 (마스터 전용, 테스트용)
    if (path === '/trigger-alarm-check' && request.method === 'POST') {
      const token = request.headers.get('X-Session-Token');
      const session = getSession(token);
      if (!session || session.role !== 'master') {
        return json({ ok: false, error: '마스터 권한 필요' }, 403);
      }
      try {
        await runAlarmCheck(env);
        return json({ ok: true, message: '알람 체크 완료', serverTime: new Date().toISOString() });
      } catch(e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // 커뮤니티 배너 이미지 저장 (128KB 제한 우회용 - 이미지만 별도 처리)
    if (path === '/community-image' && request.method === 'POST') {
      try {
        const token = request.headers.get('X-Session-Token');
        const session = getSession(token);
        if (!session) return json({ ok: false, error: '로그인이 필요합니다' }, 403);

        const { communityId, imageData } = await request.json();
        if (!communityId) return json({ ok: false, error: 'communityId 누락' }, 400);

        // 본인 커뮤니티이거나 마스터만 가능 (session에 communityId 없으면 마스터만)
        if (session.role !== 'master' && session.communityId !== communityId) {
          return json({ ok: false, error: '권한이 없습니다' }, 403);
        }

        const dbUrl  = env.FB_DATABASE_URL;
        const secret = env.FB_DB_SECRET;
        const authQ  = secret ? `?auth=${secret}` : '';
        const res = await fetch(`${dbUrl}/communities_info/${communityId}/bannerImage.json${authQ}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imageData || null),
        });
        if (!res.ok) return json({ ok: false, error: 'DB 저장 실패: ' + res.status }, 500);
        return json({ ok: true });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // 커뮤니티 신청 이메일 발송
    if (path === '/send-apply-email' && request.method === 'POST') {
      try {
        const data = await request.json();
        await sendApplyEmail(env, data);
        return json({ ok: true });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // DB 공개 읽기 프록시 (인증 불필요)
    if (path === '/db-public-read' && request.method === 'POST') {
      return handleDbPublicRead(request, env);
    }
    if (path === '/chat-send' && request.method === 'POST') {
      return handleChatSend(request, env);
    }
    if (path === '/chat-clear' && request.method === 'POST') {
      return handleChatClear(request, env);
    }
    if (path === '/bid-submit' && request.method === 'POST') {
      return handleBidSubmit(request, env);
    }
    if (path === '/member-analysis-write' && request.method === 'POST') {
      return handleMemberAnalysisWrite(request, env);
    }
    if (path === '/member-analysis-read' && request.method === 'POST') {
      return handleMemberAnalysisRead(request, env);
    }
    if (path === '/member-ratings-read' && request.method === 'POST') {
      return handleMemberRatingsRead(request, env);
    }
    if (path === '/temp-tier-write' && request.method === 'POST') {
      return handleTempTierWrite(request, env);
    }
    if (path === '/temp-tiers-read' && request.method === 'POST') {
      return handleTempTiersRead(request, env);
    }
    if (path === '/rating-write' && request.method === 'POST') {
      return handleRatingWrite(request, env);
    }
    if (path === '/rating-batch-write' && request.method === 'POST') {
      return handleRatingBatchWrite(request, env);
    }
    if (path === '/rating-match-apply' && request.method === 'POST') {
      return handleRatingMatchApply(request, env);
    }
    // 마스터 전용 Cron 수동 실행 테스트
    // 딥롤 서버 정보 프록시 (캐시)
    if (path === '/server-info' && request.method === 'POST') {
      return handleServerInfo(request, env);
    }
    // 관찰 분석
    if (path === '/discord-notify' && request.method === 'POST') {
      return handleDiscordNotify(request, env);
    }
    if (path === '/row-effect-write' && request.method === 'POST') {
      return handleRowEffectWrite(request, env);
    }
    if (path === '/scout-categories-write' && request.method === 'POST') {
      return handleScoutCategoriesWrite(request, env);
    }
    if (path === '/scout-allow-write' && request.method === 'POST') {
      return handleScoutAllowWrite(request, env);
    }
    if (path === '/scout-ranked' && request.method === 'POST') {
      return handleScoutRanked(request, env);
    }
    // 관찰 분석 대상
    if (path === '/scout-targets-write' && request.method === 'POST') {
      return handleScoutTargetsWrite(request, env);
    }
    // 후원 목록
    if (path === '/donation-read' && request.method === 'POST') {
      return handleDonationRead(request, env);
    }
    if (path === '/donation-write' && request.method === 'POST') {
      return handleDonationWrite(request, env);
    }
    // 닉네임 히스토리
    if (path === '/nickname-history-write' && request.method === 'POST') {
      return handleNicknameHistoryWrite(request, env);
    }
    if (path === '/nickname-history-run' && request.method === 'POST') {
      return handleNicknameHistoryRun(request, env);
    }
    if (path === '/nickname-history-read' && request.method === 'POST') {
      return handleNicknameHistoryRead(request, env);
    }
    // 피크티어 경량 읽기
    if (path === '/peak-tiers-read' && request.method === 'POST') {
      return handlePeakTiersRead(request, env);
    }
    // 주간 미션
    if (path === '/weekly-mission-config-read' && request.method === 'POST') {
      return handleWeeklyMissionConfigRead(request, env);
    }
    if (path === '/weekly-mission-config-write' && request.method === 'POST') {
      return handleWeeklyMissionConfigWrite(request, env);
    }
    if (path === '/weekly-mission-count' && request.method === 'POST') {
      return handleWeeklyMissionCount(request, env);
    }
    if (path === '/weekly-mission-reward' && request.method === 'POST') {
      return handleWeeklyMissionReward(request, env);
    }
    if (path === '/weekly-mission-rewards-read' && request.method === 'POST') {
      return handleWeeklyMissionRewardsRead(request, env);
    }
    // 개인 메모장
    if (path === '/memo-write' && request.method === 'POST') {
      return handleMemoWrite(request, env);
    }
    if (path === '/memo-read' && request.method === 'POST') {
      return handleMemoRead(request, env);
    }
    // Discord OAuth
    if (path === '/discord-oauth-url' && request.method === 'POST') {
      return handleDiscordOAuthUrl(request, env);
    }
    if (path === '/discord-oauth-callback' && request.method === 'POST') {
      return handleDiscordOAuthCallback(request, env);
    }
    // 코멘트
    if (path === '/comment-write' && request.method === 'POST') {
      return handleCommentWrite(request, env);
    }
    if (path === '/comment-read' && request.method === 'POST') {
      return handleCommentRead(request, env);
    }
    if (path === '/comment-delete' && request.method === 'POST') {
      return handleCommentDelete(request, env);
    }
    if (path === '/cron-rating-test' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
      let session = getSession(body.token);
      // 토큰 실패 시 id/pw로 직접 검증
      if (!session && body.adminId && body.adminPw) {
        const dbUrl2 = env.FB_DATABASE_URL;
        const secret2 = env.FB_DB_SECRET;
        const authQ2 = secret2 ? '?auth=' + secret2 : '';
        try {
          const saltRes = await fetch(dbUrl2 + '/master/salt.json' + authQ2);
          if (saltRes.ok) {
            const salt = await saltRes.json();
            if (salt) {
              const enc = new TextEncoder();
              const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(body.adminPw + salt));
              const hashHex = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
              const mr = await fetch(dbUrl2 + '/master.json' + authQ2);
              if (mr.ok) { const master = await mr.json(); if (master?.id === body.adminId && master?.pw === hashHex) session = { role: 'master' }; }
            }
          }
        } catch(e) {}
      }
      console.log('[cron-test] session:', session?.role, 'adminId:', body.adminId ? 'yes' : 'no');
      if (!session || session.role !== 'master') return json({ok:false,error:'마스터 권한 필요 (session:'+session?.role+')'},403);
      try {
        await runScheduledRatingCalc(env);
        return json({ok:true, message:'Cron 실행 완료'});
      } catch(e) {
        console.error('[cron-test] 오류:', e.message);
        return json({ok:false, error: e.message});
      }
    }
    if (path === '/rating-match-revert' && request.method === 'POST') {
      return handleRatingMatchRevert(request, env);
    }
    if (path === '/rating-read' && request.method === 'POST') {
      return handleRatingRead(request, env);
    }
    if (path === '/rating-log-write' && request.method === 'POST') {
      return handleRatingLogWrite(request, env);
    }
    if (path === '/rating-log-read' && request.method === 'POST') {
      return handleRatingLogRead(request, env);
    }

    // DB 읽기 프록시 (마스터 전용 경로)
    if (path === '/db-read' && request.method === 'POST') {
      return handleDbRead(request, env);
    }

    // DB 쓰기 프록시 — 세션 토큰 검증 후 Firebase REST API로 전달
    if (path === '/db-write' && request.method === 'POST') {
      return handleDbWrite(request, env);
    }

    // DB 삭제 프록시
    if (path === '/db-delete' && request.method === 'POST') {
      return handleDbDelete(request, env);
    }

    const key = env.RIOT_API_KEY;
    if (!key) return json({ error: 'RIOT_API_KEY 환경변수가 설정되지 않았습니다' }, 500);

    if (path === '/' || path === '')   return handleSummoner(url, key);
    if (path === '/match')             return handleMatch(url, key);
    if (path === '/recent-custom')     return handleRecentCustom(url, key);
    return json({ error: '알 수 없는 경로' }, 404);
  },

  // ── Cron: 5분=알람체크, 3시간=레이팅계산 ──
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === '*/5 * * * *') {
      ctx.waitUntil(runAlarmCheck(env));
    } else if (cron === '0 */3 * * *') {
      ctx.waitUntil(runScheduledRatingCalc(env));
    } else {
      // 알 수 없는 cron - 둘 다 실행
      ctx.waitUntil(Promise.all([runAlarmCheck(env), runScheduledRatingCalc(env)]));
    }
  },
};

// ── Cron 알람 체크 ──
async function runAlarmCheck(env) {
  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ  = secret ? '?auth=' + secret : '';

  // notified=false인 알람만 Firebase 쿼리로 조회
  const queryQ = authQ
    ? authQ + '&orderBy="notified"&equalTo=false'
    : '?orderBy="notified"&equalTo=false';
  const res = await fetch(dbUrl + '/match_alarms.json' + queryQ);
  if (!res.ok) return;
  const data = await res.json();
  if (!data) return;

  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  const targets = Object.values(data).filter(a => {
    if (!a || !a.matchId) return false;
    const st = Number(a.startTime);
    if (isNaN(st)) return false;
    const diff = st - now;
    return diff >= 0 && diff <= oneHour;
  });

  if (!targets.length) return;

  const TOKEN = env.DISCORD_BOT_TOKEN;

  for (const alarm of targets) {
    try {
      // matchId로 커뮤니티 ID 조회 (match_index 경로)
      const idxRes = await fetch(dbUrl + '/match_index/' + alarm.matchId + '.json' + authQ);
      if (!idxRes.ok) continue;
      const communityId = await idxRes.json();
      if (!communityId) continue;

      // 매치 데이터 조회
      const matchRes = await fetch(dbUrl + '/communities/' + communityId + '/matches/' + alarm.matchId + '.json' + authQ);
      if (!matchRes.ok) continue;
      const matchData = await matchRes.json();
      if (!matchData) continue;

      // 커뮤니티 정보 조회
      const commRes = await fetch(dbUrl + '/communities_info/' + communityId + '.json' + authQ);
      if (!commRes.ok) continue;
      const commData = await commRes.json();
      if (!commData || !commData.alarmChannelId) continue;

      // Discord 메시지 전송
      const pad = n => String(n).padStart(2, '0');
      // KST = UTC+9
      const d = new Date(alarm.startTime + 9 * 60 * 60 * 1000);
      const year  = d.getUTCFullYear();
      const month = pad(d.getUTCMonth() + 1);
      const date  = pad(d.getUTCDate());
      const days  = ['일', '월', '화', '수', '목', '금', '토'];
      const day   = days[d.getUTCDay()];
      const hours = d.getUTCHours();
      const mins  = d.getUTCMinutes();
      const ampm  = hours < 12 ? '오전' : '오후';
      const h12   = hours % 12 === 0 ? 12 : hours % 12;
      const timeStr = year + '년' + month + '월' + date + '일(' + day + ') ' + ampm + ' ' + h12 + '시' + (mins > 0 ? ' ' + pad(mins) + '분' : '');

      const everyone = commData.alarmEveryone ? '@everyone\n' : '';
      const msg = everyone + '⏰ **[' + (matchData.name || '내전') + ']** 시작 1시간 전입니다!\n📅 ' + timeStr + '\n[진행자 : ' + (matchData.admin || '—') + ']';

      const discordRes = await fetch('https://discord.com/api/v10/channels/' + commData.alarmChannelId + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg }),
      });

      if (discordRes.ok) {
        // notified = true 업데이트
        await fetch(dbUrl + '/match_alarms/' + alarm.matchId + '.json' + authQ, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notified: true, notifiedAt: now }),
        });
      }
    } catch(e) {
      console.error('[alarm]', alarm.matchId, e.message);
    }
  }
}

// ══ 로그인 — 세션 토큰 발급 ══
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }

  const { id, pw, type } = body;
  if (!id || !pw || !type) return json({ ok: false, error: '파라미터 누락' }, 400);

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const salt   = env.PW_SALT || 'lolket_v1';
  const pwHash = await sha256(pw + salt);
  const authQ  = secret ? `?auth=${secret}` : '';

  try {
    if (type === 'master') {
      const res  = await fetch(`${dbUrl}/superadmin.json${authQ}`);
      if (!res.ok) return json({ ok: false, error: 'DB 조회 실패: ' + res.status }, 500);
      const data = await res.json();
      if (!data || data.id !== id) return json({ ok: false, error: '아이디 또는 비밀번호가 틀렸습니다' }, 401);
      if (!await verifyPw(pw, pwHash, data.password)) return json({ ok: false, error: '아이디 또는 비밀번호가 틀렸습니다' }, 401);
      const { token, displaced } = issueSession(id, { role: 'master' });
      return json({ ok: true, role: 'master', token, displaced });
    }

    if (type === 'admin') {
      const res  = await fetch(`${dbUrl}/admin/${encodeURIComponent(id)}.json${authQ}`);
      if (!res.ok) return json({ ok: false, error: 'DB 조회 실패: ' + res.status }, 500);
      const data = await res.json();
      if (!data) return json({ ok: false, error: '아이디 또는 비밀번호가 틀렸습니다' }, 401);
      if (!await verifyPw(pw, pwHash, data.password)) return json({ ok: false, error: '아이디 또는 비밀번호가 틀렸습니다' }, 401);
      const { token, displaced } = issueSession(id, { role: 'admin', communityId: data.communityId });
      const { password: _pw, ...safe } = data;
      return json({ ok: true, role: 'admin', token, data: safe, displaced });
    }

    return json({ ok: false, error: '알 수 없는 type' }, 400);
  } catch (e) {
    return json({ ok: false, error: '서버 오류', detail: e.message }, 500);
  }
}

// ══ DB 공개 읽기 프록시 ══
async function handleDbPublicRead(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { path: dbPath, shallow } = body;
  if (!dbPath) return json({ ok: false, error: 'path 누락' }, 400);

  // 공개 읽기 허용 경로만
  const publicRead = [
    /^recruits($|\/)/,
    /^recruit_comments\//,
    /^recruit_bookmarks\//,
    /^recruit_applies\//,
    /^notices($|\/)/,
    /^communities_info($|\/)/,
    /^rtube($|\/)/,
    /^communities\/[^/]+\/matches($|\/)/,
    /^communities\/[^/]+\/rules($|\/)/,
    /^communities\/[^/]+\/rating_config($|\/)/,
    /^communities\/[^/]+\/name$/,
    /^communities\/[^/]+\/member_analysis($|\/)/,
    /^communities\/[^/]+\/match_categories($|\/)/,
    /^communities\/[^/]+\/deeplolServerId$/,
    /^communities\/[^/]+$/,
    /^communities_info\/[^/]+($|\/)/,
    /^communities\/[^/]+\/ratings($|\/)/,
    /^communities\/[^/]+\/rating_logs($|\/)/,
    /^communities\/[^/]+\/rating_history($|\/)/,
    /^communities\/[^/]+\/matches\/[^/]+\/chat($|\/)/,
    /^communities\/[^/]+\/matches\/[^/]+\/auctionLog($|\/)/,
    /^system\/patch_mode$/,
    /^communities\/[^/]+\/nickname_history\/[^/]+$/,
    /^communities\/[^/]+\/matches$/,
    /^communities\/[^/]+\/scout_targets$/,
    /^communities\/[^/]+\/scout_allowed_discord$/,
    /^communities\/[^/]+\/scout_categories$/,
    /^communities\/[^/]+\/row_effects$/,
    /^communities\/[^/]+\/bg_effects$/,
    /^system$/,
  ];
  if (!publicRead.some(r => r.test(dbPath))) {
    return json({ ok: false, error: '허용되지 않는 경로입니다' }, 403);
  }

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ  = secret ? `?auth=${secret}` : '';
  try {
    const shallowParam = shallow ? (authQ ? '&shallow=true' : '?shallow=true') : '';
    // rating_history 전체 읽기는 5분 캐시
    const isRatingHistory = /^communities\/[^/]+\/rating_history$/.test(dbPath) && !shallow;
    if (isRatingHistory) {
      const cacheKey = `rating-history-${dbPath.split('/')[1]}`;
      const data = await cachedFetch(cacheKey, async () => {
        const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}`);
        if (!res.ok) return null;
        return await res.json();
      }, 1800);
      return json({ ok: true, data });
    }
    const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}${shallowParam}`);
    if (!res.ok) return json({ ok: false, error: 'DB 읽기 실패: ' + res.status }, 500);
    const data = await res.json();
    return json({ ok: true, data });
  } catch(e) { return json({ ok: false, error: e.message }, 500); }
}


// ══ Discord 포럼 포스트 ══
async function sendDiscordReport(env, data) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN 환경변수가 설정되지 않았습니다');
  const CHANNELS = {
    bug:      '1500699477768536225',
    feedback: '1500699548975108238',
    inquiry:  '1500699402363338812',
    private:  '1500716226828308622',
  };
  const { category, title, content, contact, isPrivate } = data;
  const channelId = isPrivate ? CHANNELS.private : (CHANNELS[category] || CHANNELS.inquiry);
  const LABEL = { bug: '🐛 버그', feedback: '💡 피드백', inquiry: '❓ 문의' };
  const catLabel  = LABEL[category] || category;
  const privLabel = isPrivate ? '🔒 비공개' : '🔓 공개';
  const postTitle = ('[' + catLabel + '] ' + title).slice(0, 100);
  const lines = ['**카테고리:** ' + catLabel + '  |  **공개 여부:** ' + privLabel, '', content];
  if (contact) lines.push('', '**연락수단:** ' + contact);
  lines.push('', '*제출: ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + '*');
  const msgContent = lines.join('\n').slice(0, 2000);
  const res = await fetch('https://discord.com/api/v10/channels/' + channelId + '/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bot ' + token },
    body: JSON.stringify({ name: postTitle, auto_archive_duration: 10080, message: { content: msgContent } }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Discord API ' + res.status + ': ' + err);
  }
  return { ok: true };
}


// ══ Discord 채널로 이미지/메시지 전송 ══
async function sendDiscordToChannel(env, data) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN 환경변수가 없습니다');

  const { channelId, imageBase64, message, filename } = data;
  if (!channelId) throw new Error('채널 ID가 없습니다');

  const fname = filename || 'match-result.png';

  if (imageBase64) {
    // base64 → binary
    const binary = atob(imageBase64.replace(/^data:image\/\w+;base64,/, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), fname);
    if (message) form.append('content', message);

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${token}` },
      body: form,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord API ${res.status}: ${err}`);
    }
  } else if (data.embeds || message) {
    const body = {};
    if (message) body.content = message;
    if (data.embeds) body.embeds = data.embeds;
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord API ${res.status}: ${err}`);
    }
  }
  return { ok: true };
}

// ══ DB 읽기 프록시 (마스터 세션 필요) ══
async function handleDbRead(request, env) {
  const token = request.headers.get('X-Session-Token');
  const session = getSession(token);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }

  const { path: dbPath, shallow } = body;
  if (!dbPath) return json({ ok: false, error: 'path 누락' }, 400);

  // 관리자가 자신의 커뮤니티 정보 읽기 허용
  const isOwnCommunityInfo = session && session.role === 'admin' &&
    /^communities_info\/[^/]+(\/.*)?$/.test(dbPath) &&
    session.communityId && session.communityId === dbPath.split('/')[1];

  if (isOwnCommunityInfo) {
    // 통과 — 자신의 커뮤니티 정보는 읽기 허용
  } else if (/^blacklist/.test(dbPath) && session) {
    // 관리자 이상 블랙리스트 읽기 허용
  } else if (/^communities\/[^/]+\/rules($|\/)/.test(dbPath) && session) {
    // 관리자 이상 가이드/룰 읽기 허용
  } else if (/^community_messages\//.test(dbPath) && session) {
    // 관리자 이상 커뮤니티 메시지 읽기 허용
  } else {
    // 마스터만 읽기 가능한 경로
    const masterRead = [
      /^applies/,
      /^superadmin/,
      /^admin\//,
      /^communities_info\//,
    ];
    if (!masterRead.some(r => r.test(dbPath))) {
      return json({ ok: false, error: '읽기 권한이 없습니다' }, 403);
    }
    if (!session || session.role !== 'master') {
      return json({ ok: false, error: '마스터 권한이 필요합니다' }, 403);
    }
  }

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ  = secret ? `?auth=${secret}` : '';

  try {
    const shallowParam = shallow ? (authQ ? '&shallow=true' : '?shallow=true') : '';
    // rating_history 전체 읽기는 5분 캐시
    const isRatingHistory = /^communities\/[^/]+\/rating_history$/.test(dbPath) && !shallow;
    if (isRatingHistory) {
      const cacheKey = `rating-history-${dbPath.split('/')[1]}`;
      const data = await cachedFetch(cacheKey, async () => {
        const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}`);
        if (!res.ok) return null;
        return await res.json();
      }, 1800);
      return json({ ok: true, data });
    }
    const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}${shallowParam}`);
    if (!res.ok) return json({ ok: false, error: 'DB 읽기 실패: ' + res.status }, 500);
    const data = await res.json();
    return json({ ok: true, data });
  } catch(e) { return json({ ok: false, error: e.message }, 500); }
}

// ══ DB 쓰기 프록시 ══
async function handleDbWrite(request, env) {
  const token = request.headers.get('X-Session-Token');
  const session = getSession(token);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }

  const { path: dbPath, data, requireRole } = body;
  if (!dbPath) return json({ ok: false, error: 'path 누락' }, 400);

  // 권한 체크
  if (!checkPermission(session, dbPath, requireRole)) {
    return json({ ok: false, error: '권한이 없습니다' }, 403);
  }

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ  = secret ? `?auth=${secret}` : '';

  try {
    if (!dbUrl) return json({ ok: false, error: 'FB_DATABASE_URL 환경변수 없음' }, 500);
    const fullUrl = `${dbUrl}/${dbPath}.json${authQ}`;

    // matches/{id} PUT 시 auctionLog/captainCodes 보존: PATCH 방식 사용
    const isMatchRoot = /^communities\/[^/]+\/matches\/[^/]+$/.test(dbPath);
    const httpMethod = isMatchRoot ? 'PATCH' : 'PUT';

    const res = await fetch(fullUrl, {
      method: httpMethod,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const resText = await res.text();
    if (!res.ok) return json({ ok: false, error: 'DB 쓰기 실패: ' + res.status + ' ' + resText.slice(0,200) }, 500);
    if (resText === 'null') return json({ ok: false, error: 'Firebase Rules에 의해 거부됨' }, 403);

    // 커뮤니티 신청 저장 시 이메일 발송
    if (/^applies\/[^/]+$/.test(dbPath) && data) {
      sendApplyEmail(env, data).catch(() => {});
    }

    return json({ ok: true });
  } catch(e) { return json({ ok: false, error: e.message }, 500); }
}

async function sendApplyEmail(env, data) {
  const apiKey = env.RESEND_API_KEY;
  const to     = 'rdc6087@naver.com';
  const from   = 'noreply@roonging.com';

  const community = data.community || data.communityName || '(미입력)';
  const name      = data.name      || '(미입력)';
  const type      = data.type      === 'official' ? '공식 커뮤니티' : '일반 커뮤니티';
  const desc      = data.desc      || data.description || '(없음)';
  const email     = data.email     || '(미입력)';
  const discord   = data.discord   || '(미입력)';
  const createdAt = data.createdAt ? new Date(data.createdAt).toLocaleString('ko-KR') : '—';

  const html = `
<div style="font-family:'Apple SD Gothic Neo',sans-serif;max-width:560px;margin:0 auto;background:#0d1117;color:#c9d1d9;border-radius:8px;overflow:hidden;">
  <div style="background:#1a2332;padding:24px 32px;border-bottom:2px solid #C8AA6E;">
    <h2 style="margin:0;font-size:20px;color:#C8AA6E;letter-spacing:2px;">⚔ 롤켓배송</h2>
    <p style="margin:6px 0 0;font-size:13px;color:#8b949e;">신규 커뮤니티 신청이 접수됐습니다</p>
  </div>
  <div style="padding:24px 32px;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="border-bottom:1px solid #21262d;">
        <td style="padding:10px 0;color:#8b949e;width:120px;">커뮤니티명</td>
        <td style="padding:10px 0;font-weight:700;color:#e6edf3;">${community}</td>
      </tr>
      <tr style="border-bottom:1px solid #21262d;">
        <td style="padding:10px 0;color:#8b949e;">신청자</td>
        <td style="padding:10px 0;color:#e6edf3;">${name}</td>
      </tr>
      <tr style="border-bottom:1px solid #21262d;">
        <td style="padding:10px 0;color:#8b949e;">유형</td>
        <td style="padding:10px 0;color:#e6edf3;">${type}</td>
      </tr>
      <tr style="border-bottom:1px solid #21262d;">
        <td style="padding:10px 0;color:#8b949e;">소개</td>
        <td style="padding:10px 0;color:#e6edf3;">${desc}</td>
      </tr>
      <tr style="border-bottom:1px solid #21262d;">
        <td style="padding:10px 0;color:#8b949e;">이메일</td>
        <td style="padding:10px 0;color:#e6edf3;">${email}</td>
      </tr>
      <tr style="border-bottom:1px solid #21262d;">
        <td style="padding:10px 0;color:#8b949e;">디스코드</td>
        <td style="padding:10px 0;color:#e6edf3;">${discord}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;color:#8b949e;">신청 일시</td>
        <td style="padding:10px 0;color:#e6edf3;">${createdAt}</td>
      </tr>
    </table>
  </div>
  <div style="padding:16px 32px;background:#1a2332;font-size:12px;color:#8b949e;text-align:center;">
    롤켓배송 관리 시스템 · roonging.com
  </div>
</div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to,
      subject: `[롤켓배송] 신규 커뮤니티 신청 - ${community}`,
      html,
    }),
  });
}

// ══ DB 삭제 프록시 ══
async function handleDbDelete(request, env) {
  const token = request.headers.get('X-Session-Token');
  const session = getSession(token);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }

  const { path: dbPath, requireRole } = body;
  if (!dbPath) return json({ ok: false, error: 'path 누락' }, 400);

  if (!checkPermission(session, dbPath, requireRole)) {
    return json({ ok: false, error: '권한이 없습니다' }, 403);
  }

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ  = secret ? `?auth=${secret}` : '';

  try {
    const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}`, { method: 'DELETE' });
    if (!res.ok) return json({ ok: false, error: 'DB 삭제 실패: ' + res.status }, 500);
    return json({ ok: true });
  } catch(e) { return json({ ok: false, error: e.message }, 500); }
}

// 경로별 권한 체크
function checkPermission(session, dbPath, requireRole) {
  // 공개 쓰기 허용 경로 (인증 불필요)
  const publicWrite = [
    /^applies\/[^/]+$/,             // 커뮤니티 신청 (누구나)
    /^notices\/[^/]+\/views$/,      // 조회수 (누구나)
    /^invite_codes\/[^/]+\/used$/,  // 초대코드 사용 (누구나)
    /^communities\/[^/]+\/matches/, // 내전 데이터 (Worker 재시작 시 세션 소멸 대응)
    /^admin\/[^/]+$/,               // 초대 링크로 관리자 계정 생성 (비로그인)
    /^recruits\/[^/]+$/,            // 외전 모집 생성/수정
    /^recruit_comments\/[^/]+\//,   // 외전 댓글
    /^recruit_bookmarks\/[^/]+\//,  // 외전 북마크
    /^recruit_applies\/[^/]+\//,    // 외전 신청
    /^match_alarms\/[^/]+$/,        // 내전 알람 예약 (로그인 관리자)
    /^match_index\/[^/]+$/,         // 내전-커뮤니티 인덱스 (Cron 조회용)
  ];
  if (publicWrite.some(r => r.test(dbPath))) return true;

  // 이하 모두 로그인 필요
  if (!session) return false;

  // 일반 관리자도 자신의 커뮤니티 정보 및 하위 경로 수정 가능 (discordChannelId, devApis 등)
  if (/^communities_info\/[^/]+(\/.*)?$/.test(dbPath) && session.role === 'admin') {
    // 자신의 커뮤니티인지 확인
    const cidFromPath = dbPath.split('/')[1];
    if (session.communityId && session.communityId === cidFromPath) return true;
  }
  // 관리자 이상 블랙리스트 쓰기 허용
  if (/^blacklist\//.test(dbPath)) return true;
  // 관리자 이상 커뮤니티 메시지 쓰기 허용
  if (/^community_messages\//.test(dbPath)) return true;
  // 관리자 이상 경매 로그 쓰기 허용
  if (/^communities\/[^/]+\/matches\/[^/]+\/auctionLog($|\/)/.test(dbPath)) {
    if (session.role === 'master') return true;
    if (session.role === 'admin') return true;
  }
  // 관리자 이상 레이팅 설정 쓰기 허용 (자신의 커뮤니티)
  if (/^communities\/[^/]+\/rating_config($|\/)/.test(dbPath)) {
    if (session.role === 'master') return true;
    if (session.role === 'admin') {
      const cidFromPath = dbPath.split('/')[1];
      return !session.communityId || session.communityId === cidFromPath;
    }
  }
  // 관리자 이상 가이드/룰 쓰기 허용 (자신의 커뮤니티)
  if (/^communities\/[^/]+\/rules($|\/)/.test(dbPath)) {
    if (session.role === 'master') return true;
    if (session.role === 'admin') {
      const cidFromPath = dbPath.split('/')[1];
      return !session.communityId || session.communityId === cidFromPath;
    }
  }
  // 레이팅 데이터 쓰기 (admin/master)
  if (/^communities\/[^/]+\/ratings($|\/)/.test(dbPath) ||
      /^communities\/[^/]+\/rating_logs($|\/)/.test(dbPath)) {
    if (session.role === 'master') return true;
    if (session.role === 'admin') {
      const cidFromPath = dbPath.split('/')[1];
      return !session.communityId || session.communityId === cidFromPath;
    }
  }
  // 관리자 이상 카테고리 쓰기 허용 (자신의 커뮤니티)
  if (/^communities\/[^/]+\/match_categories($|\/)/.test(dbPath)) {
    if (session.role === 'master') return true;
    if (session.role === 'admin') {
      const cidFromPath = dbPath.split('/')[1];
      return !session.communityId || session.communityId === cidFromPath;
    }
  }

  // 마스터 전용 경로
  const masterWrite = [
    /^communities_info\//,
    /^invite_codes\//,
    /^admin\//,
    /^notices\//,
    /^applies\/[^/]+\/status$/,  // 신청 상태 변경
    /^system\//,                 // 점검 모드 등 시스템 설정
    /^rtube\//,                  // RoongTube 영상/카테고리
    /^match_alarms\//,           // 내전 알람 예약
  ];
  if (masterWrite.some(r => r.test(dbPath))) {
    return session.role === 'master';
  }

  return false;
}

async function verifyPw(plain, plainHash, stored) {
  if (!stored) return false;
  if (/^[0-9a-f]{64}$/.test(stored)) return plainHash === stored;
  return plain === stored;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function handleSummoner(url, key) {
  const gameName = url.searchParams.get('gameName');
  const tagLine  = url.searchParams.get('tagLine');
  const puuidParam = url.searchParams.get('puuid');
  const region   = (url.searchParams.get('region') || 'KR').toUpperCase();
  const r = REGIONS[region] || REGIONS.KR;

  // puuid로 직접 조회 (블랙리스트 정보 업데이트용)
  if (puuidParam) {
    try {
      const accountRes = await riotFetch(
        `https://${r.regional}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${enc(puuidParam)}`, key);
      if (!accountRes.ok) return json({ error: '소환사를 찾을 수 없습니다' }, accountRes.status);
      const account = await accountRes.json();
      const summonerRes = await riotFetch(
        `https://${r.platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${enc(puuidParam)}`, key);
      if (!summonerRes.ok) return json({ error: '소환사 정보 조회 실패' }, summonerRes.status);
      const summoner = await summonerRes.json();
      const leagueRes = await riotFetch(
        `https://${r.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${enc(puuidParam)}`, key);
      let entries = [];
      if (leagueRes.ok) entries = await leagueRes.json();
      const solo = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
      const flex = entries.find(e => e.queueType === 'RANKED_FLEX_SR');
      const prevSeasonHighest = solo?.highestTierAchieved || flex?.highestTierAchieved
        || entries.find(e => e.highestTierAchieved)?.highestTierAchieved || null;
      // 모스트 챔피언 3개
      let topChamps = [];
      try {
        const masteryRes = await riotFetch(
          `https://${r.platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${enc(puuidParam)}/top?count=3`, key);
        if (masteryRes.ok) topChamps = await masteryRes.json();
      } catch(e) {}
      return json({ name: account.gameName, tag: account.tagLine, level: summoner.summonerLevel,
        icon: summoner.profileIconId, puuid: puuidParam, solo: formatRank(solo), flex: formatRank(flex),
        prevSeasonHighest,
        soloWins: solo?.wins || 0, soloLosses: solo?.losses || 0,
        soloLP: solo?.leaguePoints || 0, soloTier: solo?.tier || 'UNRANKED', soloDivision: solo?.rank || '',
        highTier: await (async () => {
          try {
            const dlRes = await fetch(`https://b2c-api-cdn.deeplol.gg/summoner/summoner-realtime?platform_id=${platform}&puu_id=${encodeURIComponent(puuidParam)}`);
            if (!dlRes.ok) return null;
            const dlData = await dlRes.json();
            const dlSolo = dlData?.tier_info?.ranked_solo_5x5;
            if (dlSolo?.high_tier) return dlSolo.high_tier + (dlSolo.high_lp ? ' ' + dlSolo.high_lp + 'LP' : '');
            if (dlSolo?.tier) return dlSolo.tier + (dlSolo.division ? ' ' + dlSolo.division : '');
            return null;
          } catch(e) { return null; }
        })(),
        highLp: 0,
        topChampions: topChamps.map(c => ({ championId: c.championId, masteryLevel: c.championLevel, masteryPoints: c.championPoints })) });
    } catch(e) { return json({ error: '서버 오류', detail: e.message }, 500); }
  }

  if (!gameName || !tagLine) return json({ error: 'gameName, tagLine 파라미터 필요' }, 400);
  try {
    const accountRes = await riotFetch(
      `https://${r.regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${enc(gameName)}/${enc(tagLine)}`, key);
    if (!accountRes.ok) return json({ error: '소환사를 찾을 수 없습니다' }, accountRes.status);
    const account = await accountRes.json();
    const { puuid } = account;
    const summonerRes = await riotFetch(
      `https://${r.platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`, key);
    if (!summonerRes.ok) return json({ error: '소환사 정보 조회 실패' }, summonerRes.status);
    const summoner = await summonerRes.json();
    const leagueRes = await riotFetch(
      `https://${r.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, key);
    let entries = [];
    if (leagueRes.ok) entries = await leagueRes.json();
    else if (summoner.id) {
      const fb = await riotFetch(
        `https://${r.platform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${enc(summoner.id)}`, key);
      if (fb.ok) entries = await fb.json();
    }
    const solo = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
    const flex = entries.find(e => e.queueType === 'RANKED_FLEX_SR');
    // 언랭크인 경우에도 entries 안에 highestTierAchieved가 있을 수 있으므로 전체 탐색
    const prevSeasonHighest = solo?.highestTierAchieved
      || flex?.highestTierAchieved
      || entries.find(e => e.highestTierAchieved)?.highestTierAchieved
      || null;
    // 모스트 챔피언 3개
    let topChamps = [];
    try {
      const masteryRes = await riotFetch(
        `https://${r.platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=3`, key);
      if (masteryRes.ok) topChamps = await masteryRes.json();
    } catch(e) {}
    return json({ name: account.gameName, tag: account.tagLine, level: summoner.summonerLevel,
      icon: summoner.profileIconId, puuid, solo: formatRank(solo), flex: formatRank(flex),
      prevSeasonHighest, _debug_entries: entries,
      soloWins: solo?.wins || 0, soloLosses: solo?.losses || 0,
      soloLP: solo?.leaguePoints || 0, soloTier: solo?.tier || 'UNRANKED', soloDivision: solo?.rank || '',
      topChampions: topChamps.map(c => ({ championId: c.championId, masteryLevel: c.championLevel, masteryPoints: c.championPoints })) });
  } catch(e) { return json({ error: '서버 오류', detail: e.message }, 500); }
}

async function handleMatch(url, key) {
  const code   = url.searchParams.get('code');
  const region = (url.searchParams.get('region') || 'KR').toUpperCase();
  if (!code) return json({ error: 'code 파라미터 필요' }, 400);
  const r = REGIONS[region] || REGIONS.KR;
  let matchId = code.trim();
  if (/^\d+$/.test(matchId)) matchId = region + '_' + matchId;
  try {
    const matchRes = await riotFetch(
      `https://${r.regional}.api.riotgames.com/lol/match/v5/matches/${enc(matchId)}`, key);
    if (!matchRes.ok) {
      const err = await matchRes.json().catch(() => ({}));
      return json({ error: '매치를 찾을 수 없습니다', detail: err, matchId }, matchRes.status);
    }
    return json({ ...(await matchRes.json()), _matchId: matchId });
  } catch(e) { return json({ error: '서버 오류', detail: e.message }, 500); }
}

async function handleRecentCustom(url, key) {
  const puuidsParam = url.searchParams.get('puuids');
  const region      = (url.searchParams.get('region') || 'KR').toUpperCase();
  const minPlayers  = parseInt(url.searchParams.get('minPlayers') || '10');
  if (!puuidsParam) return json({ error: 'puuids 파라미터 필요' }, 400);
  const puuids = puuidsParam.split(',').filter(Boolean).slice(0, 10);
  const r = REGIONS[region] || REGIONS.KR;
  try {
    const allResults = await Promise.all(puuids.map(async puuid => {
      const res = await riotFetch(
        `https://${r.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=0&count=20`, key);
      if (!res.ok) return [];
      return await res.json();
    }));
    const idCount = {};
    allResults.forEach(ids => { ids.forEach(id => { idCount[id] = (idCount[id] || 0) + 1; }); });
    if (Object.keys(idCount).length === 0)
      return json({ error: '최근 커스텀 게임을 찾을 수 없습니다', matchIds: [], counts: {} }, 404);
    const candidates = Object.entries(idCount).sort((a,b)=>b[1]-a[1]).map(([id])=>id).slice(0,15);
    const details = await Promise.all(candidates.map(async matchId => {
      const res = await riotFetch(`https://${r.regional}.api.riotgames.com/lol/match/v5/matches/${enc(matchId)}`, key);
      if (!res.ok) return { matchId, valid: false };
      const data = await res.json();
      const cnt = (data.info?.participants||[]).length;
      return { matchId, valid: cnt >= minPlayers, gameCreation: data.info?.gameCreation||0 };
    }));
    const validMatches = details.filter(d=>d.valid).sort((a,b)=>b.gameCreation-a.gameCreation).map(d=>d.matchId);
    if (!validMatches.length)
      return json({ matchIds: candidates.slice(0,10), counts: idCount, total: puuids.length, note: '10인 게임 없음' });
    return json({ matchIds: validMatches.slice(0,10), counts: idCount, total: puuids.length });
  } catch(e) { return json({ error: '서버 오류', detail: e.message }, 500); }
}

function riotFetch(url, key) { return fetch(url, { headers: { 'X-Riot-Token': key } }); }
function enc(s) { return encodeURIComponent(s); }
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
function formatRank(e) {
  if (!e) return 'UNRANKED';
  if (['MASTER','GRANDMASTER','CHALLENGER'].includes(e.tier)) return `${e.tier} ${e.leaguePoints}LP`;
  return `${e.tier} ${e.rank} ${e.leaguePoints}LP`;
}

// ── 경매 채팅 전송 (팀장 코드 인증) ──
async function handleChatSend(request, env) {
  try {
    const body = await request.json();
    const { matchId, communityId, captainCode, message } = body;
    if (!matchId || !communityId || !message) return json({ ok: false, error: '필수값 누락' }, 400);
    if (!message.trim() || message.length > 200) return json({ ok: false, error: '메시지 오류' }, 400);

    const dbUrl = env.FB_DATABASE_URL;
    const secret = env.FB_DB_SECRET;
    const authQ = secret ? `?auth=${secret}` : '';

    // 팀장 코드 검증
    let senderName = '관리자';
    let teamName = '';
    if (captainCode) {
      const codeRes = await fetch(`${dbUrl}/communities/${communityId}/matches/${matchId}/captainCodes/${captainCode}.json${authQ}`);
      const codeData = await codeRes.json();
      if (!codeData) return json({ ok: false, error: '유효하지 않은 코드' }, 403);
      senderName = codeData.captainName || '팀장';
      teamName = codeData.teamName || '';
    }

    // Firebase serverTimestamp 대신 Date.now() 사용 (REST API 제한)
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const msgObj = {
      id: msgId,
      sender: senderName,
      teamName,
      message: message.trim(),
      ts: Date.now(),
      isCaptain: !!captainCode,
    };
    await fetch(`${dbUrl}/communities/${communityId}/matches/${matchId}/chat/${msgId}.json${authQ}`,
      { method: 'PUT', body: JSON.stringify(msgObj) });

    return json({ ok: true, msgId });
  } catch(e) { return json({ ok: false, error: e.message }, 500); }
}

// ── 채팅 전체 삭제 (낙찰/유찰 시) ──
async function handleChatClear(request, env) {
  try {
    const body = await request.json();
    const { matchId, communityId, sessionToken } = body;
    if (!matchId || !communityId) return json({ ok: false, error: '필수값 누락' }, 400);

    // 세션 검증 (관리자만)
    const session = await getSession(sessionToken, env);
    if (!session || (session.role !== 'admin' && session.role !== 'master')) {
      return json({ ok: false, error: '권한 없음' }, 403);
    }

    const dbUrl = env.FB_DATABASE_URL;
    const secret = env.FB_DB_SECRET;
    const authQ = secret ? `?auth=${secret}` : '';
    await fetch(`${dbUrl}/communities/${communityId}/matches/${matchId}/chat.json${authQ}`,
      { method: 'DELETE' });

    return json({ ok: true });
  } catch(e) { return json({ ok: false, error: e.message }, 500); }
}

// ── 팀장 경매 호가 제출 ──
async function handleBidSubmit(request, env) {
  try {
    const body = await request.json();
    const { matchId, communityId, captainCode, amount, teamName, teamId } = body;
    if (!matchId || !communityId || !captainCode || !amount) {
      return json({ ok: false, error: '필수값 누락' }, 400);
    }

    const dbUrl = env.FB_DATABASE_URL;
    const secret = env.FB_DB_SECRET;
    const authQ = secret ? `?auth=${secret}` : '';

    const bidLeaderUrl = `${dbUrl}/communities/${communityId}/matches/${matchId}/_bidLeader.json${authQ}`;
    const captainCodeUrl = `${dbUrl}/communities/${communityId}/matches/${matchId}/captainCodes/${captainCode}.json${authQ}`;
    const bidLockedUrl  = `${dbUrl}/communities/${communityId}/matches/${matchId}/_bidLocked.json${authQ}`;
    const teamsUrl      = `${dbUrl}/communities/${communityId}/matches/${matchId}/_teams.json${authQ}`;
    const onSaleUrl     = `${dbUrl}/communities/${communityId}/matches/${matchId}/_onSaleMember.json${authQ}`;

    // 1. 필요한 필드만 병렬 조회 (ETag도 동시에)
    const [codeRes, bidLeaderRes, lockedRes, teamsRes, onSaleRes] = await Promise.all([
      fetch(captainCodeUrl),
      fetch(bidLeaderUrl, { headers: { 'X-Firebase-ETag': 'true' } }),
      fetch(bidLockedUrl),
      fetch(teamsUrl),
      fetch(onSaleUrl)
    ]);

    const [codeData, bidLeaderData, bidLocked, teamsData, onSaleData] = await Promise.all([
      codeRes.json(),
      bidLeaderRes.json(),
      lockedRes.json(),
      teamsRes.json(),
      onSaleRes.json()
    ]);
    const etag = bidLeaderRes.headers.get('ETag');

    // 2. captainCodes에 없으면 _teams에서 fallback 검증
    let resolvedCode = codeData;
    if (!resolvedCode) {
      const teamsArr2 = Array.isArray(teamsData) ? teamsData : Object.values(teamsData || {});
      const ft = teamsArr2.find(t => t && t.captainCode === captainCode);
      if (ft) resolvedCode = { teamId: ft.id, teamName: teamName || ft.name || ('팀' + ft.id) };
    }
    if (!resolvedCode) return json({ ok: false, error: '유효하지 않은 코드' }, 403);

    // 3. 호가 종료 체크
    if (bidLocked) return json({ ok: false, error: '호가가 종료됐습니다' }, 400);

    // 4. 잔여 포인트 체크
    const teamsArr = Array.isArray(teamsData) ? teamsData : Object.values(teamsData || {});
    const myTeam = teamsArr.find(t => t.id == teamId);
    if (myTeam && myTeam.points != null && amount > myTeam.points) {
      return json({ ok: false, error: `잔여 포인트(${myTeam.points}pt) 초과` }, 400);
    }

    // 5. 최고가 확인
    const currentMax = (bidLeaderData && bidLeaderData.price) || 0;
    if (amount <= currentMax) {
      return json({ ok: false, error: `현재 최고가(${currentMax}pt)보다 높아야 합니다` }, 400);
    }
    const matchData = { _onSaleMember: onSaleData }; // 로그용

    // ETag 조건부 PUT - 다른 호가가 먼저 들어왔으면 412 반환
    const bidLeader = { 
      price: amount, 
      team: teamName || resolvedCode.teamName, 
      teamId: resolvedCode.teamId || teamId, 
      locked: false, 
      ts: Date.now() 
    };
    
    const putHeaders = { 'Content-Type': 'application/json' };
    if (etag) putHeaders['if-match'] = etag;
    
    const putRes = await fetch(bidLeaderUrl, {
      method: 'PUT',
      headers: putHeaders,
      body: JSON.stringify(bidLeader)
    });

    if (putRes.status === 412) {
      // 다른 팀장이 먼저 호가함 - 현재 최고가 다시 읽어서 반환
      const latestRes = await fetch(bidLeaderUrl);
      const latest = await latestRes.json();
      return json({ 
        ok: false, 
        error: `다른 팀이 먼저 호가했습니다. 현재 최고가: ${latest?.price || 0}pt` 
      }, 409);
    }

    if (!putRes.ok) {
      return json({ ok: false, error: '호가 저장 실패' }, 500);
    }

    // 호가 로그 저장
    const logId = 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2,5);
    const onSale = onSaleData;
    const onSaleName = (onSale && onSale.name) ? onSale.name : '?';
    const logEntry = { id: logId, type: 'bid', text: onSaleName + ' — ' + (resolvedCode.teamName || teamName || '') + ' ' + amount + 'pt', ts: Date.now() };
    const logUrl = `${dbUrl}/communities/${communityId}/matches/${matchId}/auctionLog/${logId}.json${authQ}`;
    // 로그는 비동기로 (응답 지연 없이)
    fetch(logUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logEntry)
    }).catch(() => {});

    return json({ ok: true, bidLeader });
  } catch(e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// ══════════════════════════════════════════
// 멤버 분석 데이터 저장/조회
// ══════════════════════════════════════════

// 멤버가 해당 커뮤니티 소속인지 딥롤 API로 검증
async function verifyMember(serverId, puuId) {
  try {
    const res = await fetch(
      `https://b2c-api-cdn.deeplol.gg/tournament/server_info?server_id=${serverId}`
    );
    if (!res.ok) return false;
    const json = await res.json();
    const list = (json.tournament_stats && json.tournament_stats.tournament_stats_all_list) || [];
    return list.some(m => m.puu_id === puuId);
  } catch(e) {
    return false;
  }
}

async function handleMemberAnalysisWrite(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }

  const { communityId, serverId, puuId, mode, data } = body;
  if (!communityId || !puuId || !mode || !data) {
    return json({ ok: false, error: '필수 파라미터 누락' }, 400);
  }
  if (!['custom', 'all', 'rating'].includes(mode)) {
    return json({ ok: false, error: '유효하지 않은 mode' }, 400);
  }

  // 커뮤니티 멤버 검증 (실패해도 경고만, 저장은 허용)
  if (serverId) {
    const isMember = await verifyMember(serverId, puuId);
    if (!isMember) {
      console.warn('[member-analysis-write] 멤버 검증 실패:', puuId, '서버:', serverId);
    }
  }

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  if (!dbUrl) return json({ ok: false, error: 'DB 설정 없음' }, 500);
  const authQ = secret ? `?auth=${secret}` : '';

  // PATCH로 저장 (기존 데이터 보존, 새 필드 추가 호환)
  const path = `communities/${communityId}/member_analysis/${puuId}/${mode}`;
  const res = await fetch(`${dbUrl}/${path}.json${authQ}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  const resText = await res.text();
  if (!res.ok) {
    console.error('[member-analysis-write] 저장 실패:', res.status, resText.slice(0,100));
    return json({ ok: false, error: 'DB 저장 실패: ' + res.status + ' ' + resText.slice(0,100) }, 500);
  }
  console.log('[member-analysis-write] 저장 성공:', path);
  return json({ ok: true });
}

async function handleMemberAnalysisRead(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }

  const { communityId, puuId, mode } = body;
  if (!communityId || !puuId || !mode) {
    return json({ ok: false, error: '필수 파라미터 누락' }, 400);
  }

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  if (!dbUrl) return json({ ok: false, error: 'DB 설정 없음' }, 500);
  const authQ = secret ? `?auth=${secret}` : '';

  const path = `communities/${communityId}/member_analysis/${puuId}/${mode}`;
  const res = await fetch(`${dbUrl}/${path}.json${authQ}`);
  if (!res.ok) return json({ ok: false, error: 'DB 읽기 실패' }, 500);

  const data = await res.json();
  return json({ ok: true, data: data || null });
}

async function handleMemberRatingsRead(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId } = body;
  if (!communityId) return json({ ok: false, error: 'communityId 필요' }, 400);

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  if (!dbUrl) return json({ ok: false, error: 'DB 설정 없음' }, 500);
  const authQ = secret ? `?auth=${secret}` : '';

  // member_analysis 전체를 한 번에 읽기
  // shallow=true로 puuId 목록만 먼저 읽고 → rating 노드만 개별 읽기
  const path = `communities/${communityId}/member_analysis`;
  const shallowQ = authQ ? `${authQ}&shallow=true` : `?shallow=true`;
  const fullUrl = `${dbUrl}/${path}.json${shallowQ}`;
  console.log('[member-ratings-read] URL:', fullUrl.replace(env.FB_DB_SECRET||'','***'));
  const res = await fetch(fullUrl);
  if (!res.ok) {
    const errTxt = await res.text();
    console.error('[member-ratings-read] shallow 읽기 실패:', res.status, errTxt.slice(0,100));
    return json({ ok: false, error: 'DB 읽기 실패: '+res.status }, 500);
  }

  const keys = await res.json();
  const keyCount = keys ? Object.keys(keys).length : 0;
  console.log('[member-ratings-read] shallow keys count:', keyCount);
  if (keyCount > 0) console.log('[member-ratings-read] 첫 번째 key:', Object.keys(keys)[0].slice(0,20));
  if (!keys) return json({ ok: true, data: {} });

  // 각 puuId의 rating 노드만 병렬로 읽기
  const puuIds = Object.keys(keys);
  const BATCH = 20;
  const ratings = {};

  for (let i = 0; i < puuIds.length; i += BATCH) {
    const batch = puuIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (puuId) => {
      try {
        const r = await fetch(`${dbUrl}/${path}/${encodeURIComponent(puuId)}/rating.json${authQ}`);
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.rating !== undefined) {
          ratings[puuId] = { rating: d.rating, breakdown: d.breakdown || {} };
        }
      } catch(e) {}
    }));
  }

  return json({ ok: true, data: ratings });
}

async function handleTempTierWrite(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, puuId, tier, token, adminId, adminPw } = body;
  if (!communityId || !puuId) return json({ ok: false, error: '필수 파라미터 누락' }, 400);

  // 방법 1: 세션 토큰으로 검증
  let session = getSession(token);

  // 방법 2: 토큰 실패 시 id/pw로 직접 Firebase 검증
  if (!session && adminId && adminPw) {
    const dbUrl = env.FB_DATABASE_URL;
    const secret = env.FB_DB_SECRET;
    const authQ = secret ? '?auth=' + secret : '';
    // master 검증
    const saltRes = await fetch(dbUrl + '/master/salt.json' + authQ);
    if (saltRes.ok) {
      const salt = await saltRes.json();
      if (salt) {
        const encoder = new TextEncoder();
        const data = encoder.encode(adminPw + salt);
        const hashBuf = await crypto.subtle.digest('SHA-256', data);
        const hashArr = Array.from(new Uint8Array(hashBuf));
        const hashHex = hashArr.map(b => b.toString(16).padStart(2,'0')).join('');
        const masterRes = await fetch(dbUrl + '/master.json' + authQ);
        if (masterRes.ok) {
          const master = await masterRes.json();
          if (master && master.id === adminId && master.pw === hashHex) {
            session = { role: 'master', id: adminId };
          }
        }
      }
    }
    // master 실패 시 admin 검증
    if (!session) {
      const adminsRes = await fetch(dbUrl + '/communities/' + communityId + '/admins.json' + authQ);
      if (adminsRes.ok) {
        const admins = await adminsRes.json();
        if (admins) {
          const adminList = Array.isArray(admins) ? admins : Object.values(admins);
          for (const admin of adminList) {
            if (admin.id === adminId) {
              const saltRes2 = await fetch(dbUrl + '/communities/' + communityId + '/salt.json' + authQ);
              if (saltRes2.ok) {
                const salt2 = await saltRes2.json();
                if (salt2) {
                  const encoder = new TextEncoder();
                  const data = encoder.encode(adminPw + salt2);
                  const hashBuf = await crypto.subtle.digest('SHA-256', data);
                  const hashArr = Array.from(new Uint8Array(hashBuf));
                  const hashHex = hashArr.map(b => b.toString(16).padStart(2,'0')).join('');
                  if (admin.pw === hashHex) { session = { role: 'admin', id: adminId }; break; }
                }
              }
            }
          }
        }
      }
    }
  }

  if (!session || !['admin','master'].includes(session.role)) {
    return json({ ok: false, error: '권한이 없습니다' }, 403);
  }

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  if (!dbUrl) return json({ ok: false, error: 'DB 설정 없음' }, 500);
  const authQ = secret ? '?auth=' + secret : '';

  const path = 'communities/' + communityId + '/temp_tiers/' + puuId;

  if (!tier) {
    // tier 없으면 삭제
    await fetch(dbUrl + '/' + path + '.json' + authQ, { method: 'DELETE' });
  } else {
    await fetch(dbUrl + '/' + path + '.json' + authQ, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tier)
    });
  }
  // 캐시 무효화
  await invalidateCache(`temp-tiers-${communityId}`);
  return json({ ok: true });
}

async function handleTempTiersRead(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId } = body;
  if (!communityId) return json({ ok: false, error: 'communityId 필요' }, 400);

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  if (!dbUrl) return json({ ok: false, error: 'DB 설정 없음' }, 500);
  const authQ = secret ? '?auth=' + secret : '';

  const res = await fetch(dbUrl + '/communities/' + communityId + '/temp_tiers.json' + authQ);
  if (!res.ok) return json({ ok: true, data: {} });
  const data = await res.json();
  return json({ ok: true, data: data || {} });
}

// ══════════════════════════════════════
// 레이팅 핸들러
// ══════════════════════════════════════

async function handleRatingWrite(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, puuId, rating, season, token, adminId, adminPw } = body;
  if (!communityId || !puuId || rating === undefined) return json({ ok: false, error: '필수 파라미터 누락' }, 400);

  // 세션 토큰 검증
  let session = getSession(token);

  // 토큰 실패 시 id/pw로 직접 Firebase 검증
  if (!session && adminId && adminPw) {
    const dbUrl = env.FB_DATABASE_URL;
    const secret = env.FB_DB_SECRET;
    const authQ = secret ? '?auth=' + secret : '';
    // master 검증
    const saltRes = await fetch(dbUrl + '/master/salt.json' + authQ);
    if (saltRes.ok) {
      const salt = await saltRes.json();
      if (salt) {
        const encoder = new TextEncoder();
        const data = encoder.encode(adminPw + salt);
        const hashBuf = await crypto.subtle.digest('SHA-256', data);
        const hashArr = Array.from(new Uint8Array(hashBuf));
        const hashHex = hashArr.map(b => b.toString(16).padStart(2,'0')).join('');
        const masterRes = await fetch(dbUrl + '/master.json' + authQ);
        if (masterRes.ok) {
          const master = await masterRes.json();
          if (master && master.id === adminId && master.pw === hashHex) {
            session = { role: 'master', id: adminId };
          }
        }
      }
    }
  }

  if (!session || !['admin','master'].includes(session.role)) {
    return json({ ok: false, error: '권한이 없습니다' }, 403);
  }

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const seasonKey = season || 'default';
  const path = `communities/${communityId}/ratings/${seasonKey}/${puuId}`;

  const res = await fetch(`${dbUrl}/${path}.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rating)
  });
  if (!res.ok) return json({ ok: false, error: 'DB 저장 실패' }, 500);
  // 캐시 무효화
  await invalidateCache(`ratings-${communityId}-${seasonKey}`);
  return json({ ok: true });
}

async function handleRatingRead(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, season } = body;
  if (!communityId) return json({ ok: false, error: 'communityId 필요' }, 400);

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const seasonKey = season || 'default';
  const path = `communities/${communityId}/ratings/${seasonKey}`;

  const data = await cachedFetch(
    `ratings-${communityId}-${seasonKey}`,
    async () => {
      const res = await fetch(`${dbUrl}/${path}.json${authQ}`);
      if (!res.ok) return {};
      return await res.json();
    },
    1800 // 30분
  );
  return json({ ok: true, data: data || {} });
}

async function handleRatingLogWrite(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, log, season, token } = body;
  if (!communityId || !log) return json({ ok: false, error: '필수 파라미터 누락' }, 400);

  const session = getSession(token);
  if (!session || !['admin','master'].includes(session.role)) {
    return json({ ok: false, error: '권한이 없습니다' }, 403);
  }

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const seasonKey = season || 'default';
  const logId = 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const path = `communities/${communityId}/rating_logs/${seasonKey}/${logId}`;

  const res = await fetch(`${dbUrl}/${path}.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...log, timestamp: Date.now() })
  });
  if (!res.ok) return json({ ok: false, error: 'DB 저장 실패' }, 500);
  return json({ ok: true, logId });
}

async function handleRatingLogRead(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, puuId, season, limit } = body;
  if (!communityId) return json({ ok: false, error: 'communityId 필요' }, 400);

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const seasonKey = season || 'default';
  const path = `communities/${communityId}/rating_logs/${seasonKey}`;

  const res = await fetch(`${dbUrl}/${path}.json${authQ}`);
  if (!res.ok) return json({ ok: true, data: [] });
  const raw = await res.json();
  if (!raw) return json({ ok: true, data: [] });

  let logs = Object.values(raw).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (puuId) logs = logs.filter(l => l.puuId === puuId);
  if (limit) logs = logs.slice(0, limit);
  return json({ ok: true, data: logs });
}

// 레이팅 배치 저장 (전체를 한 번에)
async function handleRatingBatchWrite(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, season, ratings, token, adminId, adminPw } = body;
  if (!communityId || !ratings) return json({ ok: false, error: '필수 파라미터 누락' }, 400);

  // 세션 토큰 먼저 시도
  let session = getSession(token);

  // 토큰 실패 시 id/pw로 직접 Firebase 검증 (1회만)
  if (!session && adminId && adminPw) {
    const dbUrl2 = env.FB_DATABASE_URL;
    const secret2 = env.FB_DB_SECRET;
    const authQ2 = secret2 ? '?auth=' + secret2 : '';
    try {
      const saltRes = await fetch(dbUrl2 + '/master/salt.json' + authQ2);
      if (saltRes.ok) {
        const salt = await saltRes.json();
        if (salt) {
          const encoder = new TextEncoder();
          const data = encoder.encode(adminPw + salt);
          const hashBuf = await crypto.subtle.digest('SHA-256', data);
          const hashArr = Array.from(new Uint8Array(hashBuf));
          const hashHex = hashArr.map(b => b.toString(16).padStart(2,'0')).join('');
          const masterRes = await fetch(dbUrl2 + '/master.json' + authQ2);
          if (masterRes.ok) {
            const master = await masterRes.json();
            if (master && master.id === adminId && master.pw === hashHex) {
              session = { role: 'master', id: adminId };
            }
          }
        }
      }
    } catch(e) {}
  }

  if (!session || !['admin','master'].includes(session.role)) {
    return json({ ok: false, error: '권한이 없습니다' }, 403);
  }

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const seasonKey = season || 'default';
  // season이 'history_YYYY-MM-DD' 형식이면 rating_history 경로로 저장
  const path = seasonKey.startsWith('history_')
    ? `communities/${communityId}/rating_history/${seasonKey.replace('history_', '')}`
    : `communities/${communityId}/ratings/${seasonKey}`;

  // Firebase PATCH로 전체 한 번에 저장
  const res = await fetch(`${dbUrl}/${path}.json${authQ}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ratings)
  });
  if (!res.ok) {
    const txt = await res.text();
    return json({ ok: false, error: 'DB 저장 실패: ' + res.status + ' ' + txt.slice(0,100) }, 500);
  }
  return json({ ok: true, count: Object.keys(ratings).length });
}

// 레이팅 + 로그 일괄 저장 (대진 저장 시)
async function handleRatingMatchApply(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, season, token, ratings, logs, matchKey } = body;
  if (!communityId || !ratings) return json({ ok: false, error: '필수 파라미터 누락' }, 400);

  let session = getSession(token);

  // 토큰 실패 시 id/pw로 직접 검증
  if (!session && body.adminId && body.adminPw) {
    const dbUrl2 = env.FB_DATABASE_URL;
    const secret2 = env.FB_DB_SECRET;
    const authQ2 = secret2 ? '?auth=' + secret2 : '';
    try {
      const enc = new TextEncoder();
      // master 검증
      const saltRes = await fetch(dbUrl2 + '/master/salt.json' + authQ2);
      if (saltRes.ok) {
        const salt = await saltRes.json();
        if (salt) {
          const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(body.adminPw + salt));
          const hashHex = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
          const mr = await fetch(dbUrl2 + '/master.json' + authQ2);
          if (mr.ok) {
            const master = await mr.json();
            if (master?.id === body.adminId && master?.pw === hashHex) {
              session = { role: 'master', id: body.adminId };
            }
          }
        }
      }
      // master 실패 시 admin 검증
      if (!session) {
        const commRes = await fetch(dbUrl2 + '/communities/' + body.communityId + '/admins.json' + authQ2);
        if (commRes.ok) {
          const admins = await commRes.json();
          if (admins) {
            const saltRes2 = await fetch(dbUrl2 + '/communities/' + body.communityId + '/salt.json' + authQ2);
            if (saltRes2.ok) {
              const salt2 = await saltRes2.json();
              if (salt2) {
                const hashBuf2 = await crypto.subtle.digest('SHA-256', enc.encode(body.adminPw + salt2));
                const hashHex2 = Array.from(new Uint8Array(hashBuf2)).map(b=>b.toString(16).padStart(2,'0')).join('');
                const adminList = Array.isArray(admins) ? admins : Object.values(admins);
                for (const a of adminList) {
                  if (a.id === body.adminId && a.pw === hashHex2) {
                    session = { role: 'admin', id: body.adminId, communityId: body.communityId };
                    break;
                  }
                }
              }
            }
          }
        }
      }
    } catch(e) {}
  }
  if (!session || !['admin','master'].includes(session.role)) {
    return json({ ok: false, error: '권한이 없습니다' }, 403);
  }

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const seasonKey = season || 'default';

  // 레이팅 PATCH
  const rRes = await fetch(`${dbUrl}/communities/${communityId}/ratings/${seasonKey}.json${authQ}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ratings)
  });
  if (!rRes.ok) return json({ ok: false, error: '레이팅 저장 실패' }, 500);

  // 로그 PATCH (matchKey 기준으로 묶음)
  if (logs && Object.keys(logs).length > 0) {
    await fetch(`${dbUrl}/communities/${communityId}/rating_logs/${seasonKey}.json${authQ}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logs)
    });
  }

  return json({ ok: true });
}

// 대진 삭제 시 레이팅 원복
async function handleRatingMatchRevert(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }
  const { communityId, season, token, matchKey } = body;
  if (!communityId || !matchKey) return json({ ok: false, error: '필수 파라미터 누락' }, 400);

  let session = getSession(token);
  if (!session && body.adminId && body.adminPw) {
    session = { role: 'admin' }; // 세션 없으면 허용 (실제 prod에선 검증 강화)
  }
  if (!session) return json({ ok: false, error: '권한이 없습니다' }, 403);

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const seasonKey = season || 'default';

  // 해당 matchKey 로그 조회
  const logsRes = await fetch(`${dbUrl}/communities/${communityId}/rating_logs/${seasonKey}.json${authQ}`);
  if (!logsRes.ok) return json({ ok: false, error: '로그 조회 실패' }, 500);
  const allLogs = await logsRes.json() || {};

  // matchKey에 해당하는 로그만 필터
  const matchLogs = Object.entries(allLogs)
    .filter(([k, v]) => v && v.matchKey === matchKey)
    .map(([k, v]) => ({ logId: k, ...v }));

  if (!matchLogs.length) return json({ ok: true, reverted: 0 });

  // 현재 레이팅 로드
  const rRes = await fetch(`${dbUrl}/communities/${communityId}/ratings/${seasonKey}.json${authQ}`);
  const ratingData = rRes.ok ? (await rRes.json() || {}) : {};

  // 각 참여자 레이팅 원복
  const revertedRatings = {};
  const deletedLogs = {};

  for (const log of matchLogs) {
    const puuId = log.puuId;
    if (!puuId) continue;
    const cur = ratingData[puuId];
    if (!cur) continue;
    const reverted = Math.round((cur.current || 0) - log.delta);
    revertedRatings[puuId] = {
      ...cur,
      current: reverted,
      wins: Math.max(0, (cur.wins || 0) - (log.isWin ? 1 : 0)),
      losses: Math.max(0, (cur.losses || 0) - (log.isWin ? 0 : 1)),
      updatedAt: Date.now()
    };
    deletedLogs[log.logId] = null; // Firebase에서 삭제
  }

  // 레이팅 원복 저장
  await fetch(`${dbUrl}/communities/${communityId}/ratings/${seasonKey}.json${authQ}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(revertedRatings)
  });

  // 로그 삭제
  await fetch(`${dbUrl}/communities/${communityId}/rating_logs/${seasonKey}.json${authQ}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deletedLogs)
  });

  return json({ ok: true, reverted: matchLogs.length });
}

// ── Cron Trigger: 초기 레이팅 자동 계산 ──
async function runScheduledRatingCalc(env) {
  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';

  console.log('[cron] 시작. dbUrl:', dbUrl ? 'ok' : 'MISSING', 'secret:', secret ? 'ok' : 'MISSING');

  try {
    // communities_info shallow 조회로 cid 목록
    const shallowQ = authQ ? authQ + '&shallow=true' : '?shallow=true';
    const commRes = await fetch(`${dbUrl}/communities_info.json${shallowQ}`);
    const commRaw = await commRes.text();
    console.log('[cron] communities_info shallow status:', commRes.status, 'raw:', commRaw.slice(0, 200));
    if (!commRes.ok) return;

    let commKeys;
    try { commKeys = JSON.parse(commRaw); } catch(e) { console.error('[cron] parse 실패:', e.message); return; }
    if (!commKeys || typeof commKeys !== 'object') { console.error('[cron] commKeys 비어있음'); return; }

    const cidList = Object.keys(commKeys);
    console.log('[cron] 커뮤니티 목록:', JSON.stringify(cidList));

    for (const cid of cidList) {
      try {
        const sidRes = await fetch(`${dbUrl}/communities_info/${cid}/deeplolServerId.json${authQ}`);
        const sidData = sidRes.ok ? await sidRes.json() : null;
        const serverId = sidData ? String(sidData) : null;
        console.log(`[cron] ${cid} serverId:`, serverId);
        if (!serverId) continue;

        const statsRes = await fetch(`https://b2c-api-cdn.deeplol.gg/tournament/server_info?server_id=${serverId}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.deeplol.gg/',
            'Origin': 'https://www.deeplol.gg'
          }
        });
        if (!statsRes.ok) { console.error(`[cron] ${cid} 딥롤 API 실패:`, statsRes.status); continue; }
        const statsJson = await statsRes.json();
        const members = (statsJson.tournament_stats && statsJson.tournament_stats.tournament_stats_all_list) || [];
        console.log(`[cron] ${cid} 멤버 수:`, members.length);
        if (!members.length) continue;

        // 초기 레이팅 계산
        const ratingsMap = {};
        for (const m of members) {
          if (!m.puu_id) continue;
          const W = m.win || 0, N = m.cnt || 0, L = N - W, S = W - L;
          const ai = m.ai_score || 50;
          const aiMult = 0.7 + 0.3 * (ai / 100);
          const sqrtN = N > 0 ? Math.sqrt(N) : 1;
          const S_adj = S > 0 ? S : S * 0.3;
          const R0 = Math.max(500, Math.round(1000 + (S_adj / sqrtN) * 637 * aiMult));
          ratingsMap[m.puu_id] = { current: R0, initial: R0, updatedAt: Date.now() };
        }

        // 기존 레이팅 읽기
        const prevRes = await fetch(`${dbUrl}/communities/${cid}/ratings/default.json${authQ}`);
        const prevRatings = prevRes.ok ? (await prevRes.json() || {}) : {};

        // 변화 있는 유저 히스토리
        const now = new Date();
        // KST(UTC+9) 기준으로 날짜/시각 계산
        const kstOffset = 9 * 60 * 60 * 1000;
        const kstNow = new Date(now.getTime() + kstOffset);
        const today = kstNow.toISOString().slice(0, 10);
        const hhmm = kstNow.getUTCHours().toString().padStart(2,'0') + kstNow.getUTCMinutes().toString().padStart(2,'0');
        const histKey = today + '_' + hhmm;
        const historyMap = {};
        for (const [puuId, newData] of Object.entries(ratingsMap)) {
          const prev = prevRatings[puuId];
          const delta = prev ? newData.current - prev.current : null;
          if (delta === null || delta !== 0) {
            historyMap[puuId] = { rating: newData.current, delta, timestamp: Date.now() };
          }
        }

        // 저장
        await fetch(`${dbUrl}/communities/${cid}/ratings/default.json${authQ}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ratingsMap)
        });

        if (Object.keys(historyMap).length > 0) {
          await fetch(`${dbUrl}/communities/${cid}/rating_history/${histKey}.json${authQ}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(historyMap)
          });
        }

        console.log(`[cron] ${cid} 완료: ${Object.keys(ratingsMap).length}명 레이팅, ${Object.keys(historyMap).length}명 변화`);
      } catch(e) {
        console.error(`[cron] ${cid} 오류:`, e.message, e.stack?.slice(0,200));
      }
    }
  } catch(e) {
    console.error('[cron] 전체 오류:', e.message, e.stack?.slice(0,200));
  }
}

// ── Discord OAuth + 코멘트 ──

// Discord OAuth URL 생성
async function handleDiscordOAuthUrl(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, redirectUri } = body;
  if (!env.DISCORD_CLIENT_ID) return json({ok:false,error:'DISCORD_CLIENT_ID 없음'},500);

  const state = btoa(JSON.stringify({ communityId, puuId, ts: Date.now() }));
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state
  });
  return json({ ok: true, url: 'https://discord.com/oauth2/authorize?' + params.toString() });
}

// Discord OAuth 콜백 - code → token → user info
async function handleDiscordOAuthCallback(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { code, redirectUri, state, communityId, puuId, text } = body;
  if (!code) return json({ok:false,error:'code 없음'},400);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return json({ok:false,error:'Discord 설정 없음'},500);

  // code → access_token
  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return json({ok:false,error:'토큰 교환 실패: '+err.slice(0,100)},400);
  }
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // 유저 정보 조회
  const userRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!userRes.ok) return json({ok:false,error:'유저 정보 조회 실패'},400);
  const user = await userRes.json();

  // 코멘트 저장
  if (communityId && puuId && text && text.trim()) {
    const dbUrl = env.FB_DATABASE_URL;
    const secret = env.FB_DB_SECRET;
    const authQ = secret ? '?auth=' + secret : '';
    const commentId = 'dc_' + user.id + '_' + Date.now();
    const comment = {
      discordId: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
      text: text.trim().slice(0, 500),
      createdAt: Date.now()
    };
    await fetch(`${dbUrl}/communities/${communityId}/comments/${puuId}/${commentId}.json${authQ}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(comment)
    });
    return json({ ok: true, user: { id: user.id, username: user.username, displayName: comment.displayName, avatar: comment.avatar }, comment: { id: commentId, ...comment } });
  }

  // 텍스트 없이 인증만 한 경우 - 유저 정보만 반환
  return json({ ok: true, user: { id: user.id, username: user.username, displayName: user.global_name || user.username, avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null } });
}

// 코멘트 읽기
async function handleCommentRead(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId } = body;
  if (!communityId || !puuId) return json({ok:false,error:'필수 파라미터 누락'},400);
  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const res = await fetch(`${dbUrl}/communities/${communityId}/comments/${puuId}.json${authQ}`);
  if (!res.ok) return json({ok:false,error:'조회 실패'},500);
  const data = await res.json();
  return json({ ok: true, data: data || {} });
}

// 코멘트 작성 (이미 인증된 유저 - discordId 검증)
async function handleCommentWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, text, discordId, username, displayName, avatar } = body;
  if (!communityId || !puuId || !text || !discordId) return json({ok:false,error:'필수 파라미터 누락'},400);
  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  const commentId = 'dc_' + discordId + '_' + Date.now();
  const comment = { discordId, username: username||'', displayName: displayName||username||'', avatar: avatar||null, text: text.trim().slice(0,500), createdAt: Date.now() };
  const res = await fetch(`${dbUrl}/communities/${communityId}/comments/${puuId}/${commentId}.json${authQ}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(comment)
  });
  if (!res.ok) return json({ok:false,error:'저장 실패'},500);
  return json({ ok: true, comment: { id: commentId, ...comment } });
}

// 코멘트 삭제 (본인만)
async function handleCommentDelete(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, commentId, discordId } = body;
  if (!communityId || !puuId || !commentId || !discordId) return json({ok:false,error:'필수 파라미터 누락'},400);
  // commentId가 본인 것인지 확인 (dc_{discordId}_ 로 시작)
  if (!commentId.startsWith('dc_' + discordId + '_')) return json({ok:false,error:'권한 없음'},403);
  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';
  await fetch(`${dbUrl}/communities/${communityId}/comments/${puuId}/${commentId}.json${authQ}`, { method: 'DELETE' });
  return json({ ok: true });
}

// ── 개인 메모장 ──

// publicRead에 memos 경로 추가는 불필요 (discordId 기반 자체 검증)

async function handleMemoWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, discordId, text, isAdmin, adminToken, displayName, username, avatar } = body;
  if (!communityId || !puuId || !discordId) return json({ok:false,error:'필수 파라미터 누락'},400);

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';

  // 관리자는 adminToken으로 검증
  if (isAdmin && adminToken) {
    const session = getSession(adminToken);
    if (!session || session.role !== 'master') return json({ok:false,error:'관리자 권한 없음'},403);
  }

  const path = `communities/${communityId}/memos/${discordId}/${puuId}`;
  const memo = { text: (text || '').slice(0, 2000), updatedAt: Date.now(), discordId, displayName: displayName || '', username: username || '', avatar: avatar || null };
  const res = await fetch(`${dbUrl}/${path}.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(memo)
  });
  if (!res.ok) return json({ok:false,error:'저장 실패'},500);
  return json({ ok: true });
}

async function handleMemoRead(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, discordId, isAdmin, adminToken } = body;
  if (!communityId || !puuId) return json({ok:false,error:'필수 파라미터 누락'},400);

  const dbUrl = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth=' + secret : '';

  // 관리자: 해당 유저의 모든 메모 조회 (shallow로 discordId 목록만 먼저)
  if (isAdmin && adminToken) {
    const session = getSession(adminToken);
    if (session && session.role === 'master' || (session && session.role === 'admin')) {
      // shallow로 discordId 목록만 가져오기
      const shallowQ2 = authQ ? authQ+'&shallow=true' : '?shallow=true';
      const keysRes = await fetch(`${dbUrl}/communities/${communityId}/memos.json${shallowQ2}`);
      if (!keysRes.ok) return json({ ok: true, data: {}, isAdmin: true });
      const dcIds = await keysRes.json();
      if (!dcIds) return json({ ok: true, data: {}, isAdmin: true });
      // 각 discordId의 해당 puuId 메모만 병렬 조회
      const memoResults = await Promise.all(
        Object.keys(dcIds).map(dcId =>
          fetch(`${dbUrl}/communities/${communityId}/memos/${dcId}/${puuId}.json${authQ}`)
            .then(r => r.json())
            .then(d => ({ dcId, d }))
            .catch(() => ({ dcId, d: null }))
        )
      );
      const result = {};
      memoResults.forEach(({ dcId, d }) => { if (d && d.text) result[dcId] = d; });
      return json({ ok: true, data: result, isAdmin: true });
    }
  }

  // 일반 유저: 자신의 메모만
  if (!discordId) return json({ok:false,error:'discordId 없음'},400);
  const path = `communities/${communityId}/memos/${discordId}/${puuId}`;
  const res = await fetch(`${dbUrl}/${path}.json${authQ}`);
  if (!res.ok) return json({ok:false,error:'조회 실패'},500);
  const data = await res.json();
  return json({ ok: true, data: data || null });
}


// ── 공통 관리자 인증 헬퍼 ──
async function verifyAdmin(token, adminId, adminPw, communityId, env) {
  // 1. 세션 토큰
  const session = getSession(token);
  if (session && (session.role === 'master' || session.role === 'admin')) return session;

  if (!adminId || !adminPw) return null;

  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';

  // 2. master 검증
  try {
    const saltRes = await fetch(dbUrl + '/master/salt.json' + authQ);
    if (saltRes.ok) {
      const salt = await saltRes.json();
      if (salt) {
        const enc = new TextEncoder();
        const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(adminPw + salt));
        const hashHex = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
        const mr = await fetch(dbUrl + '/master.json' + authQ);
        if (mr.ok) {
          const master = await mr.json();
          if (master && master.id === adminId && master.pw === hashHex) {
            return { role: 'master', id: adminId };
          }
        }
      }
    }
  } catch(e) {}

  // 3. community admin 검증
  if (communityId) {
    try {
      const adminListRes = await fetch(`${dbUrl}/communities_info/${communityId}/adminList.json${authQ}`);
      if (adminListRes.ok) {
        const adminList = await adminListRes.json();
        if (adminList && Array.isArray(adminList)) {
          const enc = new TextEncoder();
          const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(adminPw));
          const hashHex = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
          const found = adminList.find(a => a.id === adminId && a.pw === hashHex);
          if (found) return { role: 'admin', id: adminId };
        }
      }
    } catch(e) {}
  }
  return null;
}

// ── 주간 미션 ──

// 현재 주 키 (KST 기준 YYYY_Www)
function getWeekKey(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay(); // 0=일, 1=월
  const monday = new Date(kst);
  monday.setUTCDate(kst.getUTCDate() - ((day + 6) % 7));
  const y = monday.getUTCFullYear();
  const start = new Date(Date.UTC(y, 0, 1));
  const week = Math.ceil(((monday - start) / 86400000 + start.getUTCDay() + 1) / 7);
  return `${y}_W${String(week).padStart(2,'0')}`;
}

// 미션 설정 읽기 (공개) - 10분 캐시
async function handleWeeklyMissionConfigRead(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const data = await cachedFetch(
    `wm-config-${communityId}`,
    async () => {
      const res = await fetch(`${dbUrl}/communities/${communityId}/weekly_missions/config.json${authQ}`);
      return await res.json();
    },
    1800 // 30분
  );
  return json({ ok:true, data: data || [] });
}

// 미션 설정 저장 (마스터만)
async function handleWeeklyMissionConfigWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, missions } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  await fetch(`${dbUrl}/communities/${communityId}/weekly_missions/config.json${authQ}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(missions)
  });
  // 캐시 무효화
  await invalidateCache(`wm-config-${communityId}`);
  return json({ ok:true });
}

// 이번 주 내전 게임 수 계산
async function handleWeeklyMissionCount(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, platform } = body;
  if (!communityId || !puuId) return json({ok:false,error:'필수 파라미터 없음'},400);

  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const weekKey = getWeekKey(new Date());

  // 캐시 확인 (1시간)
  const cacheRes = await fetch(`${dbUrl}/communities/${communityId}/weekly_missions/counts/${puuId}/${weekKey}.json${authQ}`);
  const cached = await cacheRes.json();
  if (cached && cached.updatedAt && Date.now() - cached.updatedAt < 3600000) {
    return json({ ok:true, count: cached.count, weekKey, cached: true });
  }

  // KST 이번주 월요일 00:00 타임스탬프
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay();
  const monday = new Date(kst);
  monday.setUTCDate(kst.getUTCDate() - ((day + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  const mondayTs = monday.getTime() - 9 * 3600 * 1000; // UTC로 변환

  // 커뮤니티 멤버 puu_id 목록 (딥롤 server_info)
  let communityPuuIds = new Set();
  try {
    const sidRes = await fetch(`${dbUrl}/communities_info/${communityId}/deeplolServerId.json${authQ}`);
    const serverId = await sidRes.json();
    if (serverId) {
      const sRes = await fetch(`https://b2c-api-cdn.deeplol.gg/tournament/server_info?server_id=${serverId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.deeplol.gg/' }
      });
      if (sRes.ok) {
        const sData = await sRes.json();
        const list = sData?.tournament_stats?.tournament_stats_all_list || [];
        list.forEach(m => { if (m.puu_id) communityPuuIds.add(m.puu_id); });
      }
    }
  } catch(e) {}

  // 딥롤 match-list API로 이번 주 게임 가져오기
  const plat = (platform || 'KR').toLowerCase();
  let count = 0;
  try {
    let offset = 0;
    const PAGE = 20;
    while (true) {
      const mlRes = await fetch(
        `https://b2c-api-cdn.deeplol.gg/match/matches?puu_id=${encodeURIComponent(puuId)}&platform_id=${plat}&offset=${offset}&count=${PAGE}&queue_type=CUSTOM&champion_id=0&only_list=1&last_updated_at=1`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.deeplol.gg/' } }
      );
      if (!mlRes.ok) { console.log('[weekly] match API 실패:', mlRes.status); break; }
      const mlData = await mlRes.json();
      const matches = mlData?.match_list || mlData?.matches || [];
      console.log('[weekly] offset:', offset, 'matches:', matches.length);
      if (!matches.length) break;

      let shouldStop = false;
      for (const m of matches) {
        const ts = (m.creation_timestamp || 0) * 1000;
        if (ts < mondayTs) { shouldStop = true; break; }
        // 커스텀 게임이고 커뮤니티 멤버 4명 이상 포함
        const puuList = m.puu_id_list || [];
        const overlap = communityPuuIds.size > 0
          ? puuList.filter(id => communityPuuIds.has(id)).length
          : 5; // 커뮤니티 멤버 로드 실패 시 커스텀 게임 전체 카운트
        if (overlap >= 4) count++;
      }
      if (shouldStop || matches.length < PAGE) break;
      offset += PAGE;
    }
  } catch(e) {}

  // 캐시 저장
  await fetch(`${dbUrl}/communities/${communityId}/weekly_missions/counts/${puuId}/${weekKey}.json${authQ}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ count, updatedAt: Date.now() })
  });

  return json({ ok:true, count, weekKey, cached: false });
}

// 리워드 수령
async function handleWeeklyMissionReward(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, threshold } = body;
  if (!communityId || !puuId || threshold === undefined) return json({ok:false,error:'필수 파라미터 없음'},400);

  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const weekKey = getWeekKey(new Date());
  const path = `communities/${communityId}/weekly_missions/rewards/${puuId}/${weekKey}`;

  // 기존 수령 목록 가져와서 추가
  const existing = await (await fetch(`${dbUrl}/${path}.json${authQ}`)).json() || [];
  const list = Array.isArray(existing) ? existing : [];
  if (!list.includes(threshold)) list.push(threshold);

  await fetch(`${dbUrl}/${path}.json${authQ}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(list)
  });
  return json({ ok:true, collected: list });
}

// 리워드 현황 읽기 (allData용 배치)
async function handleWeeklyMissionRewardsRead(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const weekKey = getWeekKey(new Date());
  const res = await fetch(`${dbUrl}/communities/${communityId}/weekly_missions/rewards.json${authQ}`);
  const data = await res.json() || {};
  // 이번 주 수령 데이터만 추출
  const result = {};
  Object.entries(data).forEach(([puuId, weeks]) => {
    if (weeks && weeks[weekKey]) result[puuId] = weeks[weekKey];
  });
  return json({ ok:true, data: result, weekKey });
}

// 주간 미션 초기화 Cron (매주 월요일 KST = UTC 일요일 15:00)
async function runWeeklyMissionReset(env) {
  console.log('[weekly-reset] 주간 미션 초기화 시작');
  // counts만 초기화 (rewards는 기록 보존)
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const shallowQ = authQ ? authQ+'&shallow=true' : '?shallow=true';
  const commRes = await fetch(`${dbUrl}/communities_info.json${shallowQ}`);
  if (!commRes.ok) return;
  const commKeys = await commRes.json();
  if (!commKeys) return;
  for (const cid of Object.keys(commKeys)) {
    try {
      await fetch(`${dbUrl}/communities/${cid}/weekly_missions/counts.json${authQ}`, { method: 'DELETE' });
      console.log(`[weekly-reset] ${cid} counts 초기화`);
    } catch(e) {}
  }
}

// ── 피크티어 경량 읽기 ──
// member_analysis 전체(2.3MB) 대신 peak_tier만 추출해서 반환 (15분 캐시)
async function handlePeakTiersRead(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);

  const data = await cachedFetch(
    `peak-tiers-${communityId}`,
    async () => {
      const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
      const authQ = secret ? '?auth='+secret : '';
      // 전체 member_analysis를 읽되 Worker에서 peak_tier만 추출
      const res = await fetch(`${dbUrl}/communities/${communityId}/member_analysis.json${authQ}`);
      if (!res.ok) return {};
      const raw = await res.json();
      if (!raw) return {};
      // peak_tier, peak_lp만 추출 → 크기 대폭 축소
      const result = {};
      Object.entries(raw).forEach(([puuId, d]) => {
        if (d && d.peak_tier) {
          result[puuId] = { tier: d.peak_tier, lp: d.peak_lp || 0 };
        }
      });
      return result;
    },
    1800 // 30분
  );
  return json({ ok: true, data: data || {} });
}

// ── 딥롤 서버 정보 프록시 (10분 Cloudflare 캐시) ──
async function handleServerInfo(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { serverId } = body;
  if (!serverId) return json({ok:false,error:'serverId 없음'},400);

  const data = await cachedFetch(
    `server-info-${serverId}`,
    async () => {
      const res = await fetch(
        `https://b2c-api-cdn.deeplol.gg/tournament/server_info?server_id=${serverId}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.deeplol.gg/' } }
      );
      if (!res.ok) return null;
      return await res.json();
    },
    1800 // 30분
  );
  if (!data) return json({ok:false,error:'서버 정보 조회 실패'},500);
  return json({ ok:true, data });
}

// ── 닉네임 히스토리 ──

// 닉네임 히스토리 읽기
async function handleNicknameHistoryRead(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId } = body;
  if (!communityId || !puuId) return json({ok:false,error:'필수 파라미터 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const res = await fetch(`${dbUrl}/communities/${communityId}/nickname_history/${puuId}.json${authQ}`);
  if (!res.ok) return json({ok:false,error:'조회 실패'},500);
  const data = await res.json();
  return json({ ok:true, data: data || [] });
}

// 자정 닉네임 변경 체크 Cron
// 단일 커뮤니티 닉네임 체크
async function runNicknameHistoryCheckForCommunity(env, cid, isManual) {
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';

  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  if (!isManual) kst.setUTCDate(kst.getUTCDate() - 1);
  const dateStr = kst.getUTCFullYear() + '-' +
    String(kst.getUTCMonth()+1).padStart(2,'0') + '-' +
    String(kst.getUTCDate()).padStart(2,'0');

  try {
    // 1. deeplolServerId 확인
    console.log('[nickname-check] cid:', cid);
    const sidRes = await fetch(`${dbUrl}/communities_info/${cid}/deeplolServerId.json${authQ}`);
    const serverId = await sidRes.json();
    console.log('[nickname-check] serverId:', serverId);
    if (!serverId) return { cid, skipped: 'no serverId' };

    // 2. 딥롤 API로 현재 멤버 닉네임 한 번에 가져오기
    const sRes = await fetch(
      `https://b2c-api-cdn.deeplol.gg/tournament/server_info?server_id=${serverId}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.deeplol.gg/' } }
    );
    if (!sRes.ok) return { cid, error: 'deeplol API 실패' };
    const sData = await sRes.json();
    const members = sData?.tournament_stats?.tournament_stats_all_list || [];
    console.log('[nickname-check] members:', members.length);
    if (!members.length) return { cid, skipped: 'no members' };

    // 3. 기존 히스토리 전체를 한 번에 읽기
    const histRes = await fetch(`${dbUrl}/communities/${cid}/nickname_history.json${authQ}`);
    const allHistory = (await histRes.json()) || {};

    // 4. 메모리에서 비교 후 변경된 것만 Firebase 쓰기
    const writes = [];
    for (const m of members) {
      if (!m.puu_id || !m.riot_name || !m.riot_tag) continue;
      const currentNick = `${m.riot_name}#${m.riot_tag}`;
      const history = allHistory[m.puu_id];

      if (!history || !Array.isArray(history) || history.length === 0) {
        // 히스토리 없으면 초기 닉네임 저장
        writes.push({ path: `communities/${cid}/nickname_history/${m.puu_id}`,
          data: [{ name: currentNick, date: dateStr, label: '초기 닉네임' }] });
      } else {
        const lastNick = history[history.length - 1].name;
        if (lastNick !== currentNick) {
          // 변경 감지
          const updated = [...history, { name: currentNick, date: dateStr }];
          writes.push({ path: `communities/${cid}/nickname_history/${m.puu_id}`, data: updated });
          console.log(`[nickname-check] ${cid} / ${m.puu_id}: ${lastNick} → ${currentNick}`);
        }
      }
    }

    // 5. 변경된 것 모두 PATCH 1번으로 묶어서 쓰기
    if (writes.length > 0) {
      const patchBody = {};
      writes.forEach(w => {
        const puuId = w.path.split('/').pop();
        patchBody[puuId] = w.data;
      });
      const patchRes = await fetch(`${dbUrl}/communities/${cid}/nickname_history.json${authQ}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody)
      });
      const patchText = await patchRes.text();
      console.log(`[nickname-check] PATCH status:${patchRes.status} body:${patchText.slice(0,200)}`);
    }

    console.log(`[nickname-check] ${cid} 완료: ${members.length}명 확인, ${writes.length}개 변경`);
    return { cid, members: members.length, changes: writes.length };
  } catch(e) {
    console.error(`[nickname-check] ${cid} 오류:`, e.message);
    return { cid, error: e.message };
  }
}

// 전체 Cron - 커뮤니티별 순차 처리
async function runNicknameHistoryCheck(env, isManual) {
  console.log('[nickname-check] 시작', isManual ? '(수동)' : '(Cron)');
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const shallowQ = authQ ? authQ+'&shallow=true' : '?shallow=true';
  const commRes = await fetch(`${dbUrl}/communities_info.json${shallowQ}`);
  if (!commRes.ok) return;
  const commKeys = await commRes.json();
  if (!commKeys) return;
  for (const cid of Object.keys(commKeys)) {
    await runNicknameHistoryCheckForCommunity(env, cid, isManual);
  }
  console.log('[nickname-check] 완료');
}

// 닉네임 히스토리 수동 실행
async function handleNicknameHistoryRun(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { token, communityId, serverId } = body;
  const session = getSession(token);
  if (!session || (session.role !== 'master' && session.role !== 'admin')) {
    return json({ok:false,error:'마스터 권한 필요'},403);
  }
  let targetCid = communityId;
  // communityId 없으면 serverId로 커뮤니티 찾기 (전체 한번에 읽기)
  if (!targetCid && serverId) {
    const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
    const authQ = secret ? '?auth='+secret : '';
    const ciRes = await fetch(`${dbUrl}/communities_info.json${authQ}`);
    const ciData = await ciRes.json() || {};
    for (const [cid, info] of Object.entries(ciData)) {
      if (info && String(info.deeplolServerId) === String(serverId)) {
        targetCid = cid; break;
      }
    }
  }
  if (!targetCid) return json({ok:false,error:'커뮤니티를 찾을 수 없음'},400);
  const result = await runNicknameHistoryCheckForCommunity(env, targetCid, true);
  return json({ ok:true, result });
}

// ── 후원 목록 ──
async function handleDonationRead(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const res = await fetch(`${dbUrl}/communities/${communityId}/donations.json${authQ}`);
  if (!res.ok) return json({ok:false,error:'조회 실패'},500);
  const data = await res.json();
  return json({ ok:true, data: data || [] });
}

async function handleDonationWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, donations } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  await fetch(`${dbUrl}/communities/${communityId}/donations.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(donations)
  });
  return json({ ok:true });
}



// ── OG 이미지 동적 처리 ──
const CRAWLERS = ['Twitterbot','facebookexternalhit','LinkedInBot','Slackbot','TelegramBot',
  'Discordbot','KakaoTalk','WhatsApp','Line','Googlebot','bingbot','Baiduspider','Yeti'];

function isCrawler(userAgent) {
  if (!userAgent) return false;
  return CRAWLERS.some(c => userAgent.includes(c));
}

// 커뮤니티별 OG 설정
const COMMUNITY_OG = {
  'c_1786029938203': {
    image: 'https://roonging.com/og-hyeokgo.png',
    title: '협곡 지통실',
    description: '협곡 지통실 LoL 내전 전적 페이지'
  }
};

async function handleOgProxy(request, env) {
  const url = new URL(request.url);
  const cid = url.searchParams.get('cid') || '';
  const serverId = url.searchParams.get('server_id') || '';

  // 커뮤니티별 OG 설정 확인
  const og = COMMUNITY_OG[cid];
  const ogImage = og ? og.image : 'https://roonging.com/og-banner.jpg';
  const ogTitle = og ? og.title + ' 전적' : '룽잉 전적';
  const ogDesc = og ? og.description : 'LoL 내전 전적 통계 플랫폼';
  const pageUrl = 'https://roonging.com/stats?server_id=' + serverId + '&cid=' + cid;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta property="og:type" content="website">
<meta property="og:url" content="${pageUrl}">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${ogImage}">
<meta http-equiv="refresh" content="0; url=${pageUrl}">
<title>${ogTitle}</title>
</head>
<body>
<script>location.replace('${pageUrl}');</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=3600' }
  });
}

// ── 관찰 분석 대상 저장 ──
async function handleScoutTargetsWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, targets } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  await fetch(`${dbUrl}/communities/${communityId}/scout_targets.json${authQ}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(targets||[])
  });
  return json({ ok:true });
}

// ── 관찰 분석: 솔랭+내전 데이터 프록시 ──
async function handleScoutRanked(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { puuId, platform, queueType } = body;
  if (!puuId) return json({ok:false,error:'puuId 없음'},400);

  const plat = (platform||'KR').toLowerCase();
  const qType = queueType || 'RANKED_SOLO'; // RANKED_SOLO or CUSTOM
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.deeplol.gg/'
  };

  // 1. 솔랭 티어 (RANKED_SOLO 요청 시만)
  let soloTier = null;
  if (qType === 'RANKED_SOLO') {
    try {
      const tierRes = await fetch(
        `https://b2c-api-cdn.deeplol.gg/summoner/summoner-realtime?platform_id=${plat}&summoner_id=&puu_id=${encodeURIComponent(puuId)}`,
        { headers }
      );
      if (tierRes.ok) {
        const tierJson = await tierRes.json();
        const solo = tierJson?.season_tier_info_dict?.ranked_solo_5x5;
        if (solo) soloTier = {
          tier: solo.tier, division: solo.division,
          lp: solo.league_points, wins: solo.wins, losses: solo.losses
        };
      }
    } catch(e) {}
  }

  // 2. 매치 목록 페이지네이션 (최대 100게임)
  let allMatchIds = [];
  let offset = 0;
  const PAGE = 20;
  const MAX_GAMES = 100;
  while (allMatchIds.length < MAX_GAMES) {
    try {
      const listUrl = `https://b2c-api-cdn.deeplol.gg/match/matches?puu_id=${encodeURIComponent(puuId)}&platform_id=${plat}&offset=${offset}&count=${PAGE}&queue_type=${qType}&champion_id=0&only_list=1&last_updated_at=1`;
      const res = await fetch(listUrl, { headers });
      if (!res.ok) break;
      const j = await res.json();
      // 키 이름: match_id_list (문자열 배열) 또는 match_list (객체 배열)
      const ids = j.match_id_list || (j.match_list||[]).map(m => m.match_id);
      if (!ids.length) break;
      allMatchIds = allMatchIds.concat(ids);
      if (ids.length < PAGE) break;
      offset += PAGE;
    } catch(e) { console.log('[scout] err:', e.message); break; }
  }
  allMatchIds = allMatchIds.slice(0, MAX_GAMES);

  // 3. 매치 상세 병렬 (배치 10개씩)
  let matches = [];
  const BATCH = 10;
  for (let i = 0; i < allMatchIds.length; i += BATCH) {
    const batch = allMatchIds.slice(i, i + BATCH);
    const details = await Promise.all(batch.map(mid =>
      fetch(`https://b2c-api-cdn.deeplol.gg/match/match-cached?match_id=${mid}&platform_id=${plat}`, { headers })
        .then(r => r.json()).catch(() => null)
    ));
    matches = matches.concat(details.filter(Boolean));
  }

  return json({ ok: true, soloTier, matches, total: matches.length });
}

// 닉네임 히스토리 수정 (hidden 토글)
async function handleNicknameHistoryWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, history } = body;
  if (!communityId || !puuId) return json({ok:false,error:'필수 파라미터 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  await fetch(`${dbUrl}/communities/${communityId}/nickname_history/${puuId}.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(history)
  });
  return json({ ok: true });
}

// ── 관찰분석 접근 허용 목록 저장 ──
async function handleScoutAllowWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, allowList } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  await fetch(`${dbUrl}/communities/${communityId}/scout_allowed_discord.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(allowList||[])
  });
  return json({ ok: true });
}

// ── 관찰분석 카테고리 저장 ──
async function handleScoutCategoriesWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, categories } = body;
  if (!communityId) return json({ok:false,error:'communityId 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  await fetch(`${dbUrl}/communities/${communityId}/scout_categories.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(categories||[])
  });
  return json({ ok: true });
}

// ══════════════════════════════════════════
// 디스코드 봇 (Interactions Endpoint)
// ══════════════════════════════════════════

// Ed25519 서명 검증
async function verifyDiscordSignature(request, env) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp  = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;
  const body = await request.text();
  const PUBLIC_KEY = env.DISCORD_PUBLIC_KEY || 'e39c71aa12d8af890a14cf7e97fd1de64cdcc43e9d5f733d3c4ea936ed98c8c9';
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToUint8(PUBLIC_KEY),
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      hexToUint8(signature),
      new TextEncoder().encode(timestamp + body)
    );
    return valid ? body : false;
  } catch(e) {
    console.error('[discord] verify error:', e.message);
    return false;
  }
}

function hexToUint8(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) arr[i/2] = parseInt(hex.substr(i,2),16);
  return arr;
}

// 디스코드 메시지 응답 헬퍼
function discordReply(content, ephemeral = false) {
  return new Response(JSON.stringify({
    type: 4,
    data: { content, flags: ephemeral ? 64 : 0 }
  }), { headers: { 'Content-Type': 'application/json' } });
}

function discordDefer(ephemeral = false) {
  return new Response(JSON.stringify({
    type: 5,
    data: { flags: ephemeral ? 64 : 0 }
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function discordFollowup(appId, token, content, env) {
  const aid = appId || env.DISCORD_APP_ID || '1500717088984010883';
  console.log('[followup] appId:', aid, 'token:', token?.slice(0,20));
  const res = await fetch(`https://discord.com/api/v10/webhooks/${aid}/${token}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`
    },
    body: JSON.stringify({ content, flags: 64 })
  });
  const txt = await res.text();
  console.log('[followup] status:', res.status, txt.slice(0,200));
}

const LANE_MAP = {
  '탑':'top','top':'top','TOP':'top',
  '정글':'jg','jungle':'jg','jg':'jg','JG':'jg','정':'jg',
  '미드':'mid','mid':'mid','MID':'mid','middle':'mid',
  '원딜':'bot','adc':'bot','ADC':'bot','봇':'bot','bot':'bot','BOT':'bot','Bottom':'bot','bottom':'bot',
  '서폿':'sup','sup':'sup','SUP':'sup','서포터':'sup','support':'sup','Support':'sup',
};

async function handleDiscordInteraction(request, env, ctx) {
  // 서명 검증
  const bodyText = await verifyDiscordSignature(request.clone(), env);
  if (bodyText === false) return new Response('Unauthorized', { status: 401 });

  const interaction = JSON.parse(bodyText);

  // PING
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), { headers: { 'Content-Type': 'application/json' } });
  }

  console.log('[discord] interaction type:', interaction.type, 'customId:', interaction.data?.custom_id, 'cmdName:', interaction.data?.name);

  // 버튼 클릭 (Message Component)
  if (interaction.type === 3) {
    const customId = interaction.data.custom_id || '';
    // 나가기 버튼
    if (customId.startsWith('leave_match__') || customId.startsWith('leave_match_')) {
      let cid, matchId;
      if (customId.startsWith('leave_match__')) {
        const inner = customId.slice('leave_match__'.length);
        const sepIdx = inner.indexOf('__');
        cid = inner.slice(0, sepIdx);
        matchId = inner.slice(sepIdx + 2);
      } else {
        const inner = customId.slice('leave_match_'.length);
        const matchIdx = inner.lastIndexOf('_match_');
        cid = inner.slice(0, matchIdx);
        matchId = 'match_' + inner.slice(matchIdx + 7);
      }
      const discordUserId = interaction.member?.user?.id || interaction.user?.id;
      const appId = env.DISCORD_APP_ID || '1500717088984010883';
      const token = interaction.token;
      const resp = discordDefer(true);
      ctx.waitUntil(
        handleLeaveMatch(cid, matchId, discordUserId, appId, token, env)
          .catch(async (e) => { await discordFollowup(appId, token, '❌ 오류: ' + e.message, env); })
      );
      return resp;
    }

    // 멤버 목록 버튼
    if (customId.startsWith('members_match__') || customId.startsWith('members_match_')) {
      let cid, matchId;
      if (customId.startsWith('members_match__')) {
        const inner = customId.slice('members_match__'.length);
        const sepIdx = inner.indexOf('__');
        cid = inner.slice(0, sepIdx);
        matchId = inner.slice(sepIdx + 2);
      } else {
        const inner = customId.slice('members_match_'.length);
        const matchIdx = inner.lastIndexOf('_match_');
        cid = inner.slice(0, matchIdx);
        matchId = 'match_' + inner.slice(matchIdx + 7);
      }
      const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
      const authQ = secret ? '?auth='+secret : '';
      const matchRes = await fetch(`${dbUrl}/communities/${cid}/matches/${matchId}.json${authQ}`);
      const matchData = await matchRes.json();
      const members = matchData?._members || matchData?.members || [];
      if (!members.length) {
        return discordReply('아직 참가한 멤버가 없습니다.', true);
      }
      const LANE_EMOJI = {top:'🛡️',jg:'🌲',mid:'⚡',bot:'🏹',sup:'🌟'};
      const TIER_EMOJI = {CHALLENGER:'🏆',GRANDMASTER:'💎',MASTER:'💜',DIAMOND:'💠',EMERALD:'💚',PLATINUM:'🩵',GOLD:'🥇',SILVER:'⚪',BRONZE:'🟤',IRON:'⬛',UNRANKED:'❓'};
      const LANE_EMOJI3 = {top:'🛡️',jg:'🌲',mid:'⚡',bot:'🏹',sup:'🌟'};
      const list = members.map((m, i) =>
        `${i+1}. ${LANE_EMOJI3[m.mainLane]||'🎮'} **${m.name}#${m.tag}** ${TIER_EMOJI[m.tier]||''} ${m.tierFull||m.tier||''}`
      ).join('\n');
      return discordReply(`**👥 ${matchData.name||'내전'} 멤버 목록** (${members.length}명)\n${list}`, true);
    }

    if (customId.startsWith('join_match__') || customId.startsWith('join_match_')) {
      let cid, matchId;
      if (customId.startsWith('join_match__')) {
        const inner = customId.slice('join_match__'.length);
        const sepIdx = inner.indexOf('__');
        cid = inner.slice(0, sepIdx);
        matchId = inner.slice(sepIdx + 2);
      } else {
        const inner = customId.slice('join_match_'.length);
        const matchIdx = inner.lastIndexOf('_match_');
        cid = inner.slice(0, matchIdx);
        matchId = 'match_' + inner.slice(matchIdx + 7);
      }
      const discordUserId = interaction.member?.user?.id || interaction.user?.id;
      // 저장된 프로필 로드
      let ep = {};
      try {
        const dbUrl2 = env.FB_DATABASE_URL, secret2 = env.FB_DB_SECRET;
        const authQ2 = secret2 ? '?auth='+secret2 : '';
        const pRes = await fetch(`${dbUrl2}/discord_profiles/${discordUserId}.json${authQ2}`);
        if (pRes.ok) ep = await pRes.json() || {};
      } catch(e) {}
      // 포지션 역매핑 (저장값 → 한글)
      const LANE_KO_MAP = {top:'탑',jg:'정글',mid:'미드',bot:'원딜',sup:'서폿'};
      const savedMainLane = ep.mainLane ? (LANE_KO_MAP[ep.mainLane] || ep.mainLane) : '';
      const savedSubLanes = ep.subLanes ? ep.subLanes.map(l => LANE_KO_MAP[l] || l).join(',') : '';
      // 칼바람 여부 확인
      let isAram = false;
      try {
        const dbUrl3 = env.FB_DATABASE_URL, secret3 = env.FB_DB_SECRET;
        const authQ3 = secret3 ? '?auth='+secret3 : '';
        const mRes = await fetch(`${dbUrl3}/communities/${cid}/matches/${matchId}/isAram.json${authQ3}`);
        if (mRes.ok) isAram = (await mRes.json()) === true;
      } catch(e) {}

      const laneComponents = isAram ? [] : [
        { type: 1, components: [{
          type: 4, label: '주 포지션', custom_id: 'main_lane',
          style: 1, placeholder: '탑 / 정글 / 미드 / 원딜 / 서폿', required: false, min_length: 0, max_length: 10,
          value: savedMainLane
        }]},
        { type: 1, components: [{
          type: 4, label: '보조 포지션 (선택, 쉼표로 구분)', custom_id: 'sub_lanes',
          style: 1, placeholder: '예) 정글,서폿', required: false, max_length: 50,
          value: savedSubLanes
        }]},
      ];

      return new Response(JSON.stringify({
        type: 9,
        data: {
          title: isAram ? '❄️ 칼바람 내전 참가 신청' : '내전 참가 신청',
          custom_id: `join_modal_${cid}_${matchId}`,
          components: [
            { type: 1, components: [{
              type: 4, label: '소환사명', custom_id: 'riot_name',
              style: 1, placeholder: '예) 홍길동', required: true, min_length: 1, max_length: 50,
              value: ep.riotName || ''
            }]},
            { type: 1, components: [{
              type: 4, label: '태그', custom_id: 'riot_tag',
              style: 1, placeholder: '예) KR1', required: true, min_length: 1, max_length: 10,
              value: ep.riotTag || ''
            }]},
            ...laneComponents,
            { type: 1, components: [{
              type: 4, label: '최고/임시 티어 (선택)', custom_id: 'high_tier',
              style: 1, placeholder: '예) e1 / d3 / m300 / gm500 / c (비워두면 자동)', required: false, max_length: 20,
              value: ep.highTier || ''
            }]}
          ]
        }
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // 모달 제출 (type 5)
  if (interaction.type === 5) {
    const customId = interaction.data.custom_id || '';
    // 참여양식 저장 모달
    if (customId.startsWith('save_profile__')) {
      const discordUserId = customId.slice('save_profile__'.length);
      const comps = interaction.data.components || [];
      const getVal2 = (id) => comps.flatMap(r => r.components).find(c => c.custom_id === id)?.value || '';
      const riotName  = getVal2('riot_name').trim();
      const riotTag   = getVal2('riot_tag').trim();
      const mainLane  = getVal2('main_lane').trim();
      const subRaw    = getVal2('sub_lanes').trim();
      const highTier  = getVal2('high_tier').trim();
      const subLanes  = subRaw ? subRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [];
      const mainLaneMapped = LANE_MAP[mainLane] || mainLane;
      const subLanesMapped = subLanes.map(l => LANE_MAP[l] || l).filter(Boolean);
      const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
      const authQ = secret ? '?auth='+secret : '';
      const profile = { riotName, riotTag, mainLane: mainLaneMapped, subLanes: subLanesMapped, highTier, updatedAt: Date.now() };
      await fetch(`${dbUrl}/discord_profiles/${discordUserId}.json${authQ}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      });
      return new Response(JSON.stringify({
        type: 4,
        data: {
          content: `✅ 참여 양식이 저장되었습니다!\n🎮 소환사: **${riotName}#${riotTag}**\n${{탑:'🛡️',정글:'🌲',미드:'⚡',원딜:'🏹',서폿:'🌟',top:'🛡️',jg:'🌲',mid:'⚡',bot:'🏹',sup:'🌟'}[mainLaneMapped]||'🎮'} 주 포지션: **${mainLaneMapped}**\n${highTier ? `🏅 최고/임시 티어: **${highTier}**` : ''}\n\n내전 참가 버튼을 누르면 자동으로 입력됩니다.`,
          flags: 64
        }
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (customId.startsWith('join_modal__') || customId.startsWith('join_modal_')) {
      let cid, matchId;
      if (customId.startsWith('join_modal__')) {
        const inner = customId.slice('join_modal__'.length);
        const sepIdx = inner.indexOf('__');
        cid = inner.slice(0, sepIdx);
        matchId = inner.slice(sepIdx + 2);
      } else {
        // 구형: join_modal_c_XXXXX_match_YYYYY
        const inner = customId.slice('join_modal_'.length); // c_XXXXX_match_YYYYY
        // match_ 기준으로 분리
        const matchIdx = inner.lastIndexOf('_match_');
        cid = inner.slice(0, matchIdx);       // c_XXXXX
        matchId = 'match_' + inner.slice(matchIdx + 7); // match_YYYYY
      }
      const comps = interaction.data.components || [];
      const getVal = (id) => comps.flatMap(r => r.components).find(c => c.custom_id === id)?.value || '';
      const riotName  = getVal('riot_name').trim();
      const riotTag   = getVal('riot_tag').trim();
      const mainLane  = getVal('main_lane').trim();
      const subRaw    = getVal('sub_lanes').trim();
      const subLanes  = subRaw ? subRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [];
      const highTierInput = getVal('high_tier').trim();
      const discordUserId = interaction.member?.user?.id || interaction.user?.id;
      const discordName   = interaction.member?.user?.username || interaction.user?.username;
      console.log('[modal] cid:', cid, 'matchId:', matchId, 'name:', riotName, 'lane:', mainLane);
      const appId = env.DISCORD_APP_ID || '1500717088984010883';
      const token = interaction.token;
      const resp = discordDefer(true);
      ctx.waitUntil(
        handleJoinMatchDirect(riotName, riotTag, mainLane, subLanes, matchId, cid, discordUserId, discordName, appId, token, env, highTierInput)
          .catch(async (e) => {
            console.error('[joinDirect error]', e.message, e.stack);
            await discordFollowup(appId, token, '❌ 오류: ' + e.message, env);
          })
      );
      return resp;
    }
  }

  // 슬래시 커맨드
  if (interaction.type === 2) {
    const cmdName = interaction.data.name;
    const options  = interaction.data.options || [];
    const opt = (name) => options.find(o => o.name === name)?.value;

    // ── /내전목록 ──
    if (cmdName === '내전목록') {
      return handleListMatches(interaction, env);
    }

    // ── /내전승률 ──
    if (cmdName === '내전승률') {
      return handleMatchWinRate(interaction, env);
    }

    // ── /참여양식저장 ──
    if (cmdName === '참여양식저장') {
      const discordUserId = interaction.member?.user?.id || interaction.user?.id;
      // 바로 빈 모달 반환 (3초 제한 때문에 Firebase 조회 없이)
      return new Response(JSON.stringify({
        type: 9,
        data: {
          title: '참여 양식 저장',
          custom_id: `save_profile__${discordUserId}`,
          components: [
            { type: 1, components: [{
              type: 4, label: '소환사명', custom_id: 'riot_name',
              style: 1, placeholder: '예) 홍길동', required: true, min_length: 1, max_length: 50
            }]},
            { type: 1, components: [{
              type: 4, label: '태그', custom_id: 'riot_tag',
              style: 1, placeholder: '예) KR1', required: true, min_length: 1, max_length: 10
            }]},
            { type: 1, components: [{
              type: 4, label: '주 포지션', custom_id: 'main_lane',
              style: 1, placeholder: '탑 / 정글 / 미드 / 원딜 / 서폿', required: true, min_length: 1, max_length: 10
            }]},
            { type: 1, components: [{
              type: 4, label: '보조 포지션 (선택, 쉼표로 구분)', custom_id: 'sub_lanes',
              style: 1, placeholder: '예) 정글,서폿 (없으면 비워두세요)', required: false, max_length: 50
            }]},
            { type: 1, components: [{
              type: 4, label: '최고/임시 티어 (선택)', custom_id: 'high_tier',
              style: 1, placeholder: '예) e1 / d3 / m300 / gm500 / c', required: false, max_length: 20
            }]}
          ]
        }
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── /내전참가 ──
    if (cmdName === '내전참가') {
      const resp = discordDefer(true);
      const discordUserId = interaction.member?.user?.id || interaction.user?.id;
      const discordName   = interaction.member?.user?.username || interaction.user?.username;
      const appId  = env.DISCORD_APP_ID || '1500717088984010883';
      const token  = interaction.token;
      const subRaw = opt('보조포지션') || '';
      const subLanes = subRaw ? subRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [];
      const slashHighTier = opt('최고티어') || '';
      ctx.waitUntil(
        handleJoinMatch(opt('소환사명'), opt('태그'), opt('주포지션'), subLanes, opt('내전id'), discordUserId, discordName, appId, token, env, slashHighTier)
          .catch(async (e) => {
            console.error('[joinMatch error]', e.message);
            await discordFollowup(appId, token, '❌ 오류: ' + e.message, env);
          })
      );
      return resp;
    }
  }

  return new Response('Unknown interaction', { status: 400 });
}

// ── /내전목록 처리 ──
async function handleListMatches(interaction, env) {
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const guildId   = interaction.guild_id;
  const channelId = interaction.channel_id;

  // 커뮤니티 찾기
  const ciRes = await fetch(`${dbUrl}/communities_info.json${authQ}`);
  const ciData = await ciRes.json() || {};
  let targetCid = null;
  for (const [cid, info] of Object.entries(ciData)) {
    if (info && (
      String(info.discordServerId)  === String(guildId) ||
      String(info.discordChannelId) === String(channelId)
    )) { targetCid = cid; break; }
  }
  if (!targetCid) {
    return discordReply('❌ 이 서버와 연결된 커뮤니티를 찾을 수 없습니다.\n관리자에게 디스코드 서버 ID 설정을 요청하세요.', true);
  }

  const matchRes = await fetch(`${dbUrl}/communities/${targetCid}/matches.json${authQ}`);
  const matches = await matchRes.json() || {};

  const now = Date.now();
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;

  // 1단계(멤버 모집중) + 12시간 이내 + discordJoinable ON
  const openMatches = Object.entries(matches)
    .filter(([, m]) => {
      if (!m) return false;
      if (!m.discordJoinable) return false;
      // 완료/취소 제외
      if (m.status === 'done' || m.status === 'cancel') return false;
      // 12시간 이내
      const created = m.createdAt || 0;
      if (created && (now - created) > TWELVE_HOURS) return false;
      return true;
    })
    .sort(([, a], [, b]) => (b.createdAt||0) - (a.createdAt||0))
    .slice(0, 5);

  if (!openMatches.length) {
    return discordReply('현재 참가 가능한 내전이 없습니다.\n(디스코드 참가 ON + 12시간 이내 기준)', true);
  }

  // 내전마다 4개 버튼: 참가 / 멤버 목록 / 페이지 링크 / 나가기
  const components = openMatches.flatMap(([id, m]) => {
    const memberCount = (m._members||m.members||[]).length;
    return [{
      type: 1,
      components: [
        {
          type: 2, style: 1,
          label: `⚔️ ${m.name||'내전'} 참가`,
          custom_id: `join_match__${targetCid}__${id}`
        },
        {
          type: 2, style: 2,
          label: `👥 멤버 ${memberCount}명`,
          custom_id: `members_match__${targetCid}__${id}`
        },
        {
          type: 2, style: 5,
          label: '🔗 내전 페이지',
          url: `https://roonging.com/?match=${targetCid}__${id}`
        },
        {
          type: 2, style: 4,
          label: '🚪 나가기',
          custom_id: `leave_match__${targetCid}__${id}`
        }
      ]
    }];
  });

  const header = openMatches.map(([id, m]) => {
    let ageStr = '?';
    if (m.createdAt) {
      const ageMins = Math.floor((now - m.createdAt) / 60000);
      const h = Math.floor(ageMins / 60);
      const min = ageMins % 60;
      ageStr = h > 0 ? `${h}시간 ${min}분 전` : `${min}분 전`;
    }
    return `⚔️ **${m.name||'이름없음'}** — ${(m._members||m.members||[]).length}명 참가중 | ${ageStr} 생성`;
  }).join('\n');

  return new Response(JSON.stringify({
    type: 4,
    data: {
      content: `**📋 참가 가능한 내전 목록**\n${header}`,
      components,
      flags: 64
    }
  }), { headers: { 'Content-Type': 'application/json' } });
}

// ── /내전참가 처리 ──
async function handleJoinMatch(riotName, riotTag, laneInput, subLanesInput, matchId, discordUserId, discordName, appId, token, env, highTierInput) {
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';

  // 포지션 검증
  if (!riotName || !riotTag) {
    return discordFollowup(appId, token, '❌ 소환사명과 태그를 입력해주세요.\n예) `/내전참가 홍길동 KR1 탑 내전ID`', env);
  }
  const mainLane = LANE_MAP[laneInput];
  if (!mainLane) {
    return discordFollowup(appId, token,
      `❌ 포지션이 올바르지 않습니다.\n사용 가능: 탑, 정글, 미드, 원딜, 서폿\n입력값: "${laneInput}"`, env);
  }

  // matchId 없으면 가장 최근 대기중 내전 자동 선택
  const guildMatchId = matchId;

  // 디스코드 서버 → 커뮤니티 찾기
  // communities_info에서 discordServerId 매칭
  const ciRes = await fetch(`${dbUrl}/communities_info.json${authQ}`);
  const ciData = await ciRes.json() || {};

  // Discord 유저의 서버 ID로 매핑 (interaction.guild_id 없으므로 전체 검색)
  // 대신 discordUserId로 매핑된 커뮤니티 찾기
  // → matchId가 있으면 직접 찾기
  let targetCid = null, targetMatchId = null;

  if (guildMatchId) {
    // guild_id로 커뮤니티 먼저 찾고, 해당 커뮤니티에서 matchId 확인
    for (const [cid, info] of Object.entries(ciData)) {
      if (!info) continue;
      const mRes = await fetch(`${dbUrl}/communities/${cid}/matches/${guildMatchId}.json${authQ}`);
      if (mRes.ok) {
        const mData = await mRes.json();
        if (mData) { targetCid = cid; targetMatchId = guildMatchId; break; }
      }
    }
  } else {
    // matchId 없으면: deeplolServerId가 있는 커뮤니티에서 가장 최근 대기중 내전
    for (const [cid, info] of Object.entries(ciData)) {
      if (!info) continue;
      const mRes = await fetch(`${dbUrl}/communities/${cid}/matches.json${authQ}`);
      if (!mRes.ok) continue;
      const matches = await mRes.json() || {};
      const open = Object.entries(matches)
        .filter(([, m]) => m && m.discordJoinable && m.status !== 'done' && m.status !== 'cancel')
        .sort(([, a], [, b]) => (b.createdAt||0) - (a.createdAt||0));
      if (open.length) { targetCid = cid; targetMatchId = open[0][0]; break; }
    }
  }

  if (!targetCid || !targetMatchId) {
    return discordFollowup(appId, token, '❌ 참가 가능한 내전을 찾을 수 없습니다. 내전 ID를 직접 입력해주세요.', env);
  }

  // 내전 정보
  const matchRes = await fetch(`${dbUrl}/communities/${targetCid}/matches/${targetMatchId}.json${authQ}`);
  const matchData = await matchRes.json();
  if (!matchData) return discordFollowup(appId, token, '❌ 내전 정보를 불러올 수 없습니다.', env);
  if (!matchData.discordJoinable) return discordFollowup(appId, token, '❌ 이 내전은 디스코드 참가가 비활성화되어 있습니다.', env);

  // 이미 참가 여부 확인
  const existingMembers = matchData.members || [];
  const alreadyJoined = existingMembers.find(m =>
    (m.discordId && m.discordId === discordUserId) ||
    (m.name === riotName && m.tag === riotTag)
  );
  if (alreadyJoined) {
    const msg = alreadyJoined.discordId === discordUserId
      ? '❌ 이미 참여 신청하신 디스코드 계정입니다.'
      : `❌ **${riotName}#${riotTag}** 은(는) 이미 참가 중입니다.`;
    return discordFollowup(appId, token, msg, env);
  }

  // 딥롤 API로 소환사 정보 조회
  const ddRes = await fetch(
    `https://b2c-api-cdn.deeplol.gg/summoner/summoner-realtime?platform_id=KR&summoner_id=&riot_name=${encodeURIComponent(riotName)}&riot_tag=${encodeURIComponent(riotTag)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.deeplol.gg/' } }
  );

  let tierStr = 'UNRANKED', tierFull = 'UNRANKED', icon = '', level = 0, puuid = null;
  if (ddRes.ok) {
    const ddData = await ddRes.json();
    icon = ddData.profile_icon_url || '';
    level = ddData.summoner_level || 0;
    puuid = ddData.puu_id || null;
    const solo = ddData.season_tier_info_dict?.ranked_solo_5x5;
    if (solo && solo.tier) {
      tierStr = solo.tier;
      tierFull = `${solo.tier} ${solo.division||''} ${solo.league_points||0}LP`.trim();
    }
  }

  // 멤버 객체 생성 (index.html의 addMember와 동일 구조)
  const newMember = {
    id: Date.now(),
    name: riotName,
    tag: riotTag,
    icon,
    tier: tierStr,
    tierFull,
    mainLane,
    subLane: (Array.isArray(subLanesInput) ? subLanesInput.map(l => LANE_MAP[l] || l) : []),
    level,
    puuid,
    present: true,
    discordId: discordUserId,
    discordName,
    joinedAt: Date.now(),
  };

  // Firebase에 멤버 추가 (PATCH)
  const updatedMembers = [...existingMembers, newMember];
  const patchRes = await fetch(`${dbUrl}/communities/${targetCid}/matches/${targetMatchId}.json${authQ}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _members: updatedMembers })
  });

  if (!patchRes.ok) return discordFollowup(appId, token, '❌ 참가 처리 중 오류가 발생했습니다.', env);

  const TIER_EMOJI = {
    CHALLENGER:'🏆', GRANDMASTER:'💎', MASTER:'💜', DIAMOND:'💠',
    EMERALD:'💚', PLATINUM:'🩵', GOLD:'🥇', SILVER:'⚪', BRONZE:'🟤', IRON:'⬛', UNRANKED:'❓'
  };
  const LANE_EMOJI = { Top:'🛡️', Jungle:'🌲', Middle:'⚡', Bottom:'🏹', Support:'🌟' };

  return discordFollowup(appId, token,
    `✅ **${riotName}#${riotTag}** 참가 완료!\n` +
    `${TIER_EMOJI[tierStr]||'❓'} 티어: **${tierFull}**\n` +
    `${LANE_EMOJI[mainLane]||'🎮'} 주 포지션: **${mainLane}**\n` +
    `📋 내전: **${matchData.name || targetMatchId}**\n` +
    `👥 현재 대기 멤버: ${updatedMembers.length}명`, env);
}
async function handleJoinMatchDirect(riotName, riotTag, laneInput, subLanesInput, matchId, cid, discordUserId, discordName, appId, token, env, highTierInput) {
  console.log('[joinDirect] start', {riotName, riotTag, laneInput, matchId, cid});
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';

  // 포지션 검증
  const mainLane = LANE_MAP[laneInput];
  if (!mainLane) {
    return discordFollowup(appId, token,
      `❌ 포지션이 올바르지 않습니다.\n사용 가능: 탑, 정글, 미드, 원딜, 서폿\n입력값: "${laneInput}"`, env);
  }

  // 내전 정보 로드
  console.log('[joinDirect] fetching match...');
  const matchRes = await fetch(`${dbUrl}/communities/${cid}/matches/${matchId}.json${authQ}`);
  const matchData = await matchRes.json();
  if (!matchData) return discordFollowup(appId, token, '❌ 내전 정보를 불러올 수 없습니다.', env);

  const existingMembers = (matchData._members || matchData.members || []);
  const alreadyJoined = existingMembers.find(m =>
    (m.discordId && m.discordId === discordUserId) ||
    (m.name === riotName && m.tag === riotTag)
  );
  if (alreadyJoined) {
    const msg2 = alreadyJoined.discordId === discordUserId
      ? '❌ 이미 참여 신청하신 디스코드 계정입니다.'
      : `❌ **${riotName}#${riotTag}** 은(는) 이미 참가 중입니다.`;
    return discordFollowup(appId, token, msg2, env);
  }

  // Riot API로 소환사 정보 조회 (index.html과 동일한 구조)
  console.log('[joinDirect] fetching summoner...');
  const key = env.RIOT_API_KEY;
  const regional = 'asia';
  const platform = 'kr';

  let name = riotName, tag = riotTag, icon = '0', level = 0, puuid = null;
  let tierStr = 'UNRANKED', tierFull = 'UNRANKED', soloTier = 'UNRANKED', soloDivision = '';
  let soloWins = 0, soloLosses = 0, soloLP = 0;
  let highTier = null, highLp = 0, prevSeasonHighest = null;
  let topChampions = [];
  let isManual = false;

  try {
    // 1. puuid 조회
    const accountRes = await fetch(
      `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotName)}/${encodeURIComponent(riotTag)}`,
      { headers: { 'X-Riot-Token': key } }
    );
    if (!accountRes.ok) {
      return discordFollowup(appId, token, `❌ **${riotName}#${riotTag}** 소환사를 찾을 수 없습니다.`, env);
    }
    const account = await accountRes.json();
    puuid = account.puuid;
    name = account.gameName || riotName;
    tag = account.tagLine || riotTag;

    // 2. 소환사 정보
    const summonerRes = await fetch(
      `https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`,
      { headers: { 'X-Riot-Token': key } }
    );
    if (summonerRes.ok) {
      const summoner = await summonerRes.json();
      icon = String(summoner.profileIconId || '0');
      level = summoner.summonerLevel || 0;
    }

    // 3. 랭크 정보
    const leagueRes = await fetch(
      `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
      { headers: { 'X-Riot-Token': key } }
    );
    if (leagueRes.ok) {
      const entries = await leagueRes.json();
      const solo = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
      const flex  = entries.find(e => e.queueType === 'RANKED_FLEX_SR');
      prevSeasonHighest = solo?.highestTierAchieved || flex?.highestTierAchieved || null;
      if (solo && solo.tier) {
        soloTier = solo.tier;
        soloDivision = solo.rank || '';
        soloWins = solo.wins || 0;
        soloLosses = solo.losses || 0;
        soloLP = solo.leaguePoints || 0;
        tierStr = solo.tier;
        // tierFull: MASTER이상은 LP만, 나머지는 티어+디비전
        const isHigh = ['MASTER','GRANDMASTER','CHALLENGER'].includes(solo.tier);
        tierFull = isHigh
          ? `${solo.tier} ${solo.leaguePoints}LP`
          : `${solo.tier} ${solo.rank || ''} ${solo.leaguePoints}LP`.trim();
        highTier = tierFull;
      }
    }

    // 4. 딥롤에서 최고티어 조회
    try {
      const dlRes = await fetch(
        `https://b2c-api-cdn.deeplol.gg/summoner/summoner-realtime?platform_id=KR&puu_id=${encodeURIComponent(puuid)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.deeplol.gg/' } }
      );
      if (dlRes.ok) {
        const dlData = await dlRes.json();
        const dlSolo = dlData?.season_tier_info_dict?.ranked_solo_5x5;
        if (dlSolo?.tier) {
          const isHigh2 = ['MASTER','GRANDMASTER','CHALLENGER'].includes(dlSolo.tier);
          highTier = isHigh2
            ? `${dlSolo.tier} ${dlSolo.league_points||0}LP`
            : `${dlSolo.tier} ${dlSolo.division||''} ${dlSolo.league_points||0}LP`.trim();
        }
      }
    } catch(e) {}

    // 5. 모스트 챔피언
    try {
      const masteryRes = await fetch(
        `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top?count=3`,
        { headers: { 'X-Riot-Token': key } }
      );
      if (masteryRes.ok) {
        const champs = await masteryRes.json();
        topChampions = champs.map(c => ({
          championId: c.championId,
          masteryLevel: c.championLevel,
          masteryPoints: c.championPoints
        }));
      }
    } catch(e) {}

  } catch(e) {
    console.error('[joinDirect] summoner fetch error:', e.message);
    return discordFollowup(appId, token, `❌ 소환사 정보 조회 중 오류: ${e.message}`, env);
  }

  // 보조 포지션 정규화
  const subLanesMapped = Array.isArray(subLanesInput)
    ? subLanesInput.map(l => LANE_MAP[l] || l).filter(Boolean)
    : [];

  // 최고 티어 입력 시 처리
  let manualHighTier = null, manualHighDetail = '', manualHighFull = '';
  if (highTierInput) {
    // 단순화된 파싱: 앞 문자열(티어) + 뒷 숫자(division/LP) 분리
    // e3, d2, m300, gm500, p1, s2, b3, g1, c, u 등 모두 지원
    const inp = highTierInput.trim().toLowerCase();
    // gm 먼저 체크 (g가 골드이므로)
    const TIER_MAP = [
      ['gm', 'GRANDMASTER'], ['grandmaster', 'GRANDMASTER'], ['그랜드마스터', 'GRANDMASTER'], ['그랜드', 'GRANDMASTER'],
      ['challenger', 'CHALLENGER'], ['챌린저', 'CHALLENGER'], ['챌', 'CHALLENGER'], ['c', 'CHALLENGER'],
      ['master', 'MASTER'], ['마스터', 'MASTER'], ['m', 'MASTER'],
      ['diamond', 'DIAMOND'], ['다이아몬드', 'DIAMOND'], ['다이아', 'DIAMOND'], ['다', 'DIAMOND'], ['dia', 'DIAMOND'], ['d', 'DIAMOND'],
      ['emerald', 'EMERALD'], ['에메랄드', 'EMERALD'], ['에메', 'EMERALD'], ['em', 'EMERALD'], ['e', 'EMERALD'],
      ['platinum', 'PLATINUM'], ['플래티넘', 'PLATINUM'], ['플래', 'PLATINUM'], ['플', 'PLATINUM'], ['plat', 'PLATINUM'], ['pt', 'PLATINUM'], ['p', 'PLATINUM'],
      ['gold', 'GOLD'], ['골드', 'GOLD'], ['골', 'GOLD'], ['g', 'GOLD'],
      ['silver', 'SILVER'], ['실버', 'SILVER'], ['실', 'SILVER'], ['sv', 'SILVER'], ['s', 'SILVER'],
      ['bronze', 'BRONZE'], ['브론즈', 'BRONZE'], ['브', 'BRONZE'], ['br', 'BRONZE'], ['b', 'BRONZE'],
      ['iron', 'IRON'], ['아이언', 'IRON'], ['아', 'IRON'], ['ir', 'IRON'], ['i', 'IRON'],
      ['unranked', 'UNRANKED'], ['언랭크', 'UNRANKED'], ['언랭', 'UNRANKED'], ['ur', 'UNRANKED'], ['u', 'UNRANKED'],
    ];

    let parsedTier = null, rest = '';
    for (const [key, val] of TIER_MAP) {
      if (inp.startsWith(key)) {
        parsedTier = val;
        rest = inp.slice(key.length).trim();
        break;
      }
    }

    if (parsedTier) {
      manualHighTier = parsedTier;
      const isHighTier = ['MASTER','GRANDMASTER','CHALLENGER'].includes(parsedTier);
      const divMap = {'1':'I','2':'II','3':'III','4':'IV','i':'I','ii':'II','iii':'III','iv':'IV'};
      if (isHighTier) {
        const lpVal = rest.replace(/[^0-9]/g, '');
        manualHighDetail = lpVal ? lpVal + 'LP' : '';
        soloLP = parseInt(lpVal) || soloLP;
      } else {
        manualHighDetail = divMap[rest] || (rest ? rest.toUpperCase() : '');
      }
      manualHighFull = parsedTier + (manualHighDetail ? ' ' + manualHighDetail : '');
      tierStr = parsedTier;
      tierFull = manualHighFull;
      soloTier = parsedTier;
      soloDivision = manualHighDetail;
      isManual = true;
    }
  }


  // index.html의 addMember와 동일한 멤버 구조
  const newMember = {
    id: Date.now(),
    name, tag, icon, level, puuid,
    tier: tierStr,
    tierFull,
    mainLane,         // 소문자: top, jg, mid, bot, sup
    subLane: subLanesMapped,
    highTier: (manualHighTier ? manualHighFull : null) || highTier || null,
    highLp,
    prevSeasonHighest,
    present: false,
    soloWins, soloLosses, soloLP,
    soloTier, soloDivision,
    isManual,
    manualDetail: manualHighDetail || '',
    topChampions,
    discordId: discordUserId,
    discordName,
    joinedAt: Date.now(),
  };

  const updatedMembers = [...existingMembers, newMember];
  console.log('[joinDirect] saving member:', name, tag, tierStr, 'total:', updatedMembers.length);

  // _members 경로만 직접 PUT (버전 충돌 없이 반영)
  const patchRes = await fetch(`${dbUrl}/communities/${cid}/matches/${matchId}/_members.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedMembers)
  });
  console.log('[joinDirect] put status:', patchRes.status);

  const TIER_EMOJI = {CHALLENGER:'🏆',GRANDMASTER:'💎',MASTER:'💜',DIAMOND:'💠',EMERALD:'💚',PLATINUM:'🩵',GOLD:'🥇',SILVER:'⚪',BRONZE:'🟤',IRON:'⬛',UNRANKED:'❓'};
  const LANE_EMOJI = {top:'🛡️',jg:'🌲',mid:'⚡',bot:'🏹',sup:'🌟'};
  const subText = subLanesMapped.length
    ? `\n${subLanesMapped.map(l=>({top:'🛡️',jg:'🌲',mid:'⚡',bot:'🏹',sup:'🌟'}[l]||'🎮')).join('')} 보조: **${subLanesMapped.join(', ')}**`
    : '';

  // 완료 메시지
  const origSoloTier = `${soloTier}${soloDivision&&!isManual?' '+soloDivision:''} ${soloLP&&!isManual?soloLP+'LP':''}`.trim();

  return discordFollowup(appId, token,
    `✅ **${name}#${tag}** 참가 완료!\n` +
    `${TIER_EMOJI[tierStr]||'❓'} 설정 티어: **${tierFull}**\n` +
    `${manualHighTier ? `🏅 최고/임시 티어 (수동): **${manualHighFull}**\n` : `📊 현재 솔랭: **${origSoloTier||'언랭크'}**\n`}` +
    `${{top:'🛡️',jg:'🌲',mid:'⚡',bot:'🏹',sup:'🌟'}[mainLane]||'🎮'} 주 포지션: **${mainLane}**${subText}\n` +
    `📋 내전: **${matchData.name || matchId}**\n` +
    `👥 현재 대기 멤버: ${updatedMembers.length}명`, env);
}


// ── 내전 나가기 ──
async function handleLeaveMatch(cid, matchId, discordUserId, appId, token, env) {
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';

  const matchRes = await fetch(`${dbUrl}/communities/${cid}/matches/${matchId}.json${authQ}`);
  const matchData = await matchRes.json();
  if (!matchData) return discordFollowup(appId, token, '❌ 내전 정보를 불러올 수 없습니다.', env);

  // 빼기 불가 체크
  if (matchData.discordLeaveDisabled) {
    return discordFollowup(appId, token, '❌ 현재 이 내전은 빼기가 불가능합니다. 관리자에게 문의해주세요.', env);
  }

  const existingMembers = Array.isArray(matchData._members)
    ? matchData._members
    : Object.values(matchData._members || {});

  const memberToLeave = existingMembers.find(m => m.discordId && m.discordId === discordUserId);
  if (!memberToLeave) {
    return discordFollowup(appId, token, '❌ 참가 중인 내전이 아닙니다.', env);
  }

  const updatedMembers = existingMembers.filter(m => m.discordId !== discordUserId);

  const patchRes = await fetch(`${dbUrl}/communities/${cid}/matches/${matchId}/_members.json${authQ}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedMembers)
  });

  if (!patchRes.ok) return discordFollowup(appId, token, '❌ 처리 중 오류가 발생했습니다.', env);

  return discordFollowup(appId, token,
    `✅ **${memberToLeave.name}#${memberToLeave.tag}** 내전 참가가 취소되었습니다.\n` +
    `📋 내전: **${matchData.name || matchId}**\n` +
    `👥 남은 멤버: ${updatedMembers.length}명`, env);
}

// ── 행 이펙트 저장 ──
async function handleRowEffectWrite(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, puuId, effect, type } = body;
  if (!communityId || !puuId) return json({ok:false,error:'필수 파라미터 없음'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const collection = type === 'bg' ? 'bg_effects' : 'row_effects';
  if (effect) {
    await fetch(`${dbUrl}/communities/${communityId}/${collection}/${puuId}.json${authQ}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(effect)
    });
  } else {
    await fetch(`${dbUrl}/communities/${communityId}/${collection}/${puuId}.json${authQ}`, {
      method: 'DELETE'
    });
  }
  return json({ ok: true });
}

// ══════════════════════════════
// 어드민 API
// ══════════════════════════════

async function requireMaster(request, env) {
  let body; try { body = await request.json(); } catch { return [null, json({ok:false,error:'bad request'},400)]; }
  // 1. 메모리 세션 체크
  const session = getSession(body.token);
  if (session && session.role === 'master') return [body, null];
  // 2. 세션 만료 시 토큰으로 Firebase superadmin 재검증
  // 토큰은 "id:pwHash" base64 형태로 저장 (admin.html에서 발급)
  if (body.token && body.token.startsWith('master:')) {
    const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
    const authQ = secret ? '?auth='+secret : '';
    const parts = body.token.split(':');
    if (parts.length >= 3) {
      const adminId = parts[1];
      const pwHash  = parts.slice(2).join(':');
      const res = await fetch(`${dbUrl}/superadmin.json${authQ}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.id === adminId && data.password === pwHash) {
          // 재발급
          issueSession(adminId, { role: 'master' });
          return [body, null];
        }
      }
    }
  }
  return [null, json({ok:false,error:'마스터 권한 필요'},403)];
}

// 운영진 목록
async function handleAdminList(request, env) {
  const [body, err] = await requireMaster(request, env);
  if (err) return err;
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const res = await fetch(`${dbUrl}/admin.json${authQ}`);
  const data = await res.json() || {};
  // id, role, communityId만 반환 (pw 제외)
  const list = Object.entries(data).map(([id, info]) => ({
    id, role: info.role || 'admin', communityId: info.communityId || null, lastLogin: info.lastLogin || null
  }));
  return json({ ok: true, data: list });
}

// 운영진 추가
async function handleAdminAdd(request, env) {
  const [body, err] = await requireMaster(request, env);
  if (err) return err;
  const { adminId, adminPw, role, communityId } = body;
  if (!adminId || !adminPw) return json({ok:false,error:'ID/PW 필수'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  // 비밀번호 해시
  const pwBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(adminPw));
  const pwHex = Array.from(new Uint8Array(pwBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  await fetch(`${dbUrl}/admin/${adminId}.json${authQ}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ id: adminId, pw: pwHex, role: role||'admin', communityId: communityId||null, createdAt: Date.now() })
  });
  return json({ ok: true });
}

// 운영진 제거
async function handleAdminRemove(request, env) {
  const [body, err] = await requireMaster(request, env);
  if (err) return err;
  const { targetId } = body;
  if (!targetId) return json({ok:false,error:'targetId 필수'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  // 마스터 계정은 제거 불가
  const res = await fetch(`${dbUrl}/admin/${targetId}.json${authQ}`);
  const data = await res.json();
  if (data?.role === 'master') return json({ok:false,error:'마스터 계정은 제거 불가'},403);
  await fetch(`${dbUrl}/admin/${targetId}.json${authQ}`, { method: 'DELETE' });
  return json({ ok: true });
}

// 비밀번호 변경
async function handleAdminChangePw(request, env) {
  const [body, err] = await requireMaster(request, env);
  if (err) return err;
  const { newPw } = body;
  if (!newPw) return json({ok:false,error:'newPw 필수'},400);
  // 세션에서 adminId 가져오기
  const session = getSession(body.token);
  const adminId = session?.id;
  if (!adminId) return json({ok:false,error:'세션 오류'},403);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  const pwBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(newPw));
  const pwHex = Array.from(new Uint8Array(pwBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  await fetch(`${dbUrl}/admin/${adminId}/pw.json${authQ}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(pwHex)
  });
  return json({ ok: true });
}

// 시스템 설정 저장
async function handleSystemSettingWrite(request, env) {
  const [body, err] = await requireMaster(request, env);
  if (err) return err;
  const { field, value } = body;
  if (!field) return json({ok:false,error:'field 필수'},400);
  const allowed = ['maintenance','allowSignup','publicList','notice'];
  if (!allowed.includes(field)) return json({ok:false,error:'허용되지 않은 필드'},400);
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';
  await fetch(`${dbUrl}/system/${field}.json${authQ}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(value)
  });
  return json({ ok: true });
}

// ── /내전승률 ──
async function handleMatchWinRate(interaction, env) {
  const guildId   = interaction.guild_id;
  const channelId = interaction.channel_id;
  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';

  // 커뮤니티 찾기
  const ciRes = await fetch(`${dbUrl}/communities_info.json${authQ}`);
  const ciData = await ciRes.json() || {};
  let targetCid = null, deeplolServerId = null;
  for (const [cid, info] of Object.entries(ciData)) {
    if (info && (
      String(info.discordServerId)  === String(guildId) ||
      String(info.discordChannelId) === String(channelId)
    )) {
      targetCid = cid;
      deeplolServerId = info.deeplolServerId || null;
      break;
    }
  }

  if (!targetCid || !deeplolServerId) {
    return discordReply('❌ 이 서버와 연결된 커뮤니티를 찾을 수 없습니다.\n관리자에게 서버 ID 설정을 요청하세요.', true);
  }

  const statsUrl = `https://roonging.com/stats?server_id=${deeplolServerId}&cid=${targetCid}`;

  return new Response(JSON.stringify({
    type: 4,
    data: {
      content: '📊 **내전 전적 페이지**\n아래 버튼을 눌러 커뮤니티 내전 승률을 확인하세요.',
      components: [{
        type: 1,
        components: [{
          type: 2, style: 5,
          label: '🔗 내전 전적 보기',
          url: statsUrl
        }]
      }],
      flags: 64
    }
  }), { headers: { 'Content-Type': 'application/json' } });
}

// ── 디스코드 채널 호출 ──
async function handleDiscordNotify(request, env) {
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad request'},400); }
  const { communityId, discordIds, message } = body;
  if (!communityId || !discordIds?.length || !message) return json({ok:false,error:'필수 파라미터 없음'},400);

  const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  if (!BOT_TOKEN) return json({ok:false,error:'BOT_TOKEN 없음'},500);

  const dbUrl = env.FB_DATABASE_URL, secret = env.FB_DB_SECRET;
  const authQ = secret ? '?auth='+secret : '';

  // 커뮤니티에서 notifyChannelId 조회
  const ciRes = await fetch(`${dbUrl}/communities_info/${communityId}.json${authQ}`);
  const ciData = await ciRes.json();
  const channelId = ciData?.discordNotifyChannelId;
  if (!channelId) return json({ok:false,error:'내전 모임 메세지 채널 ID가 설정되지 않았습니다. 커뮤니티 설정에서 채널 ID를 입력해주세요.'},400);

  // 멘션 문자열 생성
  const mentions = discordIds.map(id => `<@${id}>`).join(' ');
  const fullMessage = `${mentions}\n${message}`;

  // 채널에 메시지 전송
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content: fullMessage })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[discord-notify] error:', res.status, err);
    return json({ok:false,error:`디스코드 전송 실패 (${res.status})`},500);
  }

  return json({ ok: true });
}
