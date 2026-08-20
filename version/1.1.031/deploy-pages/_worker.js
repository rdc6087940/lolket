const CRAWLERS = ['Twitterbot','facebookexternalhit','LinkedInBot','Slackbot','TelegramBot',
  'Discordbot','KakaoTalk','WhatsApp','Line','Googlebot','bingbot','Yeti'];

function isCrawler(ua) {
  if (!ua) return false;
  return CRAWLERS.some(c => ua.toLowerCase().includes(c.toLowerCase()));
}

const COMMUNITY_OG = {
  'c_1786029938203': {
    image: 'https://roonging.com/og-hyeokgo.png',
    title: '협곡 지통실 전적',
    description: '협곡 지통실 LoL 내전 전적 페이지'
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /stats 요청만 처리
    if (path === '/stats' || path === '/stats.html') {
      const ua = request.headers.get('User-Agent') || '';
      if (isCrawler(ua)) {
        const cid = url.searchParams.get('cid') || '';
        const serverId = url.searchParams.get('server_id') || '';
        const og = COMMUNITY_OG[cid];
        const ogImage = og ? og.image : 'https://roonging.com/og-banner.jpg';
        const ogTitle = og ? og.title : '룽잉닷컴 — LoL 내전 전적';
        const ogDesc = og ? og.description : '내전 전적, 레이팅, 챔피언 통계를 확인하세요';
        const pageUrl = 'https://roonging.com/stats?server_id=' + serverId + '&cid=' + cid;

        return new Response(`<!DOCTYPE html>
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
<meta name="twitter:image" content="${ogImage}">
<meta http-equiv="refresh" content="0; url=${pageUrl}">
<title>${ogTitle}</title>
</head>
<body><script>location.replace('${pageUrl}');</script></body>
</html>`, {
          headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=3600' }
        });
      }
    }

    // 나머지는 그대로 서빙
    return env.ASSETS.fetch(request);
  }
};
