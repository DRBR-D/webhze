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
  wireIosSheet,
  closeTopLayer,
  rubberband,
  revokeObjectUrls,
  showToast,
} from './dom.js';

const READER_THEMES = [
  { id: 'black', label: 'Đen tuyền', color: '#000000' },
  { id: 'charcoal', label: 'Than chì', color: '#14141A' },
  { id: 'sepia', label: 'Giấy cũ', color: '#F4ECD8' },
  { id: 'white', label: 'Trắng sáng', color: '#FFFFFF' },
];

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
  let mode = prefs.mode; // 'horizontal' | 'vertical'
  let theme = prefs.theme; // 'black' | 'charcoal' | 'sepia' | 'white'
  let autoScrollSpeed = prefs.autoScrollSpeed;
  let autoScrolling = false;
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

  const loadingBox = el(
    'div',
    { className: 'reader-status-box' },
    el('div', { className: 'spinner', 'aria-hidden': 'true' }),
    el('p', {}, 'Đang tải trang truyện...')
  );
  root.appendChild(loadingBox);

  // Load cached book first for instant offline reading, otherwise fetch from proxy
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

  // Build minimal, non-intrusive HUD (hidden by default; single-row liquid glass capsules when tapped)
  const pageCounterText = el('span', { className: 'reader-counter' }, `${currentPage} / ${totalPages}`);
  const floatingPagePill = el(
    'button',
    {
      type: 'button',
      className: 'reader-mini-pill glass-clear tabular-nums',
      'aria-label': 'Hiện thanh điều khiển đọc truyện',
      onClick: () => setHudVisible(true),
    },
    `${currentPage} / ${totalPages}`
  );

  const zoomResetBtn = el(
    'button',
    {
      type: 'button',
      className: 'pill-btn seg-btn',
      'aria-label': 'Đặt lại mức thu phóng 100%',
      onClick: () => setZoom(1),
    },
    '100%'
  );

  const settingsDialog = buildSettingsDialog();
  wireIosSheet(settingsDialog);

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
      svgIcon('back', 18)
    ),
    el(
      'div',
      { className: 'reader-title-wrap' },
      el('h1', { className: 'reader-title' }, titleText),
      pageCounterText
    ),
    el(
      'button',
      {
        type: 'button',
        className: 'icon-btn reader-hud-btn compact',
        'aria-label': 'Tùy chọn đọc truyện',
        onClick: () => settingsDialog.showModal(),
      },
      svgIcon('settings', 18)
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

  const autoScrollBtn = el(
    'button',
    {
      type: 'button',
      className: 'icon-btn reader-hud-btn compact',
      'aria-label': 'Bật hoặc tắt tự động cuộn',
      'aria-pressed': 'false',
      title: 'Tự động cuộn (Space)',
      onClick: () => setAutoScrolling(!autoScrolling),
    },
    svgIcon('play', 17)
  );

  const prevPageBtn = el(
    'button',
    {
      type: 'button',
      className: 'icon-btn reader-hud-btn compact',
      'aria-label': 'Trang trước',
      onClick: () => goToPage(currentPage - 1),
    },
    svgIcon('chevronLeft', 18)
  );

  const nextPageBtn = el(
    'button',
    {
      type: 'button',
      className: 'icon-btn reader-hud-btn compact',
      'aria-label': 'Trang tiếp theo',
      onClick: () => goToPage(currentPage + 1),
    },
    svgIcon('chevronRight', 18)
  );

  const bottomBar = el(
    'footer',
    { className: 'reader-bottom-bar glass-clear' },
    el(
      'div',
      { className: 'reader-scrubber-row' },
      prevPageBtn,
      pageSlider,
      nextPageBtn,
      autoScrollBtn
    )
  );

  const viewport = el('div', {
    className: 'reader-viewport',
    tabindex: '0',
    'aria-label': 'Khung đọc truyện',
  });

  const stage = el('div', { className: 'reader-stage' });
  viewport.appendChild(stage);

  root.replaceChildren(topBar, viewport, floatingPagePill, bottomBar, settingsDialog);

  function buildSettingsDialog() {
    const modeButtons = [
      { id: 'vertical', label: 'Cuộn dọc (Webtoon)' },
      { id: 'horizontal', label: 'Lật trang ngang' },
    ];

    const speedValueLabel = el('strong', {}, `${autoScrollSpeed}x`);
    const speedSlider = el('input', {
      type: 'range',
      min: '1',
      max: '10',
      step: '1',
      value: String(autoScrollSpeed),
      'aria-label': 'Tốc độ tự động cuộn',
      onInput: (e) => {
        autoScrollSpeed = Number(e.target.value);
        speedValueLabel.textContent = `${autoScrollSpeed}x`;
        saveReaderPrefs({ autoScrollSpeed });
        if (autoScrolling && mode === 'horizontal') {
          restartHorizontalAutoTimer();
        }
      },
    });

    const dialog = el(
      'dialog',
      {
        className: 'app-dialog reader-settings-dialog glass-regular',
        closedby: 'any',
        'aria-labelledby': 'reader-settings-title',
      },
      el(
        'div',
        { className: 'sheet-drag-zone', dataset: { sheetHandle: '' } },
        el('span', { className: 'sheet-grabber', 'aria-hidden': 'true' }),
        el(
          'div',
          { className: 'dialog-header' },
          el('h2', { id: 'reader-settings-title' }, 'Tùy chọn đọc'),
          el(
            'button',
            {
              type: 'button',
              className: 'sheet-done-btn',
              'aria-label': 'Xong và đóng cài đặt',
              onClick: () => closeTopLayer(dialog),
            },
            'Xong'
          )
        )
      ),
      el(
        'div',
        { className: 'dialog-body' },
        el(
          'div',
          { className: 'setting-group' },
          el('span', { className: 'setting-label' }, 'Chế độ đọc'),
          el(
            'div',
            { className: 'segmented-row', dataset: { role: 'mode-group' } },
            ...modeButtons.map((m) =>
              el(
                'button',
                {
                  type: 'button',
                  className: `pill-btn seg-btn ${mode === m.id ? 'active' : ''}`,
                  dataset: { modeVal: m.id },
                  onClick: () => setMode(m.id),
                },
                m.label
              )
            )
          )
        ),
        el(
          'div',
          { className: 'setting-group' },
          el('span', { className: 'setting-label' }, 'Màu nền đọc'),
          el(
            'div',
            { className: 'theme-swatch-grid', dataset: { role: 'theme-group' } },
            ...READER_THEMES.map((t) =>
              el(
                'button',
                {
                  type: 'button',
                  className: `theme-swatch-btn ${theme === t.id ? 'active' : ''}`,
                  dataset: { themeVal: t.id },
                  onClick: () => setTheme(t.id),
                },
                el('span', {
                  className: 'theme-swatch-dot',
                  style: { backgroundColor: t.color },
                  'aria-hidden': 'true',
                }),
                el('span', {}, t.label)
              )
            )
          )
        ),
        el(
          'div',
          { className: 'setting-group' },
          el('span', { className: 'setting-label' }, 'Thu phóng ảnh'),
          el(
            'div',
            { className: 'segmented-row' },
            el(
              'button',
              {
                type: 'button',
                className: 'pill-btn seg-btn',
                'aria-label': 'Thu nhỏ',
                onClick: () => setZoom(zoom - 0.25),
              },
              svgIcon('zoomOut', 16),
              'Thu nhỏ'
            ),
            zoomResetBtn,
            el(
              'button',
              {
                type: 'button',
                className: 'pill-btn seg-btn',
                'aria-label': 'Phóng to',
                onClick: () => setZoom(zoom + 0.25),
              },
              svgIcon('zoomIn', 16),
              'Phóng to'
            )
          )
        ),
        el(
          'div',
          { className: 'setting-group' },
          el(
            'div',
            { className: 'setting-label-row' },
            el('span', { className: 'setting-label' }, 'Tốc độ tự động cuộn'),
            speedValueLabel
          ),
          speedSlider
        ),
        el(
          'p',
          { className: 'setting-hint' },
          'Chạm giữa màn hình hoặc góc số trang để mở/ẩn thanh điều khiển • Chụm 2 ngón hoặc nhấp đúp để phóng to • Phím ←/→ lật trang.'
        )
      )
    );
    return dialog;
  }

  function syncSettingsDialogUI() {
    for (const btn of settingsDialog.querySelectorAll('[data-mode-val]')) {
      btn.classList.toggle('active', btn.dataset.modeVal === mode);
    }
    for (const btn of settingsDialog.querySelectorAll('[data-theme-val]')) {
      btn.classList.toggle('active', btn.dataset.themeVal === theme);
    }
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
    syncSettingsDialogUI();
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
    pageCounterText.textContent = `${currentPage} / ${totalPages}`;
    floatingPagePill.textContent = `${currentPage} / ${totalPages}`;
    pageSlider.value = String(currentPage);
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;

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
    syncSettingsDialogUI();

    if (mode === 'vertical') {
      const list = el('div', { className: 'reader-vertical-list' });
      pages.forEach((p, idx) => {
        const pageNum = idx + 1;
        const priority = Math.abs(pageNum - currentPage) <= 1 ? 'high' : 'lazy';
        const fig = el(
          'figure',
          { className: 'reader-page-frame', dataset: { page: pageNum } },
          createPageImg(p, book.media_id, priority)
        );
        list.appendChild(fig);
      });
      stage.appendChild(list);

      // Jump to currentPage immediately after layout
      requestAnimationFrame(() => {
        const targetEl = list.querySelector(`[data-page="${currentPage}"]`);
        if (targetEl) {
          viewport.scrollTop = targetEl.offsetTop;
        }
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
            if (pageNum && pageNum !== currentPage) {
              persistCurrentPage(pageNum);
            }
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
    const frame = el(
      'div',
      { className: 'reader-horizontal-frame' },
      createPageImg(p, book.media_id, 'high')
    );
    stage.replaceChildren(frame);
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
      if (targetEl) {
        viewport.scrollTo({ top: targetEl.offsetTop, behavior: 'auto' });
      }
    }
  }

  function setMode(nextMode) {
    if (nextMode === mode) return;
    setAutoScrolling(false);
    mode = nextMode;
    saveReaderPrefs({ mode });
    renderStage();
    showToast(mode === 'vertical' ? 'Chế độ cuộn dọc (Webtoon)' : 'Chế độ lật trang ngang');
  }

  // --- Auto-scroll loop ---
  function stopAutoScrollLoops() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    clearInterval(horizAutoTimer);
    horizAutoTimer = 0;
  }

  function restartHorizontalAutoTimer() {
    clearInterval(horizAutoTimer);
    const intervalMs = Math.max(1200, Math.round((8.8 - autoScrollSpeed * 0.72) * 1000));
    horizAutoTimer = setInterval(() => {
      if (!autoScrolling || mode !== 'horizontal') return;
      if (currentPage >= totalPages) {
        setAutoScrolling(false);
        showToast('Đã đọc đến trang cuối cùng.');
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
    const pxPerSec = autoScrollSpeed * 42;
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
    autoScrollBtn.setAttribute('aria-pressed', String(autoScrolling));
    autoScrollBtn.classList.toggle('active', autoScrolling);
    autoScrollBtn.replaceChildren(svgIcon(autoScrolling ? 'pause' : 'play', 17));

    if (!autoScrolling) return;
    setHudVisible(false);
    if (mode === 'vertical') {
      lastFrameTs = 0;
      rafId = requestAnimationFrame(verticalAutoStep);
    } else {
      restartHorizontalAutoTimer();
    }
  }

  // --- Touch Gestures: Pinch-zoom, Pan, 1:1 Horizontal Swipe w/ Rubber-band, Double-tap ---
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

      // Direct 1:1 horizontal page tracking with edge rubber-banding
      if (mode === 'horizontal' && (horizDragging || (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15))) {
        e.preventDefault();
        horizDragging = true;
        const atStartEdge = currentPage <= 1 && dx > 0;
        const atEndEdge = currentPage >= totalPages && dx < 0;
        horizDragX = (atStartEdge || atEndEdge) ? rubberband(dx, viewport.clientWidth * 0.5, 0.45) : dx;
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
        stage.style.transition = '';
        stage.style.transform = '';
        goToPage(goNext ? currentPage + 1 : currentPage - 1);
      } else {
        // Spring-like snap back to center
        stage.style.transition = 'transform 280ms cubic-bezier(0.23, 1, 0.32, 1)';
        stage.style.transform = 'translate3d(0, 0, 0)';
        setTimeout(() => {
          stage.style.transition = '';
          stage.style.transform = '';
        }, 280);
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
    tapTimer = setTimeout(() => {
      handleViewportTap(tapX);
    }, 240);
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

  // Auto-hide HUD the instant user scrolls in vertical reading mode so controls never get in the way
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

  // Desktop mouse interactions: click, double-click zoom, Ctrl+wheel zoom
  let clickDelayTimer = 0;
  function onViewportClick(e) {
    // Touch taps already handled via onTouchEnd
    if (e.pointerType === 'touch') return;
    if (e.target.closest('button, input, dialog')) return;
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
    if (settingsDialog.open) return;
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
