import http from 'node:http';
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

export function createAppServer({ upstreamBase = process.env.API_UPSTREAM || DEFAULT_UPSTREAM } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (urlObj.pathname.startsWith('/api/proxy/')) {
        return await handleApiProxy(req, res, urlObj, upstreamBase);
      }
      if (urlObj.pathname === '/api/img') {
        return await handleImageProxy(req, res, urlObj);
      }
      return await serveStatic(res, urlObj.pathname);
    } catch (err) {
      sendJson(res, 500, { error: 'Internal Server Error', message: err.message });
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
