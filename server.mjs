import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_UPSTREAM = 'https://nhentai.net/api/v2';
const UPSTREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ALLOWED_IMAGE_HOST = /^(?:i[1-3]|t[1-4])\.nhentai\.net$/;

const ALLOWED_API_PATHS = [
  /^\/galleries$/,
  /^\/galleries\/popular$/,
  /^\/galleries\/random$/,
  /^\/galleries\/\d+$/,
  /^\/galleries\/\d+\/related$/,
  /^\/search$/,
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function validateApiPath(subPath) {
  if (!subPath || subPath.includes('..') || subPath.includes('\\')) return false;
  return ALLOWED_API_PATHS.some((re) => re.test(subPath));
}

export function validateImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!ALLOWED_IMAGE_HOST.test(parsed.hostname)) return null;
  if (!parsed.pathname.startsWith('/galleries/') || parsed.pathname.includes('..')) return null;
  return parsed.toString();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleApiProxy(req, res, urlObj, upstreamBase) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const subPath = urlObj.pathname.slice('/api/proxy'.length);
  if (!validateApiPath(subPath)) {
    return sendJson(res, 400, { error: 'Endpoint không hợp lệ.' });
  }

  const target = new URL(`${upstreamBase.replace(/\/+$/, '')}${subPath}`);
  for (const [k, v] of urlObj.searchParams.entries()) {
    if (['page', 'per_page', 'query', 'sort'].includes(k)) {
      target.searchParams.set(k, v);
    }
  }

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': UPSTREAM_UA,
      },
      signal: AbortSignal.timeout(15000),
    });

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': subPath === '/galleries/random' ? 'no-store' : 'public, max-age=30',
    });
    res.end(buf);
  } catch (err) {
    const code = err?.cause?.code || err?.code || err?.name || 'FETCH_ERROR';
    sendJson(res, 502, {
      error: 'Không thể kết nối tới API nguồn.',
      code,
      hint: 'Nếu nhà mạng chặn nhentai.net, hãy bật VPN hoặc cấu hình biến môi trường API_UPSTREAM / HTTPS_PROXY (kèm NODE_USE_ENV_PROXY=1).',
    });
  }
}

async function handleImageProxy(req, res, urlObj) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const safeUrl = validateImageUrl(urlObj.searchParams.get('url'));
  if (!safeUrl) {
    return sendJson(res, 400, { error: 'URL ảnh không hợp lệ.' });
  }

  try {
    const upstream = await fetch(safeUrl, {
      method: 'GET',
      headers: {
        'User-Agent': UPSTREAM_UA,
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });

    // Reject redirects to prevent open-redirect SSRF bypass.
    if (upstream.status >= 300 && upstream.status < 400) {
      return sendJson(res, 502, { error: 'Chuyển hướng ảnh không được phép.' });
    }

    if (!upstream.ok) {
      return sendJson(res, upstream.status, { error: `Lỗi tải ảnh (${upstream.status}).` });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!contentType.startsWith('image/')) {
      return sendJson(res, 502, { error: 'Phản hồi không phải định dạng ảnh.' });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  } catch (err) {
    sendJson(res, 502, { error: 'Không thể tải ảnh từ máy chủ nguồn.', code: err?.cause?.code || err?.name });
  }
}

async function serveStatic(res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const fullPath = path.resolve(PUBLIC_DIR, rel);

  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  let targetFile = fullPath;
  try {
    const stat = await fs.stat(targetFile);
    if (stat.isDirectory()) targetFile = path.join(targetFile, 'index.html');
  } catch {
    // SPA client-side routes fallback to index.html unless requesting an asset file
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    targetFile = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const data = await fs.readFile(targetFile);
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': ['.html', '.css', '.js', '.mjs', '.webmanifest'].includes(ext)
      ? 'no-cache'
      : 'public, max-age=3600',
  };
  if (path.basename(targetFile) === 'sw.js') {
    headers['Service-Worker-Allowed'] = '/';
  }
  res.writeHead(200, headers);
  res.end(data);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Payload quá lớn.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function timingSafeTokenMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractWorkerToken(req, urlObj) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-worker-token']) return String(req.headers['x-worker-token']).trim();
  return urlObj.searchParams.get('token') || '';
}

function createTranslationHub({ workerToken = '', maxCacheEntries = 32, allowLocalImages = false } = {}) {
  const cache = new Map(); // cacheKey -> { buffer, contentType, meta, createdAt }
  const inflight = new Map(); // cacheKey -> Promise
  const pendingJobs = new Map(); // jobId -> { resolve, reject, timer, cacheKey }
  const jobQueue = [];
  let activeWorker = null;
  let jobSeq = 0;

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    // Refresh LRU recency
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(key, entry) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }

  function sendSseEvent(worker, eventName, payload) {
    if (!worker || worker.res.writableEnded) return false;
    try {
      worker.res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  function flushQueue() {
    while (activeWorker && jobQueue.length > 0) {
      const job = jobQueue.shift();
      if (!pendingJobs.has(job.jobId)) continue;
      if (!sendSseEvent(activeWorker, 'job', job)) {
        jobQueue.unshift(job);
        break;
      }
    }
  }

  function disconnectWorker(worker) {
    if (activeWorker !== worker) return;
    clearInterval(worker.pingTimer);
    activeWorker = null;
    // Fail any in-flight jobs cleanly so clients are not left hanging
    for (const [jobId, pending] of pendingJobs.entries()) {
      clearTimeout(pending.timer);
      pendingJobs.delete(jobId);
      pending.reject(Object.assign(new Error('Laptop dịch vừa ngắt kết nối.'), { statusCode: 503 }));
    }
    jobQueue.length = 0;
  }

  function getStatus() {
    return {
      online: Boolean(activeWorker && !activeWorker.res.writableEnded),
      configured: Boolean(workerToken),
      worker: activeWorker
        ? {
            name: activeWorker.name,
            gpu: activeWorker.gpu,
            model: activeWorker.model,
            connectedAt: activeWorker.connectedAt,
          }
        : null,
      queueSize: jobQueue.length,
      inFlight: pendingJobs.size,
      cachedCount: cache.size,
    };
  }

  function handleWorkerStream(req, res, urlObj) {
    if (!workerToken) {
      return sendJson(res, 503, { error: 'Server chưa cấu hình WORKER_TOKEN.' });
    }
    const provided = extractWorkerToken(req, urlObj);
    if (!timingSafeTokenMatch(provided, workerToken)) {
      return sendJson(res, 401, { error: 'WORKER_TOKEN không đúng.' });
    }

    // Replace previous stale worker connection cleanly
    if (activeWorker) {
      clearInterval(activeWorker.pingTimer);
      try { activeWorker.res.end(); } catch {}
      activeWorker = null;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const worker = {
      res,
      name: String(req.headers['x-worker-name'] || urlObj.searchParams.get('name') || 'Arch-GPU-Worker').slice(0, 64),
      gpu: String(req.headers['x-worker-gpu'] || urlObj.searchParams.get('gpu') || 'RTX 3050').slice(0, 64),
      model: String(req.headers['x-worker-model'] || urlObj.searchParams.get('model') || 'gemini').slice(0, 64),
      connectedAt: Date.now(),
      pingTimer: null,
    };
    activeWorker = worker;
    sendSseEvent(worker, 'connected', { ok: true, ts: Date.now() });

    worker.pingTimer = setInterval(() => {
      if (worker.res.writableEnded) {
        disconnectWorker(worker);
        return;
      }
      try {
        worker.res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        disconnectWorker(worker);
      }
    }, 20000);

    req.on('close', () => disconnectWorker(worker));
    req.on('error', () => disconnectWorker(worker));
    flushQueue();
  }

  async function handleWorkerResult(req, res, urlObj) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
    if (!workerToken) return sendJson(res, 503, { error: 'Server chưa cấu hình WORKER_TOKEN.' });
    const provided = extractWorkerToken(req, urlObj);
    if (!timingSafeTokenMatch(provided, workerToken)) {
      return sendJson(res, 401, { error: 'WORKER_TOKEN không đúng.' });
    }

    const jobId = urlObj.pathname.slice('/api/worker/result/'.length).trim();
    const pending = pendingJobs.get(jobId);
    const body = await readBody(req, 10 * 1024 * 1024); // 10 MB max per translated page
    const contentType = String(req.headers['content-type'] || '').toLowerCase();

    if (!pending) {
      return sendJson(res, 404, { error: 'Job không tồn tại hoặc đã hết hạn.' });
    }

    clearTimeout(pending.timer);
    pendingJobs.delete(jobId);

    if (contentType.startsWith('application/json')) {
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8')); } catch {}
      pending.reject(Object.assign(new Error(parsed.error || 'Worker dịch thất bại.'), { statusCode: 502 }));
      return sendJson(res, 200, { ok: true });
    }

    if (!contentType.startsWith('image/') || body.length < 32) {
      pending.reject(Object.assign(new Error('Dữ liệu ảnh trả về không hợp lệ.'), { statusCode: 502 }));
      return sendJson(res, 400, { error: 'Cần gửi ảnh (image/webp hoặc image/png).' });
    }

    let meta = {};
    const metaHeader = req.headers['x-translate-meta'];
    if (metaHeader) {
      try { meta = JSON.parse(String(metaHeader)); } catch {}
    }

    const entry = {
      buffer: body,
      contentType: contentType.split(';')[0],
      meta,
      createdAt: Date.now(),
    };
    cacheSet(pending.cacheKey, entry);
    pending.resolve(entry);
    return sendJson(res, 200, { ok: true, bytes: body.length });
  }

  async function handleTranslatePage(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const raw = await readBody(req, 64 * 1024);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'JSON không hợp lệ.' });
    }

    const bookId = Number(body.bookId);
    const page = Number(body.page);
    const sourceLang = String(body.sourceLang || 'auto').slice(0, 24);
    const targetLang = String(body.targetLang || 'vi').slice(0, 12);
    const readingDir = body.readingDir === 'ltr' ? 'ltr' : 'rtl';
    const force = Boolean(body.force);

    if (!Number.isInteger(bookId) || bookId <= 0 || !Number.isInteger(page) || page <= 0) {
      return sendJson(res, 400, { error: 'bookId hoặc page không hợp lệ.' });
    }

    const rawImageUrl = String(body.imageUrl || '');
    const safeRemoteUrl = validateImageUrl(rawImageUrl);
    const isAllowedLocal = allowLocalImages && /^http:\/\/127\.0\.0\.1:\d+\/img\//.test(rawImageUrl);
    const imageUrl = safeRemoteUrl || (isAllowedLocal ? rawImageUrl : null);
    if (!imageUrl) {
      return sendJson(res, 400, { error: 'URL ảnh không hợp lệ.' });
    }

    const cacheKey = `${bookId}_${page}_${targetLang}`;
    if (!force) {
      const hit = cacheGet(cacheKey);
      if (hit) {
        return sendJson(res, 200, {
          status: 'done',
          cached: true,
          imageUrl: `/api/translate/image/${encodeURIComponent(cacheKey)}?v=${hit.createdAt}`,
          meta: hit.meta,
        });
      }
    }

    if (!activeWorker || activeWorker.res.writableEnded) {
      return sendJson(res, 503, {
        error: 'Laptop dịch chưa kết nối. Hãy mở script worker trên laptop để dịch.',
        online: false,
      });
    }

    let promise = inflight.get(cacheKey);
    if (!promise) {
      const jobId = `j_${Date.now()}_${++jobSeq}`;
      const proxyPath = safeRemoteUrl ? `/api/img?url=${encodeURIComponent(safeRemoteUrl)}` : null;

      promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingJobs.delete(jobId);
          reject(Object.assign(new Error('Quá thời gian chờ laptop dịch trang này (95s).'), { statusCode: 504 }));
        }, 95000);

        pendingJobs.set(jobId, { resolve, reject, timer, cacheKey });
        jobQueue.push({
          jobId,
          bookId,
          page,
          imageUrl,
          proxyPath,
          sourceLang,
          targetLang,
          readingDir,
        });
        flushQueue();
      }).finally(() => {
        inflight.delete(cacheKey);
      });

      inflight.set(cacheKey, promise);
    }

    try {
      const entry = await promise;
      return sendJson(res, 200, {
        status: 'done',
        cached: false,
        imageUrl: `/api/translate/image/${encodeURIComponent(cacheKey)}?v=${entry.createdAt}`,
        meta: entry.meta,
      });
    } catch (err) {
      return sendJson(res, err.statusCode || 502, {
        error: err.message || 'Lỗi dịch trang truyện.',
        online: Boolean(activeWorker),
      });
    }
  }

  function handleTranslateImage(req, res, urlObj) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const cacheKey = decodeURIComponent(urlObj.pathname.slice('/api/translate/image/'.length));
    if (!/^\d+_\d+_[a-zA-Z0-9-]+$/.test(cacheKey)) {
      return sendJson(res, 400, { error: 'Key ảnh không hợp lệ.' });
    }
    const hit = cacheGet(cacheKey);
    if (!hit) {
      return sendJson(res, 404, { error: 'Ảnh dịch đã hết hạn cache.' });
    }
    res.writeHead(200, {
      'Content-Type': hit.contentType || 'image/webp',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(hit.buffer);
  }

  return {
    getStatus,
    handleWorkerStream,
    handleWorkerResult,
    handleTranslatePage,
    handleTranslateImage,
  };
}

export function createAppServer({
  upstreamBase = process.env.API_UPSTREAM || DEFAULT_UPSTREAM,
  workerToken = process.env.WORKER_TOKEN || '',
  allowLocalImages = false,
} = {}) {
  const hub = createTranslationHub({ workerToken, allowLocalImages });

  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (urlObj.pathname.startsWith('/api/proxy/')) {
        return await handleApiProxy(req, res, urlObj, upstreamBase);
      }
      if (urlObj.pathname === '/api/img') {
        return await handleImageProxy(req, res, urlObj);
      }
      if (urlObj.pathname === '/api/translate/status') {
        return sendJson(res, 200, hub.getStatus());
      }
      if (urlObj.pathname === '/api/translate/page') {
        return await hub.handleTranslatePage(req, res);
      }
      if (urlObj.pathname.startsWith('/api/translate/image/')) {
        return hub.handleTranslateImage(req, res, urlObj);
      }
      if (urlObj.pathname === '/api/worker/stream') {
        return hub.handleWorkerStream(req, res, urlObj);
      }
      if (urlObj.pathname.startsWith('/api/worker/result/')) {
        return await hub.handleWorkerResult(req, res, urlObj);
      }
      return await serveStatic(res, urlObj.pathname);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || 'Internal Server Error' });
    }
  });
}

// Start server only when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`Manga Reader đang chạy tại http://localhost:${port}`);
    console.log(`API Upstream: ${process.env.API_UPSTREAM || DEFAULT_UPSTREAM}`);
  });
}
