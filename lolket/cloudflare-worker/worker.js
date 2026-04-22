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
    const key  = env.RIOT_API_KEY;

    // Riot 앱 인증
    if (path === '/riot.txt') {
      return new Response('e8781c6a-562d-45db-903d-d54ad00da76c', {
        status: 200, headers: { 'Content-Type': 'text/plain', ...CORS },
      });
    }

    if (!key) return json({ error: 'RIOT_API_KEY 환경변수가 설정되지 않았습니다' }, 500);

    if (path === '/' || path === '')    return handleSummoner(url, key);
    if (path === '/match')              return handleMatch(url, key);
    if (path === '/recent-custom')      return handleRecentCustom(url, key);
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

// ══ puuid 목록으로 최근 커스텀 게임 Match ID 검색 ══
// queueId=0 = 커스텀(사용자 설정) 게임
// ?puuids=puuid1,puuid2,...&region=KR
async function handleRecentCustom(url, key) {
  const puuidsParam = url.searchParams.get('puuids');
  const region      = (url.searchParams.get('region') || 'KR').toUpperCase();
  if (!puuidsParam) return json({ error: 'puuids 파라미터 필요' }, 400);

  const puuids = puuidsParam.split(',').filter(Boolean).slice(0, 10); // 최대 10명
  const r = REGIONS[region] || REGIONS.KR;

  try {
    // 각 멤버의 최근 커스텀 게임 목록 병렬 조회
    const results = await Promise.all(puuids.map(async puuid => {
      const res = await riotFetch(
        // queueId=0: 커스텀, count=5: 최근 5경기
        `https://${r.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=0&count=5`,
        key
      );
      if (!res.ok) return [];
      return await res.json();
    }));

    // 모든 멤버의 매치 ID 합치기
    const allIds = results.flat();
    if (allIds.length === 0) {
      return json({ error: '최근 커스텀 게임을 찾을 수 없습니다', matchIds: [] }, 404);
    }

    // 여러 멤버에게 공통으로 나타나는 Match ID (같은 게임에 참여) 우선순위
    const idCount = {};
    allIds.forEach(id => { idCount[id] = (idCount[id] || 0) + 1; });

    // 공통 매치 내림차순 정렬 (같은 게임 참여자 많을수록 앞)
    const sorted = Object.entries(idCount)
      .sort((a, b) => b[1] - a[1] || 0)
      .map(([id]) => id);

    // 상위 5개 반환
    return json({ matchIds: sorted.slice(0, 5), counts: idCount });
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
