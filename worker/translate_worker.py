"""Outbound Arch Linux GPU Worker connecting to webhen Node server via SSE + HTTP POST.

No router port-forwarding needed! Works cleanly with Render Free sleep/wake via auto-reconnect.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import socket
import sys
import time

import requests

from gemini_translator import GeminiMangaTranslator
from image_pipeline import MangaTranslationPipeline

try:
    import torch
except Exception:
    torch = None

WORKER_DIR = pathlib.Path(__file__).resolve().parent
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def load_dotenv(env_path: pathlib.Path) -> None:
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def detect_gpu_name() -> str:
    if torch is not None and torch.cuda.is_available():
        try:
            name = torch.cuda.get_device_name(0)
            return name.replace("NVIDIA GeForce ", "")[:48]
        except Exception:
            return "CUDA GPU"
    return "CPU"


def fetch_source_image(session: requests.Session, server_url: str, image_url: str, proxy_path: str | None) -> bytes:
    # Prefer server's /api/img proxy if provided (avoids local ISP blocks on nhentai.net!)
    candidates = []
    if proxy_path:
        candidates.append(f"{server_url.rstrip('/')}{proxy_path}")
    if image_url:
        candidates.append(image_url)

    last_err = None
    for url in candidates:
        try:
            resp = session.get(url, headers={"User-Agent": UA}, timeout=25)
            resp.raise_for_status()
            if len(resp.content) > 64:
                return resp.content
        except Exception as exc:
            last_err = exc
    raise RuntimeError(f"Không tải được ảnh gốc: {last_err}")


def post_result(
    session: requests.Session,
    server_url: str,
    token: str,
    job_id: str,
    webp_bytes: bytes | None = None,
    meta: dict | None = None,
    error: str | None = None,
) -> None:
    url = f"{server_url.rstrip('/')}/api/worker/result/{job_id}"
    headers = {"X-Worker-Token": token}
    if error is not None:
        resp = session.post(url, json={"error": error}, headers=headers, timeout=20)
        resp.raise_for_status()
        return
    headers["Content-Type"] = "image/webp"
    if meta:
        headers["X-Translate-Meta"] = json.dumps(meta, ensure_ascii=True)
    resp = session.post(url, data=webp_bytes, headers=headers, timeout=35)
    resp.raise_for_status()


def run_worker_loop() -> None:
    load_dotenv(WORKER_DIR / ".env")
    server_url = os.getenv("SERVER_URL", "http://127.0.0.1:4321").rstrip("/")
    token = os.getenv("WORKER_TOKEN", "").strip()
    if not token:
        print("[ERROR] Thiếu WORKER_TOKEN trong worker/.env!", file=sys.stderr)
        sys.exit(1)

    translator = GeminiMangaTranslator()
    pipeline = MangaTranslationPipeline(translator=translator)
    gpu_name = detect_gpu_name()
    worker_name = os.getenv("WORKER_NAME", socket.gethostname() or "Arch-Laptop")
    primary_model = translator.models[0]

    print(f"=== MANGA GPU TRANSLATION WORKER ===", flush=True)
    print(f"Server : {server_url}", flush=True)
    print(f"Device : {gpu_name} | Inpaint <= {pipeline.inpainter.max_size}px", flush=True)
    print(f"Gemini : {' -> '.join(translator.models)}", flush=True)
    print(f"Font   : {pipeline.font_path or 'default'}", flush=True)

    http_sess = requests.Session()
    backoff = 2.0

    while True:
        stream_url = f"{server_url}/api/worker/stream"
        headers = {
            "Accept": "text/event-stream",
            "X-Worker-Token": token,
            "X-Worker-Name": worker_name,
            "X-Worker-GPU": gpu_name,
            "X-Worker-Model": primary_model,
        }
        try:
            print(f"[Connect] Đang nối tới {stream_url} ...", flush=True)
            with http_sess.get(stream_url, headers=headers, stream=True, timeout=(12, 45)) as resp:
                if resp.status_code == 401:
                    print("[ERROR] WORKER_TOKEN bị từ chối (401). Kiểm tra lại token trên Render và worker/.env!", flush=True)
                    time.sleep(10)
                    continue
                resp.raise_for_status()
                backoff = 2.0
                print("[Connect] ĐÃ KẾT NỐI! Sẵn sàng nhận trang truyện từ web.", flush=True)

                event_name = None
                data_lines: list[str] = []

                for raw_line in resp.iter_lines(decode_unicode=True):
                    if raw_line is None:
                        continue
                    line = raw_line.strip("\r")
                    if not line:
                        if event_name == "job" and data_lines:
                            payload_str = "\n".join(data_lines)
                            try:
                                job = json.loads(payload_str)
                                handle_job(http_sess, server_url, token, pipeline, job)
                            except Exception as exc:
                                print(f"[Job Error] {exc}", flush=True)
                        event_name = None
                        data_lines = []
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        event_name = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].strip())
        except KeyboardInterrupt:
            print("\n[Stop] Đã tắt worker dịch truyện.", flush=True)
            break
        except Exception as exc:
            print(f"[Reconnect] Mất kết nối ({exc}). Thử nối lại sau {backoff:.0f}s...", flush=True)
            time.sleep(backoff)
            backoff = min(20.0, backoff * 1.5)


def handle_job(
    session: requests.Session,
    server_url: str,
    token: str,
    pipeline: MangaTranslationPipeline,
    job: dict,
) -> None:
    job_id = job["jobId"]
    book_id = job.get("bookId")
    page = job.get("page")
    source_lang = job.get("sourceLang", "auto")
    target_lang = job.get("targetLang", "vi")
    reading_dir = job.get("readingDir", "rtl")
    print(f"[Job {job_id}] Book #{book_id} Pg {page} ({source_lang}->{target_lang}, {reading_dir})...", flush=True)

    try:
        raw_img = fetch_source_image(session, server_url, job.get("imageUrl", ""), job.get("proxyPath"))
        webp_bytes, meta = pipeline.process_image_bytes(
            raw_img,
            source_lang=source_lang,
            target_lang=target_lang,
            reading_dir=reading_dir,
        )
        post_result(session, server_url, token, job_id, webp_bytes=webp_bytes, meta=meta)
        print(
            f"[Done {job_id}] {meta.get('bubbles', 0)} bóng thoại | {meta.get('model')} | "
            f"{meta.get('ms', 0)}ms | {len(webp_bytes) // 1024}KB",
            flush=True,
        )
    except Exception as exc:
        print(f"[Fail {job_id}] {exc}", flush=True)
        try:
            post_result(session, server_url, token, job_id, error=str(exc))
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Arch GPU Manga Translation Worker")
    parser.add_argument("--test-image", help="Test dịch trực tiếp 1 file ảnh local và lưu ảnh .vi.webp")
    parser.add_argument("--lang", default="auto", help="Ngôn ngữ nguồn (auto/ja/en/zh/ko)")
    parser.add_argument("--dir", default="rtl", choices=["rtl", "ltr"], help="Chiều đọc (rtl/ltr)")
    args = parser.parse_args()

    load_dotenv(WORKER_DIR / ".env")
    if args.test_image:
        src = pathlib.Path(args.test_image)
        out_path = src.with_suffix(".vi.webp")
        pipeline = MangaTranslationPipeline()
        webp_bytes, meta = pipeline.process_image_bytes(
            src.read_bytes(), source_lang=args.lang, target_lang="vi", reading_dir=args.dir
        )
        out_path.write_bytes(webp_bytes)
        print(f"TEST_OK -> {out_path} | meta={json.dumps(meta, ensure_ascii=False)}")
        return

    run_worker_loop()


if __name__ == "__main__":
    main()
