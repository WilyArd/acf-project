# ACF Automated API Testing Tool (ACF Workbench)

Tool internal ringan untuk validasi cepat endpoint RESTful API dengan verdict deterministik (**`PASS`** / **`FAIL`** / **`ERROR`**), dukungan eksekusi berurutan (**Multi-Run**), serta bypass CORS melalui backend proxy yang aman.

> **Posisi Produk:** ACF Workbench dirancang sebagai tool validasi API yang cepat dan fokus untuk pengujian fungsional maupun regresi ringan (termasuk uji *tenant isolation*). Tool ini **bukan** pengganti Postman dengan *cloud sync* ataupun penyimpanan kredensial di server.

---

## Daftar Isi

1. [Fitur Utama](#fitur-utama)
2. [Tech Stack](#tech-stack)
3. [Arsitektur & Keamanan](#arsitektur--keamanan)
4. [Struktur Direktori](#struktur-direktori)
5. [Prasyarat & Menjalankan Secara Lokal](#prasyarat--menjalankan-secara-lokal)
6. [Konfigurasi Environment Backend](#konfigurasi-environment-backend)
7. [Kontrak API Proxy](#kontrak-api-proxy)
8. [Pengujian & Typecheck](#pengujian--typecheck)
9. [Batasan & Keterbatasan yang Diketahui](#batasan--keterbatasan-yang-diketahui)
10. [Dokumentasi Teknis](#dokumentasi-teknis)

---

## Fitur Utama

### 1. Request Builder & Multi-Tab Workbench
- Mendukung HTTP method **`GET`**, **`POST`**, **`PUT`**, **`PATCH`**, dan **`DELETE`**.
- Editor **Query Params** (di-append satu arah ke URL saat eksekusi), **Headers**, **JSON Request Body** (maks. `1 MB`), dan **Assertions**.
- **Multi-Tab Request** (`RequestTabBar`): buka banyak endpoint sekaligus, buat tab baru dari tombol **`+`** di sidebar, atau duplikasi tab (`Ctrl+Click` maupun aksi duplikat tab).

### 2. Sidebar Collections Bergaya Postman
- Koleksi ditampilkan sebagai **pohon folder bersarang** (bukan daftar datar), dengan expand/collapse per level.
- **Folder selalu tampil di atas**, request tanpa folder (root collection) menyusul di bawahnya — begitu pula di dalam tiap folder, sub-folder didahulukan daripada request langsung.
- Angka di kanan folder = jumlah request **termasuk seluruh sub-folder**; klik satu folder untuk melipat seluruh isinya.
- Mode **Multi-Run** menampilkan checkbox di setiap level; mencentang folder memilih folder itu **beserta semua turunannya** (maks. `30` request per batch).

### 3. Assertion Engine Deterministik
- Berjalan sebagai *pure function module* terpisah di backend agar mudah diuji dan konsisten.
- Tipe assertion yang didukung (maks. `100` assertion per request):
  - `STATUS_CODE` (`equals`)
  - `LATENCY` (`less_than_or_equal`, dalam milidetik)
  - `BODY_JSON_PATH` (`equals`, `not_equals`, `contains`, `exists` dengan `expectedValue: null` untuk `exists`)
- Membedakan secara eksplisit antara key JSON yang **tidak ditemukan** (`found: false`) dan key yang **bernilai `null`** (`found: true, actual: null`).

### 4. Multi-Run Berurutan & Chaining Token
- Menjalankan hingga **`30` request** secara berurutan dalam satu batch (`batchRunner`).
- Mendukung **Token Passthrough** (misalnya `{{$.data.token}}` yang di-scope per *origin*) dan aturan **`postResponseVars`** untuk mengekstrak nilai response dari request sebelumnya (misalnya login) ke request berikutnya.
- Cocok digunakan untuk skenario **Tenant Isolation Testing** (misalnya menjalankan login Tenant A lalu memverifikasi endpoint milik Tenant B mengembalikan status penolakan dan tidak membocorkan data).

### 5. Import Collection & Environment (Postman, Bruno, GitHub)
- **Postman (`.json`)**, **Bruno (`.json` / `.bru`)**, **Drag & Drop Folder Bruno** secara rekursif (menggunakan `webkitGetAsEntry()` agar tidak memicu dialog konfirmasi upload browser), serta import dari **repositori GitHub**.
- Pilihan **`Muat 1 Terpilih`** (hanya endpoint awal yang dipilih) atau **`Import Semua`** (memuat seluruh struktur folder ke sidebar sesi).
- Parser deklaratif **tanpa `eval()`** untuk script post-response Postman/Bruno (`pm.environment.set`, `pm.collectionVariables.set`, `pm.globals.set`, `postman.setEnvironmentVariable`, `bru.setEnvVar`, `bru.setVar`), lengkap dengan opsi **`Auto-Sync Env`** dan tombol **`Simpan ke Env`**.
- Deteksi otomatis header `Authorization` yang berisi JWT mentah tanpa prefix `Bearer ` disertai tombol cepat 1-klik untuk menambahkan prefix `Bearer `.

### 6. Environment, Collection Variables & Inspector Inline
- Layering variabel antara **Collection Variables** dan **Active Environment** dengan substitusi placeholder `{{variabel}}` di browser sebelum dikirim ke proxy.
- Panel inspektor variabel di sidebar kanan (`VariablesInspector`) untuk memantau variabel yang dipakai pada request aktif serta melakukan edit nilai secara langsung (*inline*).

### 7. Response Viewer, Riwayat & Pengalaman UI
- **Pretty JSON Viewer** dengan *syntax highlighting*, kontrol **Word Wrap** (`Wrap: ON/OFF`), nomor baris, dan tombol **`Salin`** per baris saat kursor diarahkan (*hover*).
- Indikator loading saat eksekusi berlangsung, ringkasan status `PASS` / `FAIL` / `ERROR`, serta dialog konfirmasi in-app saat menghapus cache atau data.
- Mendukung mode tema **Gelap / Terang**.

---

## Tech Stack

| Layer | Teknologi | Keterangan |
|---|---|---|
| **Frontend** | Astro `7.4`, React `19.3`, TypeScript `6.0`, Tailwind CSS v4 | Interactive workbench islands & ikon `@hugeicons/react` |
| **Backend Proxy** | Fastify `5.12`, Node.js, TypeScript `5.9` | Proxy HTTP asinkron, pre-flight validator, SSRF guard, dan assertion engine |
| **Runtime** | Node.js `>= 22` (`>= 22.23.4` untuk frontend) | Menjalankan `tsx` (dev/test) dan bundle hasil build TypeScript/Astro |
| **Test Runner** | `tsx --test` (Node built-in test runner) | Unit & integration tests backend maupun library frontend |
| **Container** | Docker + Docker Compose, Nginx | Demo satu perintah; Nginx menyajikan static Astro & mem-proxy `/api` |

> **Catatan versi TypeScript:** kedua paket memakai versi TypeScript berbeda (`backend` 5.9, `frontend` 6.0). Ini disengaja karena Astro 7 membutuhkan TS 6, dan bukan masalah selama tiap paket memakai `tsc`-nya sendiri.

---

## Arsitektur & Keamanan

### Alur Eksekusi Request
```text
Browser (Astro + React)
  │  1. Substitusi {{variabel}} & evaluasi token passthrough (di browser)
  │  2. POST /api/proxy/execute
  ▼
Backend Proxy (Fastify)
  │  3. Auth header check (x-proxy-key jika PROXY_API_KEY aktif) -> 401
  │  4. Rate limiter per IP & concurrency guard               -> 429
  │  5. Validasi method, URL, JSON body (<=1MB), CRLF header   -> 400
  │  6. Pre-flight SSRF & DNS lookup + cek port terlarang      -> 403
  │  7. Outbound HTTP request (pin IP valid, tanpa redirect, timeout 15s, max body 2MB)
  │  8. Evaluasi assertion deterministik (PASS / FAIL / ERROR)
  ▼
JSON ResultPayload (HTTP 200) -> Ditampilkan di ResponsePanel & post-response sync
```

### Kebijakan Keamanan & Penyimpanan Data
- **Zero Server Persistence:** Backend tidak menyimpan request body, header, token, maupun response ke database atau disk. Semua response proxy mengirim header `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, dan `X-Frame-Options: DENY`. Header sensitif (`authorization`, `x-proxy-key`) juga di-redact pada log Fastify.
- **Pre-Flight SSRF Protection:** Secara default (`ALLOW_LOCAL_TARGETS=false`), backend melakukan DNS lookup sebelum membuka koneksi keluar dan memblokir target IP privat/loopback/link-local dengan HTTP `403 LOCAL_TARGET_BLOCKED`, memblokir port berisiko (`BLOCKED_PORTS`), serta tidak mengikuti HTTP redirect secara otomatis.
- **Kebijakan Penyimpanan Browser:**
  - `localStorage`: hanya menyimpan ringkasan riwayat eksekusi ringan tanpa menyimpan request `headers` maupun `body`.
  - `IndexedDB` (`acf-workbench-db`): menyimpan cache sesi collection/environment di browser dengan sanitasi otomatis — nilai variabel bertipe `secret` dan header sensitif non-template dibersihkan sebelum disimpan (`sanitizeWorkspaceSnapshot`).

---

## Struktur Direktori

```text
acf-project/
├── AGENTS.md                        # Aturan engineering & constraint non-negotiable
├── README.md                        # Dokumentasi utama proyek
├── docker-compose.yml               # Demo lokal: frontend (Nginx) + backend (Fastify)
├── .gitignore                       # Mengabaikan node_modules, dist, .astro, .env*, kredensial
├── docs/                            # Spesifikasi arsitektur, kontrak API, assertion, UI, QA
│   ├── 01-product-requirements.md
│   ├── 02-system-architecture.md
│   ├── 03-api-contracts.md
│   ├── 04-assertion-engine-spec.md
│   ├── 05-frontend-spec.md
│   ├── 06-qa-verification-plan.md
│   ├── 07-proposal-import-single-request.md
│   └── notes/                       # Catatan desain backend
│   
├── requirement/                     # Dokumen PRD resmi (v1.4 arsip & v1.5 aktif)
├── backend/
│   ├── Dockerfile                   # Multi-stage: build TS -> runtime non-root
│   ├── package.json
│   ├── src/
│   │   ├── app.ts                   # Setup Fastify, security headers, error handler
│   │   ├── server.ts                # Entrypoint HTTP server
│   │   ├── api/proxy.routes.ts      # Handler POST /api/proxy/execute
│   │   ├── config/index.ts          # Konfigurasi env & limit sistem
│   │   ├── core/assertion/          # Pure function Assertion Evaluator & JSON path
│   │   ├── models/types.ts
│   │   └── services/                # validator, ssrfGuard, rateLimiter, dispatcher
│   └── test/                        # 5 file test: assertion, json path, route, ssrf, validator
└── frontend/
    ├── Dockerfile                   # Build Astro -> Nginx static + proxy /api
    ├── astro.config.mjs             # Konfigurasi Astro, Tailwind v4, proxy /api -> :3001 (dev)
    ├── package.json
    ├── deploy/nginx.conf            # Nginx demo lokal: static + /api -> backend:3001
    ├── public/                      # Logo & favicon (acf-logo.svg, favicon.svg, favicon.ico)
    ├── src/
    │   ├── pages/index.astro        # Halaman utama dengan CSP & WorkbenchApp island
    │   ├── components/              # 15 komponen React workbench (TopBar, Sidebar, Request/Response, ...)
    │   ├── lib/                     # Parser Postman/Bruno/GitHub, collectionTree, batchRunner, tab, IndexedDB, JSON formatter
    │   ├── styles/global.css
    │   └── types/api.ts
    └── test/
        ├── frontend.lib.test.ts     # Unit tests library frontend
        └── collectionTree.test.ts   # Unit tests pohon folder sidebar
```

---

## Prasyarat & Menjalankan Secara Lokal

Pastikan **Node.js** terpasang sesuai kebutuhan minimum:
- Backend: `Node.js >= 22`
- Frontend: `Node.js >= 22.23.4`

### 1. Instalasi Dependensi

Jalankan pada masing-masing direktori (`backend` dan `frontend`):

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Mode Development

Jalankan backend dan frontend di dua terminal terpisah:

**Terminal 1 — Backend Proxy (default `http://127.0.0.1:3001`):**
```bash
cd backend
npm run dev
```

> **Catatan Uji Target Lokal:** Jika Anda menguji API yang berjalan di `localhost` / `127.0.0.1` / jaringan privat saat pengembangan lokal, jalankan backend dengan `ALLOW_LOCAL_TARGETS=true` (contoh di PowerShell: `$env:ALLOW_LOCAL_TARGETS="true"; npm run dev`). Jangan aktifkan flag ini di lingkungan publik/produksi.

**Terminal 2 — Frontend Workbench (default `http://localhost:4321`):**
```bash
cd frontend
npm run dev
```

Pada mode development, [frontend/astro.config.mjs](frontend/astro.config.mjs) meneruskan permintaan `/api/*` secara otomatis ke `http://127.0.0.1:3001`.

### 3. Build & Mode Production

```bash
# Build & start backend
cd backend
npm run build
npm start

# Build & preview frontend
cd ../frontend
npm run build
npm run preview
```

### 4. Menjalankan dengan Docker (demo satu perintah)

Dari root repo, cukup satu perintah — tidak perlu `npm install` di kedua paket:

```bash
docker compose up --build
```

Buka `http://localhost:8080`. Compose menjalankan dua container stateless:

- `frontend` — Nginx menyajikan hasil build static Astro **dan** mem-proxy `/api/` ke `backend:3001` (pengganti proxy Vite yang hanya aktif saat `npm run dev`).
- `backend` — Fastify di `0.0.0.0:3001`, **tidak** mem-publish port ke host sehingga hanya dapat diakses lewat Nginx.

Catatan penting untuk demo lokal:

- Compose menyetel `ALLOW_LOCAL_TARGETS=true` agar endpoint di mesin/container yang sama dapat diuji. **Jangan pakai nilai ini di VPS** — SSRF guard harus tetap menolak IP privat.
- Nginx memakai `client_max_body_size 2m`, sengaja di atas batas backend 1 MB, agar payload kebesaran tetap dijawab `400 REQUEST_BODY_TOO_LARGE` (JSON) dan bukan `413` HTML dari Nginx.
- Untuk target yang berjalan di host (bukan di jaringan Compose), gunakan `http://host.docker.internal:<port>` dari dalam container.

### 5. Deployment ke VPS (GitLab CI/CD)

Demo produksi berjalan di **VPS1** (`demo-acf-project.ard6j1.my.id`) dengan pipeline hybrid:

| Job | Runner | Isi |
|---|---|---|
| `test:backend`, `test:frontend`, `build:images` | `vps2` | Test + build image (server dengan swap besar) |
| `deploy:vps1` | `vps1` | `docker compose pull && up -d` di host tempat container hidup |

Arsitektur jaringan di VPS1:

```text
Cloudflare Tunnel → edge_nginx (vhost deploy/40-acf.conf)
                        │  (network acf_net)
                        ├─ acf-frontend (static Astro, tidak publish port)
                        └─ acf-backend  (Fastify :3001, tidak publish port)
```

- `deploy/docker-compose.prod.yml` membuat network **`acf_net`** khusus ACF; `edge_nginx` di-attach ke network itu via `docker network connect acf_net edge_nginx` (sekali, manual).
- **Tidak ada port yang dipublish ke host** — satu-satunya jalur masuk adalah Cloudflare Tunnel → `edge_nginx`, sehingga Security Group AWS tidak perlu dibuka.
- `ALLOW_LOCAL_TARGETS=false` di produksi (SSRF guard penuh); `TRUST_PROXY=true` karena Nginx meneruskan `X-Forwarded-For`.
- Setiap deploy menyalin `docker-compose.prod.yml` + `.env` (tag image dari CI) ke `/srv/acf/` di host, lalu `docker compose up -d` dan reload `edge_nginx`.
- GitLab CI/CD variable `PROXY_API_KEY` dibuat kosong; frontend belum mengirim header `x-proxy-key` (lihat [Batasan](#batasan--keterbatasan-yang-diketahui)).

---

## Konfigurasi Environment Backend

Seluruh variabel environment backend didefinisikan di [backend/src/config/index.ts](backend/src/config/index.ts):

| Variabel | Default | Deskripsi |
|---|---|---|
| `PORT` | `3001` | Port HTTP server backend proxy |
| `HOST` | `127.0.0.1` | Host binding server Fastify |
| `ALLOW_LOCAL_TARGETS` | `false` | Mengizinkan target loopback/IP privat jika `true` (wajib `false` di produksi) |
| `TRUST_PROXY` | `false` | Konfigurasi `trustProxy` Fastify (`true`, `false`, atau jumlah hop/CIDR) untuk pembacaan IP client |
| `PROXY_API_KEY` | `""` | Jika diisi, client wajib mengirim header `x-proxy-key` yang cocok |
| `RATE_LIMIT_MAX` | `30` | Maksimum request per IP dalam satu jendela waktu |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Durasi jendela sliding-window rate limiter (milidetik) |
| `RATE_LIMIT_MAX_KEYS` | `10000` | Batas maksimum entri IP di memory rate limiter |
| `DNS_LOOKUP_TIMEOUT_MS` | `5000` | Batas waktu resolusi DNS sebelum request dianggap gagal |
| `MAX_ASSERTIONS` | `100` | Batas maksimum assertion per satu eksekusi request |
| `MAX_IN_FLIGHT_REQUESTS` | `20` | Batas maksimum request proxy yang berjalan bersamaan |

**Batas Tetap (Hardcoded Safety Limits):**
- Maksimum ukuran request body masuk: **`1 MB`** (`1_048_576` bytes)
- Maksimum ukuran response body target: **`2 MB`** (`2 * 1_048_576` bytes)
- Timeout koneksi outbound ke target API: **`15 detik`** (`15_000` ms)

---

## Kontrak API Proxy

Endpoint utama backend: **`POST /api/proxy/execute`** (`Content-Type: application/json`)

Ringkasan kode status yang dikembalikan proxy:

| HTTP Status | Makna |
|---|---|
| `200 OK` | Eksekusi diproses proxy; lihat `overallStatus` pada payload: **`PASS`** (semua assertion lolos), **`FAIL`** (target merespons, minimal 1 assertion gagal), atau **`ERROR`** (DNS gagal, timeout 15s, atau target tidak dapat dijangkau) |
| `400 Bad Request` | Payload tidak valid, JSON rusak, body > 1 MB, header mengandung CRLF, atau format assertion salah |
| `401 Unauthorized` | `PROXY_API_KEY` aktif namun header `x-proxy-key` hilang atau tidak cocok. **Catatan:** frontend saat ini belum mengirim header tersebut, sehingga mengisi `PROXY_API_KEY` akan memblokir UI (lihat [Batasan](#batasan--keterbatasan-yang-diketahui)). |
| `403 Forbidden` | Target mengarah ke alamat lokal/privat sementara `ALLOW_LOCAL_TARGETS=false` (`LOCAL_TARGET_BLOCKED`) |
| `429 Too Many Requests` | Melebihi batas rate limit per IP (`RATE_LIMIT_EXCEEDED`) atau batas concurrency `MAX_IN_FLIGHT_REQUESTS` |

Detail penuh skema request, response, dan kode error tersedia di [docs/03-api-contracts.md](docs/03-api-contracts.md).

---

## Pengujian & Typecheck

### Backend
```bash
cd backend
npm test        # Menjalankan seluruh unit & integration test (tsx --test "test/**/*.test.ts")
npm run typecheck
npm run build
```

Seluruh test backend **self-contained** — target HTTP dijalankan in-process lewat `inject()`, jadi tidak butuh Docker, database, atau service eksternal.

### Frontend
```bash
cd frontend
npm run check   # Typecheck Astro & komponen React (astro check)
npm run build   # Build produksi Astro

# Menjalankan unit test library frontend (memakai runner tsx dari backend)
..\backend\node_modules\.bin\tsx --test test/frontend.lib.test.ts test/collectionTree.test.ts
```

> Frontend **tidak punya script `npm test` sendiri**. Test-nya meminjam `tsx` dari `backend/node_modules`, jadi jalankan `npm install` di `backend/` lebih dulu. Menjalankan satu file saja juga bisa, misalnya `..\backend\node_modules\.bin\tsx --test test/collectionTree.test.ts`.

Tidak ada linter di kedua paket — `typecheck` / `astro check` adalah satu-satunya gerbang statis.

---

## Batasan & Keterbatasan yang Diketahui

Bagian ini mencatat hal yang **belum** didukung atau masih terbatas, agar tidak menimbulkan ekspektasi salah saat demo.

### Batasan Scope

- **Satu request per eksekusi.** Multi-Run menjalankan hingga `30` request berurutan, tetapi tidak ada konsep *collection runner* penuh atau penjadwalan.
- **Assertion hanya 3 tipe:** `STATUS_CODE`, `LATENCY`, `BODY_JSON_PATH`. Tidak ada tipe `HEADER`, dan tidak ada penerjemahan otomatis script `pm.test` / Bruno test menjadi assertion.
- **JSON path tidak mendukung array index** (`items[0].name`). Hanya traversal key objek.
- **Tidak ada duplicate key** untuk query param maupun header (direpresentasikan sebagai object JSON).
- **Tidak ada penyimpanan atau sinkronisasi koleksi di server.** Semua data koleksi/environment hanya hidup di memori tab + cache browser.

### Keterbatasan yang Perlu Diketahui Sebelum Demo

- **`PROXY_API_KEY` belum terpakai oleh frontend.** Bila variabel ini diisi, backend membalas `401` untuk semua request karena `frontend/src/lib/apiClient.ts` tidak mengirim header `x-proxy-key` — UI akan terlihat "rusak" tanpa penjelasan. Untuk demo, biarkan `PROXY_API_KEY` kosong, atau lindungi proxy di layer Nginx/VPN.
- **CSP halaman frontend dikirim lewat `<meta>`**, yang tidak dapat menegakkan `frame-ancestors`. Header `X-Frame-Options` / CSP sebenarnya baru berlaku bila dipasang di reverse proxy (lihat `frontend/deploy/nginx.conf`).
- **`TRUST_PROXY=1` dipetakan ke `true`**, artinya seluruh hop `X-Forwarded-For` dipercaya. Di VPS, isi dengan IP/CIDR Nginx, bukan `1`.
- **Batch maksimum `30`** diselaraskan dengan `RATE_LIMIT_MAX` backend. Menaikkan salah satu tanpa yang lain akan membuat batch terhenti oleh `429`.

---

## Dokumentasi Teknis

- [docs/01-product-requirements.md](docs/01-product-requirements.md) — Kebutuhan produk & batasan scope
- [docs/02-system-architecture.md](docs/02-system-architecture.md) — Arsitektur sistem & batas keamanan
- [docs/03-api-contracts.md](docs/03-api-contracts.md) — Kontrak API `POST /api/proxy/execute`
- [docs/04-assertion-engine-spec.md](docs/04-assertion-engine-spec.md) — Spesifikasi evaluator assertion
- [docs/05-frontend-spec.md](docs/05-frontend-spec.md) — Spesifikasi antarmuka & kebijakan storage frontend
- [docs/06-qa-verification-plan.md](docs/06-qa-verification-plan.md) — Rencana verifikasi QA & skenario uji
- [docs/07-proposal-import-single-request.md](docs/07-proposal-import-single-request.md) — Proposal & rancangan fitur import
