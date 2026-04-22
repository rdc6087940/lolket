const functions = require('firebase-functions/v2/https');
const https     = require('https');

// .env 파일 또는 Firebase Secret에서 API Key 읽기
const RIOT_API_KEY = process.env.RIOT_API_KEY || 'YOUR_RIOT_API_KEY';

const REGIONS = {
  KR:  { platform: 'kr',   regional: 'asia'     },
  NA:  { platform: 'na1',  regional: 'americas' },
  EUW: { platform: 'euw1', regional: 'europe'   },
  JP:  { platform: 'jp1',  regional: 'asia'     },
};

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

function riotGet(host, path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: host,
      path: path,
      headers: { 'X-Riot-Token': RIOT_API_KEY },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { reject(new Error('파싱 실패: ' + data)); }
      });
    }).on('error', reject);
  });
}

exports.riotProxy = functions.onRequest(
  { region: 'asia-northeast3', cors: true },
  async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const { gameName, tagLine, region = 'KR' } = req.query;
    if (!gameName || !tagLine) {
      res.status(400).json({ error: 'gameName, tagLine 파라미터 필요' });
      return;
    }

    const r = REGIONS[region.toUpperCase()] || REGIONS.KR;

    try {
      // 1. Account v1 → puuid
      const accountResp = await riotGet(
        `${r.regional}.api.riotgames.com`,
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
      );
      if (accountResp.status !== 200) {
        res.status(accountResp.status).json({ error: '소환사를 찾을 수 없습니다', detail: accountResp.data });
        return;
      }
      const { puuid } = accountResp.data;

      // 2. Summoner v4 → 소환사 정보
      const summonerResp = await riotGet(
        `${r.platform}.api.riotgames.com`,
        `/lol/summoner/v4/summoners/by-puuid/${puuid}`
      );
      if (summonerResp.status !== 200) {
        res.status(summonerResp.status).json({ error: '소환사 정보 조회 실패', detail: summonerResp.data });
        return;
      }
      const summoner = summonerResp.data;

      // 3. League v4 → 랭크 정보
      const leagueResp = await riotGet(
        `${r.platform}.api.riotgames.com`,
        `/lol/league/v4/entries/by-summoner/${summoner.id}`
      );
      const entries = leagueResp.status === 200 ? leagueResp.data : [];

      const soloEntry = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
      const flexEntry = entries.find(e => e.queueType === 'RANKED_FLEX_SR');

      const formatRank = e => {
        if (!e) return 'UNRANKED';
        if (['MASTER','GRANDMASTER','CHALLENGER'].includes(e.tier))
          return `${e.tier} ${e.leaguePoints}LP`;
        return `${e.tier} ${e.rank} ${e.leaguePoints}LP`;
      };

      res.status(200).json({
        name:  accountResp.data.gameName,
        tag:   accountResp.data.tagLine,
        level: summoner.summonerLevel,
        icon:  summoner.profileIconId,
        puuid,
        solo:  formatRank(soloEntry),
        flex:  formatRank(flexEntry),
      });

    } catch(e) {
      console.error('riotProxy 오류:', e);
      res.status(500).json({ error: '서버 오류', detail: e.message });
    }
  }
);
