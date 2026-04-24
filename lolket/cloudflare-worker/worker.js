const REGIONS = {
  KR:  { platform: 'kr',   regional: 'asia'     },
  NA:  { platform: 'na1',  regional: 'americas' },
  EUW: { platform: 'euw1', regional: 'europe'   },
  JP:  { platform: 'jp1',  regional: 'asia'     },
};
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

    // 관리자 이메일 반환 (환경변수에서 로드)
    if (path === '/contact-info') {
      return new Response(JSON.stringify({ email: env.ADMIN_EMAIL || '' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // 비밀번호 솔트 반환 (환경변수에서 로드)
    if (path === '/auth-salt') {
      return new Response(JSON.stringify({ salt: env.PW_SALT || '' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // Firebase 설정 반환 (환경변수에서 로드)
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
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // Riot API 키 필요한 엔드포인트
    const key = env.RIOT_API_KEY;
    if (!key) return json({ error: 'RIOT_API_KEY 환경변수가 설정되지 않았습니다' }, 500);

    if (path === '/' || path === '')   return handleSummoner(url, key);
    if (path === '/match')             return handleMatch(url, key);
    if (path === '/recent-custom')     return handleRecentCustom(url, key);
    return json({ error: '알 수 없는 경로' }, 404);
  }
};

// ══ 소환사 검색 ══
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
    return json({
      name: account.gameName, tag: account.tagLine,
      level: summoner.summonerLevel, icon: summoner.profileIconId,
      puuid, solo: formatRank(solo), flex: formatRank(flex),
    });
  } catch(e) { return json({ error: '서버 오류', detail: e.message }, 500); }
}

// ══ Match ID로 게임 상세 조회 ══
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

// ══ 최근 커스텀(사용자 설정) 게임 검색 ══
// 전략:
// 1. 첫 번째 puuid로 최근 커스텀 게임 목록 조회 (queue=0)
// 2. 각 게임 상세를 조회해서 10인 참여 게임만 필터 (내전 기준)
// 3. 나머지 puuid들과 공통 여부 계산
async function handleRecentCustom(url, key) {
  const puuidsParam = url.searchParams.get('puuids');
  const region      = (url.searchParams.get('region') || 'KR').toUpperCase();
  const minPlayers  = parseInt(url.searchParams.get('minPlayers') || '10');
  if (!puuidsParam) return json({ error: 'puuids 파라미터 필요' }, 400);

  const puuids = puuidsParam.split(',').filter(Boolean).slice(0, 10);
  const r = REGIONS[region] || REGIONS.KR;

  try {
    // Step1: 모든 멤버의 커스텀 게임 ID 수집 (queue=0, count=20)
    const allResults = await Promise.all(puuids.map(async puuid => {
      const res = await riotFetch(
        `https://${r.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=0&count=20`,
        key
      );
      if (!res.ok) return [];
      return await res.json();
    }));

    // Step2: Match ID 등장 횟수 카운트
    const idCount = {};
    allResults.forEach(ids => {
      ids.forEach(id => { idCount[id] = (idCount[id] || 0) + 1; });
    });

    if (Object.keys(idCount).length === 0) {
      return json({ error: '최근 커스텀 게임을 찾을 수 없습니다', matchIds: [], counts: {} }, 404);
    }

    // Step3: 공통 인원 많은 순으로 정렬, 상위 15개 후보
    const candidates = Object.entries(idCount)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .slice(0, 15);

    // Step4: 각 게임 상세 조회 — 참여 인원수 확인 (10인 = 사용자 설정 내전)
    const details = await Promise.all(candidates.map(async matchId => {
      const res = await riotFetch(
        `https://${r.regional}.api.riotgames.com/lol/match/v5/matches/${enc(matchId)}`, key);
      if (!res.ok) return { matchId, valid: false };
      const data = await res.json();
      const participantCount = (data.info?.participants || []).length;
      // 10인 게임만 내전으로 간주 (minPlayers 파라미터로 조정 가능)
      const valid = participantCount >= minPlayers;
      return { matchId, valid, participantCount, gameCreation: data.info?.gameCreation || 0 };
    }));

    // Step5: 유효한 게임만 필터, 최신순 정렬
    const validMatches = details
      .filter(d => d.valid)
      .sort((a, b) => b.gameCreation - a.gameCreation)
      .map(d => d.matchId);

    if (validMatches.length === 0) {
      // 10인 게임이 없으면 참여 인원 상관없이 커스텀 게임 전체 반환
      const allCustom = candidates.slice(0, 10);
      return json({
        matchIds: allCustom,
        counts: idCount,
        total: puuids.length,
        note: '10인 게임을 찾지 못해 전체 커스텀 게임을 반환합니다',
      });
    }

    return json({
      matchIds: validMatches.slice(0, 10),
      counts: idCount,
      total: puuids.length,
    });

  } catch(e) {
    return json({ error: '서버 오류', detail: e.message }, 500);
  }
}

function riotFetch(url, key) {
  return fetch(url, { headers: { 'X-Riot-Token': key } });
}
function enc(s) { return encodeURIComponent(s); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function formatRank(e) {
  if (!e) return 'UNRANKED';
  if (['MASTER','GRANDMASTER','CHALLENGER'].includes(e.tier))
    return `${e.tier} ${e.leaguePoints}LP`;
  return `${e.tier} ${e.rank} ${e.leaguePoints}LP`;
}
