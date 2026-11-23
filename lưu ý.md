# Manga Reader — Web Migration Spec

Tài liệu này trích xuất toàn bộ kiến trúc, API, data model, UI/UX, design system và logic từ project Android Jetpack Compose (`manga-reader.zip`) để dùng làm spec dựng bản Web (ví dụ: Next.js / React + TypeScript + Tailwind CSS).

---

## 1. Tech Stack Gợi Ý Cho Bản Web

| Thành phần Android | Tương đương trên Web |
| :--- | :--- |
| Jetpack Compose + Material 3 | React / Next.js (App Router) + Tailwind CSS |
| Retrofit + Moshi | `fetch` / TanStack Query + TypeScript interfaces |
| Room DB (`manga_metadata`) | `IndexedDB` (Dexie.js / `idb`) hoặc `localStorage` |
| `SharedPreferences` (`manga_settings`) | `localStorage` |
| Coil (Image loading + cache) | `<img>` lazy loading + Service Worker / Cache API (nếu hỗ trợ offline) |
| Navigation Compose | Next.js App Router / React Router |

> [!IMPORTANT]
> **Lưu ý quan trọng về CORS khi lên Web:**
> App Android gọi trực tiếp `https://nhentai.net/api/v2/` kèm header `User-Agent`. Trên trình duyệt, **CORS sẽ chặn** request trực tiếp từ frontend và trình duyệt cũng không cho phép set `User-Agent` thủ công.
> **Giải pháp bắt buộc:** Tạo một **API Proxy** ở backend (ví dụ: Next.js Route Handlers `/api/proxy/...`, Cloudflare Worker, hoặc Express) để server gọi tới `nhentai.net/api/v2/` kèm `User-Agent` và `Accept: application/json`, rồi trả về cho frontend.

---

## 2. API & Image CDN (`NHentaiApi.kt`, `NHentaiClient.kt`)

### Base URL & Headers
- **API Base URL:** `https://nhentai.net/api/v2/`
- **Required Headers (ở Proxy):**
  - `Accept: application/json`
  - `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`

### Endpoints
| Chức năng | Method & Path | Query / Params | Response |
| :--- | :--- | :--- | :--- |
| Trang chủ (mới nhất) | `GET /galleries` | `page=1`, `per_page=25` | `SearchResult` |
| Phổ biến (Popular) | `GET /galleries/popular` | — | `BookLite[]` |
| Ngẫu nhiên (Random) | `GET /galleries/random` | — | `Book` |
| Chi tiết truyện | `GET /galleries/{id}` | `id: number` | `Book` |
| Truyện liên quan | `GET /galleries/{id}/related` | `id: number` | `RelatedResult` |
| Tìm kiếm | `GET /search` | `query`, `page=1`, `sort?` | `SearchResult` |

### Image & Thumbnail URL Builder
Server được chọn dựa trên tổng mã ASCII của các ký tự trong `media_id` chia lấy dư (`sum % servers.length`):
- `IMG_SERVERS = [1, 2, 3]`
- `THUMB_SERVERS = [1, 2, 3, 4]`

```ts
function pickServer(servers: number[], mediaId: string): number {
  let hash = 0;
  for (let i = 0; i < mediaId.length; i++) {
    hash += mediaId.charCodeAt(i);
  }
  return servers[hash % servers.length];
}

export function fullImageUrl(path: string | null | undefined, mediaId: string): string | null {
  if (!path) return null;
  const srv = pickServer([1, 2, 3], mediaId);
  return `https://i${srv}.nhentai.net/${path}`;
}

export function fullThumbUrl(path: string | null | undefined, mediaId: string): string | null {
  if (!path) return null;
  const srv = pickServer([1, 2, 3, 4], mediaId);
  return `https://t${srv}.nhentai.net/${path}`;
}

export function galleryThumbUrl(mediaId: string): string {
  const srv = pickServer([1, 2, 3, 4], mediaId);
  return `https://t${srv}.nhentai.net/galleries/${mediaId}/thumb.webp`;
}
```

---

## 3. Data Models (`Models.kt`)

```ts
export interface SearchResult {
  result?: BookLite[];
  num_pages: number;
  per_page: number;
  total: number;
}

export interface BookLite {
  id: number;
  media_id?: string | null;
  english_title?: string | null;
  japanese_title?: string | null;
  thumbnail?: string | null;
  num_pages: number;
  num_favorites: number;
  tag_ids?: number[];
  blacklisted: boolean;
}

export interface Book {
  id: number;
  media_id: string;
  title?: Title | null;
  cover?: ImagePath | null;
  thumbnail?: ImagePath | null;
  pages?: PageInfo[];
  tags?: Tag[];
  num_pages: number;
  num_favorites: number;
  scanlator?: string | null;
  upload_date: number;
}

export interface ImagePath {
  path?: string | null;
  width: number;
  height: number;
}

export interface PageInfo {
  number: number;
  path?: string | null;
  width: number;
  height: number;
  thumbnail?: string | null;
  thumbnail_width: number;
  thumbnail_height: number;
}

export interface Title {
  english?: string | null;
  japanese?: string | null;
  pretty?: string | null;
}

export interface Tag {
  id: number;
  type?: string | null;
  name?: string | null;
  url?: string | null;
  count: number;
}

export interface RelatedResult {
  result?: Book[];
}
```

---

## 4. Local Storage & Persistence (`MangaMetadata.kt`, `MangaDao.kt`, `MangaViewModel.kt`)

### A. Manga Metadata (IndexedDB / LocalStorage)
Lưu cache thông tin truyện và trạng thái của user theo `id`:
```ts
export interface MangaMetadata {
  id: number;
  bookJson: Book;
  isFavorite: boolean;
  isDownloaded: boolean;
  lastReadPage: number; // default: 0
  lastReadTime: number; // timestamp (ms), default: 0
  totalPages: number;
}
```
Các query cần có:
- `getFavorites()`: `isFavorite === true`, sort theo `lastReadTime DESC`
- `getHistory()`: `lastReadPage > 0`, sort theo `lastReadTime DESC`
- `getDownloads()`: `isDownloaded === true`, sort theo `lastReadTime DESC`
- `updateHistory(id, page)`: cập nhật `lastReadPage = page`, `lastReadTime = Date.now()`

### B. User Settings & Gamification (`localStorage`)
- `dark_mode`: `boolean` (default `false`)
- `points`: `number` (default `300`)
- `coupons`: `string[]` (default `["WELCOME100", "FREETOON", "DAILYACC"]`)
- `checked_in_days`: `number[]`
- `last_check_in_date`: `string` (`YYYY-MM-DD`)

**Logic Gamification:**
- **Daily Check-in (`checkIn(day)`):** Mỗi ngày (`YYYY-MM-DD`) chỉ điểm danh 1 lần. Thành công: `+100` points và thêm coupon `DAILY-DAY-{day}`.
- **Redeem Code (`redeemCode(code)`):**
  - `MANGA999` hoặc `NHENTAI` -> `+500` points, thêm coupon `VIP-CODE-{CODE}` (mỗi code 1 lần).
  - `LUCKY` -> `+200` points, thêm coupon `LUCKY-RED` (1 lần).
- **Spend Points (`spendPoints(amount, itemName)`):** Trừ `amount` points nếu đủ, thêm coupon `REDEEM-{ITEMNAME}`.

---

## 5. Routes & Chức Năng Từng Màn Hình (`Routes.kt`, `ui/screens/*`)

| Route | Màn hình | Chức năng chính |
| :--- | :--- | :--- |
| `/` | **Home** | • Hero Parallax Carousel (từ `/galleries/popular`)<br>• Quick Actions (điều hướng nhanh Search, Favorites, History, Downloads, Check-in/Redeem)<br>• Grid danh sách truyện mới (`/galleries`) hỗ trợ **infinite scroll** (`loadMoreHome`) và **auto-refresh mỗi 60 giây** |
| `/search` | **Search** | • Thanh tìm kiếm: hỗ trợ tìm theo từ khóa/tag hoặc **nhập trực tiếp số ID** (regex `^\d+$` gọi thẳng `/galleries/{id}`)<br>• Quick tag chips: `english`, `full color`, `vanilla`, `romance`, `fantasy`, `schoolgirl`<br>• Bộ lọc sắp xếp (`sort`, mặc định `popular`)<br>• Infinite scroll (`loadMoreSearch`) |
| `/favorites` | **Favorites** | Danh sách truyện đã yêu thích (`isFavorite = true`), sort theo `lastReadTime DESC` |
| `/history` | **History** | Lịch sử đọc (`lastReadPage > 0`), hiển thị tiến độ trang đã đọc và mở tiếp |
| `/downloads` | **Downloads** | Danh sách truyện đã lưu/tải offline (`isDownloaded = true`) |
| `/manga/[id]` | **Detail** | • Hiển thị bìa, tên (English / Japanese / Pretty), tags, số trang, lượt thích<br>• Nút Toggle Favorite, nút Download (prefetch toàn bộ ảnh trang vào cache), nút Đọc / Đọc tiếp |
| `/read/[id]/[page]` | **Reader** | • **2 chế độ đọc:** `horizontal` (Lật trang / Carousel) và `vertical` (Cuộn dọc kiểu Webtoon)<br>• **Auto-scroll** với thanh chỉnh tốc độ (`autoScrollSpeed`)<br>• **Zoom ảnh** (pinch / scroll wheel / double-click)<br>• **4 theme nền đọc:** `black` (`#000000`), `charcoal` (`#14141A`), `sepia` (`#F4ECD8`), `white` (`#FFFFFF`)<br>• Thanh điều khiển ẩn/hiện khi chạm/click, tự động lưu `lastReadPage` |

---

## 6. Design System & Theme (`Color.kt`, `Theme.kt`, `Type.kt`, `Shape.kt`)

### Bảng màu (Editorial Manga Palette)
- **Brand / Accents:**
  - Primary (`CoralVermilion`): `#FF5A36` (Glow: `#FF7A59`)
  - Secondary (`AmberGold`): `#FFB347`
  - Tertiary (`SakuraPink`): `#FF4D8D`
  - Info / Accent: `SkyCyan` `#38BDF8`, `EmeraldFresh` `#34D399`
- **Dark Mode (Deep Obsidian):**
  - Background: `#0B0B10`
  - Surface: `#14141D`
  - Surface Variant: `#20202E`
  - Outline: `#323246`
  - Text Primary: `#F4F4F8`
  - Text Secondary: `#A0A0B8`
- **Light Mode (Warm Alabaster):**
  - Background: `#F8F7F4`
  - Surface: `#FFFFFF`
  - Surface Variant: `#EEECE6`
  - Outline: `#DCD8CE`
  - Text Primary: `#14141B`
  - Text Secondary: `#666677`

### Typography & Shape
- **Display Font:** `Space Grotesk` (Bold / ExtraBold cho tiêu đề)
- **Body Font:** `Plus Jakarta Sans` (Regular / Medium / SemiBold cho nội dung & label)
- **Border Radius:** Phong cách bo tròn pill (`9999px` / `rounded-full`) cho button, chip, và floating bar; card dùng bo góc mềm mại.
