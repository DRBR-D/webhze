import {
  fetchGalleries,
  fetchPopular,
  fetchRandom,
  fetchBook,
  fetchRelated,
  searchGalleries,
  getBookCoverUrl,
  getBookTitle,
  getBookSubTitle,
  fullThumbUrl,
  downloadBookPages,
  removeBookCache,
} from './api.js';
import {
  loadUserState,
  checkIn,
  redeemCode,
  spendPoints,
  toggleColorScheme,
  initThemeSync,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  getMetadata,
  upsertMetadata,
  toggleFavorite,
  setDownloaded,
  clearHistoryItem,
  getFavorites,
  getHistory,
  getDownloads,
  getLocalDateString,
} from './store.js';
import {
  el,
  svgIcon,
  createMangaImg,
  revokeObjectUrls,
  rubberband,
  runHeroFlyTransition,
  wireIosSheet,
  closeTopLayer,
  formatNumber,
  formatUnixDate,
  showToast,
  parseRoute,
  initCarousel,
} from './dom.js';
import { mountReaderView } from './reader.js';

const QUICK_TAGS = ['english', 'full color', 'vanilla', 'romance', 'fantasy', 'schoolgirl'];

const SHOP_ITEMS = [
  { name: 'AD-FREE-DAY', label: 'Ad-Free Day', cost: 200 },
  { name: 'VIP-EMBLEM', label: 'VIP Emblem', cost: 400 },
];

const SORT_OPTIONS = [
  { value: 'date', label: 'Mới nhất' },
  { value: 'popular', label: 'Hot nhất' },
  { value: 'popular-week', label: 'Hot tuần' },
  { value: 'popular-today', label: 'Hot ngày' },
];

const TAG_DOT_COLORS = ['#FF5A36', '#FF4D8D', '#FFB347', '#38BDF8', '#34D399', '#A855F7'];

let activeCleanup = null;
let favoriteIdSet = new Set();
let historyMap = new Map();
let cachedPopularList = [];

// Navigation stack, scroll restoration, in-memory view caches, and hero fly-in state
let navSeq = Math.max(1, Number(window.history.state?.navId) || 1);
let currentNavId = navSeq;
let restoringScroll = false;
const scrollPositions = new Map();
const bookMemoryCache = new Map();
let homeCache = null;
const searchCache = new Map();
let pendingHeroTransition = null;
let syncHeaderChromeFn = null;

function cacheBook(book) {
  if (!book?.id) return;
  const id = Number(book.id);
  const existing = bookMemoryCache.get(id);
  // Prefer keeping full book objects (with pages & tags) over summary cards
  if (existing?.pages?.length && !book.pages?.length) return;
  bookMemoryCache.set(id, book);
  if (bookMemoryCache.size > 32) {
    const oldestKey = bookMemoryCache.keys().next().value;
    bookMemoryCache.delete(oldestKey);
  }
}

function getScrollTop() {
  return Math.max(window.scrollY || 0, appStage?.scrollTop || 0);
}

function setScrollTop(y) {
  const target = Math.max(0, Math.round(Number(y) || 0));
  window.scrollTo({ top: target, behavior: 'instant' });
  if (appStage) appStage.scrollTop = target;
}

function saveCurrentScroll() {
  scrollPositions.set(currentNavId, getScrollTop());
}

function captureHeroTransition(type, book, sourceEl, extra = {}) {
  if (!book?.id) return;
  cacheBook(book);
  const imgEl = sourceEl?.tagName === 'IMG' ? sourceEl : sourceEl?.querySelector('img');
  const fromRect = imgEl ? imgEl.getBoundingClientRect() : null;
  const imgSrc = imgEl?.currentSrc || imgEl?.src || getBookCoverUrl(book);
  let borderRadius = '14px';
  if (imgEl) {
    const styleTarget = imgEl.closest('.manga-cover-wrap, .detail-cover-box, .weekly-card, .ranking-thumb') || imgEl;
    borderRadius = getComputedStyle(styleTarget).borderRadius || '14px';
  }
  pendingHeroTransition = {
    type,
    id: Number(book.id),
    book,
    imgSrc,
    fromRect:
      fromRect && fromRect.width > 8 && fromRect.height > 8
        ? { left: fromRect.left, top: fromRect.top, width: fromRect.width, height: fromRect.height }
        : null,
    borderRadius,
    ts: performance.now(),
    ...extra,
  };
}

function openBookDetail(book, sourceEl = null) {
  captureHeroTransition('to-detail', book, sourceEl);
  navigate(`/manga/${book.id}`);
}

function openBookReader(book, page = 1, sourceEl = null) {
  const targetPage = Math.max(1, Number(page) || 1);
  if (sourceEl) {
    captureHeroTransition('to-reader', book, sourceEl, { page: targetPage });
  } else {
    cacheBook(book);
  }
  navigate(`/read/${book.id}/${targetPage}`);
}

const appMain = document.getElementById('app-main');
const appShell = document.getElementById('app-shell');
const appStage = document.querySelector('.app-stage');
const topHeader = document.getElementById('top-header');
const toolbarTitleEl = document.getElementById('toolbar-title');
const navDrawer = document.getElementById('nav-drawer');
const drawerScrim = document.getElementById('drawer-scrim');
const appSheet = document.getElementById('app-sheet');
const appSheetTitle = document.getElementById('app-sheet-title');
const appSheetBody = document.getElementById('app-sheet-body');

const supportsWebInstall = typeof Navigator !== 'undefined' && typeof Navigator.prototype?.install === 'function';
let deferredInstallPrompt = null;

function isStandaloneMode() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

// --- Drawer & Library Counters Sync ---

async function refreshLibraryStats() {
  const [favs, hist, saved] = await Promise.all([getFavorites(), getHistory(), getDownloads()]);
  favoriteIdSet = new Set(favs.map((f) => f.id));
  historyMap = new Map(hist.map((h) => [h.id, h]));

  const setCount = (id, n) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = String(n);
    if (node.classList.contains('drawer-count-pill')) node.hidden = n === 0;
  };
  setCount('drawer-fav-count', favs.length);
  setCount('drawer-history-count', hist.length);
  setCount('drawer-saved-count', saved.length);
  setCount('overview-fav-num', favs.length);
  setCount('overview-history-num', hist.length);
  setCount('overview-saved-num', saved.length);

  const setDot = (id, show) => {
    const d = document.getElementById(id);
    if (d) d.hidden = !show;
  };
  setDot('tab-fav-dot', favs.length > 0);
  setDot('tab-history-dot', hist.length > 0);
  setDot('tab-saved-dot', saved.length > 0);
}

function updatePointsLabels() {
  const { points } = loadUserState();
  for (const node of document.querySelectorAll('[data-points-label]')) {
    node.textContent = `${points} pts`;
  }
}

function openMobileDrawer() {
  if (window.innerWidth >= 900) {
    const collapsed = !appShell.classList.contains('sidebar-collapsed');
    appShell.classList.toggle('sidebar-collapsed', collapsed);
    saveSidebarCollapsed(collapsed);
    return;
  }
  appShell.classList.add('drawer-open');
  if (drawerScrim) drawerScrim.hidden = false;
}

function closeMobileDrawer() {
  appShell.classList.remove('drawer-open');
  if (drawerScrim) drawerScrim.hidden = true;
}

function updateActiveNav(routeName) {
  const isReader = routeName === 'reader';
  const isDetail = routeName === 'detail';
  const isHome = routeName === 'home';
  appShell.classList.toggle('is-reader-route', isReader);
  appShell.classList.toggle('is-detail-route', isDetail);
  appShell.classList.toggle('is-home-route', isHome);

  if (toolbarTitleEl) {
    toolbarTitleEl.textContent =
      routeName === 'home' ? 'MANGA' :
      routeName === 'search' ? 'Search' :
      routeName === 'favorites' ? 'My Favorites' :
      routeName === 'history' ? 'Reading History' :
      routeName === 'downloads' ? 'Downloaded Books' :
      'MANGA';
  }

  for (const link of document.querySelectorAll('[data-nav-route]')) {
    const active = link.dataset.navRoute === routeName;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

export function navigate(url, { replace = false } = {}) {
  closeMobileDrawer();
  saveCurrentScroll();
  const next = new URL(url, window.location.origin);
  const full = `${next.pathname}${next.search}`;
  const currentFull = `${window.location.pathname}${window.location.search}`;
  if (full !== currentFull) {
    const curStackIdx = Number(window.history.state?.stackIdx) || 0;
    const nextNavId = ++navSeq;
    const nextState = replace
      ? { navId: nextNavId, stackIdx: curStackIdx }
      : { navId: nextNavId, stackIdx: curStackIdx + 1 };
    if (replace) window.history.replaceState(nextState, '', full);
    else window.history.pushState(nextState, '', full);
    currentNavId = nextNavId;
  }
  renderRoute({ isPop: false });
}

export function goBack(fallbackUrl = '/') {
  if (appSheet?.open) {
    closeTopLayer(appSheet);
    return;
  }
  if (appShell.classList.contains('drawer-open')) {
    closeMobileDrawer();
    return;
  }
  const route = parseRoute(window.location.pathname, window.location.search);
  if (route.name === 'home') return;

  const stackIdx = Number(window.history.state?.stackIdx) || 0;
  if (stackIdx > 0) {
    window.history.back();
  } else {
    navigate(fallbackUrl, { replace: true });
  }
}

// --- Shared Kinetic Manga Card & States ---

function buildMangaCard(book, { meta = null, progressBadge = null, onDelete = null, index = 0, noAnim = false } = {}) {
  const id = book.id;
  const title = getBookTitle(book);
  const coverUrl = getBookCoverUrl(book);
  const pages = book.num_pages || meta?.totalPages || book.pages?.length || 0;
  const hist = meta || historyMap.get(id);
  const pct =
    hist && hist.lastReadPage > 0 && pages > 0
      ? Math.min(100, (hist.lastReadPage / pages) * 100)
      : 0;

  const badgeText = progressBadge || (pct > 0 ? `${pct.toFixed(0)}%` : null);
  const staggerMs = Math.min(index, 9) * 32;
  const openDirectReader = Boolean(progressBadge && hist?.lastReadPage);

  return el(
    'article',
    {
      className: `manga-card ${noAnim ? '' : 'card-fly-in'}`.trim(),
      style: noAnim ? {} : { '--stagger': `${staggerMs}ms` },
    },
    el(
      'a',
      {
        href: openDirectReader ? `/read/${id}/${hist.lastReadPage}` : `/manga/${id}`,
        className: 'manga-card-link',
        onClick: (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (openDirectReader) {
            openBookReader(book, hist.lastReadPage, e.currentTarget);
          } else {
            openBookDetail(book, e.currentTarget);
          }
        },
      },
      el(
        'div',
        { className: 'manga-cover-wrap' },
        createMangaImg(coverUrl, title, { priority: 'lazy', className: 'manga-cover-img', width: 250, height: 350 }),
        badgeText ? el('span', { className: 'badge badge-progress tabular-nums' }, badgeText) : null,
        meta?.isDownloaded ? el('span', { className: 'badge badge-offline' }, 'Offline') : null,
        el('span', { className: 'badge badge-pages tabular-nums' }, `${pages}p`)
      ),
      el('p', { className: 'manga-card-title' }, title)
    ),
    onDelete
      ? el(
          'button',
          {
            type: 'button',
            className: 'card-corner-remove',
            'aria-label': `Xóa ${title}`,
            onClick: (e) => {
              e.stopPropagation();
              onDelete();
            },
          },
          svgIcon('close', 14)
        )
      : null
  );
}

function buildErrorPanel(err, onRetry) {
  return el(
    'section',
    { className: 'state-panel error-panel', role: 'alert' },
    el('h2', {}, 'Không thể tải dữ liệu'),
    el('p', {}, err?.message || 'Đã xảy ra lỗi khi kết nối tới máy chủ.'),
    err?.hint ? el('p', { className: 'muted-hint' }, err.hint) : null,
    el(
      'div',
      { className: 'btn-row' },
      el('button', { type: 'button', className: 'btn btn-primary', onClick: onRetry }, svgIcon('refresh', 17), 'Thử lại'),
      el('button', { type: 'button', className: 'btn btn-surface', onClick: () => navigate('/downloads') }, svgIcon('download', 17), 'Truyện đã tải')
    )
  );
}

function buildSkeletonGrid(count = 6) {
  return el(
    'div',
    { className: 'manga-grid', 'aria-busy': 'true', 'aria-label': 'Đang tải danh sách truyện' },
    ...Array.from({ length: count }, () =>
      el(
        'div',
        { className: 'manga-card skeleton-card' },
        el('div', { className: 'skeleton-cover shimmer' }),
        el('div', { className: 'skeleton-line shimmer' }),
        el('div', { className: 'skeleton-line short shimmer' })
      )
    )
  );
}

// --- 4 Kinetic Bottom Sheets (Ranking, Daily Attendance, Points Wallet & Shop, My Coupons) ---

function openSheet(title, contentNodes) {
  appSheetTitle.textContent = title;
  appSheetBody.replaceChildren(...contentNodes);
  if (!appSheet.open) appSheet.showModal();
}

function openRankingSheet() {
  const list = cachedPopularList.slice(0, 8);
  const rows = list.length
    ? list.map((book, idx) => {
        const rank = idx + 1;
        const score = Math.max(520, 1000 - idx * 65);
        return el(
          'button',
          {
            type: 'button',
            className: 'ranking-row',
            onClick: (e) => {
              const rowEl = e.currentTarget;
              captureHeroTransition('to-detail', book, rowEl);
              closeTopLayer(appSheet);
              navigate(`/manga/${book.id}`);
            },
          },
          el('span', { className: `rank-circle rank-${rank <= 3 ? rank : 'other'} tabular-nums` }, String(rank)),
          el(
            'div',
            { className: 'ranking-thumb' },
            createMangaImg(getBookCoverUrl(book), getBookTitle(book), { priority: 'lazy', width: 54, height: 72 })
          ),
          el(
            'div',
            { className: 'ranking-info' },
            el('p', { className: 'ranking-title' }, getBookTitle(book)),
            el('span', { className: 'ranking-score tabular-nums' }, `Hot Score: ${score}`)
          )
        );
      })
    : [el('p', { className: 'muted-hint' }, 'Chưa có dữ liệu bảng xếp hạng.')];

  openSheet('Daily Hot Ranking', [el('div', { className: 'ranking-list' }, ...rows)]);
}

function openDailySheet() {
  const state = loadUserState();
  const today = getLocalDateString();
  const checkedToday = state.last_check_in_date === today;
  const nextDay = [1, 2, 3, 4, 5, 6, 7].find((d) => !state.checked_in_days.includes(d)) || 1;

  const daysRow = el(
    'div',
    { className: 'attendance-row' },
    ...[1, 2, 3, 4, 5, 6, 7].map((day) => {
      const claimed = state.checked_in_days.includes(day);
      return el(
        'div',
        { className: `attendance-day ${claimed ? 'claimed' : ''}` },
        el('span', { className: 'attendance-d' }, `D${day}`),
        el('span', { className: 'attendance-icon' }, svgIcon(claimed ? 'check' : 'star', 16)),
        el('span', { className: 'attendance-pts tabular-nums' }, '+100')
      );
    })
  );

  const ctaBtn = el(
    'button',
    {
      type: 'button',
      className: `attendance-cta-btn ${checkedToday ? 'claimed' : ''}`,
      disabled: checkedToday,
      onClick: () => {
        const res = checkIn(nextDay);
        updatePointsLabels();
        showToast(res.message, res.ok ? 'success' : 'error');
        openDailySheet();
      },
    },
    checkedToday ? 'Checked-In Today!' : 'Check-In Now (+100 Points)'
  );

  openSheet('Daily Attendance Rewards', [
    el('p', { className: 'sheet-subtitle' }, 'Check in daily to earn +100 Points and claim exclusive reading coupons!'),
    daysRow,
    ctaBtn,
  ]);
}

function openWalletSheet() {
  const state = loadUserState();

  const codeInput = el('input', {
    type: 'text',
    className: 'wallet-code-input',
    placeholder: 'MANGA999 or NHENTAI',
    enterkeyhint: 'done',
    autocapitalize: 'characters',
    autocorrect: 'off',
    'aria-label': 'Redeem Gift Code',
  });

  const redeemForm = el(
    'form',
    {
      className: 'wallet-redeem-row',
      onSubmit: (e) => {
        e.preventDefault();
        const res = redeemCode(codeInput.value);
        updatePointsLabels();
        showToast(res.message, res.ok ? 'success' : 'error');
        openWalletSheet();
      },
    },
    codeInput,
    el('button', { type: 'submit', className: 'btn btn-primary wallet-apply-btn' }, 'Apply')
  );

  const shopCards = el(
    'div',
    { className: 'wallet-rewards-grid' },
    ...SHOP_ITEMS.map((item) => {
      const canAfford = state.points >= item.cost;
      return el(
        'div',
        { className: 'wallet-reward-card' },
        el('strong', { className: 'wallet-reward-name' }, item.label),
        el('span', { className: 'wallet-reward-cost tabular-nums' }, `${item.cost} pts`),
        el(
          'button',
          {
            type: 'button',
            className: `pill-btn compact ${canAfford ? 'btn-primary' : 'btn-surface'}`,
            disabled: !canAfford,
            onClick: () => {
              const res = spendPoints(item.cost, item.name);
              updatePointsLabels();
              showToast(res.message, res.ok ? 'success' : 'error');
              openWalletSheet();
            },
          },
          'Redeem'
        )
      );
    })
  );

  openSheet('Points Wallet & Shop', [
    el(
      'div',
      { className: 'wallet-balance-card' },
      el(
        'div',
        {},
        el('span', { className: 'wallet-balance-label' }, 'Current Balance'),
        el('strong', { className: 'wallet-balance-val tabular-nums' }, `${state.points} pts`)
      ),
      el('span', { className: 'wallet-balance-icon', 'aria-hidden': 'true' }, svgIcon('coin', 34))
    ),
    el('div', { className: 'sheet-group' }, el('span', { className: 'sheet-group-label' }, 'Redeem Gift Code'), redeemForm),
    el('div', { className: 'sheet-group' }, el('span', { className: 'sheet-group-label' }, 'Claim Rewards'), shopCards),
  ]);
}

function couponTitleFor(code) {
  if (code.startsWith('DAILY-DAY-')) return 'Attendance Coupon';
  if (code.startsWith('VIP-CODE-')) return 'VIP Gift Voucher';
  if (code.startsWith('REDEEM-')) return 'Reward Pass';
  if (code === 'LUCKY-RED') return 'Lucky Bonus Voucher';
  return 'Premium Welcome Voucher';
}

function openCouponsSheet() {
  const { coupons } = loadUserState();
  openSheet('My Coupons & Tickets', [
    el('p', { className: 'sheet-subtitle' }, 'Use coupons to unlock sponsored chapters, prefetch speedups, and HQ quality!'),
    el(
      'div',
      { className: 'coupons-sheet-list' },
      ...coupons.map((code) =>
        el(
          'div',
          { className: 'coupon-ticket-row' },
          el('span', { className: 'coupon-ticket-icon', 'aria-hidden': 'true' }, svgIcon('ticket', 20)),
          el(
            'div',
            { className: 'coupon-ticket-info' },
            el('strong', {}, couponTitleFor(code)),
            el('span', {}, `Code: ${code}`)
          ),
          el('span', { className: 'coupon-active-pill' }, 'Active')
        )
      )
    ),
  ]);
}

// --- Screen 1: Home (`/`) — Exact Kinetic Reader Layout ---

async function mountHomeView(container, { restoreCache = false, forceRefresh = false } = {}) {
  const cleanups = [];
  const abortController = new AbortController();
  cleanups.push(() => abortController.abort());

  let currentPage = 1;
  let totalPages = 1;
  let loadingMore = false;
  const loadedIds = new Set();
  const loadedItems = [];

  const heroHost = el('div', { className: 'kinetic-hero-host' });
  const weeklyTrack = el('div', { className: 'weekly-track' });
  const recommendCountBadge = el('span', { className: 'section-count-badge sky tabular-nums' }, '25+');
  const gridEl = el('div', { className: 'manga-grid' });
  const loadMoreHost = el('div', { className: 'load-more-host' });
  const sentinel = el('div', { className: 'scroll-sentinel', 'aria-hidden': 'true' });

  const { points } = loadUserState();
  const quickRow = el(
    'section',
    { className: 'kinetic-quick-grid', 'aria-label': 'Tiện ích nhanh' },
    buildPastelAction('Ranking', 'trophy', 'gold', openRankingSheet),
    buildPastelAction('Daily', 'calendar', 'mint', openDailySheet),
    buildPastelAction(`${points} pts`, 'coin', 'coral', openWalletSheet, true),
    buildPastelAction('Coupons', 'ticket', 'pink', openCouponsSheet)
  );

  const tipBanner = el(
    'div',
    { className: 'kinetic-tip-card' },
    el('span', { className: 'tip-icon-box', 'aria-hidden': 'true' }, svgIcon('bolt', 18)),
    el(
      'div',
      { className: 'tip-text-col' },
      el('strong', {}, 'Mẹo trải nghiệm mượt mà'),
      el('p', {}, 'Mở 1 lần đọc để ảnh tải siêu tốc và mượt nhất nhé!')
    )
  );

  const weeklySection = el(
    'section',
    { className: 'home-section', 'aria-label': 'Weekly Crazy Update' },
    el(
      'div',
      { className: 'kinetic-section-head' },
      el('h2', { className: 'kinetic-section-title' }, 'Weekly Crazy Update'),
      el('span', { className: 'live-pill' }, 'LIVE')
    ),
    weeklyTrack
  );

  const recommendSection = el(
    'section',
    { className: 'home-section', 'aria-label': 'Recommend For You' },
    el(
      'div',
      { className: 'kinetic-section-head' },
      el('h2', { className: 'kinetic-section-title' }, 'Recommend For You'),
      recommendCountBadge
    ),
    gridEl,
    loadMoreHost,
    sentinel
  );

  const homeWrap = el(
    'div',
    { className: 'home-layout' },
    heroHost,
    el('div', { className: 'home-curved-sheet' }, quickRow, tipBanner, weeklySection, recommendSection)
  );
  container.replaceChildren(homeWrap);

  function buildPastelAction(label, icon, tone, onClick, isPoints = false) {
    return el(
      'button',
      { type: 'button', className: `pastel-action-btn tone-${tone}`, onClick },
      el('span', { className: 'pastel-icon-tile', 'aria-hidden': 'true' }, svgIcon(icon, 21)),
      el('span', { className: 'pastel-action-label tabular-nums', dataset: isPoints ? { pointsLabel: '' } : {} }, label)
    );
  }

  function renderHeroBanner(popularList) {
    const items = (popularList || []).slice(0, 6);
    if (!items.length) {
      heroHost.replaceChildren();
      return;
    }

    const track = el(
      'div',
      { className: 'carousel-track', tabindex: '0', role: 'group', 'aria-label': 'Truyện thịnh hành' },
      ...items.map((book, idx) => {
        const title = getBookTitle(book);
        const cover = getBookCoverUrl(book);
        const priority = idx === 0 ? 'high' : 'low';
        return el(
          'a',
          {
            href: `/manga/${book.id}`,
            className: 'kinetic-hero-slide',
            role: 'group',
            'aria-roledescription': 'slide',
            'aria-label': `${idx + 1} / ${items.length}: ${title}`,
            dataset: { markerName: `Trending ${idx + 1}: ${title}` },
            onClick: (e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              openBookDetail(book, e.currentTarget);
            },
          },
          createMangaImg(cover, title, { priority, className: 'kinetic-hero-img', width: 500, height: 680 }),
          el(
            'div',
            { className: 'kinetic-hero-overlay' },
            el(
              'div',
              { className: 'hero-pill-row tabular-nums' },
              el('span', { className: 'trending-pill' }, `TRENDING #${idx + 1}`),
              el('span', { className: 'pages-glass-pill' }, `${book.num_pages || 0} PAGES`)
            ),
            el('h1', { className: 'kinetic-hero-title' }, title)
          )
        );
      })
    );

    const carousel = el(
      'section',
      { className: 'carousel kinetic-hero-carousel', 'aria-roledescription': 'carousel', 'aria-label': 'Truyện nổi bật' },
      el(
        'div',
        { className: 'carousel-controls' },
        el('button', { type: 'button', className: 'carousel-nav-btn', dataset: { direction: 'previous' }, 'aria-label': 'Trước' }, svgIcon('chevronLeft', 20)),
        el('button', { type: 'button', className: 'carousel-nav-btn', dataset: { direction: 'next' }, 'aria-label': 'Tiếp' }, svgIcon('chevronRight', 20))
      ),
      track,
      el('p', { className: 'visually-hidden', role: 'status', 'aria-live': 'polite' }),
      el('nav', { className: 'carousel-markers', 'aria-label': 'Chọn slide nổi bật' })
    );

    heroHost.replaceChildren(carousel);
    cleanups.push(initCarousel(carousel));
  }

  function renderWeeklyUpdate(list) {
    const items = (list || []).slice(0, 8);
    if (!items.length) return;
    weeklyTrack.replaceChildren(
      ...items.map((book) => {
        const title = getBookTitle(book);
        return el(
          'a',
          {
            href: `/manga/${book.id}`,
            className: 'weekly-card',
            onClick: (e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              openBookDetail(book, e.currentTarget);
            },
          },
          createMangaImg(getBookCoverUrl(book), title, { priority: 'lazy', className: 'weekly-card-img', width: 220, height: 220 }),
          el('div', { className: 'weekly-card-scrim' }, el('p', { className: 'weekly-card-title' }, title))
        );
      })
    );
  }

  function renderLoadMoreControl() {
    loadMoreHost.replaceChildren();
    if (loadingMore) {
      loadMoreHost.appendChild(el('div', { className: 'inline-loader' }, el('span', { className: 'spinner small' }), 'Đang tải thêm...'));
      return;
    }
    if (currentPage < totalPages) {
      loadMoreHost.appendChild(
        el('button', { type: 'button', className: 'btn btn-surface', onClick: () => loadMoreHome() }, `Tải thêm (Trang ${currentPage + 1} / ${totalPages})`)
      );
    }
  }

  function syncHomeCache() {
    homeCache = {
      popularList: cachedPopularList,
      items: loadedItems.slice(),
      currentPage,
      totalPages,
    };
  }

  async function loadMoreHome() {
    if (loadingMore || currentPage >= totalPages) return;
    loadingMore = true;
    renderLoadMoreControl();
    try {
      const nextPage = currentPage + 1;
      const data = await fetchGalleries(nextPage, 25, abortController.signal);
      totalPages = data.num_pages || totalPages;
      currentPage = nextPage;
      const frag = document.createDocumentFragment();
      for (const item of data.result || []) {
        if (loadedIds.has(item.id)) continue;
        loadedIds.add(item.id);
        loadedItems.push(item);
        cacheBook(item);
        frag.appendChild(buildMangaCard(item));
      }
      gridEl.appendChild(frag);
      syncHomeCache();
    } catch (err) {
      if (err.name !== 'AbortError') showToast(err.message || 'Không tải thêm được truyện.', 'error');
    } finally {
      loadingMore = false;
      renderLoadMoreControl();
    }
  }

  async function refreshFirstPage() {
    try {
      const data = await fetchGalleries(1, 25, abortController.signal);
      totalPages = data.num_pages || totalPages;
      const prependFrag = document.createDocumentFragment();
      const newItems = [];
      for (const item of data.result || []) {
        if (!loadedIds.has(item.id)) {
          loadedIds.add(item.id);
          newItems.push(item);
          cacheBook(item);
          prependFrag.appendChild(buildMangaCard(item));
        }
      }
      if (prependFrag.childNodes.length > 0) {
        loadedItems.unshift(...newItems);
        gridEl.prepend(prependFrag);
        syncHomeCache();
      }
    } catch {
      // Silent background refresh failure
    }
  }

  async function loadInitial() {
    if (!forceRefresh && homeCache?.items?.length) {
      cachedPopularList = homeCache.popularList || [];
      totalPages = homeCache.totalPages || 1;
      currentPage = homeCache.currentPage || 1;
      renderHeroBanner(cachedPopularList);
      renderWeeklyUpdate(cachedPopularList);
      recommendCountBadge.textContent = `${homeCache.items.length}+`;
      gridEl.replaceChildren();
      const frag = document.createDocumentFragment();
      let cardIdx = 0;
      for (const item of homeCache.items) {
        if (loadedIds.has(item.id)) continue;
        loadedIds.add(item.id);
        loadedItems.push(item);
        frag.appendChild(buildMangaCard(item, { index: cardIdx++, noAnim: restoreCache }));
      }
      gridEl.appendChild(frag);
      renderLoadMoreControl();
      return;
    }

    gridEl.replaceChildren(...buildSkeletonGrid(6).children);
    loadMoreHost.replaceChildren();
    loadedIds.clear();
    loadedItems.length = 0;
    currentPage = 1;

    const [popularRes, latestRes] = await Promise.allSettled([
      fetchPopular(abortController.signal),
      fetchGalleries(1, 25, abortController.signal),
    ]);

    if (abortController.signal.aborted) return;

    if (popularRes.status === 'fulfilled') {
      cachedPopularList = popularRes.value || [];
      cachedPopularList.forEach(cacheBook);
      renderHeroBanner(cachedPopularList);
      renderWeeklyUpdate(cachedPopularList);
    }

    if (latestRes.status === 'fulfilled') {
      const data = latestRes.value;
      totalPages = data.num_pages || 1;
      const list = data.result || [];
      recommendCountBadge.textContent = `${list.length}+`;
      if (!cachedPopularList.length && list.length) {
        cachedPopularList = list;
        renderHeroBanner(list);
        renderWeeklyUpdate(list);
      }
      gridEl.replaceChildren();
      const frag = document.createDocumentFragment();
      let cardIdx = 0;
      for (const item of list) {
        if (loadedIds.has(item.id)) continue;
        loadedIds.add(item.id);
        loadedItems.push(item);
        cacheBook(item);
        frag.appendChild(buildMangaCard(item, { index: cardIdx++ }));
      }
      gridEl.appendChild(frag);
      renderLoadMoreControl();
      syncHomeCache();
    } else {
      gridEl.replaceChildren();
      loadMoreHost.replaceChildren(buildErrorPanel(latestRes.reason, loadInitial));
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreHome();
    },
    { root: isStandaloneMode() ? appStage : null, rootMargin: '400px 0px' }
  );
  io.observe(sentinel);
  cleanups.push(() => io.disconnect());

  // Auto-refresh every 60 seconds per spec
  const refreshInterval = setInterval(() => {
    if (!document.hidden && loadedIds.size > 0) refreshFirstPage();
  }, 60000);
  cleanups.push(() => clearInterval(refreshInterval));
  cleanups.push(() => revokeObjectUrls(homeWrap));

  await loadInitial();
  return () => cleanups.forEach((fn) => fn());
}

// --- Screen 2: Search (`/search`) — Exact Kinetic Search & Discover Empty State ---

async function mountSearchView(container, { q: initialQuery, sort: initialSort }, { restoreCache = false, forceRefresh = false } = {}) {
  const cleanups = [];
  let abortController = new AbortController();
  cleanups.push(() => abortController.abort());

  let query = initialQuery || '';
  let sort = initialSort || 'popular';
  let currentPage = 1;
  let totalPages = 1;
  let totalResults = 0;
  let loadingMore = false;
  const loadedIds = new Set();
  const loadedItems = [];
  const getCacheKey = () => `${query}|${sort}`;

  const searchInput = el('input', {
    type: 'search',
    className: 'search-input',
    placeholder: 'Search tags, titles, or #ID...',
    value: query,
    enterkeyhint: 'search',
    autocapitalize: 'none',
    autocorrect: 'off',
    'aria-label': 'Tìm kiếm truyện theo từ khóa, tag hoặc ID',
  });

  const searchForm = el(
    'form',
    {
      className: 'kinetic-search-bar',
      role: 'search',
      onSubmit: (e) => {
        e.preventDefault();
        query = searchInput.value.trim();
        syncUrlAndRun();
      },
    },
    (Number(window.history.state?.stackIdx) || 0) > 0
      ? el(
          'button',
          {
            type: 'button',
            className: 'search-back-icon',
            'aria-label': 'Quay lại',
            onClick: () => goBack('/'),
          },
          svgIcon('back', 19)
        )
      : null,
    searchInput,
    el(
      'button',
      { type: 'submit', className: 'search-submit-icon', 'aria-label': 'Tìm kiếm' },
      svgIcon('search', 19)
    )
  );

  const sortRow = el(
    'div',
    { className: 'sort-pill-row', role: 'group', 'aria-label': 'Sắp xếp kết quả' },
    ...SORT_OPTIONS.map((opt) =>
      el(
        'button',
        {
          type: 'button',
          className: `sort-pill-btn ${sort === opt.value ? 'active' : ''}`,
          dataset: { sortVal: opt.value },
          onClick: () => {
            sort = opt.value;
            for (const b of sortRow.querySelectorAll('.sort-pill-btn')) {
              b.classList.toggle('active', b.dataset.sortVal === sort);
            }
            if (query) syncUrlAndRun();
          },
        },
        opt.label
      )
    )
  );

  const contentHost = el('div', { className: 'search-content-host' });
  const loadMoreHost = el('div', { className: 'load-more-host' });
  const sentinel = el('div', { className: 'scroll-sentinel', 'aria-hidden': 'true' });

  const pageWrap = el(
    'div',
    { className: 'page-container search-page' },
    searchForm,
    sortRow,
    contentHost,
    loadMoreHost,
    sentinel
  );
  container.replaceChildren(pageWrap);

  function buildDiscoverEmpty() {
    return el(
      'section',
      { className: 'discover-empty-state' },
      el('div', { className: 'discover-icon-box coral', 'aria-hidden': 'true' }, svgIcon('search', 28)),
      el('h1', { className: 'discover-title' }, 'Discover Something New'),
      el('p', { className: 'discover-desc' }, 'Search by title, artist, tag, or enter a 6-digit gallery code directly.'),
      el('p', { className: 'quick-searches-heading' }, svgIcon('flame', 15), 'Quick Searches'),
      el(
        'div',
        { className: 'quick-tags-wrap' },
        ...QUICK_TAGS.map((tag) =>
          el(
            'button',
            {
              type: 'button',
              className: 'hash-tag-pill',
              onClick: () => {
                query = tag;
                searchInput.value = tag;
                syncUrlAndRun();
              },
            },
            `#${tag}`
          )
        )
      )
    );
  }

  function syncUrlAndRun() {
    const qs = new URLSearchParams();
    if (query) qs.set('q', query);
    if (sort && sort !== 'popular') qs.set('sort', sort);
    window.history.replaceState(window.history.state, '', `/search${qs.toString() ? `?${qs}` : ''}`);
    runSearch(true);
  }

  let gridEl = null;

  function renderLoadMore() {
    loadMoreHost.replaceChildren();
    if (loadingMore) {
      loadMoreHost.appendChild(el('div', { className: 'inline-loader' }, el('span', { className: 'spinner small' }), 'Đang tải thêm...'));
      return;
    }
    if (query && !/^\d+$/.test(query) && currentPage < totalPages) {
      loadMoreHost.appendChild(
        el('button', { type: 'button', className: 'btn btn-surface', onClick: () => loadMoreSearch() }, `Tải thêm (Trang ${currentPage + 1} / ${totalPages})`)
      );
    }
  }

  function syncSearchCache() {
    if (!query) return;
    searchCache.set(getCacheKey(), {
      items: loadedItems.slice(),
      totalResults,
      currentPage,
      totalPages,
    });
    if (searchCache.size > 16) {
      const oldest = searchCache.keys().next().value;
      searchCache.delete(oldest);
    }
  }

  async function runSearch(skipCache = false) {
    abortController.abort();
    abortController = new AbortController();
    loadedIds.clear();
    loadedItems.length = 0;
    currentPage = 1;
    totalPages = 1;
    totalResults = 0;
    gridEl = null;
    loadMoreHost.replaceChildren();

    if (!query) {
      contentHost.replaceChildren(buildDiscoverEmpty());
      return;
    }

    const cached = !skipCache && !forceRefresh ? searchCache.get(getCacheKey()) : null;
    if (cached?.items?.length) {
      totalPages = cached.totalPages || 1;
      currentPage = cached.currentPage || 1;
      totalResults = cached.totalResults || cached.items.length;
      gridEl = el('div', { className: 'manga-grid' });
      const frag = document.createDocumentFragment();
      let cardIdx = 0;
      for (const item of cached.items) {
        loadedIds.add(item.id);
        loadedItems.push(item);
        frag.appendChild(buildMangaCard(item, { index: cardIdx++, noAnim: restoreCache }));
      }
      gridEl.appendChild(frag);
      const summary = /^\d+$/.test(query)
        ? `Gallery #${cached.items[0].id}`
        : `${formatNumber(totalResults)} kết quả cho "${query}"`;
      contentHost.replaceChildren(el('p', { className: 'search-summary tabular-nums' }, summary), gridEl);
      renderLoadMore();
      return;
    }

    contentHost.replaceChildren(buildSkeletonGrid(6));

    // Direct numeric ID lookup per spec (^\d+$)
    if (/^\d+$/.test(query)) {
      try {
        const book = await fetchBook(query, abortController.signal);
        cacheBook(book);
        loadedIds.add(book.id);
        loadedItems.push(book);
        totalResults = 1;
        gridEl = el('div', { className: 'manga-grid' }, buildMangaCard(book));
        contentHost.replaceChildren(el('p', { className: 'search-summary' }, `Gallery #${book.id}`), gridEl);
        syncSearchCache();
      } catch (err) {
        if (err.name === 'AbortError') return;
        contentHost.replaceChildren(buildErrorPanel(err, () => runSearch(true)));
      }
      return;
    }

    try {
      const data = await searchGalleries(query, 1, sort, abortController.signal);
      totalPages = data.num_pages || 1;
      const items = data.result || [];
      totalResults = data.total || items.length;
      if (!items.length) {
        contentHost.replaceChildren(
          el('section', { className: 'state-panel' }, el('p', {}, `Không tìm thấy kết quả cho "${query}".`))
        );
        return;
      }
      gridEl = el('div', { className: 'manga-grid' });
      const frag = document.createDocumentFragment();
      let cardIdx = 0;
      for (const item of items) {
        loadedIds.add(item.id);
        loadedItems.push(item);
        cacheBook(item);
        frag.appendChild(buildMangaCard(item, { index: cardIdx++ }));
      }
      gridEl.appendChild(frag);
      contentHost.replaceChildren(
        el('p', { className: 'search-summary tabular-nums' }, `${formatNumber(totalResults)} kết quả cho "${query}"`),
        gridEl
      );
      renderLoadMore();
      syncSearchCache();
    } catch (err) {
      if (err.name === 'AbortError') return;
      contentHost.replaceChildren(buildErrorPanel(err, () => runSearch(true)));
    }
  }

  async function loadMoreSearch() {
    if (loadingMore || !gridEl || !query || /^\d+$/.test(query) || currentPage >= totalPages) return;
    loadingMore = true;
    renderLoadMore();
    try {
      const nextPage = currentPage + 1;
      const data = await searchGalleries(query, nextPage, sort, abortController.signal);
      totalPages = data.num_pages || totalPages;
      currentPage = nextPage;
      const frag = document.createDocumentFragment();
      for (const item of data.result || []) {
        if (loadedIds.has(item.id)) continue;
        loadedIds.add(item.id);
        loadedItems.push(item);
        cacheBook(item);
        frag.appendChild(buildMangaCard(item));
      }
      gridEl.appendChild(frag);
      syncSearchCache();
    } catch (err) {
      if (err.name !== 'AbortError') showToast(err.message || 'Lỗi tải thêm kết quả.', 'error');
    } finally {
      loadingMore = false;
      renderLoadMore();
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreSearch();
    },
    { root: isStandaloneMode() ? appStage : null, rootMargin: '400px 0px' }
  );
  io.observe(sentinel);
  cleanups.push(() => io.disconnect());
  cleanups.push(() => revokeObjectUrls(pageWrap));

  await runSearch();
  return () => cleanups.forEach((fn) => fn());
}

// --- Screens 3, 4, 5: Favorites, History, Downloads ---

async function mountCollectionView(container, kind) {
  const configs = {
    favorites: {
      title: 'My Favorites',
      subtitle: 'Books you loved and bookmarked',
      tone: 'pink',
      icon: 'heart',
      emptyTitle: 'No Favorites Yet',
      emptyDesc: 'Tap the heart button on any manga to bookmark it here.',
      fetchList: getFavorites,
    },
    history: {
      title: 'Reading History',
      subtitle: 'Pick up right where you left off',
      tone: 'amber',
      icon: 'history',
      emptyTitle: 'No Reading History',
      emptyDesc: 'Chapters you read will automatically appear here with your last page saved.',
      fetchList: getHistory,
    },
    downloads: {
      title: 'Downloaded Books',
      subtitle: 'Available offline anytime',
      tone: 'sky',
      icon: 'download',
      emptyTitle: 'No Offline Downloads',
      emptyDesc: 'Download your favorite titles from their detail page for instant offline reading.',
      fetchList: getDownloads,
    },
  };
  const cfg = configs[kind];

  const pageWrap = el('div', { className: 'page-container collection-page' });
  container.replaceChildren(pageWrap);

  async function renderList() {
    const records = await cfg.fetchList();
    await refreshLibraryStats();
    revokeObjectUrls(pageWrap);

    const header = el(
      'div',
      { className: 'collection-header' },
      el(
        'div',
        { className: 'collection-title-row' },
        el('h1', { className: 'collection-title' }, cfg.title),
        records.length > 0
          ? el('span', { className: `collection-badge tone-${cfg.tone} tabular-nums` }, String(records.length))
          : null
      ),
      el('p', { className: 'collection-subtitle' }, cfg.subtitle)
    );

    if (!records.length) {
      pageWrap.replaceChildren(
        header,
        el(
          'section',
          { className: 'discover-empty-state' },
          el('div', { className: `discover-icon-box ${cfg.tone}`, 'aria-hidden': 'true' }, svgIcon(cfg.icon, 28)),
          el('h2', { className: 'discover-title' }, cfg.emptyTitle),
          el('p', { className: 'discover-desc' }, cfg.emptyDesc),
          el(
            'button',
            {
              type: 'button',
              className: `btn ${cfg.tone === 'sky' ? 'btn-sky' : 'btn-primary'}`,
              onClick: () => navigate('/'),
            },
            'Explore Manga'
          )
        )
      );
      return;
    }

    const grid = el(
      'div',
      { className: 'manga-grid' },
      ...records.map((rec, idx) => {
        const book = rec.bookJson || { id: rec.id, num_pages: rec.totalPages };
        const progressBadge =
          kind === 'history' ? `${rec.lastReadPage}/${rec.totalPages || book.num_pages || '?'}` : null;

        return buildMangaCard(book, {
          meta: rec,
          progressBadge,
          index: idx,
          onDelete: async () => {
            if (kind === 'history') await clearHistoryItem(rec.id);
            else if (kind === 'favorites') await toggleFavorite(book);
            else if (kind === 'downloads') {
              await removeBookCache(book);
              await setDownloaded(book, false);
              showToast('Đã xóa bản lưu offline.');
            }
            renderList();
          },
        });
      })
    );

    pageWrap.replaceChildren(header, grid);
  }

  await renderList();
  return () => revokeObjectUrls(pageWrap);
}

// --- Screen 6: Detail (`/manga/:id`) — Instant Hero Cover Fly-In + Gentle Backdrop & Text Fade ---

async function mountDetailView(container, { id }, { isPop = false, forceRefresh = false } = {}) {
  const cleanups = [];
  const abortController = new AbortController();
  let downloadAbort = null;
  cleanups.push(() => abortController.abort());
  cleanups.push(() => downloadAbort?.abort());

  const numId = Number(id);
  const hero =
    !isPop &&
    pendingHeroTransition?.type === 'to-detail' &&
    pendingHeroTransition.id === numId &&
    performance.now() - pendingHeroTransition.ts < 1800
      ? pendingHeroTransition
      : null;
  if (hero) pendingHeroTransition = null;

  const pageWrap = el('div', { className: `detail-layout ${isPop ? 'no-entry-anim' : ''}`.trim() });
  container.replaceChildren(pageWrap);

  const cachedBook = !forceRefresh ? bookMemoryCache.get(numId) : null;
  let meta = await getMetadata(id);
  let book = cachedBook?.pages?.length
    ? cachedBook
    : hero?.book || cachedBook || meta?.bookJson || null;
  let offlineFallbackUsed = false;

  if (!book) {
    pageWrap.replaceChildren(
      el(
        'div',
        { className: 'page-container' },
        el('div', { className: 'state-panel' }, el('div', { className: 'spinner' }), el('p', {}, `Đang tải truyện #${id}...`))
      )
    );
    try {
      book = await fetchBook(id, abortController.signal);
      cacheBook(book);
      meta = await upsertMetadata(book);
    } catch (err) {
      if (err.name === 'AbortError') return () => {};
      pageWrap.replaceChildren(
        el('div', { className: 'page-container' }, buildErrorPanel(err, () => navigate(`/manga/${id}`, { replace: true })))
      );
      return () => cleanups.forEach((fn) => fn());
    }
  }

  let isFavorite = Boolean(meta?.isFavorite);
  let isDownloaded = Boolean(meta?.isDownloaded);
  let lastReadPage = meta?.lastReadPage || 0;
  let totalPages = book.num_pages || book.pages?.length || meta?.totalPages || 0;
  const title = getBookTitle(book);
  const initialCoverUrl = hero?.imgSrc || getBookCoverUrl(book);

  const downloadStatusEl = el('p', { className: 'download-progress-text' });
  let downloading = false;

  const downloadBtn = el(
    'button',
    {
      type: 'button',
      className: `detail-circle-btn glass-clear ${isDownloaded ? 'is-downloaded' : ''}`,
      'aria-label': isDownloaded ? 'Xóa bản tải offline' : 'Tải offline',
      title: isDownloaded ? 'Đã lưu offline (nhấn để xóa)' : 'Tải offline',
      onClick: async () => {
        if (downloading) {
          downloadAbort?.abort();
          return;
        }
        if (isDownloaded) {
          await removeBookCache(book);
          await setDownloaded(book, false);
          await refreshLibraryStats();
          isDownloaded = false;
          downloadBtn.classList.remove('is-downloaded');
          downloadStatusEl.textContent = '';
          showToast('Đã xóa bản lưu offline.');
          return;
        }
        if (!book?.pages?.length) {
          showToast('Đang tải dữ liệu trang, thử lại sau giây lát.');
          return;
        }
        downloading = true;
        downloadAbort = new AbortController();
        downloadBtn.replaceChildren(svgIcon('close', 18));
        downloadStatusEl.textContent = `Đang tải offline 0 / ${totalPages} trang...`;
        try {
          await downloadBookPages(book, {
            signal: downloadAbort.signal,
            onProgress: (done, total) => {
              downloadStatusEl.textContent = `Đang lưu offline: ${done} / ${total} trang (${Math.round((done / total) * 100)}%)`;
            },
          });
          await setDownloaded(book, true);
          await refreshLibraryStats();
          isDownloaded = true;
          downloadBtn.classList.add('is-downloaded');
          downloadStatusEl.textContent = `Đã lưu đủ ${totalPages} trang để đọc offline.`;
          showToast('Tải offline thành công!', 'success');
        } catch (err) {
          downloadStatusEl.textContent = err.name === 'AbortError' ? 'Đã hủy tải xuống.' : (err.message || 'Lỗi tải offline.');
          if (err.name !== 'AbortError') showToast(err.message || 'Tải offline thất bại.', 'error');
        } finally {
          downloading = false;
          downloadAbort = null;
          downloadBtn.replaceChildren(svgIcon('download', 19));
        }
      },
    },
    svgIcon('download', 19)
  );

  const favBtn = el(
    'button',
    {
      type: 'button',
      className: `detail-circle-btn glass-clear ${isFavorite ? 'is-fav' : ''}`,
      'aria-label': isFavorite ? 'Bỏ yêu thích' : 'Yêu thích',
      'aria-pressed': String(isFavorite),
      onClick: async () => {
        const updated = await toggleFavorite(book);
        isFavorite = updated.isFavorite;
        await refreshLibraryStats();
        favBtn.classList.toggle('is-fav', isFavorite);
        favBtn.setAttribute('aria-pressed', String(isFavorite));
        favBtn.replaceChildren(svgIcon(isFavorite ? 'heart' : 'heartOutline', 19));
        showToast(isFavorite ? 'Đã thêm vào Favorites.' : 'Đã bỏ khỏi Favorites.');
      },
    },
    svgIcon(isFavorite ? 'heart' : 'heartOutline', 19)
  );

  const topActionRow = el(
    'div',
    { className: 'detail-top-bar' },
    el(
      'button',
      {
        type: 'button',
        className: 'detail-circle-btn glass-clear',
        'aria-label': 'Quay lại',
        onClick: () => goBack('/'),
      },
      svgIcon('back', 19)
    ),
    el('div', { className: 'detail-top-right' }, downloadBtn, favBtn)
  );

  // Blurred cover backdrop fades in gently behind header (never flies; uses proxy/cache fallback too)
  const bannerBackdrop = initialCoverUrl
    ? createMangaImg(initialCoverUrl, '', { priority: 'high', className: 'detail-banner-bg' })
    : null;
  if (bannerBackdrop) bannerBackdrop.setAttribute('aria-hidden', 'true');

  const bannerWash = el(
    'div',
    { className: 'detail-banner-wash' },
    bannerBackdrop,
    el('div', { className: 'detail-banner-scrim', 'aria-hidden': 'true' }),
    topActionRow
  );

  const coverImg = createMangaImg(initialCoverUrl, title, {
    priority: 'high',
    className: 'detail-cover-img',
    width: 240,
    height: 340,
  });
  const coverBox = el('div', { className: `detail-cover-box ${hero ? 'is-hero-flying' : ''}`.trim() }, coverImg);

  const offlinePillSlot = el('span', { className: 'offline-pill', hidden: !offlineFallbackUsed }, 'Offline Cache');
  const titleEl = el('h1', { className: 'detail-title detail-fade-in', style: { '--fade-delay': '80ms' } }, title);
  const subTitleEl = el(
    'p',
    { className: 'detail-subtitle detail-fade-in', style: { '--fade-delay': '130ms' }, hidden: !getBookSubTitle(book) },
    getBookSubTitle(book) || ''
  );
  const statsRow = el('div', {
    className: 'detail-inline-stats tabular-nums detail-fade-in',
    style: { '--fade-delay': '170ms' },
  });

  function renderStats(b) {
    totalPages = b.num_pages || b.pages?.length || meta?.totalPages || 0;
    const sub = getBookSubTitle(b);
    subTitleEl.textContent = sub || '';
    subTitleEl.hidden = !sub;
    statsRow.replaceChildren(
      el('span', { className: 'inline-stat gold' }, svgIcon('book', 14), `${totalPages} pgs`),
      el('span', { className: 'inline-stat pink' }, svgIcon('heart', 14), formatNumber(b.num_favorites || 0)),
      b.upload_date ? el('span', { className: 'inline-stat muted' }, formatUnixDate(b.upload_date)) : null
    );
  }
  renderStats(book);

  const heroRow = el(
    'div',
    { className: 'detail-header-row' },
    coverBox,
    el('div', { className: 'detail-meta-col' }, offlinePillSlot, titleEl, subTitleEl, statsRow)
  );

  const readCtaLabel = el('span', {}, lastReadPage > 0 ? `CONTINUE READING (PG ${lastReadPage})` : 'READ NOW');
  const readCtaBtn = el(
    'button',
    {
      type: 'button',
      className: 'read-now-cta detail-fade-in',
      style: { '--fade-delay': '200ms' },
      onClick: () => {
        const startPage = Math.max(1, lastReadPage || 1);
        // Fly the Detail cover down into Page 1 when starting from Page 1
        openBookReader(book, startPage, startPage === 1 ? coverBox : null);
      },
    },
    svgIcon('play', 18),
    readCtaLabel
  );

  const tagsHost = el('div', { className: 'detail-slot detail-fade-in', style: { '--fade-delay': '240ms' } });
  const previewHost = el('div', { className: 'detail-slot detail-fade-in', style: { '--fade-delay': '280ms' } });
  const relatedSection = el('section', { className: 'detail-section detail-fade-in', style: { '--fade-delay': '320ms' } });

  function renderFullSections(fullBook) {
    const tags = fullBook.tags || [];
    if (tags.length) {
      tagsHost.replaceChildren(
        el(
          'section',
          { className: 'detail-section' },
          el(
            'div',
            { className: 'kinetic-section-head' },
            el('h2', { className: 'kinetic-section-title' }, 'Tags'),
            el('span', { className: 'tags-count-label tabular-nums' }, `(${tags.length})`)
          ),
          el(
            'div',
            { className: 'dot-tags-wrap' },
            ...tags.map((t, i) =>
              el(
                'button',
                {
                  type: 'button',
                  className: 'dot-tag-chip',
                  onClick: () => navigate(`/search?q=${encodeURIComponent(t.name || '')}`),
                },
                el('span', { className: 'tag-color-dot', style: { backgroundColor: TAG_DOT_COLORS[i % TAG_DOT_COLORS.length] }, 'aria-hidden': 'true' }),
                el('span', {}, t.name || '')
              )
            )
          )
        )
      );
    } else {
      tagsHost.replaceChildren();
    }

    const pagesList = fullBook.pages || [];
    if (!pagesList.length) {
      previewHost.replaceChildren();
      return;
    }

    let previewLimit = Math.min(20, pagesList.length);
    const thumbsGrid = el('div', { className: 'thumb-preview-grid' });
    const moreThumbsWrap = el('div', { className: 'load-more-host' });

    function renderPreviewThumbs() {
      thumbsGrid.replaceChildren();
      const frag = document.createDocumentFragment();
      for (let i = 0; i < previewLimit; i++) {
        const p = pagesList[i];
        frag.appendChild(
          el(
            'a',
            {
              href: `/read/${fullBook.id}/${p.number}`,
              className: 'page-thumb-card',
              onClick: (e) => {
                if (e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                openBookReader(fullBook, p.number, p.number === 1 ? coverBox : e.currentTarget);
              },
            },
            createMangaImg(fullThumbUrl(p.thumbnail || p.path, fullBook.media_id), `Trang ${p.number}`, { priority: 'lazy', className: 'page-thumb-img', width: 140, height: 200 }),
            el('span', { className: 'page-thumb-num tabular-nums' }, String(p.number))
          )
        );
      }
      thumbsGrid.appendChild(frag);

      moreThumbsWrap.replaceChildren();
      if (previewLimit < pagesList.length) {
        moreThumbsWrap.appendChild(
          el(
            'button',
            {
              type: 'button',
              className: 'btn btn-surface',
              onClick: () => {
                previewLimit = pagesList.length;
                renderPreviewThumbs();
              },
            },
            `Xem tất cả ${pagesList.length} trang`
          )
        );
      }
    }
    renderPreviewThumbs();

    previewHost.replaceChildren(
      el(
        'section',
        { className: 'detail-section' },
        el('div', { className: 'kinetic-section-head' }, el('h2', { className: 'kinetic-section-title' }, `Preview (${pagesList.length})`)),
        thumbsGrid,
        moreThumbsWrap
      )
    );
  }

  pageWrap.replaceChildren(
    bannerWash,
    el(
      'div',
      { className: 'page-container detail-body-container' },
      heroRow,
      readCtaBtn,
      downloadStatusEl,
      tagsHost,
      previewHost,
      relatedSection
    )
  );

  // Run GPU-composited Menu Cover -> Detail Cover flight immediately using already-decoded cover
  if (hero?.fromRect && hero.imgSrc) {
    const cancelFly = runHeroFlyTransition({
      imgSrc: hero.imgSrc,
      fromRect: hero.fromRect,
      toEl: coverBox,
      fromRadius: hero.borderRadius || '14px',
      toRadius: '16px',
      duration: 360,
      objectFit: 'cover',
      onFinish: () => coverBox.classList.remove('is-hero-flying'),
    });
    cleanups.push(cancelFly);
  }

  if (book.pages?.length || book.tags?.length) {
    renderFullSections(book);
  }

  // Silently hydrate full book data (tags + pages + fresh stats) without reloading cover or flashing spinner
  if (forceRefresh || !book.pages?.length || !book.tags?.length) {
    fetchBook(id, abortController.signal)
      .then(async (fullBook) => {
        if (abortController.signal.aborted) return;
        book = fullBook;
        cacheBook(fullBook);
        meta = await upsertMetadata(fullBook);
        lastReadPage = meta?.lastReadPage || lastReadPage;
        readCtaLabel.textContent = lastReadPage > 0 ? `CONTINUE READING (PG ${lastReadPage})` : 'READ NOW';
        renderStats(fullBook);
        renderFullSections(fullBook);
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        if (meta?.bookJson) {
          book = meta.bookJson;
          offlineFallbackUsed = true;
          offlinePillSlot.hidden = false;
          renderStats(book);
          renderFullSections(book);
        }
      });
  }

  if (!offlineFallbackUsed) {
    fetchRelated(id, abortController.signal)
      .then((related) => {
        if (abortController.signal.aborted || !related?.length) return;
        related.forEach(cacheBook);
        relatedSection.replaceChildren(
          el('div', { className: 'kinetic-section-head' }, el('h2', { className: 'kinetic-section-title' }, 'Related Manga')),
          el('div', { className: 'manga-grid' }, ...related.slice(0, 12).map((b, idx) => buildMangaCard(b, { index: idx, noAnim: isPop })))
        );
      })
      .catch(() => {});
  }

  cleanups.push(() => revokeObjectUrls(pageWrap));
  return () => cleanups.forEach((fn) => fn());
}

// --- Native Web Install Button inside Drawer (install-web-app compliant) ---

function renderDrawerInstallControl() {
  const slot = document.getElementById('drawer-install-slot');
  if (!slot) return;
  const canInstall = !isStandaloneMode() && (supportsWebInstall || Boolean(deferredInstallPrompt));
  if (!canInstall) {
    slot.replaceChildren();
    return;
  }

  const btn = el(
    'button',
    {
      type: 'button',
      className: 'btn btn-primary drawer-install-btn',
      onClick: async () => {
        if (btn.getAttribute('aria-disabled') === 'true') return;
        btn.setAttribute('aria-disabled', 'true');
        try {
          if (supportsWebInstall) {
            await navigator.install();
            showToast('Đã cài đặt hoặc mở ứng dụng MANGA.', 'success');
            slot.replaceChildren();
          } else if (deferredInstallPrompt) {
            const promptEvent = deferredInstallPrompt;
            deferredInstallPrompt = null;
            await promptEvent.prompt();
            const { outcome } = await promptEvent.userChoice;
            showToast(outcome === 'accepted' ? 'Đã thêm ra Màn hình chính!' : 'Đã hủy cài đặt.');
            renderDrawerInstallControl();
          }
        } catch (err) {
          showToast(err?.name === 'AbortError' ? 'Đã hủy cài đặt.' : 'Không thể cài ứng dụng.');
        } finally {
          btn.removeAttribute('aria-disabled');
        }
      },
    },
    svgIcon('download', 16),
    'Cài ra Màn hình chính'
  );

  slot.replaceChildren(btn);
}

// --- Router Dispatcher ---

async function renderRoute({ isPop = false, forceRefresh = false } = {}) {
  if (typeof activeCleanup === 'function') {
    activeCleanup();
    activeCleanup = null;
  }

  // Lock scroll-position saving while restoring a popped route so Detail's scrollY=0 never wipes Home's saved scroll!
  restoringScroll = isPop;

  if (window.history.state?.navId) {
    currentNavId = window.history.state.navId;
  }
  const savedPopY = isPop ? (scrollPositions.get(currentNavId) || 0) : 0;

  const route = parseRoute(window.location.pathname, window.location.search);
  updateActiveNav(route.name);

  if (!isPop && !forceRefresh) {
    setScrollTop(0);
  }
  syncHeaderChromeFn?.();

  await refreshLibraryStats();

  if (route.name === 'home') {
    if (forceRefresh) homeCache = null;
    activeCleanup = await mountHomeView(appMain, { restoreCache: isPop, forceRefresh });
  } else if (route.name === 'search') {
    if (forceRefresh) searchCache.delete(`${route.params.q || ''}|${route.params.sort || 'popular'}`);
    activeCleanup = await mountSearchView(appMain, route.params, { restoreCache: isPop, forceRefresh });
  } else if (route.name === 'favorites' || route.name === 'history' || route.name === 'downloads') {
    activeCleanup = await mountCollectionView(appMain, route.name);
  } else if (route.name === 'detail') {
    activeCleanup = await mountDetailView(appMain, route.params, { isPop, forceRefresh });
  } else if (route.name === 'reader') {
    const numId = Number(route.params.id);
    const readerHero =
      !isPop &&
      pendingHeroTransition?.type === 'to-reader' &&
      pendingHeroTransition.id === numId &&
      performance.now() - pendingHeroTransition.ts < 1800
        ? pendingHeroTransition
        : null;
    if (readerHero) pendingHeroTransition = null;
    const initialBook = readerHero?.book?.pages?.length
      ? readerHero.book
      : bookMemoryCache.get(numId) || null;
    activeCleanup = await mountReaderView(appMain, route.params, navigate, {
      initialBook,
      heroTransition: readerHero,
      goBack,
    });
  }

  // Deterministically restore exact scroll position when going Back (Menu / Tag / Detail)
  if (isPop && route.name !== 'reader') {
    setScrollTop(savedPopY);
    requestAnimationFrame(() => {
      setScrollTop(savedPopY);
      restoringScroll = false;
      syncHeaderChromeFn?.();
    });
  } else {
    restoringScroll = false;
    requestAnimationFrame(() => syncHeaderChromeFn?.());
  }
}

// --- Native Rubber-Band Pull-to-Refresh (List & Detail screens, disabled in Reader) ---

function wirePullToRefresh() {
  const ptrIcon = el('span', { className: 'ptr-icon', 'aria-hidden': 'true' }, svgIcon('refresh', 17));
  const ptrText = el('span', { className: 'ptr-text' }, 'Kéo để làm mới');
  const ptrEl = el('div', { id: 'ptr-indicator', className: 'ptr-indicator', 'aria-hidden': 'true' }, ptrIcon, ptrText);
  document.body.appendChild(ptrEl);

  const THRESHOLD = 58;
  let tracking = false;
  let pulling = false;
  let refreshing = false;
  let startX = 0;
  let startY = 0;
  let currentPull = 0;

  function resetIndicator() {
    ptrEl.classList.remove('is-dragging', 'is-ready', 'is-refreshing');
    ptrEl.style.transform = '';
    ptrEl.style.opacity = '';
    ptrIcon.style.transform = '';
    ptrText.textContent = 'Kéo để làm mới';
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      if (refreshing || !e.touches || e.touches.length !== 1) return;
      if (appShell.classList.contains('is-reader-route') || appSheet.open || appShell.classList.contains('drawer-open')) return;
      if (e.touches[0].clientX <= 24) return; // Reserve left edge strictly for Back swipe
      if (e.target.closest('.carousel-track, .weekly-track, input, textarea, select')) return;
      if (getScrollTop() > 2) return;
      tracking = true;
      pulling = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      currentPull = 0;
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || refreshing || !e.touches || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (!pulling) {
        if (dy < 8 || Math.abs(dx) > Math.abs(dy) * 0.85 || getScrollTop() > 2) {
          if (dy < -4 || Math.abs(dx) > 12) tracking = false;
          return;
        }
        pulling = true;
        ptrEl.classList.add('is-dragging');
      }

      if (dy <= 0) {
        currentPull = 0;
        resetIndicator();
        return;
      }

      e.preventDefault();
      currentPull = rubberband(dy, 155, 0.55);
      const ready = currentPull >= THRESHOLD;
      ptrEl.classList.toggle('is-ready', ready);
      ptrEl.style.opacity = String(Math.min(1, currentPull / 38));
      ptrEl.style.transform = `translate3d(-50%, ${(currentPull - 44).toFixed(1)}px, 0)`;
      ptrIcon.style.transform = `rotate(${(currentPull * 3.4).toFixed(0)}deg)`;
      ptrText.textContent = ready ? 'Thả để tải lại' : 'Kéo để làm mới';
    },
    { passive: false }
  );

  async function finishPull() {
    if (!tracking) return;
    tracking = false;
    if (!pulling) return;
    pulling = false;
    ptrEl.classList.remove('is-dragging');

    if (currentPull >= THRESHOLD && !refreshing) {
      refreshing = true;
      ptrEl.classList.add('is-refreshing');
      ptrEl.style.opacity = '1';
      ptrEl.style.transform = 'translate3d(-50%, 16px, 0)';
      ptrText.textContent = 'Đang làm mới...';
      try {
        await renderRoute({ isPop: false, forceRefresh: true });
        showToast('Đã làm mới trang.', 'success');
      } finally {
        refreshing = false;
        currentPull = 0;
        resetIndicator();
      }
    } else {
      currentPull = 0;
      resetIndicator();
    }
  }

  document.addEventListener('touchend', finishPull, { passive: true });
  document.addEventListener('touchcancel', () => {
    tracking = false;
    pulling = false;
    currentPull = 0;
    if (!refreshing) resetIndicator();
  }, { passive: true });
}

// --- Boot ---

function boot() {
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }
  if (!window.history.state?.navId) {
    window.history.replaceState(
      { navId: currentNavId, stackIdx: 0 },
      '',
      `${window.location.pathname}${window.location.search}`
    );
  }

  wireIosSheet(appSheet);
  document.getElementById('app-sheet-close')?.addEventListener('click', () => closeTopLayer(appSheet));

  appShell.classList.toggle('sidebar-collapsed', loadSidebarCollapsed());
  document.getElementById('menu-open-btn')?.addEventListener('click', openMobileDrawer);
  document.getElementById('drawer-close-btn')?.addEventListener('click', closeMobileDrawer);
  drawerScrim?.addEventListener('click', closeMobileDrawer);

  // Desktop inline Spotlight search
  const toolbarSearchForm = document.getElementById('toolbar-search-form');
  const toolbarSearchInput = document.getElementById('toolbar-search-input');
  toolbarSearchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = toolbarSearchInput.value.trim();
    if (!val) navigate('/search');
    else if (/^\d+$/.test(val)) navigate(`/manga/${val}`);
    else navigate(`/search?q=${encodeURIComponent(val)}`);
    toolbarSearchInput.blur();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const standaloneMql = window.matchMedia('(display-mode: standalone)');
  const syncStandaloneClass = () => {
    document.documentElement.classList.toggle('is-standalone', isStandaloneMode());
    renderDrawerInstallControl();
  };
  syncStandaloneClass();
  standaloneMql.addEventListener?.('change', syncStandaloneClass);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    renderDrawerInstallControl();
  });

  // Smooth progressive header opacity (0 -> 1) on Home scroll + continuous scroll-position saving
  let headerRaf = 0;
  const applyHeaderChrome = () => {
    headerRaf = 0;
    const isHome = appShell.classList.contains('is-home-route');
    const scrollPos = getScrollTop();
    if (!restoringScroll && !appShell.classList.contains('is-reader-route')) {
      scrollPositions.set(currentNavId, scrollPos);
    }
    if (!isHome) {
      topHeader?.style.setProperty('--header-p', '1');
      topHeader?.classList.toggle('is-scrolled', scrollPos > 8);
      return;
    }
    const p = Math.max(0, Math.min(1, (scrollPos - 36) / 160));
    topHeader?.style.setProperty('--header-p', p.toFixed(3));
    topHeader?.classList.toggle('is-scrolled', p > 0.55);
  };
  syncHeaderChromeFn = applyHeaderChrome;
  const onScrollChrome = () => {
    if (!headerRaf) headerRaf = requestAnimationFrame(applyHeaderChrome);
  };
  window.addEventListener('scroll', onScrollChrome, { passive: true });
  appStage?.addEventListener('scroll', onScrollChrome, { passive: true });
  applyHeaderChrome();

  // Single-purpose iPhone left-edge swipe: ONLY goes Back (locked on Home, never opens drawer!)
  let edgeStartX = 0;
  let edgeStartY = 0;
  let edgeTracking = false;
  document.addEventListener(
    'touchstart',
    (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      if (appSheet.open || appShell.classList.contains('drawer-open')) return;
      if (appShell.classList.contains('is-home-route')) return; // Locked on Home
      if (e.target.closest('.carousel-track, .weekly-track, input, select')) return;
      if (e.touches[0].clientX <= 24) {
        edgeTracking = true;
        edgeStartX = e.touches[0].clientX;
        edgeStartY = e.touches[0].clientY;
      } else {
        edgeTracking = false;
      }
    },
    { passive: true }
  );
  document.addEventListener(
    'touchend',
    (e) => {
      if (!edgeTracking || !e.changedTouches || e.changedTouches.length !== 1) return;
      edgeTracking = false;
      const dx = e.changedTouches[0].clientX - edgeStartX;
      const dy = e.changedTouches[0].clientY - edgeStartY;
      if (dx > 68 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        goBack('/');
      }
    },
    { passive: true }
  );
  document.addEventListener('touchcancel', () => {
    edgeTracking = false;
  }, { passive: true });

  wirePullToRefresh();

  // macOS / PC keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (appSheet.open) return;
    if (e.key === 'Escape' && appShell.classList.contains('drawer-open')) {
      closeMobileDrawer();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (window.innerWidth >= 900 && toolbarSearchInput) {
        toolbarSearchInput.focus();
        toolbarSearchInput.select();
      } else {
        navigate('/search');
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault();
      openMobileDrawer();
    }
  });

  initThemeSync();
  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    toggleColorScheme();
  });

  for (const link of document.querySelectorAll('a[data-spa-link]')) {
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const href = link.getAttribute('href') || '/';
      if (href === '/' && `${window.location.pathname}${window.location.search}` === '/') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        appStage?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      navigate(href);
    });
  }

  window.addEventListener('popstate', () => renderRoute({ isPop: true }));
  renderRoute({ isPop: false });
}

boot();
