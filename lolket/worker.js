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
  }
};

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

// ══ DB 읽기 프록시 (마스터 세션 필요) ══
async function handleDbRead(request, env) {
  const token = request.headers.get('X-Session-Token');
  const session = getSession(token);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '잘못된 요청' }, 400); }

  const { path: dbPath } = body;
  if (!dbPath) return json({ ok: false, error: 'path 누락' }, 400);

  // 마스터만 읽기 가능한 경로
  const masterRead = [
    /^applies/,
    /^superadmin/,
    /^admin\//,
  ];
  if (!masterRead.some(r => r.test(dbPath))) {
    return json({ ok: false, error: '읽기 권한이 없습니다' }, 403);
  }
  if (!session || session.role !== 'master') {
    return json({ ok: false, error: '마스터 권한이 필요합니다' }, 403);
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
    const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) return json({ ok: false, error: 'DB 쓰기 실패: ' + res.status }, 500);

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
  ];
  if (publicWrite.some(r => r.test(dbPath))) return true;

  // 이하 모두 로그인 필요
  if (!session) return false;

  // 마스터 전용 경로
  const masterWrite = [
    /^communities_info\//,
    /^invite_codes\//,
    /^admin\//,
    /^notices\//,
    /^applies\/[^/]+\/status$/,  // 신청 상태 변경
    /^system\//,                 // 점검 모드 등 시스템 설정
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
  const region   = (url.searchParams.get('region') || 'KR').toUpperCase();
  if (!gameName || !tagLine) return json({ error: 'gameName, tagLine 파라미터 필요' }, 400);
  const r = REGIONS[region] || REGIONS.KR;
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
    return json({ name: account.gameName, tag: account.tagLine, level: summoner.summonerLevel,
      icon: summoner.profileIconId, puuid, solo: formatRank(solo), flex: formatRank(flex) });
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
