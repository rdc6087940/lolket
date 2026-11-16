// v_debug_03

// stats 페이지용 OG
const STATS_OG = {
  'c_1786029938203': { image: 'https://roonging.com/og-hyeokgo.png', title: '협곡 지통실 전적', desc: '협곡 지통실 LoL 내전 전적 페이지' },
  'c_1778500089386': { image: 'https://roonging.com/og-banner.jpg',  title: '롤하냥 내전전적', desc: '내전 전적 | 통계 | 분석 플랫폼' },
  'c_1792039312075': { image: 'https://roonging.com/og-rolhaejo.png', title: '롤해조 내전 전적', desc: '롤 내전 커뮤니티 No.1 롤해조의 내전 전적 페이지입니다.' },
};

// ranking 페이지용 OG
const RANKING_OG = {
  'c_1792039312075': { image: 'https://roonging.com/og-rolhaejo.png', title: '롤해조 주간 랭킹', desc: '롤 내전 커뮤니티 No.1 롤해조의 주간 랭킹 페이지입니다.' },
};

function buildOgHtml(ogImage, ogTitle, ogDesc, pageUrl, cid) {
  return '<!DOCTYPE html><html><head>' +
    '<meta charset="UTF-8">' +
    '<meta property="og:type" content="website">' +
    '<meta property="og:url" content="' + pageUrl + '">' +
    '<meta property="og:title" content="' + ogTitle + '">' +
    '<meta property="og:description" content="' + ogDesc + '">' +
    '<meta property="og:image" content="' + ogImage + '">' +
    '<meta property="og:image:width" content="1200">' +
    '<meta property="og:image:height" content="630">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<meta name="twitter:title" content="' + ogTitle + '">' +
    '<meta name="twitter:description" content="' + ogDesc + '">' +
    '<meta name="twitter:image" content="' + ogImage + '">' +
    '<title>' + ogTitle + '</title>' +
    '</head><body>' +
    '<!-- OG debug: cid=' + cid + ' image=' + ogImage + ' -->' +
    '<script>location.href="' + pageUrl + '";</script></body></html>';
}

async function injectOgTags(originalResponse, ogImage, ogTitle, ogDesc, cid) {
  let html = await originalResponse.text();
  const ogTags =
    '<meta property="og:title" content="' + ogTitle + '">\n' +
    '<meta property="og:description" content="' + ogDesc + '">\n' +
    '<meta property="og:image" content="' + ogImage + '">\n' +
    '<meta property="og:image:width" content="1200">\n' +
    '<meta property="og:image:height" content="630">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta name="twitter:title" content="' + ogTitle + '">\n' +
    '<meta name="twitter:description" content="' + ogDesc + '">\n' +
    '<meta name="twitter:image" content="' + ogImage + '">\n' +
    '<!-- OG debug: cid=' + cid + ' image=' + ogImage + ' -->\n';

  // 기존 og:title, og:image 태그 교체
  html = html.replace(/<meta property="og:title"[^>]*>/g, '');
  html = html.replace(/<meta property="og:description"[^>]*>/g, '');
  html = html.replace(/<meta property="og:image"[^>]*/g, '');
  html = html.replace(/<meta name="twitter:card"[^>]*>/g, '');
  html = html.replace(/<meta name="twitter:title"[^>]*>/g, '');
  html = html.replace(/<meta name="twitter:description"[^>]*>/g, '');
  html = html.replace(/<meta name="twitter:image"[^>]*>/g, '');

  // <head> 바로 뒤에 삽입
  html = html.replace('<head>', '<head>\n' + ogTags);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-cache,no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cid = url.searchParams.get('cid') || '';
    const serverId = url.searchParams.get('server_id') || '';

    // /stats
    if (path === '/stats' || path === '/stats.html') {
      const og = STATS_OG[cid];
      if (og) {
        const pageUrl = 'https://roonging.com/stats?server_id=' + serverId + '&cid=' + cid;
        return new Response(buildOgHtml(og.image, og.title, og.desc, pageUrl, cid), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache,no-store' }
        });
      }
      return env.ASSETS.fetch(request);
    }

    // /ranking
    if (path === '/ranking' || path === '/ranking.html') {
      const og = RANKING_OG[cid];
      if (og) {
        const pageUrl = 'https://roonging.com/ranking?cid=' + cid + '&server_id=' + serverId;
        const assetResponse = await env.ASSETS.fetch(request);
        return injectOgTags(assetResponse, og.image, og.title, og.desc, cid);
      }
      return env.ASSETS.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
