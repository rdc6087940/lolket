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
const _sessions = new Map();
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
  if (Date.now() - s.createdAt > SESSION_TTL) { _sessions.delete(token); return null; }
  return s;
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
      const token = genToken();
      _sessions.set(token, { role: 'master', id, createdAt: Date.now() });
      return json({ ok: true, role: 'master', token });
    }

    if (type === 'admin') {
      const res  = await fetch(`${dbUrl}/admin/${encodeURIComponent(id)}.json${authQ}`);
      if (!res.ok) return json({ ok: false, error: 'DB 조회 실패: ' + res.status }, 500);
      const data = await res.json();
      if (!data) return json({ ok: false, error: '아이디 또는 비밀번호가 틀렸습니다' }, 401);
      if (!await verifyPw(pw, pwHash, data.password)) return json({ ok: false, error: '아이디 또는 비밀번호가 틀렸습니다' }, 401);
      const token = genToken();
      _sessions.set(token, { role: 'admin', id, communityId: data.communityId, createdAt: Date.now() });
      const { password: _pw, ...safe } = data;
      return json({ ok: true, role: 'admin', token, data: safe });
    }

    return json({ ok: false, error: '알 수 없는 type' }, 400);
  } catch (e) {
    return json({ ok: false, error: '서버 오류', detail: e.message }, 500);
  }
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
    // ── 버전 충돌 체크 (matches 경로만 적용) ──
    // data._version이 있고 matches 경로인 경우 현재 서버 버전과 비교
    const isMatchPath = /^communities\/[^/]+\/matches\/[^/]+$/.test(dbPath);
    if (isMatchPath && data && typeof data._version === 'number') {
      const currentRes = await fetch(`${dbUrl}/${dbPath}/_version.json${authQ}`);
      if (currentRes.ok) {
        const serverVersion = await currentRes.json();
        // 서버 버전이 존재하고 클라이언트 버전보다 높으면 충돌
        if (serverVersion !== null && typeof serverVersion === 'number' && data._version <= serverVersion) {
          return json({
            ok: false,
            error: 'CONFLICT',
            message: '다른 관리자가 이미 수정했습니다. 페이지를 새로고침 후 다시 시도하세요.',
            serverVersion,
            clientVersion: data._version,
          }, 409);
        }
      }
    }

    const res = await fetch(`${dbUrl}/${dbPath}.json${authQ}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) return json({ ok: false, error: 'DB 쓰기 실패: ' + res.status }, 500);
    return json({ ok: true });
  } catch(e) { return json({ ok: false, error: e.message }, 500); }
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
  ];
  if (publicWrite.some(r => r.test(dbPath))) return true;

  // 이하 모두 로그인 필요
  if (!session) return false;

  // 관리자 쓰기 허용 경로
  const adminWrite = [
    /^communities\/[^/]+\/matches/,  // 내전 데이터 (관리자)
  ];
  if (adminWrite.some(r => r.test(dbPath))) {
    if (session.role === 'master') return true;
    if (session.role === 'admin') {
      // 자신의 커뮤니티만 쓰기 가능
      const cidMatch = dbPath.match(/^communities\/([^/]+)\//);
      return cidMatch && cidMatch[1] === session.communityId;
    }
    return false;
  }

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
