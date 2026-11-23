export const IMG_SERVERS = [1, 2, 3];
export const THUMB_SERVERS = [1, 2, 3, 4];
export const PAGE_CACHE_NAME = 'manga-pages-v1';
export const TRANSLATED_CACHE_NAME = 'manga-translated-v1';

export function pickServer(servers, mediaId) {
  let hash = 0;
  const str = String(mediaId ?? '');
  for (let i = 0; i < str.length; i++) {
    hash += str.charCodeAt(i);
  }
  return servers[hash % servers.length];
}

export function fullImageUrl(path, mediaId) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const clean = String(path).replace(/^\/+/, '');
  const srv = pickServer(IMG_SERVERS, mediaId);
  return `https://i${srv}.nhentai.net/${clean}`;
}

export function fullThumbUrl(path, mediaId) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const clean = String(path).replace(/^\/+/, '');
  const srv = pickServer(THUMB_SERVERS, mediaId);
  return `https://t${srv}.nhentai.net/${clean}`;
}

export function galleryThumbUrl(mediaId) {
  if (!mediaId) return null;
  const srv = pickServer(THUMB_SERVERS, mediaId);
  return `https://t${srv}.nhentai.net/galleries/${mediaId}/thumb.webp`;
}

export function proxyImageUrl(remoteUrl) {
  if (!remoteUrl) return '';
  return `/api/img?url=${encodeURIComponent(remoteUrl)}`;
}

export function getBookCoverUrl(book) {
  if (!book) return null;
  const mediaId = book.media_id || '';
  if (typeof book.thumbnail === 'string' && book.thumbnail) {
    return fullThumbUrl(book.thumbnail, mediaId || String(book.id));
  }
  if (book.cover?.path) {
    return fullThumbUrl(book.cover.path, mediaId);
  }
  if (book.thumbnail?.path) {
    return fullThumbUrl(book.thumbnail.path, mediaId);
  }
  if (mediaId) {
    return galleryThumbUrl(mediaId);
  }
  return null;
}

export function getBookTitle(book) {
  if (!book) return '';
  if (book.title) {
    return book.title.pretty || book.title.english || book.title.japanese || `#${book.id}`;
  }
  return book.english_title || book.japanese_title || `#${book.id}`;
}

export function getBookSubTitle(book) {
  if (!book) return '';
  const primary = getBookTitle(book);
  const candidates = book.title
    ? [book.title.english, book.title.japanese]
    : [book.japanese_title, book.english_title];
  return candidates.find((t) => t && t !== primary) || '';
}

async function fetchApiJson(path, params = {}, signal) {
  const url = new URL(`/api/proxy${path}`, window.location.origin);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      url.searchParams.set(key, String(val));
    }
  }
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(body?.error || `Lỗi API (${res.status})`);
    err.status = res.status;
    err.hint = body?.hint || '';
    err.code = body?.code || '';
    throw err;
  }
  return body;
}

export function fetchGalleries(page = 1, perPage = 25, signal) {
  return fetchApiJson('/galleries', { page, per_page: perPage }, signal);
}

export async function fetchPopular(signal) {
  const data = await fetchApiJson('/galleries/popular', {}, signal);
  return Array.isArray(data) ? data : (data?.result ?? []);
}

export function fetchRandom(signal) {
  return fetchApiJson('/galleries/random', {}, signal);
}

export function fetchBook(id, signal) {
  return fetchApiJson(`/galleries/${encodeURIComponent(id)}`, {}, signal);
}

export async function fetchRelated(id, signal) {
  const data = await fetchApiJson(`/galleries/${encodeURIComponent(id)}/related`, {}, signal);
  return Array.isArray(data) ? data : (data?.result ?? []);
}

export function searchGalleries(query, page = 1, sort = 'popular', signal) {
  return fetchApiJson('/search', { query, page, sort }, signal);
}

/**
 * Prefetch all pages of a Book into the browser Cache API via the same-origin /api/img proxy
 * so offline downloads are never blocked by remote CDN CORS headers.
 */
export async function downloadBookPages(book, { onProgress, signal } = {}) {
  const pages = book?.pages || [];
  if (!pages.length) throw new Error('Truyện không có danh sách trang để tải.');
  if (!('caches' in window)) {
    throw new Error('Trình duyệt không hỗ trợ Cache API để lưu offline.');
  }

  const cache = await caches.open(PAGE_CACHE_NAME);
  let completed = 0;
  const total = pages.length;

  // Also cache cover thumbnail for offline Downloads list
  const coverRemote = getBookCoverUrl(book);
  if (coverRemote) {
    try {
      const coverProxy = proxyImageUrl(coverRemote);
      const r = await fetch(coverProxy, { signal });
      if (r.ok) await cache.put(coverProxy, r.clone());
    } catch {
      // Non-fatal if cover fails; continue downloading chapter pages.
    }
  }

  const concurrency = 4;
  let index = 0;

  async function worker() {
    while (index < total) {
      if (signal?.aborted) throw new DOMException('Đã hủy tải xuống', 'AbortError');
      const current = pages[index++];
      const remote = fullImageUrl(current.path, book.media_id);
      if (!remote) {
        completed++;
        onProgress?.(completed, total);
        continue;
      }
      const proxyUrl = proxyImageUrl(remote);
      const existing = await cache.match(proxyUrl);
      if (!existing) {
        const res = await fetch(proxyUrl, { signal });
        if (!res.ok) throw new Error(`Không tải được trang ${current.number} (${res.status})`);
        await cache.put(proxyUrl, res.clone());
      }
      completed++;
      onProgress?.(completed, total);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  return { completed, total };
}

export async function removeBookCache(book) {
  if (!('caches' in window) || !book) return;
  const cache = await caches.open(PAGE_CACHE_NAME);
  const coverRemote = getBookCoverUrl(book);
  if (coverRemote) await cache.delete(proxyImageUrl(coverRemote));
  for (const page of book.pages || []) {
    const remote = fullImageUrl(page.path, book.media_id);
    if (remote) await cache.delete(proxyImageUrl(remote));
  }
}

export async function getCachedImageObjectUrl(remoteUrl) {
  if (!remoteUrl || !('caches' in window)) return null;
  try {
    const cache = await caches.open(PAGE_CACHE_NAME);
    const match = await cache.match(proxyImageUrl(remoteUrl));
    if (!match) return null;
    const blob = await match.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

// --- Laptop GPU AI Translation API & Browser Cache ---

export function detectBookLanguage(book) {
  const tags = (book?.tags || []).map((t) => String(t?.name || '').toLowerCase());
  if (tags.includes('english')) return { sourceLang: 'en', readingDir: 'ltr', label: 'English' };
  if (tags.includes('korean')) return { sourceLang: 'ko', readingDir: 'ltr', label: 'Korean' };
  if (tags.includes('chinese')) return { sourceLang: 'zh', readingDir: 'rtl', label: 'Chinese' };
  if (tags.includes('japanese')) return { sourceLang: 'ja', readingDir: 'rtl', label: 'Japanese' };
  return { sourceLang: 'auto', readingDir: 'rtl', label: 'Auto' };
}

export function translatedCacheKey(bookId, pageNum, targetLang = 'vi') {
  return `/translated-cache/${bookId}/${pageNum}/${targetLang}`;
}

export async function fetchTranslateStatus(signal) {
  try {
    const res = await fetch('/api/translate/status', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return { online: false, configured: false, worker: null };
    return await res.json();
  } catch {
    return { online: false, configured: false, worker: null };
  }
}

export async function getTranslatedPageObjectUrl(bookId, pageNum, targetLang = 'vi') {
  if (!bookId || !pageNum || !('caches' in window)) return null;
  try {
    const cache = await caches.open(TRANSLATED_CACHE_NAME);
    const match = await cache.match(translatedCacheKey(bookId, pageNum, targetLang));
    if (!match) return null;
    const blob = await match.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export async function countTranslatedPages(book, targetLang = 'vi') {
  const pages = book?.pages || [];
  if (!pages.length || !('caches' in window)) return { done: 0, total: pages.length };
  try {
    const cache = await caches.open(TRANSLATED_CACHE_NAME);
    let done = 0;
    for (const p of pages) {
      const hit = await cache.match(translatedCacheKey(book.id, p.number, targetLang));
      if (hit) done++;
    }
    return { done, total: pages.length };
  } catch {
    return { done: 0, total: pages.length };
  }
}

export async function clearBookTranslation(book, targetLang = 'vi') {
  if (!book?.pages?.length || !('caches' in window)) return;
  const cache = await caches.open(TRANSLATED_CACHE_NAME);
  for (const p of book.pages) {
    await cache.delete(translatedCacheKey(book.id, p.number, targetLang));
  }
}

export async function translateSinglePage(
  book,
  pageObj,
  { sourceLang = null, readingDir = null, targetLang = 'vi', force = false, signal } = {}
) {
  const imageUrl = fullImageUrl(pageObj?.path, book?.media_id);
  if (!imageUrl) throw new Error('Thiếu đường dẫn ảnh trang.');
  const detected = detectBookLanguage(book);

  const res = await fetch('/api/translate/page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      bookId: Number(book.id),
      page: Number(pageObj.number),
      imageUrl,
      sourceLang: sourceLang || detected.sourceLang,
      targetLang,
      readingDir: readingDir || detected.readingDir,
      force,
    }),
    signal,
  });

  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Lỗi dịch trang ${pageObj.number} (${res.status})`);
    err.status = res.status;
    err.online = data?.online;
    throw err;
  }

  // Fetch translated WebP binary and persist in browser Cache API so revisiting is instant
  const imgRes = await fetch(data.imageUrl, { signal });
  if (!imgRes.ok) throw new Error(`Không tải được ảnh đã dịch trang ${pageObj.number}.`);
  const cloned = imgRes.clone();
  if ('caches' in window) {
    const cache = await caches.open(TRANSLATED_CACHE_NAME);
    await cache.put(translatedCacheKey(book.id, pageObj.number, targetLang), cloned);
  }
  const blob = await imgRes.blob();
  return {
    objectUrl: URL.createObjectURL(blob),
    meta: data.meta || {},
    cached: Boolean(data.cached),
  };
}

/**
 * Translates all pages of a book sequentially before entering Reader
 * ("khi chưa vô truyện nhấn nút dịch, khi nào xong mới vô coi").
 */
export async function translateBookPages(
  book,
  { sourceLang = null, targetLang = 'vi', force = false, signal, onProgress } = {}
) {
  const pages = book?.pages || [];
  if (!pages.length) throw new Error('Truyện chưa có dữ liệu trang để dịch.');

  const detected = detectBookLanguage(book);
  const lang = sourceLang || detected.sourceLang;
  const readingDir = detected.readingDir;
  const cache = 'caches' in window ? await caches.open(TRANSLATED_CACHE_NAME) : null;
  let done = 0;
  const total = pages.length;

  for (const p of pages) {
    if (signal?.aborted) throw new DOMException('Đã hủy dịch truyện', 'AbortError');
    if (!force && cache) {
      const hit = await cache.match(translatedCacheKey(book.id, p.number, targetLang));
      if (hit) {
        done++;
        onProgress?.(done, total, { cached: true, page: p.number });
        continue;
      }
    }
    const res = await translateSinglePage(book, p, {
      sourceLang: lang,
      readingDir,
      targetLang,
      force,
      signal,
    });
    URL.revokeObjectURL(res.objectUrl);
    done++;
    onProgress?.(done, total, { ...res.meta, page: p.number });
  }
  return { done, total };
}
