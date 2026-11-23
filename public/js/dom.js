import { proxyImageUrl, getCachedImageObjectUrl } from './api.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'className') {
        node.className = v;
      } else if (k === 'dataset' && typeof v === 'object') {
        for (const [dk, dv] of Object.entries(v)) {
          if (dv !== undefined && dv !== null) node.dataset[dk] = String(dv);
        }
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) {
        node.setAttribute(k, '');
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
  return node;
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6.5h-5V21H4a1 1 0 0 1-1-1z',
  search: 'M10.5 3a7.5 7.5 0 1 0 4.65 13.38l4.74 4.74 1.41-1.41-4.74-4.74A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z',
  heart: 'M12 21.35 10.55 20.03C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z',
  heartOutline: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3Zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05Z',
  history: 'M13 3a9 9 0 1 0 8.95 10h-2.02A7 7 0 1 1 13 5c1.93 0 3.68.79 4.95 2.05L15 10h7V3l-2.64 2.64A8.96 8.96 0 0 0 13 3Zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12Z',
  download: 'M5 20h14v-2H5v2Zm7-17v10.17l3.59-3.58L17 11l-5 5-5-5 1.41-1.41L11 13.17V3h1Z',
  gift: 'M20 7h-2.18A3 3 0 0 0 12 4.35 3 3 0 0 0 6.18 7H4a2 2 0 0 0-2 2v3h2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8h2V9a2 2 0 0 0-2-2Zm-5-2a1 1 0 1 1 0 2h-2V6a1 1 0 0 1 2-1ZM9 5a1 1 0 0 1 2 1v1H9a1 1 0 0 1 0-2Zm-3 15v-8h5v8H6Zm12 0h-5v-8h5v8Zm2-10H4V9h16v1Z',
  shuffle: 'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41ZM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5Zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13Z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5h-1v3h2V2h-1Zm0 17h-1v3h2v-3h-1ZM4.22 5.64 5.64 4.22 3.51 2.1 2.1 3.51l2.12 2.13Zm16.27 12.73-1.42 1.41 2.13 2.12 1.41-1.41-2.12-2.12ZM2 11v2h3v-2H2Zm17 0v2h3v-2h-3ZM4.22 18.36 2.1 20.49l1.41 1.41 2.13-2.12-1.42-1.42ZM19.78 5.64l2.12-2.13-1.41-1.41-2.13 2.12 1.42 1.42Z',
  moon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1Z',
  chevronLeft: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  chevronRight: 'M8.59 16.59 10 18l6-6-6-6-1.41 1.41L13.17 12z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  settings: 'M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.1 7.1 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.55-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.4.31.61.22l2.39-.96c.51.39 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.55 1.63-.94l2.39.96c.22.09.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  close: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.29-6.3z',
  refresh: 'M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z',
  book: 'M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2ZM9 4h2v5l-1-.75L9 9V4Zm9 16H6V4h1v9l3-2.25L13 13V4h5v16Z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z',
  vertical: 'M4 3h16v6H4V3Zm0 8h16v10H4V11Z',
  horizontal: 'M3 4h8v16H3V4Zm10 0h8v16h-8V4Z',
  zoomIn: 'M15.5 14h-.79l-.28-.27A6.5 6.5 0 1 0 13.73 14.43l.27.28v.79l5 5 1.5-1.5-5-5Zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm.5-7H9v2H7v1h2v2h1v-2h2V9h-2V7Z',
  zoomOut: 'M15.5 14h-.79l-.28-.27A6.5 6.5 0 1 0 13.73 14.43l.27.28v.79l5 5 1.5-1.5-5-5Zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9ZM7 9v1h5V9H7Z',
  trophy: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 15.9V19H7v2h10v-2h-4v-3.1a5.01 5.01 0 0 0 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2ZM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8Zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1Z',
  calendar: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-2 .9-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 16H5V10h14v10Zm0-12H5V6h14v2ZM7 12h5v5H7v-5Z',
  coin: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm.75 15.93V19h-1.5v-1.08c-1.45-.23-2.55-1.1-2.72-2.42h1.68c.15.65.72 1.12 1.79 1.12 1.15 0 1.72-.48 1.72-1.17 0-.68-.5-.98-1.95-1.33-1.84-.44-2.95-1.12-2.95-2.52 0-1.26.98-2.17 2.43-2.46V7.9h1.5v1.22c1.25.25 2.13 1.07 2.31 2.25h-1.67c-.15-.55-.64-.97-1.45-.97-.95 0-1.51.45-1.51 1.08 0 .61.55.92 1.98 1.26 1.87.45 2.92 1.16 2.92 2.57 0 1.38-1.02 2.34-2.58 2.62Z',
  ticket: 'M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4Zm-9 7.5h-2v-2h2v2Zm0-4.5h-2v-2h2v2Zm0-4.5h-2v-2h2v2Z',
  star: 'M12 2.5 14.9 8.4l6.5.95-4.7 4.58 1.11 6.47L12 17.34 6.19 20.4l1.11-6.47-4.7-4.58 6.5-.95L12 2.5Z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z',
  flame: 'M13.5 2.5c.3 2.7-1.2 4.3-2.5 5.6-1.4 1.4-2.5 2.8-2.5 5 0 2.5 1.8 4.4 4.2 4.4 2.5 0 4.3-2 4.3-4.6 0-1.9-.9-3.6-2-4.8.2 1.5-.6 2.6-1.5 3.1.2-2.2 1.4-5.1 0-8.7ZM12 22c-4.1 0-7.5-3.2-7.5-7.4 0-3.2 1.8-5.7 3.9-7.9 1.6-1.6 3-3.2 3-5.2 0-.3.4-.5.6-.3 3.7 2.4 7.5 6.4 7.5 12.1 0 4.8-3.4 8.7-7.5 8.7Z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  menu: 'M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h13v2H3v-2Z',
};

export function svgIcon(name, size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.book);
  svg.appendChild(p);
  return svg;
}

/**
 * Creates a resilient <img> following optimize-image-priority rules:
 * - priority='high': fetchpriority="high", NO loading="lazy"
 * - priority='low': fetchpriority="low" + loading="lazy" (hidden above-the-fold slides)
 * - priority='lazy' (default): loading="lazy" ONLY (omit fetchpriority)
 */
export function createMangaImg(remoteUrl, alt, { priority = 'lazy', className = '', width, height } = {}) {
  const img = document.createElement('img');
  img.alt = alt || '';
  if (className) img.className = className;
  if (width) img.width = width;
  if (height) img.height = height;
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';

  if (priority === 'high') {
    img.setAttribute('fetchpriority', 'high');
  } else if (priority === 'low') {
    img.setAttribute('fetchpriority', 'low');
    img.loading = 'lazy';
  } else if (priority === 'lazy') {
    img.loading = 'lazy';
  }

  if (!remoteUrl) {
    img.classList.add('img-placeholder');
    return img;
  }

  let triedProxy = false;
  img.addEventListener('error', () => {
    if (!triedProxy) {
      triedProxy = true;
      img.src = proxyImageUrl(remoteUrl);
    } else {
      img.classList.add('img-error');
    }
  });

  // Prefer offline Cache API blob when previously downloaded
  getCachedImageObjectUrl(remoteUrl).then((objUrl) => {
    if (objUrl) {
      img.dataset.objectUrl = objUrl;
      img.src = objUrl;
    } else if (!img.src) {
      img.src = remoteUrl;
    }
  });
  img.src = remoteUrl;
  return img;
}

export function revokeObjectUrls(root) {
  if (!root) return;
  for (const img of root.querySelectorAll('img[data-object-url]')) {
    URL.revokeObjectURL(img.dataset.objectUrl);
    delete img.dataset.objectUrl;
  }
}

/**
 * Apple rubber-banding formula for soft boundary resistance (emil-apple-design §9).
 */
export function rubberband(overshoot, dimension = 180, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

let supportsDisplayTransition;
function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

/**
 * Smoothly closes a top-layer <dialog>, falling back to [data-closing] in Firefox/Safari
 * where `overlay` or discrete `display` transitions aren't supported (animate-to-from-top-layer).
 */
export async function closeTopLayer(dialog) {
  if (!dialog || !dialog.open) return;
  if (!supportsTopLayerExit()) {
    if (dialog.hasAttribute('data-closing')) return;
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations ? dialog.getAnimations({ subtree: true }) : [];
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 450)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.style.transform = '';
  dialog.style.transition = '';
  dialog.close();
}

/**
 * Wires iOS Bottom Sheet / macOS Modal Sheet behavior on a native <dialog closedby="any">:
 * - Safari fallback for `closedby="any"` light-dismiss
 * - Smooth top-layer exit animation fallback on `cancel`
 * - 1:1 Pointer-Events drag-to-dismiss with rubber-banding & release velocity handoff on mobile
 */
export function wireIosSheet(dialog) {
  if (!dialog || dialog.dataset.lightDismissWired) return;
  dialog.dataset.lightDismissWired = '1';

  // Fallback for browsers without `closedby` support (Safari)
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (inside) return;
      closeTopLayer(dialog);
    });
  }

  // Intercept native Esc / light-dismiss cancel so exit animation plays in Firefox/Safari
  dialog.addEventListener('cancel', (event) => {
    if (!supportsTopLayerExit()) {
      event.preventDefault();
      closeTopLayer(dialog);
    }
  });

  // 1:1 swipe-to-dismiss on the mobile bottom-sheet grabber/header
  const handle = dialog.querySelector('[data-sheet-handle]');
  if (!handle) return;

  let dragging = false;
  let activePointerId = null;
  let startY = 0;
  let currentOffset = 0;
  let samples = [];

  handle.addEventListener('pointerdown', (e) => {
    if (window.innerWidth >= 768) return; // macOS centered sheet doesn't drag-dismiss
    if (e.target.closest('button, a, input, select')) return;
    if (dragging) return;
    dragging = true;
    activePointerId = e.pointerId;
    startY = e.clientY;
    currentOffset = 0;
    samples = [{ y: e.clientY, t: performance.now() }];
    handle.setPointerCapture(e.pointerId);
    dialog.style.transition = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    const rawDy = e.clientY - startY;
    // Rubber-band when dragging upward past natural top edge
    currentOffset = rawDy < 0 ? rubberband(rawDy, 160, 0.45) : rawDy;
    dialog.style.transform = `translate3d(0, ${currentOffset.toFixed(1)}px, 0)`;
    const now = performance.now();
    samples.push({ y: e.clientY, t: now });
    if (samples.length > 5) samples.shift();
  });

  function finishDrag(e) {
    if (!dragging || e.pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;

    let velocity = 0; // px per ms
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = Math.max(1, last.t - first.t);
      velocity = (last.y - first.y) / dt;
    }

    const height = dialog.getBoundingClientRect().height || 400;
    const shouldDismiss = currentOffset > height * 0.28 || (currentOffset > 24 && velocity > 0.42);

    dialog.style.transition = 'transform 340ms cubic-bezier(0.32, 0.72, 0, 1)';
    if (shouldDismiss) {
      dialog.style.transform = `translate3d(0, ${Math.ceil(height + 40)}px, 0)`;
      setTimeout(() => {
        dialog.style.transform = '';
        dialog.style.transition = '';
        if (dialog.open) dialog.close();
      }, 260);
    } else {
      dialog.style.transform = 'translate3d(0, 0, 0)';
      setTimeout(() => {
        dialog.style.transform = '';
        dialog.style.transition = '';
      }, 340);
    }
  }

  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
}

export const wireDialogLightDismiss = wireIosSheet;

export function formatNumber(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}

export function formatRelativeTime(timestampMs) {
  if (!timestampMs) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return 'Vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
  if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)} ngày trước`;
  return new Date(timestampMs).toLocaleDateString('vi-VN');
}

export function formatUnixDate(unixSec) {
  if (!unixSec) return '';
  return new Date(unixSec * 1000).toLocaleDateString('vi-VN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

let toastTimer = null;
export function showToast(message, variant = 'info') {
  const host = document.getElementById('toast-region');
  if (!host) return;
  host.textContent = message;
  host.dataset.variant = variant;
  host.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.classList.remove('visible');
  }, 3200);
}

/**
 * Pure SPA route parser (unit-tested in test/app.test.mjs).
 */
export function parseRoute(pathname, search = '') {
  const cleanPath = (pathname || '/').replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search || '');

  if (cleanPath === '/') return { name: 'home', params: {} };
  if (cleanPath === '/search') {
    return {
      name: 'search',
      params: {
        q: params.get('q') || '',
        sort: params.get('sort') || 'popular',
      },
    };
  }
  if (cleanPath === '/favorites') return { name: 'favorites', params: {} };
  if (cleanPath === '/history') return { name: 'history', params: {} };
  if (cleanPath === '/downloads') return { name: 'downloads', params: {} };

  const mangaMatch = cleanPath.match(/^\/manga\/(\d+)$/);
  if (mangaMatch) {
    return { name: 'detail', params: { id: Number(mangaMatch[1]) } };
  }

  const readMatch = cleanPath.match(/^\/read\/(\d+)(?:\/(\d+))?$/);
  if (readMatch) {
    return {
      name: 'reader',
      params: {
        id: Number(readMatch[1]),
        page: Math.max(1, Number(readMatch[2] || 1)),
      },
    };
  }

  return { name: 'home', params: {} };
}

/**
 * Native scroll-snap carousel controller following modern-web-guidance `carousel` rules:
 * - Continuous looping via CSS `order` + `sibling-count()` (with JS `--children-count` fallback)
 * - Settled-scroll tracking via `scrollend` (debounced `scroll` fallback when unsupported)
 * - Polite live announcements only on settled user navigation (silent on initial load & park)
 * - Pending target resolution for rapid Previous/Next clicks & sequential marker travel
 */
export function initCarousel(carouselEl) {
  const track = carouselEl.querySelector('.carousel-track');
  const prevBtn = carouselEl.querySelector('[data-direction="previous"]');
  const nextBtn = carouselEl.querySelector('[data-direction="next"]');
  const markersNav = carouselEl.querySelector('.carousel-markers');
  const statusEl = carouselEl.querySelector('[role="status"]');

  const slides = Array.from(track.children);
  const total = slides.length;
  if (!total) return () => {};

  const looping = total >= 3;
  if (looping && !CSS.supports('order: sibling-count()')) {
    track.style.setProperty('--children-count', String(total));
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const markerButtons = [];
  markersNav.replaceChildren();

  slides.forEach((slide, idx) => {
    const btn = el(
      'button',
      {
        type: 'button',
        className: 'carousel-marker',
        'aria-label': slide.dataset.markerName || `Slide ${idx + 1}`,
        onClick: () => goToMarker(idx),
      },
      el('span', { className: 'carousel-marker-dot', 'aria-hidden': 'true' })
    );
    markerButtons.push(btn);
    markersNav.appendChild(btn);
  });

  let settledIndex = 0;
  let activeMarkerIndex = -1;
  let pendingTargetIndex = null;
  let requestedFromScrollLeft = null;
  let heldDirection = null;
  let scrollRaf = 0;
  let debounceTimer = 0;
  let suppressStatus = true;

  function visualSlides() {
    return [...slides].sort((a, b) => a.offsetLeft - b.offsetLeft);
  }

  function slideCenter(slide) {
    return slide.offsetLeft + slide.offsetWidth / 2;
  }

  function trackCenter() {
    return track.scrollLeft + track.clientWidth / 2;
  }

  function findNearestSlideIndex() {
    const center = trackCenter();
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < total; i++) {
      const dist = Math.abs(slideCenter(slides[i]) - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function setActiveMarker(idx) {
    if (idx === activeMarkerIndex) return;
    activeMarkerIndex = idx;
    markerButtons.forEach((btn, i) => {
      if (i === idx) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
  }

  function updateParallax() {
    if (reducedMotion.matches) return;
    const center = trackCenter();
    const width = Math.max(1, track.clientWidth);
    for (const slide of slides) {
      const offset = (slideCenter(slide) - center) / width;
      const clamped = Math.max(-1, Math.min(1, offset));
      slide.style.setProperty('--parallax-x', `${(clamped * -22).toFixed(1)}px`);
    }
  }

  function scrollToSlide(targetSlide, smooth = !reducedMotion.matches) {
    const delta = slideCenter(targetSlide) - trackCenter();
    requestedFromScrollLeft = Math.round(track.scrollLeft);
    track.scrollBy({
      left: delta,
      behavior: smooth ? 'smooth' : 'instant',
    });
  }

  function applyParking(currentIdx, { lockOverflow = true } = {}) {
    if (!looping) return;
    const prevProp = track.style.getPropertyValue('--current');
    const nextProp = currentIdx === null ? '' : String(currentIdx);
    if (prevProp === nextProp) return;

    const anchorSlide = slides[findNearestSlideIndex()];
    const beforeOffset = anchorSlide.offsetLeft;
    const prevSnap = track.style.scrollSnapType;

    track.style.scrollSnapType = 'none';
    if (lockOverflow) track.style.overflowX = 'hidden';

    if (currentIdx === null) {
      track.style.setProperty('--current', 'initial');
    } else {
      track.style.setProperty('--current', String(currentIdx));
    }

    const afterOffset = anchorSlide.offsetLeft;
    const diff = afterOffset - beforeOffset;
    if (diff !== 0) {
      track.scrollBy({ left: diff, behavior: 'instant' });
    }
    track.style.scrollSnapType = prevSnap;

    if (lockOverflow) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          track.style.overflowX = '';
        });
      });
    }
  }

  function updateButtonStates(idx) {
    if (looping) {
      prevBtn.disabled = false;
      nextBtn.disabled = false;
      return;
    }
    const prevWasFocused = document.activeElement === prevBtn;
    const nextWasFocused = document.activeElement === nextBtn;
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= total - 1;
    if (prevBtn.disabled && prevWasFocused) nextBtn.focus();
    if (nextBtn.disabled && nextWasFocused) prevBtn.focus();
  }

  function step(direction) {
    if (total <= 1) return;
    suppressStatus = false;

    if (looping && track.style.getPropertyValue('--current') === 'initial') {
      heldDirection = direction;
      return;
    }

    const ordered = visualSlides();
    const baseIdx = pendingTargetIndex !== null ? pendingTargetIndex : findNearestSlideIndex();
    const visualPos = ordered.indexOf(slides[baseIdx]);
    const nextVisualPos = visualPos + (direction === 'next' ? 1 : -1);
    if (nextVisualPos < 0 || nextVisualPos >= ordered.length) return;

    const targetSlide = ordered[nextVisualPos];
    const targetIdx = slides.indexOf(targetSlide);
    pendingTargetIndex = targetIdx;
    setActiveMarker(targetIdx);
    scrollToSlide(targetSlide);
  }

  function goToMarker(targetIdx) {
    if (targetIdx === findNearestSlideIndex() && pendingTargetIndex === null) return;
    suppressStatus = false;
    heldDirection = null;
    if (looping) {
      // Un-park into DOM order without overflow lock so Safari initiates the scroll cleanly.
      applyParking(null, { lockOverflow: false });
    }
    pendingTargetIndex = targetIdx;
    setActiveMarker(targetIdx);
    scrollToSlide(slides[targetIdx]);
  }

  function handleSettled() {
    if (
      pendingTargetIndex !== null &&
      requestedFromScrollLeft !== null &&
      Math.abs(Math.round(track.scrollLeft) - requestedFromScrollLeft) <= 1 &&
      findNearestSlideIndex() !== pendingTargetIndex
    ) {
      // Stale settle belonging to a previous scroll before the new scroll moved.
      return;
    }

    const idx = findNearestSlideIndex();
    pendingTargetIndex = null;
    requestedFromScrollLeft = null;
    setActiveMarker(idx);
    updateButtonStates(idx);

    const hasHeld = Boolean(heldDirection);
    if (looping) {
      applyParking(idx, { lockOverflow: !hasHeld });
    }
    updateParallax();

    if (!suppressStatus && idx !== settledIndex && statusEl) {
      statusEl.textContent = `Trang nổi bật ${idx + 1} trên ${total}`;
    }
    settledIndex = idx;
    suppressStatus = false;

    if (hasHeld) {
      const dir = heldDirection;
      heldDirection = null;
      step(dir);
    }
  }

  const onPrev = () => step('previous');
  const onNext = () => step('next');
  prevBtn.addEventListener('click', onPrev);
  nextBtn.addEventListener('click', onNext);

  const supportsScrollEnd = 'onscrollend' in window;
  const onScroll = () => {
    if (!supportsScrollEnd) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(handleSettled, 130);
    }
    if (pendingTargetIndex !== null) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      setActiveMarker(findNearestSlideIndex());
      updateParallax();
    });
  };

  track.addEventListener('scroll', onScroll, { passive: true });
  if (supportsScrollEnd) {
    track.addEventListener('scrollend', handleSettled);
  }

  // Initial sync without speaking to assistive technology
  setActiveMarker(0);
  updateButtonStates(0);
  if (looping) applyParking(0, { lockOverflow: false });
  updateParallax();

  // Keep current slide aligned when viewport or device orientation changes
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (pendingTargetIndex !== null) return;
        const slide = slides[settledIndex];
        if (!slide) return;
        const delta = slideCenter(slide) - trackCenter();
        if (Math.abs(delta) > 2) {
          track.scrollBy({ left: delta, behavior: 'instant' });
        }
        updateParallax();
      })
    : null;
  resizeObserver?.observe(track);

  return () => {
    prevBtn.removeEventListener('click', onPrev);
    nextBtn.removeEventListener('click', onNext);
    track.removeEventListener('scroll', onScroll);
    if (supportsScrollEnd) track.removeEventListener('scrollend', handleSettled);
    resizeObserver?.disconnect();
    cancelAnimationFrame(scrollRaf);
    clearTimeout(debounceTimer);
  };
}
