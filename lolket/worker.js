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
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url  = new URL(request.url);
    const path = url.pathname;

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

  // match_alarms에서 notified=false 전체 조회
  const res = await fetch(dbUrl + '/match_alarms.json' + authQ);
  if (!res.ok) return;
  const data = await res.json();
  if (!data) return;

  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  const targets = Object.values(data).filter(a => {
    if (!a || !a.matchId || a.notified) return false;
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
  const { path: dbPath } = body;
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
  ];
  if (!publicRead.some(r => r.test(dbPath))) {
    return json({ ok: false, error: '허용되지 않는 경로입니다' }, 403);
  }

  const dbUrl  = env.FB_DATABASE_URL;
  const secret = env.FB_DB_SECRET;
  const authQ  = secret ? `?auth=${secret}` : '';
  try {
    const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}`);
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

  const { path: dbPath } = body;
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
    const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}`);
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

    // 1. 매치 데이터 조회 (captainCodes + 전체 정보)
    const matchRes = await fetch(`${dbUrl}/communities/${communityId}/matches/${matchId}.json${authQ}`);
    const matchData = await matchRes.json();
    if (!matchData) return json({ ok: false, error: '내전 데이터 없음' }, 404);

    // 2. 팀장 코드 검증 - captainCodes 필드 또는 _teams에서 직접 확인
    let codeData = null;
    // captainCodes 필드에서 먼저 확인
    if (matchData.captainCodes && matchData.captainCodes[captainCode]) {
      codeData = matchData.captainCodes[captainCode];
    }
    // _teams에서 직접 확인 (fallback)
    if (!codeData && matchData._teams) {
      const teamsArr = Array.isArray(matchData._teams) ? matchData._teams : Object.values(matchData._teams);
      const foundTeam = teamsArr.find(t => t && t.captainCode === captainCode);
      if (foundTeam) {
        const membersList = Array.isArray(matchData._members) ? matchData._members : Object.values(matchData._members || {});
        const cap = membersList.find(m => m.id === foundTeam.captainId);
        const tName = cap ? cap.name + '팀' : (foundTeam.name || ('팀' + foundTeam.id));
        codeData = { teamId: foundTeam.id, teamName: tName, captainName: cap ? cap.name : '팀장' };
      }
    }
    if (!codeData) return json({ ok: false, error: '유효하지 않은 코드' }, 403);

    // 3. 호가 종료 체크
    if (matchData._bidLocked) return json({ ok: false, error: '호가가 종료됐습니다' }, 400);

    // 4. 잔여 포인트 체크
    const teamsArr = Array.isArray(matchData._teams) ? matchData._teams : Object.values(matchData._teams || {});
    const myTeam = teamsArr.find(t => t.id == teamId);
    if (myTeam && myTeam.points != null && amount > myTeam.points) {
      return json({ ok: false, error: `잔여 포인트(${myTeam.points}pt) 초과` }, 400);
    }

    // 5. Firebase ETag 기반 조건부 업데이트 (동시 호가 충돌 방지)
    // _bidLeader를 ETag와 함께 읽어서 변경이 없을 때만 PUT
    const bidLeaderUrl = `${dbUrl}/communities/${communityId}/matches/${matchId}/_bidLeader.json${authQ}`;
    
    // ETag 읽기
    const getRes = await fetch(bidLeaderUrl, { headers: { 'X-Firebase-ETag': 'true' } });
    const etag = getRes.headers.get('ETag');
    const currentBidLeader = await getRes.json();
    
    // 다시 한번 최고가 확인 (ETag 읽기 시점 기준)
    const currentMax = (currentBidLeader && currentBidLeader.price) || 0;
    if (amount <= currentMax) {
      return json({ ok: false, error: `현재 최고가(${currentMax}pt)보다 높아야 합니다` }, 400);
    }

    // ETag 조건부 PUT - 다른 호가가 먼저 들어왔으면 412 반환
    const bidLeader = { 
      price: amount, 
      team: teamName || codeData.teamName, 
      teamId: codeData.teamId || teamId, 
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
    const onSale = matchData._onSaleMember;
    const onSaleName = (onSale && onSale.name) ? onSale.name : '?';
    const logEntry = { id: logId, type: 'bid', text: onSaleName + ' — ' + (codeData.teamName || teamName || '') + ' ' + amount + 'pt', ts: Date.now() };
    const logUrl = `${dbUrl}/communities/${communityId}/matches/${matchId}/auctionLog/${logId}.json${authQ}`;
    const logRes = await fetch(logUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logEntry)
    });
    const logResText = await logRes.text();
    console.log('[BID-LOG]', logUrl.replace(secret||'','***'), '→', logRes.status, logResText.slice(0,80));

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

  const res = await fetch(`${dbUrl}/${path}.json${authQ}`);
  if (!res.ok) return json({ ok: true, data: {} });
  const data = await res.json();
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
