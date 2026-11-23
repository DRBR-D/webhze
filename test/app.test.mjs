import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  pickServer,
  fullImageUrl,
  fullThumbUrl,
  galleryThumbUrl,
  IMG_SERVERS,
  THUMB_SERVERS,
} from '../public/js/api.js';
import {
  createInitialUserState,
  applyCheckIn,
  applyRedeemCode,
  applySpendPoints,
} from '../public/js/store.js';
import { parseRoute, computePreloadOrder } from '../public/js/dom.js';
import { createAppServer, validateApiPath, validateImageUrl } from '../server.mjs';

test('URL builders match ASCII-sum server picking spec', () => {
  // "12345" => 49+50+51+52+53 = 255 => 255 % 3 = 0 -> i1; 255 % 4 = 3 -> t4
  assert.equal(pickServer(IMG_SERVERS, '12345'), 1);
  assert.equal(pickServer(THUMB_SERVERS, '12345'), 4);
  assert.equal(
    fullImageUrl('galleries/12345/1.webp', '12345'),
    'https://i1.nhentai.net/galleries/12345/1.webp'
  );
  assert.equal(
    fullThumbUrl('/galleries/12345/1t.webp', '12345'),
    'https://t4.nhentai.net/galleries/12345/1t.webp'
  );
  assert.equal(
    galleryThumbUrl('12345'),
    'https://t4.nhentai.net/galleries/12345/thumb.webp'
  );
  assert.equal(fullImageUrl(null, '12345'), null);
  assert.equal(fullThumbUrl('', '12345'), null);
});

test('Gamification rules: checkIn, redeemCode, spendPoints', () => {
  let state = createInitialUserState();
  assert.equal(state.points, 300);
  assert.deepEqual(state.coupons, ['WELCOME100', 'FREETOON', 'DAILYACC']);

  // Daily check-in once per calendar date
  const c1 = applyCheckIn(state, 1, '2026-11-24');
  assert.equal(c1.ok, true);
  assert.equal(c1.state.points, 400);
  assert.ok(c1.state.coupons.includes('DAILY-DAY-1'));

  const cDup = applyCheckIn(c1.state, 2, '2026-11-24');
  assert.equal(cDup.ok, false);
  assert.equal(cDup.state.points, 400);

  const cNextDay = applyCheckIn(c1.state, 2, '2026-11-25');
  assert.equal(cNextDay.ok, true);
  assert.equal(cNextDay.state.points, 500);
  assert.ok(cNextDay.state.coupons.includes('DAILY-DAY-2'));

  // Redeem codes (once each)
  const r1 = applyRedeemCode(cNextDay.state, 'manga999');
  assert.equal(r1.ok, true);
  assert.equal(r1.state.points, 1000);
  assert.ok(r1.state.coupons.includes('VIP-CODE-MANGA999'));

  const r1Dup = applyRedeemCode(r1.state, 'MANGA999');
  assert.equal(r1Dup.ok, false);

  const rLucky = applyRedeemCode(r1.state, 'LUCKY');
  assert.equal(rLucky.ok, true);
  assert.equal(rLucky.state.points, 1200);
  assert.ok(rLucky.state.coupons.includes('LUCKY-RED'));

  const rBad = applyRedeemCode(rLucky.state, 'UNKNOWN');
  assert.equal(rBad.ok, false);

  // Spend points
  const s1 = applySpendPoints(rLucky.state, 250, 'badge gold');
  assert.equal(s1.ok, true);
  assert.equal(s1.state.points, 950);
  assert.ok(s1.state.coupons.includes('REDEEM-BADGE-GOLD'));

  const sOver = applySpendPoints(s1.state, 5000, 'VIP');
  assert.equal(sOver.ok, false);
});

test('SPA route parser handles all spec routes', () => {
  assert.deepEqual(parseRoute('/'), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('/search', '?q=full+color&sort=date'), {
    name: 'search',
    params: { q: 'full color', sort: 'date' },
  });
  assert.deepEqual(parseRoute('/favorites'), { name: 'favorites', params: {} });
  assert.deepEqual(parseRoute('/history'), { name: 'history', params: {} });
  assert.deepEqual(parseRoute('/downloads'), { name: 'downloads', params: {} });
  assert.deepEqual(parseRoute('/manga/177013'), { name: 'detail', params: { id: 177013 } });
  assert.deepEqual(parseRoute('/read/177013/15'), { name: 'reader', params: { id: 177013, page: 15 } });
});

test('Sliding-window preload order loads 4 ahead then 3 behind sequentially', () => {
  assert.deepEqual(computePreloadOrder(1, 20), [2, 3, 4, 5]);
  assert.deepEqual(computePreloadOrder(4, 20), [5, 6, 7, 8, 3, 2, 1]);
  assert.deepEqual(computePreloadOrder(19, 20), [20, 18, 17, 16]);
  assert.deepEqual(computePreloadOrder(1, 3), [2, 3]);
});

test('Proxy endpoint and image URL validators block SSRF and traversal', () => {
  assert.equal(validateApiPath('/galleries'), true);
  assert.equal(validateApiPath('/galleries/popular'), true);
  assert.equal(validateApiPath('/galleries/random'), true);
  assert.equal(validateApiPath('/galleries/12345'), true);
  assert.equal(validateApiPath('/galleries/12345/related'), true);
  assert.equal(validateApiPath('/search'), true);

  assert.equal(validateApiPath('/admin'), false);
  assert.equal(validateApiPath('/galleries/../secret'), false);
  assert.equal(validateApiPath('/galleries/abc'), false);

  assert.equal(
    validateImageUrl('https://i2.nhentai.net/galleries/999/1.webp'),
    'https://i2.nhentai.net/galleries/999/1.webp'
  );
  assert.equal(
    validateImageUrl('https://t4.nhentai.net/galleries/999/thumb.webp'),
    'https://t4.nhentai.net/galleries/999/thumb.webp'
  );
  assert.equal(validateImageUrl('http://i1.nhentai.net/galleries/999/1.webp'), null);
  assert.equal(validateImageUrl('https://i4.nhentai.net/galleries/999/1.webp'), null);
  assert.equal(validateImageUrl('https://127.0.0.1/galleries/999/1.webp'), null);
  assert.equal(validateImageUrl('https://evil.example/galleries/999/1.webp'), null);
  assert.equal(validateImageUrl('https://user:pass@i1.nhentai.net/galleries/999/1.webp'), null);
  assert.equal(validateImageUrl('https://i1.nhentai.net/galleries/../etc/passwd'), null);
});

test('HTTP server proxies API with required headers and serves SPA routes', async (t) => {
  let lastUpstreamHeaders = null;
  let lastUpstreamUrl = null;

  const mockUpstream = http.createServer((req, res) => {
    lastUpstreamHeaders = req.headers;
    lastUpstreamUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        result: [{ id: 101, media_id: '555', english_title: 'Test Manga', num_pages: 12, num_favorites: 88 }],
        num_pages: 3,
        per_page: 25,
        total: 60,
      })
    );
  });

  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = mockUpstream.address().port;

  const appServer = createAppServer({ upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v2` });
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  const appPort = appServer.address().port;
  const base = `http://127.0.0.1:${appPort}`;

  t.after(() => {
    appServer.close();
    mockUpstream.close();
  });

  // 1. Proxy request forwards headers & query params
  const apiRes = await fetch(`${base}/api/proxy/galleries?page=2&per_page=25`);
  assert.equal(apiRes.status, 200);
  const json = await apiRes.json();
  assert.equal(json.result[0].id, 101);
  assert.equal(lastUpstreamUrl, '/api/v2/galleries?page=2&per_page=25');
  assert.equal(lastUpstreamHeaders.accept, 'application/json');
  assert.match(lastUpstreamHeaders['user-agent'], /Chrome\/131\.0\.0\.0/);

  // 2. Disallowed proxy path rejected with 400
  const badApi = await fetch(`${base}/api/proxy/secret`);
  assert.equal(badApi.status, 400);

  // 3. Disallowed image URL rejected with 400
  const badImg = await fetch(`${base}/api/img?url=${encodeURIComponent('http://127.0.0.1:80/secret')}`);
  assert.equal(badImg.status, 400);

  // 4. SPA fallback serves index.html on deep routes with iOS standalone meta tags
  const spaRes = await fetch(`${base}/read/101/4`);
  assert.equal(spaRes.status, 200);
  assert.equal(spaRes.headers.get('referrer-policy'), 'no-referrer');
  const html = await spaRes.text();
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);

  // 5. Web App Manifest, Service Worker & Apple Touch Icon served cleanly for Home Screen install
  const mfRes = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(mfRes.status, 200);
  assert.match(mfRes.headers.get('content-type'), /application\/manifest\+json/);
  const mf = await mfRes.json();
  assert.equal(mf.id, '/');
  assert.equal(mf.display, 'standalone');
  assert.equal(mf.start_url, '/');

  const swRes = await fetch(`${base}/sw.js`);
  assert.equal(swRes.status, 200);
  assert.equal(swRes.headers.get('service-worker-allowed'), '/');

  const iconRes = await fetch(`${base}/icons/apple-touch-icon.png`);
  assert.equal(iconRes.status, 200);
  assert.equal(iconRes.headers.get('content-type'), 'image/png');
  const iconBytes = new Uint8Array(await iconRes.arrayBuffer());
  assert.deepEqual([...iconBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
