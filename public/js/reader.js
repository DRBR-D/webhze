import {
  fetchBook,
  fullImageUrl,
  proxyImageUrl,
  getBookTitle,
  getCachedImageObjectUrl,
} from './api.js';
import {
  getMetadata,
  updateHistory,
  loadReaderPrefs,
  saveReaderPrefs,
} from './store.js';
import {
  el,
  svgIcon,
  rubberband,
  revokeObjectUrls,
  showToast,
} from './dom.js';

const EYE_FILTERS = [
  { id: 'black', label: 'Đen tuyền', color: '#000000' },
  { id: 'charcoal', label: 'Than chì', color: '#14141A' },
  { id: 'sepia', label: 'Giấy cũ', color: '#F4ECD8' },
  { id: 'white', label: 'Trắng sáng', color: '#FFFFFF' },
];

const AUTO_SPEEDS = [1, 2, 3, 4, 5];

function createPageImg(page, mediaId, priority = 'lazy') {
  const remoteUrl = fullImageUrl(page.path, mediaId);
  const img = document.createElement('img');
  img.alt = `Trang ${page.number}`;
  img.className = 'reader-page-img';
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.draggable = false;
  if (page.width && page.height) {
    img.width = page.width;
    img.height = page.height;
    img.style.aspectRatio = `${page.width} / ${page.height}`;
  }
  if (priority === 'high') {
    img.setAttribute('fetchpriority', 'high');
  } else if (priority === 'lazy') {
    img.loading = 'lazy';
  }

  let triedProxy = false;
  img.addEventListener('error', () => {
    if (!triedProxy && remoteUrl) {
      triedProxy = true;
      img.src = proxyImageUrl(remoteUrl);
    } else {
      img.classList.add('img-error');
    }
  });

  if (remoteUrl) {
    getCachedImageObjectUrl(remoteUrl).then((objUrl) => {
      if (objUrl) {
        img.dataset.objectUrl = objUrl;
        img.src = objUrl;
      }
    });
    img.src = remoteUrl;
  }
  return img;
}

export async function mountReaderView(container, { id, page: initialPage }, navigate) {
  const cleanups = [];
  const abortController = new AbortController();
  cleanups.push(() => abortController.abort());

  const prefs = loadReaderPrefs();
  let mode = prefs.mode; // 'horizontal' (Page Flip) | 'vertical' (Webtoon)
  let theme = prefs.theme; // 'black' | 'charcoal' | 'sepia' | 'white'
  let autoScrollSpeed = Math.min(5, Math.max(1, Number(prefs.autoScrollSpeed) || 2));
  let autoScrolling = false;
  // Unobstructed by default: full-bleed manga reading; tap screen to open the Kinetic panel
  let hudVisible = false;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let currentPage = Math.max(1, Number(initialPage) || 1);
  let book = null;
  let totalPages = 0;

  let rafId = 0;
  let lastFrameTs = 0;
  let horizAutoTimer = 0;
  let observer = null;

  const root = el('div', {
    className: 'reader-shell hud-hidden',
    dataset: { readerTheme: theme, mode },
  });
  container.replaceChildren(root);

  root.appendChild(
    el(
      'div',
      { className: 'reader-status-box' },
      el('div', { className: 'spinner', 'aria-hidden': 'true' }),
      el('p', {}, 'Đang tải trang truyện...')
    )
  );

  try {
    const meta = await getMetadata(id);
    if (meta?.bookJson?.pages?.length) {
      book = meta.bookJson;
    } else {
      book = await fetchBook(id, abortController.signal);
    }
  } catch (err) {
    if (err.name === 'AbortError') return () => {};
    root.replaceChildren(
      el(
        'div',
        { className: 'reader-status-box error-panel' },
        el('h2', {}, 'Không tải được chương truyện'),
        el('p', {}, err.message),
        err.hint ? el('p', { className: 'muted-hint' }, err.hint) : null,
        el(
          'div',
          { className: 'btn-row' },
          el(
            'button',
            { type: 'button', className: 'btn btn-primary', onClick: () => navigate(`/read/${id}/${currentPage}`, { replace: true }) },
            'Thử lại'
          ),
          el(
            'button',
            { type: 'button', className: 'btn btn-ghost', onClick: () => navigate(`/manga/${id}`) },
            'Về trang chi tiết'
          )
        )
      )
    );
    return () => cleanups.forEach((fn) => fn());
  }

  const pages = book?.pages || [];
  totalPages = pages.length || book?.num_pages || 0;
  if (!pages.length) {
    root.replaceChildren(
      el(
        'div',
        { className: 'reader-status-box' },
        el('p', {}, 'Truyện này chưa có dữ liệu trang ảnh.'),
        el('button', { type: 'button', className: 'btn btn-primary', onClick: () => navigate(`/manga/${id}`) }, 'Quay lại')
      )
    );
    return () => cleanups.forEach((fn) => fn());
  }

  currentPage = Math.min(totalPages, Math.max(1, currentPage));
  const titleText = getBookTitle(book);

  // --- Kinetic Reader Controls (00:54–01:09 reference) ---
  const topSubCounter = el('span', { className: 'reader-counter tabular-nums' }, `Page ${currentPage} of ${totalPages}`);
  const sliderCurNum = el('span', { className: 'reader-scrubber-cur tabular-nums' }, String(currentPage));
  const sliderTotNum = el('span', { className: 'reader-scrubber-tot tabular-nums' }, String(totalPages));

  const floatingPagePill = el(
    'button',
    {
      type: 'button',
      className: 'reader-mini-pill glass-clear tabular-nums',
      'aria-label': 'Hiện bảng điều khiển đọc truyện',
      onClick: () => setHudVisible(true),
    },
    `${currentPage} / ${totalPages}`
  );

  const autoActiveBanner = el(
    'button',
    {
      type: 'button',
      className: 'reader-auto-pill',
      hidden: true,
      onClick: () => setAutoScrolling(false),
    },
    el('span', { className: 'auto-dot', 'aria-hidden': 'true' }),
    el('span', { className: 'auto-pill-text' }, `Auto ${autoScrollSpeed}x · Tap to pause`)
  );

  const topBar = el(
    'header',
    { className: 'reader-top-bar glass-clear' },
    el(
      'button',
      {
        type: 'button',
        className: 'icon-btn reader-hud-btn compact',
        'aria-label': 'Quay lại chi tiết truyện',
        onClick: () => navigate(`/manga/${id}`),
      },
      svgIcon('back', 19)
    ),
    el(
      'div',
      { className: 'reader-title-wrap' },
      el('h1', { className: 'reader-title' }, titleText),
      topSubCounter
    )
  );

  const pageSlider = el('input', {
    type: 'range',
    className: 'reader-slider',
    min: '1',
    max: String(totalPages),
    value: String(currentPage),
    'aria-label': 'Chuyển nhanh đến trang',
    onInput: (e) => goToPage(Number(e.target.value)),
  });

  const modeFlipBtn = el(
    'button',
    {
      type: 'button',
      className: `kinetic-mode-btn ${mode === 'horizontal' ? 'active' : ''}`,
      onClick: () => setMode('horizontal'),
    },
    'Page Flip'
  );
  const modeWebtoonBtn = el(
    'button',
    {
      type: 'button',
      className: `kinetic-mode-btn ${mode === 'vertical' ? 'active' : ''}`,
      onClick: () => setMode('vertical'),
    },
    'Webtoon'
  );

  const swatchButtons = EYE_FILTERS.map((f) =>
    el('button', {
      type: 'button',
      className: `eye-filter-dot ${theme === f.id ? 'active' : ''}`,
      dataset: { filterId: f.id },
      'aria-label': `Nền đọc ${f.label}`,
      title: f.label,
      style: { backgroundColor: f.color },
      onClick: () => setTheme(f.id),
    })
  );

  const autoStatusLabel = el('span', { className: 'auto-status-text tabular-nums' }, 'Paused');
  const autoPlayBtn = el(
    'button',
    {
      type: 'button',
      className: 'auto-play-circle',
      'aria-label': 'Bật hoặc tắt Auto-Scroll',
      'aria-pressed': 'false',
      onClick: () => setAutoScrolling(!autoScrolling),
    },
    svgIcon('play', 17)
  );

  const zoomResetBtn = el(
    'button',
    {
      type: 'button',
      className: 'zoom-mini-btn tabular-nums',
      'aria-label': 'Đặt lại phóng to 100%',
      onClick: () => setZoom(1),
    },
    '100%'
  );

  const speedButtons = AUTO_SPEEDS.map((sp) =>
    el(
      'button',
      {
        type: 'button',
        className: `speed-pill-btn ${autoScrollSpeed === sp ? 'active' : ''}`,
        dataset: { speedVal: sp },
        onClick: () => {
          autoScrollSpeed = sp;
          saveReaderPrefs({ autoScrollSpeed });
          syncSpeedUI();
          if (autoScrolling && mode === 'horizontal') restartHorizontalAutoTimer();
        },
      },
      `${sp}x`
    )
  );

  const bottomPanel = el(
    'footer',
    { className: 'reader-kinetic-panel glass-clear' },
    el(
      'div',
      { className: 'reader-scrubber-row' },
      sliderCurNum,
      pageSlider,
      sliderTotNum
    ),
    el(
      'div',
      { className: 'kinetic-mid-row' },
      el(
        'div',
        { className: 'kinetic-col' },
        el('span', { className: 'kinetic-micro-label' }, 'READING MODE'),
        el('div', { className: 'kinetic-mode-group' }, modeFlipBtn, modeWebtoonBtn)
      ),
      el(
        'div',
        { className: 'kinetic-col align-end' },
        el('span', { className: 'kinetic-micro-label' }, 'EYE FILTERS'),
        el('div', { className: 'eye-filter-row' }, ...swatchButtons)
      )
    ),
    el(
      'div',
      { className: 'kinetic-auto-card' },
      el(
        'div',
        { className: 'kinetic-auto-head' },
        el('div', { className: 'kinetic-auto-left' }, autoPlayBtn, el('strong', {}, 'Auto-Scroll')),
        el(
          'div',
          { className: 'kinetic-auto-right' },
          el(
            'div',
            { className: 'zoom-mini-group', role: 'group', 'aria-label': 'Thu phóng' },
            el('button', { type: 'button', className: 'zoom-mini-btn', 'aria-label': 'Thu nhỏ', onClick: () => setZoom(zoom - 0.25) }, '−'),
            zoomResetBtn,
            el('button', { type: 'button', className: 'zoom-mini-btn', 'aria-label': 'Phóng to', onClick: () => setZoom(zoom + 0.25) }, '+')
          ),
          autoStatusLabel
        )
      ),
      el('div', { className: 'kinetic-speed-row' }, ...speedButtons)
    )
  );

  const viewport = el('div', {
    className: 'reader-viewport',
    tabindex: '0',
    'aria-label': 'Khung đọc truyện',
  });
  const stage = el('div', { className: 'reader-stage' });
  viewport.appendChild(stage);

  root.replaceChildren(topBar, autoActiveBanner, viewport, floatingPagePill, bottomPanel);

  function syncSpeedUI() {
    for (const btn of speedButtons) {
      btn.classList.toggle('active', Number(btn.dataset.speedVal) === autoScrollSpeed);
    }
    const pillText = autoActiveBanner.querySelector('.auto-pill-text');
    if (pillText) pillText.textContent = `Auto ${autoScrollSpeed}x · Tap to pause`;
    if (autoScrolling) autoStatusLabel.textContent = `${autoScrollSpeed}x Active`;
  }

  function setHudVisible(visible) {
    hudVisible = visible;
    if (visible && viewport) lastHudScrollTop = viewport.scrollTop;
    root.classList.toggle('hud-hidden', !hudVisible);
  }

  function setTheme(nextTheme) {
    theme = nextTheme;
    root.dataset.readerTheme = theme;
    saveReaderPrefs({ theme });
    for (const btn of swatchButtons) {
      btn.classList.toggle('active', btn.dataset.filterId === theme);
    }
  }

  function applyTransform() {
    if (zoom <= 1) {
      panX = 0;
      panY = 0;
    }
    stage.style.transition = '';
    stage.style.transform = zoom > 1
      ? `translate3d(${panX.toFixed(1)}px, ${panY.toFixed(1)}px, 0) scale(${zoom})`
      : '';
    viewport.classList.toggle('is-zoomed', zoom > 1);
    zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(nextZoom) {
    zoom = Math.min(3.5, Math.max(1, Math.round(nextZoom * 100) / 100));
    applyTransform();
  }

  function persistCurrentPage(pageNum) {
    const clamped = Math.min(totalPages, Math.max(1, pageNum));
    currentPage = clamped;
    topSubCounter.textContent = `Page ${currentPage} of ${totalPages}`;
    sliderCurNum.textContent = String(currentPage);
    floatingPagePill.textContent = `${currentPage} / ${totalPages}`;
    pageSlider.value = String(currentPage);

    const nextUrl = `/read/${id}/${currentPage}`;
    if (window.location.pathname !== nextUrl) {
      window.history.replaceState(null, '', nextUrl);
    }
    updateHistory(book, currentPage, totalPages).catch(() => {});
    preloadAdjacentPages(currentPage);
  }

  const preloadedUrls = new Set();
  function preloadAdjacentPages(pageNum) {
    for (const offset of [1, 2]) {
      const target = pages[pageNum - 1 + offset];
      if (!target) continue;
      const url = fullImageUrl(target.path, book.media_id);
      if (!url || preloadedUrls.has(url)) continue;
      preloadedUrls.add(url);
      const preload = new Image();
      preload.referrerPolicy = 'no-referrer';
      preload.src = url;
    }
  }

  function renderStage() {
    observer?.disconnect();
    observer = null;
    revokeObjectUrls(stage);
    stage.replaceChildren();
    setZoom(1);
    root.dataset.mode = mode;

    modeFlipBtn.classList.toggle('active', mode === 'horizontal');
    modeWebtoonBtn.classList.toggle('active', mode === 'vertical');

    if (mode === 'vertical') {
      const list = el('div', { className: 'reader-vertical-list' });
      pages.forEach((p, idx) => {
        const pageNum = idx + 1;
        const priority = Math.abs(pageNum - currentPage) <= 1 ? 'high' : 'lazy';
        list.appendChild(
          el(
            'figure',
            { className: 'reader-page-frame', dataset: { page: pageNum } },
            createPageImg(p, book.media_id, priority)
          )
        );
      });
      stage.appendChild(list);

      requestAnimationFrame(() => {
        const targetEl = list.querySelector(`[data-page="${currentPage}"]`);
        if (targetEl) viewport.scrollTop = targetEl.offsetTop;
      });

      observer = new IntersectionObserver(
        (entries) => {
          let best = null;
          for (const entry of entries) {
            if (entry.isIntersecting && (!best || entry.intersectionRatio > best.intersectionRatio)) {
              best = entry;
            }
          }
          if (best) {
            const pageNum = Number(best.target.dataset.page);
            if (pageNum && pageNum !== currentPage) persistCurrentPage(pageNum);
          }
        },
        { root: viewport, threshold: [0.25, 0.55] }
      );
      for (const frame of list.children) observer.observe(frame);
    } else {
      renderHorizontalPage();
    }
  }

  function renderHorizontalPage() {
    revokeObjectUrls(stage);
    const p = pages[currentPage - 1];
    if (!p) return;
    stage.replaceChildren(
      el('div', { className: 'reader-horizontal-frame' }, createPageImg(p, book.media_id, 'high'))
    );
  }

  function goToPage(targetPage) {
    const clamped = Math.min(totalPages, Math.max(1, targetPage));
    if (clamped === currentPage && mode === 'horizontal' && stage.children.length > 0) return;
    persistCurrentPage(clamped);
    if (mode === 'horizontal') {
      setZoom(1);
      renderHorizontalPage();
    } else {
      const targetEl = stage.querySelector(`[data-page="${clamped}"]`);
      if (targetEl) viewport.scrollTo({ top: targetEl.offsetTop, behavior: 'auto' });
    }
  }

  function setMode(nextMode) {
    if (nextMode === mode) return;
    setAutoScrolling(false);
    mode = nextMode;
    saveReaderPrefs({ mode });
    renderStage();
  }

  // --- Auto-Scroll ---
  function stopAutoScrollLoops() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    clearInterval(horizAutoTimer);
    horizAutoTimer = 0;
  }

  function restartHorizontalAutoTimer() {
    clearInterval(horizAutoTimer);
    const intervalMs = Math.max(1100, Math.round((6.2 - autoScrollSpeed * 0.95) * 1000));
    horizAutoTimer = setInterval(() => {
      if (!autoScrolling || mode !== 'horizontal') return;
      if (currentPage >= totalPages) {
        setAutoScrolling(false);
        showToast('Đã đọc đến trang cuối.');
        return;
      }
      goToPage(currentPage + 1);
    }, intervalMs);
  }

  function verticalAutoStep(ts) {
    if (!autoScrolling || mode !== 'vertical') return;
    if (!lastFrameTs) lastFrameTs = ts;
    const dt = Math.min(0.08, (ts - lastFrameTs) / 1000);
    lastFrameTs = ts;
    const pxPerSec = autoScrollSpeed * 68;
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    if (viewport.scrollTop >= maxScroll - 2) {
      setAutoScrolling(false);
      showToast('Đã cuộn đến hết truyện.');
      return;
    }
    viewport.scrollTop += pxPerSec * dt;
    rafId = requestAnimationFrame(verticalAutoStep);
  }

  function setAutoScrolling(active) {
    autoScrolling = active;
    stopAutoScrollLoops();
    autoPlayBtn.setAttribute('aria-pressed', String(autoScrolling));
    autoPlayBtn.classList.toggle('active', autoScrolling);
    autoPlayBtn.replaceChildren(svgIcon(autoScrolling ? 'pause' : 'play', 17));
    autoStatusLabel.textContent = autoScrolling ? `${autoScrollSpeed}x Active` : 'Paused';
    autoStatusLabel.classList.toggle('active', autoScrolling);
    autoActiveBanner.hidden = !autoScrolling;
    syncSpeedUI();

    if (!autoScrolling) return;
    setHudVisible(false);
    if (mode === 'vertical') {
      lastFrameTs = 0;
      rafId = requestAnimationFrame(verticalAutoStep);
    } else {
      restartHorizontalAutoTimer();
    }
  }

  // --- Gestures: Pinch-Zoom, Pan, 1:1 Horizontal Swipe, Double-Tap, Auto-Hide on Scroll ---
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartPanX = 0;
  let touchStartPanY = 0;
  let touchMoved = false;
  let horizDragging = false;
  let horizDragX = 0;
  let touchSamples = [];
  let lastTapTime = 0;
  let tapTimer = 0;

  function touchDist(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartZoom = zoom;
      touchMoved = true;
      horizDragging = false;
      return;
    }
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartPanX = panX;
      touchStartPanY = panY;
      touchMoved = false;
      horizDragging = false;
      horizDragX = 0;
      touchSamples = [{ x: touchStartX, t: performance.now() }];
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 2 && pinchStartDist > 0) {
      e.preventDefault();
      const ratio = touchDist(e.touches[0], e.touches[1]) / pinchStartDist;
      setZoom(pinchStartZoom * ratio);
      return;
    }
    if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      if (Math.hypot(dx, dy) > 10) touchMoved = true;

      if (zoom > 1) {
        e.preventDefault();
        const limitX = (viewport.clientWidth * (zoom - 1)) / 2;
        const limitY = (viewport.clientHeight * (zoom - 1)) / 2;
        panX = Math.max(-limitX, Math.min(limitX, touchStartPanX + dx));
        panY = Math.max(-limitY, Math.min(limitY, touchStartPanY + dy));
        applyTransform();
        return;
      }

      if (mode === 'horizontal' && (horizDragging || (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15))) {
        e.preventDefault();
        horizDragging = true;
        const atStartEdge = currentPage <= 1 && dx > 0;
        const atEndEdge = currentPage >= totalPages && dx < 0;
        horizDragX = atStartEdge || atEndEdge ? rubberband(dx, viewport.clientWidth * 0.5, 0.45) : dx;
        stage.style.transition = 'none';
        stage.style.transform = `translate3d(${horizDragX.toFixed(1)}px, 0, 0)`;
        touchSamples.push({ x: e.touches[0].clientX, t: performance.now() });
        if (touchSamples.length > 5) touchSamples.shift();
      }
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) pinchStartDist = 0;
    if (e.changedTouches.length !== 1 || e.touches.length > 0) return;

    if (horizDragging && mode === 'horizontal' && zoom <= 1) {
      horizDragging = false;
      let velocity = 0;
      if (touchSamples.length >= 2) {
        const a = touchSamples[0];
        const b = touchSamples[touchSamples.length - 1];
        velocity = (b.x - a.x) / Math.max(1, b.t - a.t);
      }
      const threshold = Math.max(48, viewport.clientWidth * 0.22);
      const goNext = (horizDragX < -threshold || velocity < -0.35) && currentPage < totalPages;
      const goPrev = (horizDragX > threshold || velocity > 0.35) && currentPage > 1;

      if (goNext || goPrev) {
        if (hudVisible) setHudVisible(false);
        stage.style.transition = '';
        stage.style.transform = '';
        goToPage(goNext ? currentPage + 1 : currentPage - 1);
      } else {
        stage.style.transition = 'transform 260ms cubic-bezier(0.23, 1, 0.32, 1)';
        stage.style.transform = 'translate3d(0, 0, 0)';
        setTimeout(() => {
          stage.style.transition = '';
          stage.style.transform = '';
        }, 260);
      }
      return;
    }

    if (touchMoved) return;

    const now = Date.now();
    const tapX = e.changedTouches[0].clientX;
    if (now - lastTapTime < 280) {
      clearTimeout(tapTimer);
      lastTapTime = 0;
      setZoom(zoom > 1.1 ? 1 : 2);
      return;
    }
    lastTapTime = now;
    tapTimer = setTimeout(() => handleViewportTap(tapX), 240);
  }

  function handleViewportTap(clientX) {
    if (mode === 'horizontal' && zoom <= 1) {
      const ratio = clientX / Math.max(1, viewport.clientWidth);
      if (ratio < 0.25) {
        if (hudVisible) setHudVisible(false);
        goToPage(currentPage - 1);
        return;
      }
      if (ratio > 0.75) {
        if (hudVisible) setHudVisible(false);
        goToPage(currentPage + 1);
        return;
      }
    }
    setHudVisible(!hudVisible);
  }

  let lastHudScrollTop = 0;
  function onViewportScroll() {
    if (!hudVisible || mode !== 'vertical') {
      lastHudScrollTop = viewport.scrollTop;
      return;
    }
    if (Math.abs(viewport.scrollTop - lastHudScrollTop) > 28) {
      setHudVisible(false);
    }
  }

  let clickDelayTimer = 0;
  function onViewportClick(e) {
    if (e.pointerType === 'touch') return;
    if (e.target.closest('button, input')) return;
    if (e.detail >= 2) {
      clearTimeout(clickDelayTimer);
      setZoom(zoom > 1.1 ? 1 : 2);
      return;
    }
    clearTimeout(clickDelayTimer);
    const x = e.clientX;
    clickDelayTimer = setTimeout(() => handleViewportTap(x), 180);
  }

  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 0.2 : -0.2));
    }
  }

  function onKeyDown(e) {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      goToPage(currentPage + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      goToPage(currentPage - 1);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(zoom + 0.25);
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom(zoom - 0.25);
    } else if (e.key === '0') {
      e.preventDefault();
      setZoom(1);
    } else if (e.key === ' ') {
      e.preventDefault();
      setAutoScrolling(!autoScrolling);
    } else if (e.key === 'h' || e.key === 'H') {
      setHudVisible(!hudVisible);
    }
  }

  viewport.addEventListener('scroll', onViewportScroll, { passive: true });
  viewport.addEventListener('touchstart', onTouchStart, { passive: true });
  viewport.addEventListener('touchmove', onTouchMove, { passive: false });
  viewport.addEventListener('touchend', onTouchEnd, { passive: true });
  viewport.addEventListener('click', onViewportClick);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);

  cleanups.push(() => {
    stopAutoScrollLoops();
    clearTimeout(tapTimer);
    clearTimeout(clickDelayTimer);
    observer?.disconnect();
    viewport.removeEventListener('scroll', onViewportScroll);
    viewport.removeEventListener('touchstart', onTouchStart);
    viewport.removeEventListener('touchmove', onTouchMove);
    viewport.removeEventListener('touchend', onTouchEnd);
    viewport.removeEventListener('click', onViewportClick);
    viewport.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    revokeObjectUrls(stage);
  });

  renderStage();
  persistCurrentPage(currentPage);

  return () => cleanups.forEach((fn) => fn());
}
