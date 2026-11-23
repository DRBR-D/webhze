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
  getStoredColorScheme,
  getSystemColorScheme,
  setColorSchemePreference,
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
  wireIosSheet,
  closeTopLayer,
  formatNumber,
  formatRelativeTime,
  formatUnixDate,
  showToast,
  parseRoute,
  initCarousel,
} from './dom.js';
import { mountReaderView } from './reader.js';

const QUICK_TAGS = ['english', 'full color', 'vanilla', 'romance', 'fantasy', 'schoolgirl'];

const REWARD_SHOP = [
  { name: 'THEME-PACK', label: 'Gói giao diện VIP', cost: 150 },
  { name: 'BADGE-GOLD', label: 'Huy hiệu Độc giả Vàng', cost: 250 },
  { name: 'OFFLINE-BOOST', label: 'Thẻ Ưu tiên Tải Offline', cost: 400 },
];

let activeCleanup = null;
let favoriteIdSet = new Set();

const appMain = document.getElementById('app-main');
const appShell = document.getElementById('app-shell');
const topHeader = document.getElementById('top-header');
const toolbarTitleEl = document.getElementById('toolbar-title');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const pointsBadge = document.getElementById('header-points-value');
const rewardsDialog = document.getElementById('rewards-dialog');
const rewardsDialogBody = document.getElementById('rewards-dialog-body');

const ROUTE_TITLES = {
  home: 'Khám phá',
  search: 'Tìm kiếm',
  favorites: 'Yêu thích',
  history: 'Lịch sử đọc',
  downloads: 'Tải offline',
  detail: 'Chi tiết truyện',
  reader: 'Đang đọc',
};

function setToolbarTitle(text) {
  if (toolbarTitleEl) toolbarTitleEl.textContent = text || 'MangaFlow';
}

function setSidebarCollapsed(collapsed) {
  appShell.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtn?.setAttribute('aria-expanded', String(!collapsed));
  saveSidebarCollapsed(collapsed);
}

async function jumpToRandomManga() {
  showToast('Đang chọn truyện ngẫu nhiên...');
  try {
    const randomBook = await fetchRandom();
    if (randomBook?.id) {
      await upsertMetadata(randomBook);
      navigate(`/manga/${randomBook.id}`);
    }
  } catch (err) {
    if (err.name !== 'AbortError') showToast(err.message || 'Không lấy được truyện ngẫu nhiên.', 'error');
  }
}

async function refreshFavoriteIds() {
  const favs = await getFavorites();
  favoriteIdSet = new Set(favs.map((f) => f.id));
}

function updateHeaderPoints() {
  const state = loadUserState();
  if (pointsBadge) pointsBadge.textContent = formatNumber(state.points);
}

function updateActiveNav(routeName) {
  const isReader = routeName === 'reader';
  appShell.classList.toggle('is-reader-route', isReader);
  setToolbarTitle(ROUTE_TITLES[routeName] || 'MangaFlow');

  for (const link of document.querySelectorAll('[data-nav-route]')) {
    const active = link.dataset.navRoute === routeName;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

export function navigate(url, { replace = false } = {}) {
  const next = new URL(url, window.location.origin);
  const full = `${next.pathname}${next.search}`;
  if (full !== `${window.location.pathname}${window.location.search}`) {
    if (replace) window.history.replaceState(null, '', full);
    else window.history.pushState(null, '', full);
  }
  renderRoute();
}

// --- Shared Card & Error UI Builders ---

function buildMangaCard(book, { meta = null, extraFooter = null, onCardOpen = null } = {}) {
  const id = book.id;
  const title = getBookTitle(book);
  const coverUrl = getBookCoverUrl(book);
  const pages = book.num_pages || meta?.totalPages || book.pages?.length || 0;
  const favCount = book.num_favorites ?? 0;
  const isFav = meta?.isFavorite ?? favoriteIdSet.has(id);

  const link = el(
    'a',
    {
      href: `/manga/${id}`,
      className: 'manga-card-link',
      onClick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (onCardOpen) onCardOpen(book);
        else navigate(`/manga/${id}`);
      },
    },
    el(
      'div',
      { className: 'manga-cover-wrap' },
      createMangaImg(coverUrl, title, { priority: 'lazy', className: 'manga-cover-img', width: 250, height: 350 }),
      el('span', { className: 'badge badge-pages' }, `${pages} tr`),
      isFav
        ? el('span', { className: 'badge badge-fav', 'aria-label': 'Đã yêu thích' }, svgIcon('heart', 12))
        : null,
      meta?.isDownloaded
        ? el('span', { className: 'badge badge-offline' }, 'Offline')
        : null
    ),
    el(
      'div',
      { className: 'manga-card-body' },
      el('p', { className: 'manga-card-title' }, title),
      el(
        'div',
        { className: 'manga-card-meta' },
        el('span', {}, `#${id}`),
        favCount > 0 ? el('span', { className: 'meta-fav-count' }, svgIcon('heart', 12), formatNumber(favCount)) : null
      )
    )
  );

  return el('article', { className: 'manga-card' }, link, extraFooter);
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
      el('button', { type: 'button', className: 'btn btn-primary', onClick: onRetry }, svgIcon('refresh', 18), 'Thử lại'),
      el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => navigate('/downloads') }, svgIcon('download', 18), 'Đọc truyện đã tải')
    )
  );
}

function buildSkeletonGrid(count = 8) {
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

// --- Screen 1: Home (`/`) ---

async function mountHomeView(container) {
  const cleanups = [];
  const abortController = new AbortController();
  cleanups.push(() => abortController.abort());

  let currentPage = 1;
  let totalPages = 1;
  let loadingMore = false;
  const loadedIds = new Set();

  const heroSectionHost = el('div', { className: 'hero-host' });
  const refreshStatus = el('span', { className: 'refresh-indicator' }, 'Tự làm mới mỗi 60s');
  const gridEl = el('div', { className: 'manga-grid' });
  const loadMoreHost = el('div', { className: 'load-more-host' });
  const sentinel = el('div', { className: 'scroll-sentinel', 'aria-hidden': 'true' });

  const quickActions = el(
    'section',
    { className: 'quick-actions', 'aria-label': 'Thao tác nhanh' },
    buildQuickAction('Tìm kiếm', 'search', 'coral', () => navigate('/search')),
    buildQuickAction('Yêu thích', 'heart', 'sakura', () => navigate('/favorites')),
    buildQuickAction('Lịch sử', 'history', 'sky', () => navigate('/history')),
    buildQuickAction('Tải về', 'download', 'emerald', () => navigate('/downloads')),
    buildQuickAction('Ngẫu nhiên', 'shuffle', 'amber', handleRandomJump),
    buildQuickAction('Điểm danh', 'gift', 'coral', openRewardsDialog)
  );

  const feedHeader = el(
    'div',
    { className: 'section-header' },
    el(
      'div',
      {},
      el('h2', { className: 'section-title' }, 'Mới cập nhật'),
      refreshStatus
    ),
    el(
      'button',
      {
        type: 'button',
        className: 'pill-btn btn-surface',
        onClick: () => refreshFirstPage(true),
      },
      svgIcon('refresh', 16),
      el('span', {}, 'Làm mới')
    )
  );

  const pageWrap = el(
    'div',
    { className: 'page-container' },
    el('h1', { className: 'ios-large-title' }, 'Khám phá'),
    heroSectionHost,
    quickActions,
    el('section', { className: 'feed-section', 'aria-label': 'Danh sách truyện mới' }, feedHeader, gridEl, loadMoreHost, sentinel)
  );
  container.replaceChildren(pageWrap);

  function buildQuickAction(label, icon, accent, onClick) {
    return el(
      'button',
      { type: 'button', className: `quick-action-pill accent-${accent}`, onClick },
      svgIcon(icon, 18),
      el('span', {}, label)
    );
  }

  async function handleRandomJump() {
    showToast('Đang chọn truyện ngẫu nhiên...');
    try {
      const randomBook = await fetchRandom(abortController.signal);
      if (randomBook?.id) {
        await upsertMetadata(randomBook);
        navigate(`/manga/${randomBook.id}`);
      }
    } catch (err) {
      if (err.name !== 'AbortError') showToast(err.message || 'Không lấy được truyện ngẫu nhiên.', 'error');
    }
  }

  function renderHeroCarousel(popularList) {
    const items = (popularList || []).slice(0, 8);
    if (!items.length) {
      heroSectionHost.replaceChildren();
      return;
    }

    const track = el(
      'div',
      { className: 'carousel-track', tabindex: '0', role: 'group', 'aria-label': 'Truyện phổ biến' },
      ...items.map((book, idx) => {
        const title = getBookTitle(book);
        const cover = getBookCoverUrl(book);
        // optimize-image-priority: LCP first hero slide is fetchpriority="high"; hidden slides are low + lazy
        const priority = idx === 0 ? 'high' : 'low';
        return el(
          'article',
          {
            className: 'hero-slide',
            role: 'group',
            'aria-roledescription': 'slide',
            'aria-label': `${idx + 1} / ${items.length}`,
            dataset: { markerName: `Xem truyện nổi bật ${idx + 1}: ${title}` },
          },
          el(
            'div',
            { className: 'hero-slide-bg', 'aria-hidden': 'true' },
            createMangaImg(cover, '', { priority })
          ),
          el(
            'div',
            { className: 'hero-slide-content' },
            el(
              'div',
              { className: 'hero-poster' },
              createMangaImg(cover, title, { priority, width: 180, height: 252 })
            ),
            el(
              'div',
              { className: 'hero-info' },
              el('h2', { className: 'hero-title' }, title),
              el(
                'div',
                { className: 'hero-meta tabular-nums' },
                el('span', { className: 'meta-pill meta-rank' }, `Top ${idx + 1}`),
                el('span', { className: 'meta-pill' }, `${book.num_pages || 0} trang`),
                el('span', { className: 'meta-pill' }, svgIcon('heart', 13), formatNumber(book.num_favorites || 0)),
                el('span', { className: 'meta-pill' }, `#${book.id}`)
              ),
              el(
                'div',
                { className: 'hero-actions' },
                el(
                  'a',
                  {
                    href: `/manga/${book.id}`,
                    className: 'btn btn-primary',
                    onClick: (e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      e.preventDefault();
                      navigate(`/manga/${book.id}`);
                    },
                  },
                  svgIcon('book', 17),
                  'Xem chi tiết'
                )
              )
            )
          )
        );
      })
    );

    const carouselSection = el(
      'section',
      { className: 'carousel hero-carousel', 'aria-roledescription': 'carousel', 'aria-label': 'Truyện phổ biến' },
      el(
        'div',
        { className: 'carousel-controls' },
        el('button', { type: 'button', className: 'carousel-nav-btn', dataset: { direction: 'previous' }, 'aria-label': 'Truyện nổi bật trước' }, svgIcon('chevronLeft', 22)),
        el('button', { type: 'button', className: 'carousel-nav-btn', dataset: { direction: 'next' }, 'aria-label': 'Truyện nổi bật tiếp theo' }, svgIcon('chevronRight', 22))
      ),
      track,
      el('p', { className: 'visually-hidden', role: 'status', 'aria-live': 'polite' }),
      el('nav', { className: 'carousel-markers', 'aria-label': 'Chọn truyện nổi bật' })
    );

    heroSectionHost.replaceChildren(carouselSection);
    const stopCarousel = initCarousel(carouselSection);
    cleanups.push(stopCarousel);
  }

  function renderLoadMoreControl() {
    loadMoreHost.replaceChildren();
    if (loadingMore) {
      loadMoreHost.appendChild(el('div', { className: 'inline-loader' }, el('span', { className: 'spinner small' }), 'Đang tải thêm...'));
      return;
    }
    if (currentPage < totalPages) {
      loadMoreHost.appendChild(
        el(
          'button',
          { type: 'button', className: 'btn btn-surface', onClick: () => loadMoreHome() },
          `Tải thêm (Trang ${currentPage + 1} / ${totalPages})`
        )
      );
    }
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
        frag.appendChild(buildMangaCard(item));
      }
      gridEl.appendChild(frag);
    } catch (err) {
      if (err.name !== 'AbortError') showToast(err.message || 'Không tải thêm được truyện.', 'error');
    } finally {
      loadingMore = false;
      renderLoadMoreControl();
    }
  }

  async function refreshFirstPage(manual = false) {
    try {
      const data = await fetchGalleries(1, 25, abortController.signal);
      totalPages = data.num_pages || totalPages;
      const incoming = data.result || [];
      let added = 0;
      const prependFrag = document.createDocumentFragment();
      for (const item of incoming) {
        if (!loadedIds.has(item.id)) {
          loadedIds.add(item.id);
          prependFrag.appendChild(buildMangaCard(item));
          added++;
        }
      }
      if (added > 0) {
        gridEl.prepend(prependFrag);
        if (manual) showToast(`Đã cập nhật thêm ${added} truyện mới.`);
      } else if (manual) {
        showToast('Danh sách đã là mới nhất.');
      }
      const now = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      refreshStatus.textContent = `Cập nhật lúc ${now} • Tự làm mới mỗi 60s`;
    } catch {
      if (manual) showToast('Không làm mới được dữ liệu.', 'error');
    }
  }

  async function loadInitial() {
    gridEl.replaceChildren(...buildSkeletonGrid(10).children);
    loadMoreHost.replaceChildren();
    loadedIds.clear();
    currentPage = 1;

    const [popularRes, latestRes] = await Promise.allSettled([
      fetchPopular(abortController.signal),
      fetchGalleries(1, 25, abortController.signal),
    ]);

    if (abortController.signal.aborted) return;

    if (popularRes.status === 'fulfilled') {
      renderHeroCarousel(popularRes.value);
    }

    if (latestRes.status === 'fulfilled') {
      const data = latestRes.value;
      totalPages = data.num_pages || 1;
      gridEl.replaceChildren();
      const frag = document.createDocumentFragment();
      for (const item of data.result || []) {
        if (loadedIds.has(item.id)) continue;
        loadedIds.add(item.id);
        frag.appendChild(buildMangaCard(item));
      }
      gridEl.appendChild(frag);
      renderLoadMoreControl();
      const now = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      refreshStatus.textContent = `Cập nhật lúc ${now} • Tự làm mới mỗi 60s`;
    } else {
      gridEl.replaceChildren();
      loadMoreHost.replaceChildren(buildErrorPanel(latestRes.reason, loadInitial));
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        loadMoreHome();
      }
    },
    { rootMargin: '400px 0px' }
  );
  io.observe(sentinel);
  cleanups.push(() => io.disconnect());

  // Auto-refresh every 60 seconds per spec while Home is active & visible
  const refreshInterval = setInterval(() => {
    if (!document.hidden && loadedIds.size > 0) {
      refreshFirstPage(false);
    }
  }, 60000);
  cleanups.push(() => clearInterval(refreshInterval));
  cleanups.push(() => revokeObjectUrls(pageWrap));

  await loadInitial();
  return () => cleanups.forEach((fn) => fn());
}

// --- Screen 2: Search (`/search`) ---

async function mountSearchView(container, { q: initialQuery, sort: initialSort }) {
  const cleanups = [];
  let abortController = new AbortController();
  cleanups.push(() => abortController.abort());

  let query = initialQuery || '';
  let sort = initialSort || 'popular';
  let currentPage = 1;
  let totalPages = 1;
  let loadingMore = false;
  const loadedIds = new Set();

  const searchInput = el('input', {
    type: 'search',
    className: 'search-input',
    placeholder: 'Từ khóa, tag hoặc số ID (vd: 177013)...',
    value: query,
    enterkeyhint: 'search',
    autocapitalize: 'none',
    autocorrect: 'off',
    'aria-label': 'Tìm kiếm truyện theo từ khóa, tag hoặc ID',
  });

  const sortSelect = el(
    'select',
    {
      className: 'sort-select',
      'aria-label': 'Sắp xếp kết quả tìm kiếm',
      onChange: (e) => {
        sort = e.target.value;
        syncUrlAndRun(true);
      },
    },
    el('option', { value: 'popular', selected: sort === 'popular' }, 'Phổ biến nhất'),
    el('option', { value: 'popular-week', selected: sort === 'popular-week' }, 'Phổ biến tuần'),
    el('option', { value: 'popular-today', selected: sort === 'popular-today' }, 'Phổ biến hôm nay'),
    el('option', { value: 'date', selected: sort === 'date' }, 'Mới nhất')
  );

  const searchForm = el(
    'form',
    {
      className: 'search-form',
      role: 'search',
      onSubmit: (e) => {
        e.preventDefault();
        query = searchInput.value.trim();
        syncUrlAndRun(true);
      },
    },
    el(
      'div',
      { className: 'search-input-wrap' },
      svgIcon('search', 18),
      searchInput
    ),
    sortSelect,
    el('button', { type: 'submit', className: 'btn btn-primary' }, 'Tìm')
  );

  const chipRow = el(
    'div',
    { className: 'chip-row', role: 'group', 'aria-label': 'Tag gợi ý nhanh' },
    ...QUICK_TAGS.map((tag) =>
      el(
        'button',
        {
          type: 'button',
          className: `chip-btn ${query.toLowerCase() === tag ? 'active' : ''}`,
          dataset: { tag },
          onClick: () => {
            query = tag;
            searchInput.value = tag;
            syncUrlAndRun(true);
          },
        },
        tag
      )
    )
  );

  const summaryLine = el('p', { className: 'search-summary' });
  const resultsHost = el('div', { className: 'manga-grid' });
  const statusHost = el('div', { className: 'load-more-host' });
  const sentinel = el('div', { className: 'scroll-sentinel', 'aria-hidden': 'true' });

  const pageWrap = el(
    'div',
    { className: 'page-container' },
    el('h1', { className: 'page-heading' }, 'Tìm kiếm'),
    searchForm,
    chipRow,
    summaryLine,
    resultsHost,
    statusHost,
    sentinel
  );
  container.replaceChildren(pageWrap);

  function updateChipActive() {
    for (const btn of chipRow.querySelectorAll('.chip-btn')) {
      btn.classList.toggle('active', query.toLowerCase() === btn.dataset.tag);
    }
  }

  function syncUrlAndRun(pushUrl) {
    updateChipActive();
    const qs = new URLSearchParams();
    if (query) qs.set('q', query);
    if (sort && sort !== 'popular') qs.set('sort', sort);
    const nextUrl = `/search${qs.toString() ? `?${qs}` : ''}`;
    if (pushUrl) window.history.replaceState(null, '', nextUrl);
    runSearch();
  }

  function renderLoadMore() {
    statusHost.replaceChildren();
    if (loadingMore) {
      statusHost.appendChild(el('div', { className: 'inline-loader' }, el('span', { className: 'spinner small' }), 'Đang tải thêm...'));
      return;
    }
    if (query && !/^\d+$/.test(query) && currentPage < totalPages) {
      statusHost.appendChild(
        el(
          'button',
          { type: 'button', className: 'btn btn-surface', onClick: () => loadMoreSearch() },
          `Tải thêm (Trang ${currentPage + 1} / ${totalPages})`
        )
      );
    }
  }

  async function runSearch() {
    abortController.abort();
    abortController = new AbortController();
    loadedIds.clear();
    currentPage = 1;
    totalPages = 1;

    if (!query) {
      summaryLine.textContent = 'Nhập từ khóa, chọn tag gợi ý hoặc gõ trực tiếp số ID truyện.';
      resultsHost.replaceChildren();
      statusHost.replaceChildren();
      return;
    }

    resultsHost.replaceChildren(...buildSkeletonGrid(6).children);
    statusHost.replaceChildren();

    // Direct numeric ID lookup per spec: regex ^\d+$ calls /galleries/{id}
    if (/^\d+$/.test(query)) {
      summaryLine.textContent = `Tra cứu trực tiếp mã truyện #${query}...`;
      try {
        const book = await fetchBook(query, abortController.signal);
        summaryLine.textContent = `Tìm thấy truyện #${book.id}`;
        resultsHost.replaceChildren(buildMangaCard(book));
      } catch (err) {
        if (err.name === 'AbortError') return;
        resultsHost.replaceChildren();
        statusHost.replaceChildren(buildErrorPanel(err, runSearch));
      }
      return;
    }

    summaryLine.textContent = `Đang tìm "${query}"...`;
    try {
      const data = await searchGalleries(query, 1, sort, abortController.signal);
      totalPages = data.num_pages || 1;
      const items = data.result || [];
      summaryLine.textContent =
        data.total > 0
          ? `Tìm thấy ${formatNumber(data.total)} kết quả cho "${query}"`
          : `Không tìm thấy kết quả nào cho "${query}".`;
      resultsHost.replaceChildren();
      const frag = document.createDocumentFragment();
      for (const item of items) {
        loadedIds.add(item.id);
        frag.appendChild(buildMangaCard(item));
      }
      resultsHost.appendChild(frag);
      renderLoadMore();
    } catch (err) {
      if (err.name === 'AbortError') return;
      resultsHost.replaceChildren();
      statusHost.replaceChildren(buildErrorPanel(err, runSearch));
    }
  }

  async function loadMoreSearch() {
    if (loadingMore || !query || /^\d+$/.test(query) || currentPage >= totalPages) return;
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
        frag.appendChild(buildMangaCard(item));
      }
      resultsHost.appendChild(frag);
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
    { rootMargin: '400px 0px' }
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
      title: 'Truyện yêu thích',
      empty: 'Chưa có truyện yêu thích nào. Nhấn biểu tượng tim ở trang chi tiết để lưu lại.',
      fetchList: getFavorites,
    },
    history: {
      title: 'Lịch sử đọc',
      empty: 'Bạn chưa đọc truyện nào gần đây.',
      fetchList: getHistory,
    },
    downloads: {
      title: 'Đã tải offline',
      empty: 'Chưa có truyện nào được lưu offline. Vào trang chi tiết truyện và chọn Tải offline.',
      fetchList: getDownloads,
    },
  };
  const cfg = configs[kind];

  const pageWrap = el('div', { className: 'page-container' });
  container.replaceChildren(pageWrap);

  async function renderList() {
    const records = await cfg.fetchList();
    revokeObjectUrls(pageWrap);

    const header = el(
      'div',
      { className: 'section-header' },
      el('h1', { className: 'page-heading' }, cfg.title),
      el('span', { className: 'count-pill' }, `${records.length} truyện`)
    );

    if (!records.length) {
      pageWrap.replaceChildren(
        header,
        el(
          'section',
          { className: 'state-panel' },
          el('p', {}, cfg.empty),
          el('button', { type: 'button', className: 'btn btn-primary', onClick: () => navigate('/') }, 'Khám phá ngay')
        )
      );
      return;
    }

    const grid = el(
      'div',
      { className: 'manga-grid' },
      ...records.map((rec) => {
        const book = rec.bookJson || { id: rec.id, num_pages: rec.totalPages };
        const pct = rec.totalPages > 0 ? Math.min(100, Math.round((rec.lastReadPage / rec.totalPages) * 100)) : 0;
        const footerChildren = [];

        if (kind === 'history') {
          footerChildren.push(
            el(
              'div',
              { className: 'progress-block' },
              el(
                'div',
                { className: 'progress-labels' },
                el('span', {}, `Trang ${rec.lastReadPage} / ${rec.totalPages || '?'}`),
                el('span', {}, formatRelativeTime(rec.lastReadTime))
              ),
              el(
                'div',
                { className: 'progress-track', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
                el('div', { className: 'progress-fill', style: { width: `${pct}%` } })
              )
            ),
            el(
              'div',
              { className: 'card-action-row' },
              el(
                'button',
                {
                  type: 'button',
                  className: 'pill-btn btn-primary compact',
                  onClick: () => navigate(`/read/${rec.id}/${rec.lastReadPage}`),
                },
                'Đọc tiếp'
              ),
              el(
                'button',
                {
                  type: 'button',
                  className: 'icon-btn compact',
                  'aria-label': `Xóa ${getBookTitle(book)} khỏi lịch sử`,
                  onClick: async () => {
                    await clearHistoryItem(rec.id);
                    renderList();
                  },
                },
                svgIcon('trash', 16)
              )
            )
          );
        } else if (kind === 'favorites') {
          footerChildren.push(
            el(
              'div',
              { className: 'card-action-row' },
              el(
                'button',
                {
                  type: 'button',
                  className: 'pill-btn btn-surface compact',
                  onClick: () => navigate(rec.lastReadPage > 0 ? `/read/${rec.id}/${rec.lastReadPage}` : `/read/${rec.id}/1`),
                },
                rec.lastReadPage > 0 ? `Đọc tiếp (tr.${rec.lastReadPage})` : 'Đọc ngay'
              ),
              el(
                'button',
                {
                  type: 'button',
                  className: 'icon-btn compact active-heart',
                  'aria-label': `Bỏ yêu thích ${getBookTitle(book)}`,
                  onClick: async () => {
                    await toggleFavorite(book);
                    await refreshFavoriteIds();
                    renderList();
                  },
                },
                svgIcon('heart', 16)
              )
            )
          );
        } else if (kind === 'downloads') {
          footerChildren.push(
            el(
              'div',
              { className: 'card-action-row' },
              el(
                'button',
                {
                  type: 'button',
                  className: 'pill-btn btn-primary compact',
                  onClick: () => navigate(`/read/${rec.id}/${Math.max(1, rec.lastReadPage || 1)}`),
                },
                'Đọc offline'
              ),
              el(
                'button',
                {
                  type: 'button',
                  className: 'icon-btn compact',
                  'aria-label': `Xóa bản tải offline của ${getBookTitle(book)}`,
                  onClick: async () => {
                    await removeBookCache(book);
                    await setDownloaded(book, false);
                    showToast('Đã xóa bản lưu offline.');
                    renderList();
                  },
                },
                svgIcon('trash', 16)
              )
            )
          );
        }

        const extraFooter = el('div', { className: 'manga-card-footer' }, ...footerChildren);
        return buildMangaCard(book, { meta: rec, extraFooter });
      })
    );

    pageWrap.replaceChildren(header, grid);
  }

  await renderList();
  return () => revokeObjectUrls(pageWrap);
}

// --- Screen 6: Detail (`/manga/:id`) ---

async function mountDetailView(container, { id }) {
  const cleanups = [];
  const abortController = new AbortController();
  let downloadAbort = null;
  cleanups.push(() => abortController.abort());
  cleanups.push(() => downloadAbort?.abort());

  const pageWrap = el('div', { className: 'page-container detail-page' });
  container.replaceChildren(pageWrap);

  pageWrap.replaceChildren(
    el('div', { className: 'state-panel' }, el('div', { className: 'spinner' }), el('p', {}, `Đang tải thông tin truyện #${id}...`))
  );

  let book = null;
  let meta = await getMetadata(id);
  let offlineFallbackUsed = false;

  try {
    book = await fetchBook(id, abortController.signal);
    meta = await upsertMetadata(book);
  } catch (err) {
    if (err.name === 'AbortError') return () => {};
    if (meta?.bookJson) {
      book = meta.bookJson;
      offlineFallbackUsed = true;
    } else {
      pageWrap.replaceChildren(buildErrorPanel(err, () => navigate(`/manga/${id}`, { replace: true })));
      return () => cleanups.forEach((fn) => fn());
    }
  }

  const title = getBookTitle(book);
  setToolbarTitle(title);
  const subTitle = getBookSubTitle(book);
  const coverUrl = getBookCoverUrl(book);
  const totalPages = book.num_pages || book.pages?.length || meta?.totalPages || 0;
  let isFavorite = Boolean(meta?.isFavorite);
  let isDownloaded = Boolean(meta?.isDownloaded);
  const lastReadPage = meta?.lastReadPage || 0;

  const favBtn = el(
    'button',
    {
      type: 'button',
      className: `btn ${isFavorite ? 'btn-sakura' : 'btn-surface'}`,
      'aria-pressed': String(isFavorite),
      onClick: async () => {
        const updated = await toggleFavorite(book);
        isFavorite = updated.isFavorite;
        await refreshFavoriteIds();
        favBtn.className = `btn ${isFavorite ? 'btn-sakura' : 'btn-surface'}`;
        favBtn.setAttribute('aria-pressed', String(isFavorite));
        favBtn.replaceChildren(svgIcon(isFavorite ? 'heart' : 'heartOutline', 18), isFavorite ? 'Đã yêu thích' : 'Yêu thích');
        showToast(isFavorite ? 'Đã thêm vào Yêu thích.' : 'Đã bỏ khỏi Yêu thích.');
      },
    },
    svgIcon(isFavorite ? 'heart' : 'heartOutline', 18),
    isFavorite ? 'Đã yêu thích' : 'Yêu thích'
  );

  const downloadStatusEl = el('p', { className: 'download-progress-text' });
  let downloading = false;

  const downloadBtn = el(
    'button',
    {
      type: 'button',
      className: `btn ${isDownloaded ? 'btn-emerald' : 'btn-surface'}`,
      onClick: async () => {
        if (downloading) {
          downloadAbort?.abort();
          return;
        }
        if (isDownloaded) {
          await removeBookCache(book);
          await setDownloaded(book, false);
          isDownloaded = false;
          downloadBtn.className = 'btn btn-surface';
          downloadBtn.replaceChildren(svgIcon('download', 18), 'Tải offline');
          downloadStatusEl.textContent = '';
          showToast('Đã xóa cache offline.');
          return;
        }
        downloading = true;
        downloadAbort = new AbortController();
        downloadBtn.replaceChildren(svgIcon('close', 18), 'Hủy tải...');
        downloadStatusEl.textContent = `Đang tải 0 / ${totalPages} trang...`;
        try {
          await downloadBookPages(book, {
            signal: downloadAbort.signal,
            onProgress: (done, total) => {
              downloadStatusEl.textContent = `Đang lưu offline: ${done} / ${total} trang (${Math.round((done / total) * 100)}%)`;
            },
          });
          await setDownloaded(book, true);
          isDownloaded = true;
          downloadBtn.className = 'btn btn-emerald';
          downloadBtn.replaceChildren(svgIcon('download', 18), 'Đã lưu offline (Xóa)');
          downloadStatusEl.textContent = `Đã lưu toàn bộ ${totalPages} trang để đọc không cần mạng.`;
          showToast('Tải offline thành công!');
        } catch (err) {
          if (err.name === 'AbortError') {
            downloadStatusEl.textContent = 'Đã hủy tải xuống.';
          } else {
            downloadStatusEl.textContent = err.message || 'Lỗi tải ảnh offline.';
            showToast(err.message || 'Tải offline thất bại.', 'error');
          }
          downloadBtn.replaceChildren(svgIcon('download', 18), 'Tải offline');
        } finally {
          downloading = false;
          downloadAbort = null;
        }
      },
    },
    svgIcon('download', 18),
    isDownloaded ? 'Đã lưu offline (Xóa)' : 'Tải offline'
  );

  // Group tags by type (parody, artist, tag, language, category...)
  const groupedTags = new Map();
  for (const tag of book.tags || []) {
    const type = tag.type || 'tag';
    if (!groupedTags.has(type)) groupedTags.set(type, []);
    groupedTags.get(type).push(tag);
  }

  const tagsSection = groupedTags.size
    ? el(
        'div',
        { className: 'detail-tags' },
        ...[...groupedTags.entries()].map(([type, list]) =>
          el(
            'div',
            { className: 'tag-group-row' },
            el('span', { className: 'tag-group-label' }, type),
            el(
              'div',
              { className: 'tag-pills' },
              ...list.map((t) =>
                el(
                  'button',
                  {
                    type: 'button',
                    className: 'tag-chip',
                    onClick: () => navigate(`/search?q=${encodeURIComponent(t.name || '')}`),
                  },
                  el('span', {}, t.name || ''),
                  t.count ? el('span', { className: 'tag-count' }, formatNumber(t.count)) : null
                )
              )
            )
          )
        )
      )
    : null;

  const detailHero = el(
    'section',
    { className: 'detail-hero' },
    el(
      'div',
      { className: 'detail-cover-col' },
      el(
        'div',
        { className: 'detail-cover-card' },
        createMangaImg(coverUrl, title, { priority: 'high', className: 'detail-cover-img', width: 350, height: 490 })
      )
    ),
    el(
      'div',
      { className: 'detail-info-col' },
      offlineFallbackUsed
        ? el('p', { className: 'offline-notice' }, 'Đang hiển thị từ bộ nhớ cache offline.')
        : null,
      el('div', { className: 'detail-id-line' }, el('span', { className: 'id-badge' }, `#${book.id}`), book.upload_date ? el('span', {}, formatUnixDate(book.upload_date)) : null),
      el('h1', { className: 'detail-title' }, title),
      subTitle ? el('p', { className: 'detail-subtitle' }, subTitle) : null,
      el(
        'div',
        { className: 'detail-stats' },
        el('span', { className: 'stat-pill' }, `${totalPages} trang`),
        el('span', { className: 'stat-pill' }, svgIcon('heart', 14), `${formatNumber(book.num_favorites || 0)} lượt thích`),
        book.scanlator ? el('span', { className: 'stat-pill' }, `Nhóm dịch: ${book.scanlator}`) : null
      ),
      el(
        'div',
        { className: 'detail-actions' },
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn-primary btn-lg',
            onClick: () => navigate(`/read/${book.id}/${Math.max(1, lastReadPage || 1)}`),
          },
          svgIcon('book', 20),
          lastReadPage > 1 ? `Đọc tiếp (Trang ${lastReadPage})` : 'Bắt đầu đọc'
        ),
        lastReadPage > 1
          ? el(
              'button',
              { type: 'button', className: 'btn btn-surface', onClick: () => navigate(`/read/${book.id}/1`) },
              'Đọc từ đầu'
            )
          : null,
        favBtn,
        downloadBtn
      ),
      downloadStatusEl,
      tagsSection
    )
  );

  // Page thumbnails preview grid
  const pagesList = book.pages || [];
  let previewLimit = Math.min(24, pagesList.length);
  const thumbsGrid = el('div', { className: 'thumb-preview-grid' });
  const moreThumbsWrap = el('div', { className: 'load-more-host' });

  function renderPreviewThumbs() {
    thumbsGrid.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < previewLimit; i++) {
      const p = pagesList[i];
      const thumbUrl = fullThumbUrl(p.thumbnail || p.path, book.media_id);
      frag.appendChild(
        el(
          'a',
          {
            href: `/read/${book.id}/${p.number}`,
            className: 'page-thumb-card',
            onClick: (e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              navigate(`/read/${book.id}/${p.number}`);
            },
          },
          createMangaImg(thumbUrl, `Trang ${p.number}`, { priority: 'lazy', className: 'page-thumb-img', width: 150, height: 210 }),
          el('span', { className: 'page-thumb-num' }, String(p.number))
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

  const previewSection = pagesList.length
    ? el(
        'section',
        { className: 'detail-section' },
        el('h2', { className: 'section-title' }, `Xem trước trang (${pagesList.length})`),
        thumbsGrid,
        moreThumbsWrap
      )
    : null;

  const relatedSection = el('section', { className: 'detail-section' });

  pageWrap.replaceChildren(
    el(
      'div',
      { className: 'breadcrumb-bar' },
      el(
        'button',
        {
          type: 'button',
          className: 'pill-btn btn-surface',
          onClick: () => (window.history.length > 1 ? window.history.back() : navigate('/')),
        },
        svgIcon('back', 16),
        'Quay lại'
      )
    ),
    detailHero,
    previewSection,
    relatedSection
  );

  // Fetch related manga asynchronously without blocking Detail render
  if (!offlineFallbackUsed) {
    fetchRelated(id, abortController.signal)
      .then((related) => {
        if (!related?.length) return;
        relatedSection.replaceChildren(
          el('h2', { className: 'section-title' }, 'Truyện liên quan'),
          el('div', { className: 'manga-grid' }, ...related.slice(0, 12).map((b) => buildMangaCard(b)))
        );
      })
      .catch(() => {});
  }

  cleanups.push(() => revokeObjectUrls(pageWrap));
  return () => cleanups.forEach((fn) => fn());
}

// --- Gamification & Theme Settings Dialog ---

function renderRewardsDialogContent() {
  const state = loadUserState();
  updateHeaderPoints();
  const today = getLocalDateString();
  const alreadyCheckedInToday = state.last_check_in_date === today;
  const storedScheme = getStoredColorScheme();
  const sysScheme = getSystemColorScheme();
  const sysLabel = sysScheme === 'dark' ? 'Hệ thống (đang Tối)' : 'Hệ thống (đang Sáng)';

  const codeInput = el('input', {
    type: 'text',
    className: 'dialog-input',
    placeholder: 'MANGA999, NHENTAI hoặc LUCKY',
    enterkeyhint: 'done',
    autocapitalize: 'characters',
    autocorrect: 'off',
    'aria-label': 'Mã quà tặng',
  });

  const feedbackMsg = el('p', { className: 'dialog-feedback', role: 'status', 'aria-live': 'polite' });

  function showFeedback(res) {
    feedbackMsg.textContent = res.message;
    feedbackMsg.dataset.ok = String(res.ok);
    updateHeaderPoints();
  }

  const nextDayToClaim = [1, 2, 3, 4, 5, 6, 7].find((d) => !state.checked_in_days.includes(d)) || 1;

  rewardsDialogBody.replaceChildren(
    el(
      'div',
      { className: 'points-hero-card' },
      el('span', { className: 'points-label' }, 'Điểm tích lũy của bạn'),
      el('strong', { className: 'points-big' }, `${state.points} điểm`),
      el('span', { className: 'points-sub' }, `${state.coupons.length} mã ưu đãi trong ví`)
    ),
    feedbackMsg,

    // Daily Check-in
    el(
      'section',
      { className: 'dialog-section' },
      el('h3', {}, 'Điểm danh hàng ngày (+100 điểm)'),
      el(
        'div',
        { className: 'checkin-grid' },
        ...[1, 2, 3, 4, 5, 6, 7].map((day) => {
          const claimed = state.checked_in_days.includes(day);
          const isNext = !alreadyCheckedInToday && day === nextDayToClaim;
          return el(
            'button',
            {
              type: 'button',
              className: `checkin-day-btn ${claimed ? 'claimed' : ''} ${isNext ? 'next-up' : ''}`,
              disabled: claimed || alreadyCheckedInToday,
              onClick: () => {
                const res = checkIn(day);
                showFeedback(res);
                renderRewardsDialogContent();
                showToast(res.message, res.ok ? 'success' : 'error');
              },
            },
            el('span', { className: 'checkin-day-num' }, `Ngày ${day}`),
            el('span', { className: 'checkin-day-pts' }, claimed ? 'Đã nhận' : '+100')
          );
        })
      )
    ),

    // Redeem Code
    el(
      'section',
      { className: 'dialog-section' },
      el('h3', {}, 'Nhập mã quà tặng'),
      el(
        'form',
        {
          className: 'redeem-form',
          onSubmit: (e) => {
            e.preventDefault();
            const res = redeemCode(codeInput.value);
            renderRewardsDialogContent();
            showToast(res.message, res.ok ? 'success' : 'error');
          },
        },
        codeInput,
        el('button', { type: 'submit', className: 'btn btn-primary' }, 'Áp dụng')
      )
    ),

    // Spend Points
    el(
      'section',
      { className: 'dialog-section' },
      el('h3', {}, 'Đổi điểm lấy ưu đãi'),
      el(
        'div',
        { className: 'shop-list' },
        ...REWARD_SHOP.map((item) =>
          el(
            'div',
            { className: 'shop-row' },
            el(
              'div',
              {},
              el('strong', {}, item.label),
              el('span', { className: 'shop-cost' }, `${item.cost} điểm`)
            ),
            el(
              'button',
              {
                type: 'button',
                className: 'pill-btn btn-surface compact',
                disabled: state.points < item.cost,
                onClick: () => {
                  const res = spendPoints(item.cost, item.name);
                  renderRewardsDialogContent();
                  showToast(res.message, res.ok ? 'success' : 'error');
                },
              },
              'Đổi ngay'
            )
          )
        )
      )
    ),

    // Coupon wallet
    el(
      'section',
      { className: 'dialog-section' },
      el('h3', {}, `Ví mã của bạn (${state.coupons.length})`),
      el(
        'div',
        { className: 'coupon-list' },
        ...state.coupons.map((code) => el('span', { className: 'coupon-pill' }, code))
      )
    ),

    // 3-state Color Scheme Settings (modern-web-guidance: dark-mode-toggle)
    el(
      'section',
      { className: 'dialog-section' },
      el('h3', {}, 'Giao diện hiển thị'),
      el(
        'div',
        { className: 'segmented-row' },
        ...[
          { id: 'system', label: sysLabel },
          { id: 'light', label: 'Sáng' },
          { id: 'dark', label: 'Tối' },
        ].map((opt) => {
          const active = (opt.id === 'system' && storedScheme === null) || storedScheme === opt.id;
          return el(
            'button',
            {
              type: 'button',
              className: `pill-btn seg-btn ${active ? 'active' : ''}`,
              onClick: () => {
                setColorSchemePreference(opt.id === 'system' ? null : opt.id);
                renderRewardsDialogContent();
              },
            },
            opt.label
          );
        })
      )
    )
  );
}

function openRewardsDialog() {
  renderRewardsDialogContent();
  rewardsDialog.showModal();
}

// --- Router Dispatcher ---

async function renderRoute() {
  if (typeof activeCleanup === 'function') {
    activeCleanup();
    activeCleanup = null;
  }

  const route = parseRoute(window.location.pathname, window.location.search);
  updateActiveNav(route.name);
  window.scrollTo({ top: 0, behavior: 'instant' });

  await refreshFavoriteIds();

  if (route.name === 'home') {
    activeCleanup = await mountHomeView(appMain);
  } else if (route.name === 'search') {
    activeCleanup = await mountSearchView(appMain, route.params);
  } else if (route.name === 'favorites' || route.name === 'history' || route.name === 'downloads') {
    activeCleanup = await mountCollectionView(appMain, route.name);
  } else if (route.name === 'detail') {
    activeCleanup = await mountDetailView(appMain, route.params);
  } else if (route.name === 'reader') {
    activeCleanup = await mountReaderView(appMain, route.params, navigate);
  }
}

// --- Boot ---

function boot() {
  wireIosSheet(rewardsDialog);

  setSidebarCollapsed(loadSidebarCollapsed());
  sidebarToggleBtn?.addEventListener('click', () => {
    setSidebarCollapsed(!appShell.classList.contains('sidebar-collapsed'));
  });

  document.getElementById('nav-back-btn')?.addEventListener('click', () => window.history.back());
  document.getElementById('nav-forward-btn')?.addEventListener('click', () => window.history.forward());
  document.getElementById('sidebar-random-btn')?.addEventListener('click', jumpToRandomManga);

  const toolbarSearchForm = document.getElementById('toolbar-search-form');
  const toolbarSearchInput = document.getElementById('toolbar-search-input');
  toolbarSearchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = toolbarSearchInput.value.trim();
    if (!val) {
      navigate('/search');
      return;
    }
    if (/^\d+$/.test(val)) {
      navigate(`/manga/${val}`);
    } else {
      navigate(`/search?q=${encodeURIComponent(val)}`);
    }
    toolbarSearchInput.blur();
  });

  // Scroll-edge & iOS Large Title collapse detection
  const updateScrollChrome = () => {
    topHeader?.classList.toggle('is-scrolled', window.scrollY > 24);
  };
  window.addEventListener('scroll', updateScrollChrome, { passive: true });
  updateScrollChrome();

  // macOS keyboard shortcuts (zero animation on keyboard-initiated actions)
  window.addEventListener('keydown', (e) => {
    if (rewardsDialog.open) return;
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
      setSidebarCollapsed(!appShell.classList.contains('sidebar-collapsed'));
    }
  });

  initThemeSync(() => {
    if (rewardsDialog.open) renderRewardsDialogContent();
  });

  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    toggleColorScheme();
    if (rewardsDialog.open) renderRewardsDialogContent();
  });

  document.getElementById('rewards-open-btn')?.addEventListener('click', openRewardsDialog);
  document.getElementById('rewards-close-btn')?.addEventListener('click', () => closeTopLayer(rewardsDialog));

  // Intercept internal navigation links in sidebar, tablet nav, header & iOS tab bar
  for (const link of document.querySelectorAll('a[data-spa-link]')) {
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(link.getAttribute('href') || '/');
    });
  }

  window.addEventListener('popstate', () => renderRoute());
  updateHeaderPoints();
  renderRoute();
}

boot();
