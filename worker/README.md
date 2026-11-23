# Arch Linux GPU Manga Translation Worker

Chạy trực tiếp trên laptop Arch Linux (RTX 3050 Mobile 4GB VRAM + 8GB RAM), kết nối ngược lên `server.mjs` (Render hoặc localhost) bằng SSE + HTTP POST — **không cần mở port router**.

## 1. Cấu hình phía Server (Render)
Trên Render -> **Environment** -> thêm biến môi trường:
- `WORKER_TOKEN`: chuỗi bí mật tùy chọn (phải khớp với `WORKER_TOKEN` trong `worker/.env`).

## 2. Cấu hình phía Laptop (`worker/.env`)
Chỉnh `SERVER_URL` trong `worker/.env` thành URL Render của bạn (ví dụ `https://ten-app.onrender.com`) và đảm bảo `WORKER_TOKEN` giống hệt trên Render.

## 3. Chạy Worker (1 lệnh duy nhất)
```bash
./worker/run.sh
```
- Lần chạy đầu tiên sẽ tự tải model OCR (~15MB) và `big-lama.pt` (~196MB vào `worker/models/`).
- Khi tắt laptop (`Ctrl+C`), web tự hiện trạng thái Offline và đọc bản gốc bình thường.
- Khi bật lại `./worker/run.sh`, bấm nút làm mới kết nối ở trang Chi tiết truyện -> trạng thái chuyển xanh **Laptop Online** -> bấm **Dịch truyện sang Tiếng Việt (AI)** -> chờ dịch xong máy sẽ tự mở trang đọc tiếng Việt.

## Test dịch nhanh 1 file ảnh local
```bash
./worker/run.sh --test-image /duong/dan/trang1.jpg --lang ja --dir rtl
```
