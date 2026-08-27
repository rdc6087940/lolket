// OG unicode escapes
const T_HYEOKGO = '\ud611\uace1 \uc9c0\ud1b5\uc2e4 \uc804\uc801';
const D_HYEOKGO = '\ud611\uace1 \uc9c0\ud1b5\uc2e4 LoL \ub0b4\uc804 \uc804\uc801';
const T_LOLHANG = '\ub864\ud558\ub0e5 \ub0b4\uc804\uc804\uc801';
const D_LOLHANG = '\ub0b4\uc804 \uc804\uc801 | \ud1b5\uacc4 | \ubd84\uc11d \ud50c\ub7ab\ud3fc';
const T_DEFAULT = '\ub889\uc78b\ub2f7\ucef4 \uc804\uc801 \uc0ac\uc774\ud2b8';
const D_DEFAULT = 'LoL \ub0b4\uc804 \uc804\uc801 \ud1b5\uacc4 \ud50c\ub7ab\ud3fc';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/stats' || path === '/stats.html') {
      const cid = url.searchParams.get('cid') || '';
      const serverId = url.searchParams.get('server_id') || '';

      let ogImage, ogTitle, ogDesc;

      if (cid === 'c_1786029938203') {
        ogImage = 'https://roonging.com/og-hyeokgo.png';
        ogTitle = T_HYEOKGO; ogDesc = D_HYEOKGO;
      } else if (cid === 'c_1778500089386') {
        ogImage = 'https://roonging.com/og-banner.jpg';
        ogTitle = T_LOLHANG; ogDesc = D_LOLHANG;
      } else {
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
        '</head><body><script>location.href="' + pageUrl + '";</script></body></html>';

      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache,no-store' }
      });
    }

    return env.ASSETS.fetch(request);
  }
};