const DB_NAME = 'manga_metadata_db';
const DB_VERSION = 1;
const STORE_NAME = 'manga_metadata';
const FALLBACK_KEY = 'manga_metadata_fallback';

const DEFAULT_COUPONS = ['WELCOME100', 'FREETOON', 'DAILYACC'];
const DEFAULT_POINTS = 300;

// --- Pure Gamification Logic (also unit-tested in Node) ---

export function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createInitialUserState() {
  return {
    dark_mode: false,
    points: DEFAULT_POINTS,
    coupons: [...DEFAULT_COUPONS],
    checked_in_days: [],
    last_check_in_date: '',
  };
}

export function applyCheckIn(state, day, today = getLocalDateString()) {
  const dayNum = Number(day);
  if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 7) {
    return { ok: false, message: 'Ngày điểm danh không hợp lệ.', state };
  }
  if (state.last_check_in_date === today) {
    return { ok: false, message: 'Hôm nay bạn đã điểm danh rồi. Quay lại ngày mai nhé!', state };
  }
  if (state.checked_in_days.includes(dayNum)) {
    return { ok: false, message: `Ngày ${dayNum} đã được điểm danh trước đó.`, state };
  }
  const coupon = `DAILY-DAY-${dayNum}`;
  const nextDays = [...state.checked_in_days, dayNum];
  const nextCoupons = state.coupons.includes(coupon) ? state.coupons : [...state.coupons, coupon];
  return {
    ok: true,
    message: `Điểm danh Ngày ${dayNum} thành công! +100 điểm và nhận mã ${coupon}.`,
    state: {
      ...state,
      points: state.points + 100,
      coupons: nextCoupons,
      checked_in_days: nextDays.length >= 7 ? nextDays : nextDays,
      last_check_in_date: today,
    },
  };
}

export function applyRedeemCode(state, rawCode) {
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!code) {
    return { ok: false, message: 'Vui lòng nhập mã quà tặng.', state };
  }

  if (code === 'MANGA999' || code === 'NHENTAI') {
    const coupon = `VIP-CODE-${code}`;
    if (state.coupons.includes(coupon)) {
      return { ok: false, message: `Mã ${code} đã được sử dụng rồi.`, state };
    }
    return {
      ok: true,
      message: `Nhập mã ${code} thành công! +500 điểm và nhận ${coupon}.`,
      state: {
        ...state,
        points: state.points + 500,
        coupons: [...state.coupons, coupon],
      },
    };
  }

  if (code === 'LUCKY') {
    const coupon = 'LUCKY-RED';
    if (state.coupons.includes(coupon)) {
      return { ok: false, message: 'Mã LUCKY đã được sử dụng rồi.', state };
    }
    return {
      ok: true,
      message: 'Nhập mã LUCKY thành công! +200 điểm và nhận LUCKY-RED.',
      state: {
        ...state,
        points: state.points + 200,
        coupons: [...state.coupons, coupon],
      },
    };
  }

  return { ok: false, message: 'Mã quà tặng không hợp lệ. Thử MANGA999, NHENTAI hoặc LUCKY.', state };
}

export function applySpendPoints(state, amount, itemName) {
  const cost = Number(amount);
  const cleanName = String(itemName ?? '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!Number.isFinite(cost) || cost <= 0 || !cleanName) {
    return { ok: false, message: 'Thông tin đổi thưởng không hợp lệ.', state };
  }
  if (state.points < cost) {
    return { ok: false, message: `Bạn cần ${cost} điểm (hiện có ${state.points} điểm).`, state };
  }
  const coupon = `REDEEM-${cleanName}`;
  return {
    ok: true,
    message: `Đổi thưởng thành công! -${cost} điểm, nhận mã ${coupon}.`,
    state: {
      ...state,
      points: state.points - cost,
      coupons: [...state.coupons, coupon],
    },
  };
}

// --- LocalStorage Helpers ---

function safeGetItem(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota/blocked errors while keeping runtime state intact
  }
}

function safeRemoveItem(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore
  }
}

export function loadUserState() {
  const base = createInitialUserState();
  const pointsRaw = safeGetItem('points');
  const couponsRaw = safeGetItem('coupons');
  const daysRaw = safeGetItem('checked_in_days');
  const lastDate = safeGetItem('last_check_in_date');
  const darkRaw = safeGetItem('dark_mode');

  const points = pointsRaw !== null && Number.isFinite(Number(pointsRaw)) ? Number(pointsRaw) : base.points;
  let coupons = base.coupons;
  if (couponsRaw) {
    try {
      const parsed = JSON.parse(couponsRaw);
      if (Array.isArray(parsed)) coupons = parsed.map(String);
    } catch {
      // keep default
    }
  }
  let checkedInDays = base.checked_in_days;
  if (daysRaw) {
    try {
      const parsed = JSON.parse(daysRaw);
      if (Array.isArray(parsed)) checkedInDays = parsed.map(Number).filter(Number.isInteger);
    } catch {
      // keep default
    }
  }

  return {
    dark_mode: darkRaw === 'true',
    points,
    coupons,
    checked_in_days: checkedInDays,
    last_check_in_date: lastDate || '',
  };
}

export function saveUserState(state) {
  safeSetItem('dark_mode', String(Boolean(state.dark_mode)));
  safeSetItem('points', String(state.points));
  safeSetItem('coupons', JSON.stringify(state.coupons));
  safeSetItem('checked_in_days', JSON.stringify(state.checked_in_days));
  safeSetItem('last_check_in_date', state.last_check_in_date || '');
}

export function checkIn(day) {
  const res = applyCheckIn(loadUserState(), day);
  if (res.ok) saveUserState(res.state);
  return res;
}

export function redeemCode(code) {
  const res = applyRedeemCode(loadUserState(), code);
  if (res.ok) saveUserState(res.state);
  return res;
}

export function spendPoints(amount, itemName) {
  const res = applySpendPoints(loadUserState(), amount, itemName);
  if (res.ok) saveUserState(res.state);
  return res;
}

// --- Color Scheme & Dark Mode Toggle (modern-web-guidance: dark-mode-toggle) ---

export function getStoredColorScheme() {
  const val = safeGetItem('color-scheme');
  return val === 'light' || val === 'dark' ? val : null;
}

export function getSystemColorScheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getRenderedColorScheme() {
  return getStoredColorScheme() ?? getSystemColorScheme();
}

export function applyColorSchemeToMeta(scheme) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.content = scheme === 'light' || scheme === 'dark' ? scheme : 'light dark';
  }
}

export function setColorSchemePreference(pref) {
  if (pref === 'light' || pref === 'dark') {
    safeSetItem('color-scheme', pref);
    safeSetItem('dark_mode', String(pref === 'dark'));
    applyColorSchemeToMeta(pref);
  } else {
    safeRemoveItem('color-scheme');
    safeSetItem('dark_mode', String(getSystemColorScheme() === 'dark'));
    applyColorSchemeToMeta(null);
  }
}

/**
 * Two-state quick toggle: flips to opposite of rendered scheme; removes override when
 * target matches current system preference so the user cleanly reverts to System.
 */
export function toggleColorScheme() {
  const rendered = getRenderedColorScheme();
  const target = rendered === 'dark' ? 'light' : 'dark';
  const system = getSystemColorScheme();
  if (target !== system) {
    safeSetItem('color-scheme', target);
    applyColorSchemeToMeta(target);
  } else {
    safeRemoveItem('color-scheme');
    applyColorSchemeToMeta(null);
  }
  safeSetItem('dark_mode', String(target === 'dark'));
  return target;
}

export function initThemeSync(onSync) {
  applyColorSchemeToMeta(getStoredColorScheme());
  window.addEventListener('storage', (e) => {
    if (e.key === 'color-scheme' || e.key === null) {
      applyColorSchemeToMeta(getStoredColorScheme());
      onSync?.();
    }
  });
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  // Listen to system changes for UI label updates only; never erase a pinned override.
  mql.addEventListener('change', () => onSync?.());
}

// --- Reader Preferences ---

export function loadReaderPrefs() {
  return {
    mode: safeGetItem('reader_mode') === 'horizontal' ? 'horizontal' : 'vertical',
    theme: ['black', 'charcoal', 'sepia', 'white'].includes(safeGetItem('reader_theme'))
      ? safeGetItem('reader_theme')
      : 'charcoal',
    autoScrollSpeed: Math.min(10, Math.max(1, Number(safeGetItem('auto_scroll_speed') || 4))),
  };
}

export function saveReaderPrefs(prefs) {
  if (prefs.mode) safeSetItem('reader_mode', prefs.mode);
  if (prefs.theme) safeSetItem('reader_theme', prefs.theme);
  if (prefs.autoScrollSpeed) safeSetItem('auto_scroll_speed', String(prefs.autoScrollSpeed));
}

// --- IndexedDB Manga Metadata Persistence (manga_metadata) ---

let dbPromise = null;

function openMetadataDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function readFallbackMap() {
  try {
    const raw = safeGetItem(FALLBACK_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeFallbackMap(map) {
  safeSetItem(FALLBACK_KEY, JSON.stringify(map));
}

async function getAllMetadata() {
  try {
    const db = await openMetadataDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return Object.values(readFallbackMap());
  }
}

export async function getMetadata(id) {
  const numId = Number(id);
  try {
    const db = await openMetadataDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(numId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    const map = readFallbackMap();
    return map[numId] || null;
  }
}

async function putMetadata(record) {
  try {
    const db = await openMetadataDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    const map = readFallbackMap();
    map[record.id] = record;
    writeFallbackMap(map);
    return record;
  }
}

function normalizeBook(book, existingBook) {
  if (!book) return existingBook || null;
  if (!existingBook) return book;
  // Preserve full pages/tags from existing Book if incoming object is BookLite
  return {
    ...existingBook,
    ...book,
    pages: book.pages?.length ? book.pages : existingBook.pages,
    tags: book.tags?.length ? book.tags : existingBook.tags,
    title: book.title || existingBook.title,
    cover: book.cover || existingBook.cover,
  };
}

export async function upsertMetadata(book, patch = {}) {
  const id = Number(book?.id ?? patch.id);
  if (!Number.isFinite(id)) throw new Error('Invalid manga id');
  const existing = await getMetadata(id);
  const mergedBook = normalizeBook(book, existing?.bookJson);
  const totalPages =
    patch.totalPages ??
    mergedBook?.num_pages ??
    mergedBook?.pages?.length ??
    existing?.totalPages ??
    0;

  const record = {
    id,
    bookJson: mergedBook,
    isFavorite: patch.isFavorite ?? existing?.isFavorite ?? false,
    isDownloaded: patch.isDownloaded ?? existing?.isDownloaded ?? false,
    lastReadPage: patch.lastReadPage ?? existing?.lastReadPage ?? 0,
    lastReadTime: patch.lastReadTime ?? existing?.lastReadTime ?? 0,
    totalPages,
  };
  return putMetadata(record);
}

export async function toggleFavorite(book) {
  const existing = await getMetadata(book.id);
  const nextFav = !(existing?.isFavorite ?? false);
  return upsertMetadata(book, {
    isFavorite: nextFav,
    lastReadTime: nextFav ? Math.max(existing?.lastReadTime || 0, Date.now()) : existing?.lastReadTime || 0,
  });
}

export async function setDownloaded(book, isDownloaded) {
  const existing = await getMetadata(book.id);
  return upsertMetadata(book, {
    isDownloaded: Boolean(isDownloaded),
    lastReadTime: isDownloaded ? Math.max(existing?.lastReadTime || 0, Date.now()) : existing?.lastReadTime || 0,
  });
}

export async function updateHistory(bookOrId, page, totalPages) {
  const id = typeof bookOrId === 'object' ? bookOrId.id : Number(bookOrId);
  const book = typeof bookOrId === 'object' ? bookOrId : null;
  return upsertMetadata(book ?? { id }, {
    lastReadPage: Math.max(1, Number(page) || 1),
    lastReadTime: Date.now(),
    ...(totalPages ? { totalPages } : {}),
  });
}

export async function clearHistoryItem(id) {
  const existing = await getMetadata(id);
  if (!existing) return;
  return putMetadata({ ...existing, lastReadPage: 0 });
}

function sortByRecent(items) {
  return items.sort((a, b) => (b.lastReadTime || 0) - (a.lastReadTime || 0));
}

export async function getFavorites() {
  const all = await getAllMetadata();
  return sortByRecent(all.filter((item) => item.isFavorite));
}

export async function getHistory() {
  const all = await getAllMetadata();
  return sortByRecent(all.filter((item) => item.lastReadPage > 0));
}

export async function getDownloads() {
  const all = await getAllMetadata();
  return sortByRecent(all.filter((item) => item.isDownloaded));
}
