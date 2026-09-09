// v_debug_01
const T_HYEOKGO = '\ud611\uace1 \uc9c0\ud1b5\uc2e4 \uc804\uc801';
const D_HYEOKGO = '\ud611\uace1 \uc9c0\ud1b5\uc2e4 LoL \ub0b4\uc804 \uc804\uc801';
const T_LOLHANG = '\ub864\ud558\ub0e5 \ub0b4\uc804\uc804\uc801';
const D_LOLHANG = '\ub0b4\uc804 \uc804\uc801 | \ud1b5\uacc4 | \ubd84\uc11d \ud50c\ub7ab\ud3fc';
const T_DEFAULT = '\ub889\uc78b\ub2f7\ucef4 \uc804\uc801 \uc0ac\uc774\ud2b8';
const D_DEFAULT = 'LoL \ub0b4\uc804 \uc804\uc801 \ud1b5\uacc4 \ud50c\ub7ab\ud3fc';

export default {
  async fetch(request, env) {
    // 1. Worker 실행 확인
    console.log('[OG] worker executed, url:', request.url);

    const url = new URL(request.url);
    const path = url.pathname;
    const cid = url.searchParams.get('cid') || '';
    const serverId = url.searchParams.get('server_id') || '';
    const ua = request.headers.get('User-Agent') || '';

    console.log('[OG] path:', path, 'cid:', cid, 'ua:', ua.slice(0,50));

    // 2. /stats 분기 확인
    if (path === '/stats' || path === '/stats.html') {
      console.log('[OG] entered /stats branch');

      let ogImage, ogTitle, ogDesc;

      // 3. cid 분기 확인
      if (cid === 'c_1786029938203') {
        console.log('[OG] cid matched: hyeokgo');
        ogImage = 'https://roonging.com/og-hyeokgo.png';
        ogTitle = T_HYEOKGO; ogDesc = D_HYEOKGO;
      } else if (cid === 'c_1778500089386') {
        console.log('[OG] cid matched: lolhang');
        ogImage = 'https://roonging.com/og-banner.jpg';
        ogTitle = T_LOLHANG; ogDesc = D_LOLHANG;
      } else {
        console.log('[OG] cid matched: default, cid was:', cid);
        ogImage = 'https://roonging.com/og-image-v2.png';
        ogTitle = T_DEFAULT; ogDesc = D_DEFAULT;
      }

      const pageUrl = 'https://roonging.com/stats?server_id=' + serverId + '&cid=' + cid;
      const html = '<!DOCTYPE html><html><head>' +
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
        '<meta name="twitter:image" content="' + ogImage + '">' +
        '<title>' + ogTitle + '</title>' +
        '</head><body>' +
        '<!-- OG debug: cid=' + cid + ' image=' + ogImage + ' -->' +
        '<script>location.href="' + pageUrl + '";</script></body></html>';

      // 4. 반환값 확인
      console.log('[OG] returning html, ogImage:', ogImage, 'ogTitle:', ogTitle);

      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache,no-store' }
      });
    }

    console.log('[OG] not /stats, passing through');
    return env.ASSETS.fetch(request);
  }
};