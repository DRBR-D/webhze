"""Multi-language Manga OCR + LaMa CUDA Inpainting + Crisp Vietnamese Typesetting Pipeline.

Optimized for RTX 3050 Mobile (4GB VRAM) + 8GB RAM on Arch Linux:
- RapidOCR PP-OCRv4 ONNX runs on CPU (~250MB RAM, 0 MB VRAM) with JA/EN/ZH/KO/Auto models.
- LaMa TorchScript runs on CUDA GPU at <= 1024px (~1.2-1.6GB VRAM), compositing only the
  feathered text regions back onto full-resolution original artwork.
"""

from __future__ import annotations

import gc
import io
import math
import os
import pathlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import cv2
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFont
from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR

from gemini_translator import GeminiMangaTranslator

try:
    import torch
except Exception:
    torch = None

WORKER_DIR = pathlib.Path(__file__).resolve().parent
MODELS_DIR = WORKER_DIR / "models"
LAMA_URL = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt"
LAMA_PATH = MODELS_DIR / "big-lama.pt"

FONT_CANDIDATES = [
    "/usr/share/fonts/noto/NotoSans-SemiCondensedBold.ttf",
    "/usr/share/fonts/noto/NotoSans-CondensedExtraBold.ttf",
    "/usr/share/fonts/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]


@dataclass
class TextBox:
    polygon: np.ndarray  # shape (4, 2) float32
    x1: float
    y1: float
    x2: float
    y2: float
    text: str
    score: float
    vertical: bool


@dataclass
class BubbleCluster:
    boxes: list[TextBox]
    x1: float
    y1: float
    x2: float
    y2: float
    text: str
    translated: str = ""


def _pick_vietnamese_font() -> str | None:
    custom = os.getenv("MANGA_FONT_PATH", "").strip()
    if custom and os.path.isfile(custom):
        return custom
    for p in FONT_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None


def _build_ocr_engine(lang: str) -> RapidOCR:
    lang = (lang or "auto").lower()
    if lang == "ja":
        params = {
            "Det.ocr_version": OCRVersion.PPOCRV4,
            "Det.lang_type": LangDet.CH,
            "Det.model_type": ModelType.MOBILE,
            "Rec.ocr_version": OCRVersion.PPOCRV4,
            "Rec.lang_type": LangRec.JAPAN,
            "Rec.model_type": ModelType.MOBILE,
        }
    elif lang == "en":
        params = {
            "Det.ocr_version": OCRVersion.PPOCRV4,
            "Det.lang_type": LangDet.CH,
            "Det.model_type": ModelType.MOBILE,
            "Rec.ocr_version": OCRVersion.PPOCRV4,
            "Rec.lang_type": LangRec.EN,
            "Rec.model_type": ModelType.MOBILE,
        }
    elif lang == "ko":
        params = {
            "Det.ocr_version": OCRVersion.PPOCRV4,
            "Det.lang_type": LangDet.CH,
            "Det.model_type": ModelType.MOBILE,
            "Rec.ocr_version": OCRVersion.PPOCRV4,
            "Rec.lang_type": LangRec.KOREAN,
            "Rec.model_type": ModelType.MOBILE,
        }
    else:
        # 'zh' or 'auto' -> CH PP-OCRv4 covers Chinese, English, numbers & CJK Kanji cleanly
        params = {
            "Det.ocr_version": OCRVersion.PPOCRV4,
            "Det.lang_type": LangDet.CH,
            "Det.model_type": ModelType.MOBILE,
            "Rec.ocr_version": OCRVersion.PPOCRV4,
            "Rec.lang_type": LangRec.CH,
            "Rec.model_type": ModelType.MOBILE,
        }
    return RapidOCR(params=params)


def _should_merge(a: TextBox, b: TextBox) -> bool:
    aw, ah = max(1.0, a.x2 - a.x1), max(1.0, a.y2 - a.y1)
    bw, bh = max(1.0, b.x2 - b.x1), max(1.0, b.y2 - b.y1)
    char_sz = min(max(12.0, min(aw, ah)), max(12.0, min(bw, bh)))

    dx = max(0.0, max(a.x1 - b.x2, b.x1 - a.x2))
    dy = max(0.0, max(a.y1 - b.y2, b.y1 - a.y2))

    # Vertical Japanese/Chinese columns sit side-by-side in the same speech bubble
    if a.vertical and b.vertical:
        y_overlap = min(a.y2, b.y2) - max(a.y1, b.y1)
        return dx <= char_sz * 1.15 and dy <= char_sz * 0.75 and y_overlap > -char_sz * 0.6

    # Horizontal English/Korean lines stack vertically inside a speech bubble
    x_overlap = min(a.x2, b.x2) - max(a.x1, b.x1)
    return dy <= char_sz * 1.15 and dx <= char_sz * 0.85 and x_overlap > -char_sz * 0.5


def cluster_bubbles(boxes: list[TextBox], reading_dir: str = "rtl") -> list[BubbleCluster]:
    n = len(boxes)
    if n == 0:
        return []
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if _should_merge(boxes[i], boxes[j]):
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[rj] = ri

    groups: dict[int, list[TextBox]] = {}
    for idx, box in enumerate(boxes):
        groups.setdefault(find(idx), []).append(box)

    clusters: list[BubbleCluster] = []
    for grp in groups.values():
        mostly_vertical = sum(1 for b in grp if b.vertical) > len(grp) / 2
        if mostly_vertical:
            # Manga vertical columns: right-to-left, then top-to-bottom
            grp.sort(key=lambda b: (-((b.x1 + b.x2) * 0.5), b.y1))
            joined = "".join(b.text for b in grp)
        else:
            # Horizontal lines: top-to-bottom, then left-to-right
            grp.sort(key=lambda b: (b.y1, b.x1))
            joined = " ".join(b.text for b in grp)

        joined = " ".join(joined.split()).strip()
        if not joined:
            continue

        x1 = min(b.x1 for b in grp)
        y1 = min(b.y1 for b in grp)
        x2 = max(b.x2 for b in grp)
        y2 = max(b.y2 for b in grp)
        clusters.append(BubbleCluster(boxes=grp, x1=x1, y1=y1, x2=x2, y2=y2, text=joined))

    # Sort bubbles in natural manga reading order (band-grouped top-to-bottom, RTL or LTR)
    if reading_dir == "rtl":
        clusters.sort(key=lambda c: (int(c.y1 // 160), -c.x2, c.y1))
    else:
        clusters.sort(key=lambda c: (int(c.y1 // 160), c.x1, c.y1))
    return clusters


class LamaInpainter:
    """Lazy-loaded LaMa TorchScript inpainter tuned for 4GB VRAM RTX 3050 Mobile."""

    def __init__(self, device: str = "cuda", max_size: int = 1024):
        self.requested_device = device
        self.max_size = max(512, min(1536, int(max_size)))
        self.device = "cpu"
        self.model = None
        self.failed = False

    def _ensure_weights(self) -> bool:
        if LAMA_PATH.is_file() and LAMA_PATH.stat().st_size > 50_000_000:
            return True
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        tmp_path = LAMA_PATH.with_suffix(".tmp")
        print(f"[LaMa] Downloading big-lama.pt (~196MB) to {LAMA_PATH} ...", flush=True)
        try:
            with requests.get(LAMA_URL, stream=True, timeout=180) as r:
                r.raise_for_status()
                with open(tmp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
            tmp_path.replace(LAMA_PATH)
            print("[LaMa] Download complete.", flush=True)
            return True
        except Exception as exc:
            print(f"[LaMa] Download failed ({exc}); using OpenCV inpaint fallback.", flush=True)
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            return False

    def _load(self) -> bool:
        if self.model is not None:
            return True
        if self.failed or torch is None:
            return False
        if not self._ensure_weights():
            self.failed = True
            return False
        try:
            use_cuda = self.requested_device == "cuda" and torch.cuda.is_available()
            self.device = "cuda" if use_cuda else "cpu"
            self.model = torch.jit.load(str(LAMA_PATH), map_location=self.device)
            self.model.eval()
            print(f"[LaMa] Loaded TorchScript model on {self.device.upper()}.", flush=True)
            return True
        except Exception as exc:
            print(f"[LaMa] Load failed ({exc}); using OpenCV fallback.", flush=True)
            self.failed = True
            return False

    def inpaint(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        ys, xs = np.nonzero(mask > 0)
        if ys.size == 0:
            return rgb

        if not self._load():
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            cleaned = cv2.inpaint(bgr, mask, 5, cv2.INPAINT_TELEA)
            return cv2.cvtColor(cleaned, cv2.COLOR_BGR2RGB)

        # Tight ROI crop around text mask (+64px context) -> faster LaMa + higher effective resolution
        full_h, full_w = rgb.shape[:2]
        pad_ctx = 64
        ry1 = max(0, int(ys.min()) - pad_ctx)
        ry2 = min(full_h, int(ys.max()) + 1 + pad_ctx)
        rx1 = max(0, int(xs.min()) - pad_ctx)
        rx2 = min(full_w, int(xs.max()) + 1 + pad_ctx)

        roi_rgb = rgb[ry1:ry2, rx1:rx2]
        roi_mask = mask[ry1:ry2, rx1:rx2]
        orig_h, orig_w = roi_rgb.shape[:2]
        scale = min(1.0, self.max_size / float(max(orig_h, orig_w)))
        work_w = max(8, int(round(orig_w * scale)))
        work_h = max(8, int(round(orig_h * scale)))

        if scale < 1.0:
            small_rgb = cv2.resize(roi_rgb, (work_w, work_h), interpolation=cv2.INTER_AREA)
            small_mask = cv2.resize(roi_mask, (work_w, work_h), interpolation=cv2.INTER_NEAREST)
        else:
            small_rgb = roi_rgb
            small_mask = roi_mask

        pad_h = (8 - (work_h % 8)) % 8
        pad_w = (8 - (work_w % 8)) % 8
        if pad_h or pad_w:
            small_rgb = cv2.copyMakeBorder(small_rgb, 0, pad_h, 0, pad_w, cv2.BORDER_REFLECT_101)
            small_mask = cv2.copyMakeBorder(small_mask, 0, pad_h, 0, pad_w, cv2.BORDER_CONSTANT, value=0)

        img_t = torch.from_numpy(small_rgb).permute(2, 0, 1).unsqueeze(0).float().div_(255.0).to(self.device)
        mask_t = torch.from_numpy((small_mask > 127).astype(np.float32)).unsqueeze(0).unsqueeze(0).to(self.device)

        try:
            with torch.inference_mode():
                out_t = self.model(img_t, mask_t)
            out_np = out_t[0].permute(1, 2, 0).clamp(0, 255).byte().cpu().numpy()
            if out_np.max() <= 1:
                out_np = (out_t[0].permute(1, 2, 0).clamp(0, 1).cpu().numpy() * 255.0).astype(np.uint8)
        except RuntimeError as exc:
            # Automatic OOM safety fallback on 4GB VRAM cards
            print(f"[LaMa] GPU runtime error ({exc}), falling back to OpenCV.", flush=True)
            if self.device == "cuda":
                torch.cuda.empty_cache()
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            cleaned = cv2.inpaint(bgr, mask, 5, cv2.INPAINT_TELEA)
            return cv2.cvtColor(cleaned, cv2.COLOR_BGR2RGB)
        finally:
            del img_t, mask_t

        out_np = out_np[:work_h, :work_w]
        if scale < 1.0:
            out_roi = cv2.resize(out_np, (orig_w, orig_h), interpolation=cv2.INTER_CUBIC)
        else:
            out_roi = out_np

        # Feather composite ONLY inside ROI mask, keeping 100% native sharpness everywhere else!
        result = rgb.copy()
        alpha = cv2.GaussianBlur((roi_mask > 127).astype(np.float32), (5, 5), 0)[..., None]
        blended = out_roi.astype(np.float32) * alpha + roi_rgb.astype(np.float32) * (1.0 - alpha)
        result[ry1:ry2, rx1:rx2] = np.clip(blended, 0, 255).astype(np.uint8)
        return result


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    cur = words[0]
    for w in words[1:]:
        candidate = f"{cur} {w}"
        if draw.textlength(candidate, font=font) <= max_width:
            cur = candidate
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def render_vietnamese_bubbles(rgb: np.ndarray, clusters: list[BubbleCluster], font_path: str | None) -> Image.Image:
    pil_img = Image.fromarray(rgb)
    draw = ImageDraw.Draw(pil_img)
    img_w, img_h = pil_img.size

    for c in clusters:
        txt = (c.translated or "").strip()
        if not txt:
            continue

        # Give Vietnamese text slightly more horizontal room than tall Japanese vertical columns
        box_w = max(44.0, c.x2 - c.x1)
        box_h = max(28.0, c.y2 - c.y1)
        if box_h > box_w * 1.8:
            expand_x = min(box_w * 0.45, 42.0)
            x1 = max(4.0, c.x1 - expand_x)
            x2 = min(img_w - 4.0, c.x2 + expand_x)
        else:
            x1 = max(4.0, c.x1 - 6.0)
            x2 = min(img_w - 4.0, c.x2 + 6.0)
        y1 = max(4.0, c.y1 - 4.0)
        y2 = min(img_h - 4.0, c.y2 + 4.0)

        avail_w = max(36, int(x2 - x1 - 6))
        avail_h = max(24, int(y2 - y1 - 4))

        # Sample cleaned bubble luminance for crisp adaptive ink + outline contrast
        roi = rgb[int(y1) : max(int(y1) + 1, int(y2)), int(x1) : max(int(x1) + 1, int(x2))]
        luma = float(np.median(roi)) if roi.size else 245.0
        if luma >= 128.0:
            fill_color = (16, 16, 22)
            stroke_color = (255, 255, 255)
        else:
            fill_color = (250, 250, 255)
            stroke_color = (14, 14, 20)

        # Binary-search the largest font size that fits cleanly inside the bubble
        lo, hi = 11, min(42, max(16, int(math.sqrt(avail_w * avail_h / max(1, len(txt))) * 1.45)))
        best_size = lo
        best_lines = [txt]
        best_font = ImageFont.truetype(font_path, lo) if font_path else ImageFont.load_default()

        if font_path:
            while lo <= hi:
                mid = (lo + hi) // 2
                font = ImageFont.truetype(font_path, mid)
                lines = _wrap_text(draw, txt, font, avail_w)
                max_line_w = max((draw.textlength(ln, font=font) for ln in lines), default=0)
                line_h = int(mid * 1.24)
                total_h = line_h * len(lines)
                if max_line_w <= avail_w + 4 and total_h <= avail_h + 4:
                    best_size = mid
                    best_lines = lines
                    best_font = font
                    lo = mid + 1
                else:
                    hi = mid - 1
        else:
            best_lines = _wrap_text(draw, txt, best_font, avail_w)

        line_h = int(best_size * 1.22)
        total_h = line_h * len(best_lines)
        start_y = y1 + (y2 - y1 - total_h) / 2.0
        center_x = (x1 + x2) / 2.0
        stroke_w = 2 if best_size >= 15 else 1

        for idx, line in enumerate(best_lines):
            lw = draw.textlength(line, font=best_font)
            tx = max(4.0, min(img_w - lw - 4.0, center_x - lw / 2.0))
            ty = max(2.0, min(img_h - line_h - 2.0, start_y + idx * line_h))
            draw.text(
                (tx, ty),
                line,
                font=best_font,
                fill=fill_color,
                stroke_width=stroke_w,
                stroke_fill=stroke_color,
            )

    return pil_img


class MangaTranslationPipeline:
    """End-to-end multi-language OCR -> Gemini Context Translate -> LaMa Inpaint -> Vietnamese Render."""

    def __init__(self, translator: GeminiMangaTranslator | None = None):
        self.translator = translator or GeminiMangaTranslator()
        self.font_path = _pick_vietnamese_font()
        self.inpainter = LamaInpainter(
            device=os.getenv("DEVICE", "cuda"),
            max_size=int(os.getenv("INPAINT_MAX_SIZE", "768")),
        )
        # Keep at most 2 OCR engines loaded to stay lightweight on 8GB RAM
        self._ocr_cache: dict[str, RapidOCR] = {}
        self._ocr_lock = threading.Lock()
        self._gpu_lock = threading.Lock()
        self._stage_pool = ThreadPoolExecutor(max_workers=6)

    def warmup(self) -> None:
        """Pre-load LaMa onto CUDA at worker startup so Page 1 has zero cold-start delay."""
        with self._gpu_lock:
            self.inpainter._load()

    def _get_ocr(self, source_lang: str) -> RapidOCR:
        key = source_lang if source_lang in ("ja", "en", "zh", "ko") else "auto"
        if key not in self._ocr_cache:
            if len(self._ocr_cache) >= 2:
                oldest = next(iter(self._ocr_cache))
                del self._ocr_cache[oldest]
                gc.collect()
            print(f"[OCR] Loading RapidOCR PP-OCRv4 model ({key})...", flush=True)
            self._ocr_cache[key] = _build_ocr_engine(key)
        return self._ocr_cache[key]

    def process_image_bytes(
        self,
        raw_bytes: bytes,
        source_lang: str = "auto",
        target_lang: str = "vi",
        reading_dir: str = "rtl",
    ) -> tuple[bytes, dict]:
        t0 = time.perf_counter()
        pil_in = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
        rgb = np.array(pil_in)
        h, w = rgb.shape[:2]

        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        with self._ocr_lock:
            ocr = self._get_ocr(source_lang)
            out = ocr(bgr)

        raw_boxes: list[TextBox] = []
        if out and out.boxes is not None and out.txts is not None:
            scores = out.scores if out.scores is not None else [1.0] * len(out.txts)
            for poly, txt, sc in zip(out.boxes, out.txts, scores):
                text = str(txt or "").strip()
                if not text or float(sc) < 0.35:
                    continue
                pts = np.asarray(poly, dtype=np.float32).reshape(-1, 2)
                x1, y1 = float(pts[:, 0].min()), float(pts[:, 1].min())
                x2, y2 = float(pts[:, 0].max()), float(pts[:, 1].max())
                if (x2 - x1) < 6 or (y2 - y1) < 6:
                    continue
                vertical = (y2 - y1) > (x2 - x1) * 1.45
                raw_boxes.append(TextBox(pts, x1, y1, x2, y2, text, float(sc), vertical))

        clusters = cluster_bubbles(raw_boxes, reading_dir=reading_dir)
        if not clusters:
            # No text detected on artwork/cover page: return clean WebP unchanged
            buf = io.BytesIO()
            pil_in.save(buf, format="WEBP", quality=84, method=1)
            return buf.getvalue(), {
                "bubbles": 0,
                "model": "no_text",
                "fallbackCount": 0,
                "ms": int((time.perf_counter() - t0) * 1000),
            }

        # Smart Hybrid Text Eraser:
        # - Uniform solid bubbles (white speech bubbles / flat narration boxes, ring std < 12):
        #   exact border-median fill in <1ms (cleaner than neural blur, 0ms GPU!).
        # - Complex artwork / screentone / gradient / SFX backgrounds (ring std >= 12):
        #   full RTX 3050 LaMa CUDA inpainting (run IN PARALLEL with DeepSeek API!).
        dilate_px = max(7, int(round(min(h, w) * 0.008)))
        inner_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px * 2 + 1, dilate_px * 2 + 1))
        outer_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, ((dilate_px + 7) * 2 + 1, (dilate_px + 7) * 2 + 1))

        working_rgb = rgb.copy()
        lama_mask = np.zeros((h, w), dtype=np.uint8)
        for box in raw_boxes:
            bx1 = max(0, int(box.x1) - dilate_px - 10)
            by1 = max(0, int(box.y1) - dilate_px - 10)
            bx2 = min(w, int(box.x2) + dilate_px + 11)
            by2 = min(h, int(box.y2) + dilate_px + 11)
            local_poly = (box.polygon - np.array([bx1, by1], dtype=np.float32)).astype(np.int32)
            loc_mask = np.zeros((by2 - by1, bx2 - bx1), dtype=np.uint8)
            cv2.fillPoly(loc_mask, [local_poly], 255)
            inner = cv2.dilate(loc_mask, inner_k, iterations=1)
            ring = cv2.subtract(cv2.dilate(loc_mask, outer_k, iterations=1), inner)
            ring_px = working_rgb[by1:by2, bx1:bx2][ring > 0]
            if ring_px.size >= 16 and float(np.std(ring_px)) < 12.0:
                fill_rgb = np.median(ring_px, axis=0).astype(np.uint8)
                working_rgb[by1:by2, bx1:bx2][inner > 0] = fill_rgb
            else:
                lama_mask[by1:by2, bx1:bx2] = cv2.bitwise_or(lama_mask[by1:by2, bx1:bx2], inner)

        needs_lama = bool(np.any(lama_mask > 0))
        source_lines = [c.text for c in clusters]

        def _run_gpu_inpaint() -> np.ndarray:
            with self._gpu_lock:
                return self.inpainter.inpaint(working_rgb, lama_mask)

        # Overlap RTX 3050 LaMa (only when artwork background needs it) with DeepSeek API call!
        inpaint_fut = self._stage_pool.submit(_run_gpu_inpaint) if needs_lama else None
        translated_lines, trans_meta = self.translator.translate_page_lines(
            source_lines, source_lang=source_lang, target_lang=target_lang
        )
        cleaned_rgb = inpaint_fut.result() if inpaint_fut is not None else working_rgb

        for c, tr in zip(clusters, translated_lines):
            c.translated = tr

        # Render Vietnamese dialogue cleanly into the cleaned speech bubbles
        out_img = render_vietnamese_bubbles(cleaned_rgb, clusters, self.font_path)
        buf = io.BytesIO()
        out_img.save(buf, format="WEBP", quality=82, method=1)

        return buf.getvalue(), {
            "bubbles": len(clusters),
            "model": trans_meta.get("model", "gemini"),
            "fallbackCount": trans_meta.get("fallbackCount", 0),
            "device": self.inpainter.device,
            "ms": int((time.perf_counter() - t0) * 1000),
        }
