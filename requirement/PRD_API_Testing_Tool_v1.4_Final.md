# Product Requirement Document (PRD)
# ACF Automated API Testing Tool

> - **Document Version:** 1.4 (Final Revisi)
> - **Status:** Draft
> - **Target Deployment:** TBD
> - **Author:** Rahmanda Ahmad Wilyan J. (Wily)

> **Ringkasan perubahan dari v1.3:**
> - **Keamanan level aplikasi ditambahkan** (tidak tergantung keputusan deployment): rate limiting per IP, SSRF check ditingkatkan dari cek string hostname menjadi resolusi DNS + validasi IP hasil resolve, batas ukuran request body masuk, dan validasi header user untuk mencegah CRLF/header injection.
> - **Section 8.2 dipecah** jadi Keamanan Level Aplikasi (bisa dikerjakan sekarang) vs Level Infrastruktur (belum tahu ini butuh apa tidak, TBD) supaya jelas mana yang jadi tanggung jawab kode dan mana yang tanggung jawab tempat hosting.
> - Kontrak error 6.4 dan alur validasi di 4.3/5 diperbarui mengikuti pemeriksaan baru di atas.

---

## 1. Executive Summary & Vision

### 1.1 Overview
ACF Automated API Testing Tool adalah aplikasi berbasis web yang dirancang untuk menyederhanakan proses pengujian RESTful API. Alat ini memungkinkan developer, QA tester, dan mahasiswa IT untuk mengirimkan HTTP request (GET, POST, PUT, PATCH, DELETE), memeriksa respon, dan secara otomatis mengevaluasi status pengujian (**PASS** atau **FAIL**) berdasarkan serangkaian *expected result* (assertions) yang dikonfigurasi secara deklaratif tanpa memerlukan penulisan skrip pengujian yang rumit.

### 1.2 Problem Statement
- Browser modern memblokir request langsung ke domain lain karena CORS, jadi pengujian API murni dari client-side sering gagal.
- Tool ini dibuat sebagai artefak pembelajaran REST API testing sekaligus tool internal fokus untuk validasi cepat satu endpoint dengan verdict yang deterministik dan konsisten. Posisinya **bukan pengganti Postman**, melainkan pelengkap untuk kasus validasi cepat tanpa perlu membuka aplikasi besar. (Bisa dibilang seperti thirdparty internal)

### 1.3 Value Proposition
- **Ringan & Fokus:** satu endpoint, satu verdict, tanpa fitur collection/workspace yang berat.
- **No-Code Assertions:** konfigurasi validasi visual tanpa perlu menulis kode uji manual.
- **Bypass CORS via Proxy:** backend proxy internal yang mengeksekusi request secara independen dan akurat.
- **Visual Feedback Instan:** badge PASS/FAIL/ERROR beserta rincian per kriteria.

---

## 2. User Personas & Use Cases

### 2.1 Target Personas
1. **Backend Developer:** menguji endpoint lokal/staging saat development atau debugging.
2. **QA Engineer:** validasi cepat satu endpoint saat verifikasi bugfix (bukan batch/collection run — di luar scope v1).
3. **Pelajar/Mahasiswa IT:** belajar konsep REST API, status code, dan validasi data.

### 2.2 Core Use Cases
- **UC-01 (Happy Path):** `GET /api/users/1` → status `200`, `data.id equals 1` → **PASS**.
- **UC-02 (Assertion Failure):** `POST /api/auth/login` kredensial salah, expected `401`, actual `500` → **FAIL** dengan rincian expected vs actual.
- **UC-03 (Request Tidak Terkirim):** endpoint tidak terjangkau (timeout/DNS gagal/SSL invalid) → status **ERROR** (bukan FAIL biasa), dengan alasan teknis jelas, dan assertion tidak dievaluasi sama sekali.

---

## 3. User Stories & Acceptance Criteria

| ID | User Story | Acceptance Criteria |
|---|---|---|
| **US-01** | Memilih HTTP Method dan memasukkan URL endpoint. | - Method: `GET/POST/PUT/PATCH/DELETE`.<br>- Frontend validasi prefix `http://`/`https://` (catatan: ini bukan kontrol keamanan, backend tetap validasi ulang — lihat 8.2). |
| **US-02** | Menambahkan Header dan Query Parameter. | - Key-value editor, tombol hapus per baris.<br>- Query param di-append ke URL satu arah saat request dikirim (URL bar tidak diparse balik ke tabel).<br>- Nilai header ditolak backend jika mengandung karakter newline (`\r`/`\n`) — lihat 8.2. |
| **US-03** | Mengirim Request Body JSON. | - Editor dengan validasi sintaks.<br>- Aktif untuk `POST/PUT/PATCH`; untuk `GET` body diabaikan backend; untuk `DELETE` body opsional dan diteruskan apa adanya.<br>- Body ditolak backend jika ukurannya melebihi batas (lihat 8.2). |
| **US-04** | Menentukan assertion. | - Assertion berbentuk array seragam: `{ type, operator, target?, expectedValue }`.<br>- Type: `STATUS_CODE`, `LATENCY`, `BODY_JSON_PATH`.<br>- Kombinasi type × operator yang valid didefinisikan di matriks 4.2 — kombinasi di luar matriks ditolak backend dengan `400`. |
| **US-05** | Melihat hasil PASS/FAIL/ERROR. | - `PASS` = semua assertion lolos.<br>- `FAIL` = request terkirim tapi ≥1 assertion gagal.<br>- `ERROR` = request gagal terkirim (network/timeout/SSL) — assertion tidak dievaluasi.<br>- Tabel breakdown menampilkan kolom **Type, Target/Field, Operator, Expected, Actual, Status** (kolom Target/Field wajib ada supaya dua assertion `BODY_JSON_PATH` pada path berbeda bisa dibedakan). |
| **US-06** | Melihat riwayat pengujian lokal. | - Riwayat (LocalStorage) hanya menyimpan: method, URL, timestamp, overall status, jumlah assertion lolos/gagal.<br>- **Tidak menyimpan** request body maupun header sama sekali (menghindari masalah data sensitif dari akarnya). |

---

## 4. Spesifikasi Fungsional

### 4.1 Request Builder
- Method selector, URL bar, key-value table untuk header & query param (append satu arah), body editor JSON dengan validasi sintaks.
- Preset header: `Content-Type: application/json`, `Authorization: Bearer <token>`.
- **Dukungan JWT (HS256 / HMAC-SHA256):** target API yang mengautentikasi dengan JWT (mis. service lokal yang dipakai untuk demo e2e) mengeluarkan token pada response `signup`/`login` di path `data.token`, lalu endpoint yang diproteksi menerima token itu lewat header `Authorization: Bearer <token>`. Tool menyediakan mekanisme **token passthrough**: token dari response sebuah langkah diekstrak (dot-notation) dan di-inject sebagai template `{{$.data.token}}` ke header langkah berikutnya, sehingga alur multi-request berurutan (signup → login → request terproteksi) bisa diuji end-to-end. Verifikasi payload JWT hanya bersifat opsional via assertion `BODY_JSON_PATH` (mis. `decoded.exp`); tool tidak menyimpan maupun memproses token secara permanen.
- Jika body benar-benar dikirim (yaitu method `POST/PUT/PATCH`, atau `DELETE` dengan body terisi) dan header `Content-Type` belum diset, backend otomatis menambahkan `application/json`. Untuk `GET` — yang body-nya diabaikan — auto-header ini **tidak** berlaku.
- **Batasan:** `headers` dan `queryParams` direpresentasikan sebagai object JSON (lihat 6.1), sehingga **duplicate key tidak didukung**. Dua baris `tag=a` dan `tag=b` di tabel UI hanya akan menyisakan satu nilai. Multi-value query param di luar scope v1.

### 4.2 Assertion Configurator — Matriks Type × Operator

Kombinasi berikut adalah satu-satunya yang valid di v1. Kombinasi lain ditolak backend dengan `400` (`INVALID_ASSERTION`).

| Type | Operator yang didukung | Cara pembandingan |
|---|---|---|
| `STATUS_CODE` | `equals` | Numerik. Hanya `equals` di v1; `not_equals`/range di luar scope. |
| `LATENCY` | `less_than_or_equal` | **Numerik murni** (bukan normalisasi string). PASS jika `responseTimeMs <= expectedValue`. `expectedValue` wajib angka positif. |
| `BODY_JSON_PATH` | `equals`, `not_equals`, `contains`, `exists` | Lihat definisi per-operator di bawah. |

**Definisi operator untuk `BODY_JSON_PATH`** (wajib eksplisit — ini sumber bug paling umum):

| Operator | Definisi |
|---|---|
| `equals` / `not_equals` | Kedua nilai dinormalisasi ke string sebelum dibandingkan, sehingga `"1"` dan `1` dianggap sama. **Jika actual bertipe object atau array → FAIL** dengan reason `"tipe tidak didukung untuk operator equals/not_equals"` (mencegah dua object berbeda dianggap sama karena keduanya jadi `"[object Object]"`). Jika `target` path tidak ditemukan → **selalu FAIL** dengan reason "path tidak ditemukan", berlaku juga untuk `not_equals` (tidak boleh diam-diam PASS). |
| `contains` | Jika actual bertipe string → substring match. Jika actual berupa array → membership match. Tipe lain (object, number, boolean, null) → FAIL dengan reason `"tipe tidak didukung untuk operator contains"`. |
| `exists` | PASS jika key ditemukan di response, **termasuk** jika valuenya `null`. FAIL jika key sama sekali tidak ada di struktur JSON. `expectedValue` untuk operator ini selalu `null` (bukan string `"exists"`). |

**Konsekuensi normalisasi string yang perlu diketahui user** (batasan sadar, bukan bug): actual `null` akan dianggap sama dengan expected string `"null"`, dan `true` sama dengan `"true"`. Untuk membedakan keberadaan key dari nilainya, gunakan `exists`.

**Target property path** memakai dot-notation sederhana (`data.user.id`). Keterbatasan yang perlu ditulis sebagai batasan, bukan bug: key yang mengandung karakter titik tidak didukung, pencarian bersifat case-sensitive, dan array index (`items[0]`) di luar scope v1.

### 4.3 Request Execution Engine & Proxy Backend
Tanggung jawab proxy:
1. **Validasi & keamanan input lebih dulu, sebelum request dikirim** (lihat 6.4 & 8.2): rate limit per IP, ukuran body, nilai header, URL & skema, minimal 1 assertion, kombinasi type × operator valid, target policy (termasuk resolusi DNS untuk SSRF check). Request ke API eksternal baru ditembak setelah semua validasi lolos.
2. Eksekusi request (bypass CORS).
3. Ukur latency (timestamp sebelum/sesudah request).
4. Tidak mengikuti redirect (3xx dikembalikan apa adanya sebagai actual status supaya assertion terhadap redirect tidak menyesatkan).
5. Batas ukuran response 2MB; lebih dari itu body dipotong dan `rawResponse.truncated` diset `true`.
6. Strip header yang diisi user seperti `Host` dan `Content-Length` sebelum diteruskan (mencegah header konflik).
7. Timeout 15 detik. Jika request melebihi `expectedValue` dari assertion `LATENCY`, request **tetap ditunggu sampai selesai atau timeout** — tidak di-abort di tengah jalan. Assertion latency baru dievaluasi setelah response (atau timeout) diterima.

**Catatan pengukuran latency:** angka `responseTimeMs` diukur di **proxy backend**, bukan di browser, sehingga akan berbeda dari angka di DevTools. Request pertama ke suatu host umumnya lebih lambat karena mencakup DNS lookup, TLS handshake, dan kemungkinan cold start di sisi target. Konsekuensi praktis: assertion `LATENCY` dengan batas ketat bisa FAIL di run pertama walau endpoint sehat — jalankan sekali sebagai pemanasan sebelum demo.

### 4.4 Test Result & Response Viewer
- **Overall Verdict Badge:** `PASSED`, `FAILED (X of Y assertions failed)`, atau `ERROR (Request Error: <alasan>)`.
- **Assertion Result Breakdown:** tabel kolom **Type, Target/Field, Operator, Expected, Actual, Status** — semua kolom ini mirror langsung dari `assertionDetails` di section 6, bentuknya sudah disamakan. Untuk assertion `STATUS_CODE` dan `LATENCY`, kolom Target/Field ditampilkan sebagai `—`.
- **Response Inspector (2 tab):** Body (pretty-print JSON, atau raw text jika bukan JSON) dan Headers. Status code, latency, dan body size ditampilkan di panel info, bukan tab terpisah.
- Jika `truncated: true`, viewer menampilkan peringatan bahwa body dipotong pada 2MB.

---

## 5. Logika & Algoritma Evaluasi Assertion

```
[Mulai Eksekusi Pengujian]
        │
        ▼
[Rate limit check per IP — lihat 8.2]
        │
        ├─► Melebihi batas? └─► HTTP 429, SELESAI
        ▼
[Validasi Input di Backend — SEBELUM request dikirim]
        │   • Ukuran request body dalam batas?
        │   • Nilai header tidak mengandung \r/\n?
        │   • URL valid & skema http/https?
        │   • Array assertions minimal 1 item?
        │   • Kombinasi type × operator valid (matriks 4.2)?
        │   • Resolusi DNS host target → IP hasil resolve lolos policy ALLOW_LOCAL_TARGETS?
        │
        ├─► Ada yang gagal? └─► Kembalikan HTTP 400/403 dengan kontrak error 6.4
        │                       → SELESAI (request ke target TIDAK pernah dikirim)
        ▼
[Kirim Request via Proxy]
        │
        ├─► Gagal terkirim (timeout/DNS/SSL invalid)?
        │       └─► overallStatus = ERROR, assertionDetails = [], rawResponse = null → SELESAI
        │
        ▼
[Tangkap Response: status code, latency, headers, body, bodySizeBytes, truncated]
        │
        ├─► Body valid JSON?
        │       ├─► Tidak → hanya assertion STATUS_CODE & LATENCY dievaluasi;
        │       │            semua assertion BODY_JSON_PATH → FAIL dengan reason:
        │       │              • "Response body dipotong pada 2MB, tidak bisa diparse" jika truncated = true
        │       │              • "Response body bukan JSON valid" jika sebab lain
        │       │            rawResponse.body dikirim sebagai string apa adanya.
        │       └─► Ya → lanjut evaluasi normal.
        │
        ▼
[Loop setiap assertion sesuai matriks & definisi operator di 4.2]
        │
        ▼
[overallStatus = PASS jika semua lolos, FAIL jika ada minimal 1 gagal]
        │
        ▼
[Kembalikan hasil terstruktur ke frontend]
```

---

## 6. Spesifikasi Data & Kontrak API

### 6.1 Payload Permintaan (`POST /api/proxy/execute`)

```json
{
  "request": {
    "method": "POST",
    "url": "https://api.example.com/v1/auth/login",
    "headers": { "Content-Type": "application/json" },
    "queryParams": { "ref": "internal" },
    "body": { "username": "tester@example.com", "password": "SecretPassword123" }
  },
  "assertions": [
    { "type": "STATUS_CODE", "operator": "equals", "expectedValue": 200 },
    { "type": "LATENCY", "operator": "less_than_or_equal", "expectedValue": 500 },
    { "type": "BODY_JSON_PATH", "operator": "equals", "target": "status", "expectedValue": "success" },
    { "type": "BODY_JSON_PATH", "operator": "exists", "target": "data.token", "expectedValue": null }
  ]
}
```

### 6.2 Payload Respon — Kasus FAIL (`200 OK` dari proxy, verdict tetap dihitung)

```json
{
  "overallStatus": "FAIL",
  "totalAssertions": 4,
  "passedCount": 3,
  "failedCount": 1,
  "executedAt": "2026-08-28T10:00:00.000Z",
  "assertionDetails": [
    { "type": "STATUS_CODE", "target": null, "operator": "equals", "expected": 200, "actual": 200, "found": true, "status": "PASS" },
    { "type": "LATENCY", "target": null, "operator": "less_than_or_equal", "expected": 500, "actual": 142, "found": true, "status": "PASS" },
    { "type": "BODY_JSON_PATH", "target": "status", "operator": "equals", "expected": "success", "actual": "success", "found": true, "status": "PASS" },
    { "type": "BODY_JSON_PATH", "target": "data.token", "operator": "exists", "expected": null, "actual": null, "found": false, "status": "FAIL", "reason": "Field 'data.token' tidak ditemukan" }
  ],
  "rawResponse": {
    "statusCode": 200,
    "responseTimeMs": 142,
    "bodySizeBytes": 231,
    "truncated": false,
    "headers": { "content-type": "application/json; charset=utf-8" },
    "body": { "status": "success" }
  }
}
```

**Kenapa ada field `found`:** tanpa penanda ini, kasus "key ada tapi bernilai `null`" dan "key tidak ditemukan" punya bentuk JSON yang identik (`"actual": null`), sehingga kolom Actual di UI tampak kosong untuk dua kondisi yang berbeda dan informasinya hanya selamat di string `reason`. Aturannya: `found: false` berarti path tidak ada di struktur JSON; `found: true` dengan `actual: null` berarti key ada dan valuenya memang `null`. Untuk type `STATUS_CODE` dan `LATENCY`, `found` selalu `true`.

### 6.3 Payload Respon — Kasus ERROR (request gagal terkirim)

```json
{
  "overallStatus": "ERROR",
  "totalAssertions": 0,
  "passedCount": 0,
  "failedCount": 0,
  "executedAt": "2026-08-28T10:00:00.000Z",
  "errorReason": "Connection timeout setelah 15000ms",
  "assertionDetails": [],
  "rawResponse": null
}
```

### 6.4 Kontrak Error Validasi (`400 Bad Request` / `403 Forbidden` / `429 Too Many Requests`)

Dikembalikan **sebelum** request ke target dikirim. Bentuknya sengaja dibedakan dari 6.3 (`ERROR`) karena penyebabnya adalah input user atau kebijakan sistem, bukan kegagalan jaringan ke target.

```json
{
  "error": {
    "code": "NO_ASSERTIONS",
    "message": "Minimal 1 assertion wajib dikonfigurasi.",
    "field": "assertions"
  }
}
```

| HTTP | `code` | Kapan terjadi |
|---|---|---|
| 400 | `INVALID_URL_FORMAT` | URL kosong atau tidak bisa diparse. |
| 400 | `INVALID_URL_SCHEME` | Skema selain `http`/`https` (mis. `file://`, `gopher://`). |
| 400 | `NO_ASSERTIONS` | Array `assertions` kosong atau tidak ada. |
| 400 | `INVALID_ASSERTION` | Kombinasi type × operator di luar matriks 4.2, `target` kosong untuk `BODY_JSON_PATH`, atau `expectedValue` bukan angka positif untuk `LATENCY`. |
| 400 | `INVALID_JSON_BODY` | Request body bukan JSON valid (jaring pengaman kedua setelah validasi frontend di US-03). |
| 400 | `INVALID_METHOD` | Method di luar `GET/POST/PUT/PATCH/DELETE`. |
| 400 | `REQUEST_BODY_TOO_LARGE` | Request body dari user melebihi batas ukuran (lihat 8.2). |
| 400 | `INVALID_HEADER_VALUE` | Nilai header mengandung karakter newline (`\r`/`\n`), berpotensi header injection. |
| 403 | `LOCAL_TARGET_BLOCKED` | Hostname target resolve ke alamat internal sementara `ALLOW_LOCAL_TARGETS=false` (lihat 8.2). |
| 429 | `RATE_LIMIT_EXCEEDED` | IP client melebihi batas jumlah request per menit (lihat 8.2). |

> **Catatan keamanan:** contoh `password` di 6.1 hanya ilustrasi payload permintaan (dikirim ke proxy, tidak disimpan). Karena riwayat lokal (US-06) sudah tidak menyimpan body/header sama sekali, tidak perlu masking — masalahnya hilang dari akarnya.

---

## 7. Arsitektur Teknis

```
Client (Browser): Request Builder + Assertion Config → Response & Assertion Viewer
        │  HTTP JSON Payload
        ▼
Backend Proxy: Rate Limiter → Input Validator (incl. DNS resolve) → HTTP Request Dispatch → Assertion Evaluator
                                                                      (pure function:
                                                                       input response+rules,
                                                                       output verdict)
        │
        ▼
Target API Server Eksternal
```

- **Frontend:** SPA (Next.js + Tailwind CSS, implementasi menyusul). Revisi frontend jadi pakai AstroJs
- **Backend:** **FastAPI (Python 3.14)** — arsitektur modular (`src/api`, `src/core`, `src/services`, `src/models`, `src/config.py`) dengan typing ketat Pydantic v2 dan performa ASGI tinggi. Revisi backend jadi pakai fastify.
- **HTTP Client Engine:** `httpx.AsyncClient`, dengan pencatatan timestamp berpresisi tinggi (`time.perf_counter`) sebelum/sesudah request untuk mengukur latency secara akurat.
- **JSON Path Engine:** parser dot-notation internal (`get_json_path`), tanpa library eksternal khusus untuk versi awal (array index dan query syntax di luar scope v1).
- **Assertion Evaluator sebagai pure function:** [`src/core/assertion.py`](file:///home/ard/Coding/Automated%20API%20Tool/src/core/assertion.py) terpisah dari HTTP layer sehingga dapat di-unit-test secara terisolasi tanpa jaringan.
- **Rate Limiter & DNS resolver:** In-memory sliding-window limiter (30 req/menit per IP) dan modul DNS asinkron bawaan Python (`asyncio.get_running_loop().getaddrinfo`) dengan validasi `ipaddress` untuk proteksi SSRF terhadap IP privat dan link-local (`ALLOW_LOCAL_TARGETS`).

---

## 8. Kebutuhan Non-Fungsional

### 8.1 Performance & Reliability
- Timeout default 15 detik per request.
- Batas ukuran response 2MB (body dipotong di atas itu, ditandai `truncated: true`). -->(Masih wily pelajari ini)
- Tidak ada target performa evaluasi assertion yang perlu diukur formal bagian ini murni in-memory loop, tidak akan jadi bottleneck.

### 8.2 Security

**A. Level Aplikasi** bagian dari kode proxy itu sendiri, berlaku di mana pun tool ini nanti dijalankan (localhost maupun server internal). Ini yang jadi tanggung jawab pengembangan, bukan tanggung jawab infrastruktur:

- **Rate limiting:** dibatasi per IP client, mis. maksimum 30 request/menit ke endpoint `/api/proxy/execute`. Mencegah proxy dipakai untuk menembak banyak alamat sekaligus (abuse sebagai open proxy) meskipun belum ada autentikasi.
- **Batas ukuran request body masuk:** request body dari user dibatasi (mis. 1MB) sebelum diteruskan ke target — mencegah user (sengaja atau tidak) mengirim payload raksasa lewat proxy.
- **Validasi nilai header dari user:** header ditolak (`INVALID_HEADER_VALUE`) jika mengandung karakter `\r` atau `\n`, untuk mencegah header/response splitting injection.
- **Validasi ulang URL & skema:** backend **wajib** validasi ulang (bukan hanya mengandalkan validasi frontend di US-01): tolak skema selain `http`/`https`, mis. `file://` dan `gopher://`.
- **SSRF check via resolusi DNS (ditingkatkan dari v1.3):** hostname target di-resolve ke IP terlebih dahulu (`dns.lookup`), baru IP hasil resolve itu yang divalidasi terhadap kebijakan `ALLOW_LOCAL_TARGETS` — bukan lagi sekadar mencocokkan string hostname. Ini menutup celah dulu di mana domain publik yang me-resolve ke IP privat bisa lolos.
  - `ALLOW_LOCAL_TARGETS=true` saat dijalankan di mesin lokal developer (mendukung Persona 1 & 3 yang justru perlu menguji API lokal).
  - `ALLOW_LOCAL_TARGETS=false` saat dideploy ke luar mesin developer. Yang diblokir minimal: `localhost`, `127.0.0.0/8` (termasuk bentuk seperti `127.1`), `::1`, `0.0.0.0`, range privat `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, serta **`169.254.169.254`** (endpoint metadata cloud).
  - **Batasan yang masih diakui terbuka:** DNS rebinding (IP berubah antara waktu resolve dan waktu koneksi aktual) tidak tertutup sepenuhnya oleh pendekatan ini — menutup itu butuh mekanisme pinning IP di level HTTP client, dan sengaja ditaruh di luar scope v1 (lihat section 9). Ditulis di sini supaya keterbatasannya tercatat, bukan tersembunyi.
- Proxy tidak menyimpan payload/kredensial secara permanen di server.

**B. Level Infrastruktur** — TBD, belum bisa difinalkan sekarang:

- Jika dideploy ke luar localhost developer, proxy **tidak boleh terekspos publik tanpa autentikasi** — mekanisme spesifiknya (API key sederhana, VPN, atau firewall jaringan internal) menunggu keputusan deployment.
- Reverse proxy (mis. nginx) untuk TLS termination dan rate limit tambahan di level jaringan — opsional, tergantung apakah tim sudah punya infrastruktur seperti ini.

### 8.3 Usability
- Indikator jelas untuk error sintaks JSON.
- Pembeda visual antara badge **FAIL** (request terkirim, assertion gagal), **ERROR** (request tidak terkirim), dan pesan validasi `400`/`403`/`429` (request ditolak sebelum dikirim sama sekali, karena input atau kebijakan sistem).

---

## 9. Ruang Lingkup Versi Awal (Scope v1)

**Must-have (inti brief, wajib ada untuk demo):**
- Request builder: method, URL, header, body JSON
- Proxy eksekusi + validasi & keamanan input (rate limit, body size, header, SSRF via DNS resolve) + pengukuran latency
- Assertion: status code + JSON path (`equals`, `exists`)
- Verdict badge (PASS/FAIL/ERROR) + tabel breakdown + response viewer (body + headers)

**Nice-to-have (kalau waktu cukup, urutan prioritas):**
1. Query param table (append satu arah)  dipindah dari must-have karena nilainya paling rendah dibanding item inti lainnya, dan URL bar sudah bisa menampung query string secara manual
2. Assertion latency
3. Operator `not_equals`, `contains`
4. Riwayat pengujian LocalStorage (versi ringkas, tanpa body/header)

**Belum termasuk (di luar scope v1):**
- Array index pada JSON path (`items[0].name`)
- Multi-value / duplicate query param & header
- Batch/collection run banyak endpoint sekaligus
- Export riwayat ke JSON/CSV
- Proteksi terhadap DNS rebinding (IP pinning di HTTP client)
- Autentikasi akses proxy & mekanisme keamanan level infrastruktur lainnya (lihat 8.2.B) — TBD

**Rencana Verifikasi (ringkas):**
- Ketiga use case (UC-01/02/03) didemokan terhadap target uji publik yang stabil (`httpbin.org` atau `jsonplaceholder.typicode.com`).
- **Target uji lokal (docker `ecommerce-micro-service-nodejs`):** gateway nginx di `localhost:80` (path `/customer/*` → port 8001, `/shopping/*` → 8003, root `/*` → port 8002), MongoDB + RabbitMQ sebagai pendukung. Autentikasi memakai **JWT HS256 (HMAC-SHA256)** dengan `APP_SECRET` bersifat simetris (string secret biasa) — token diterbitkan `/customer/signup` & `/customer/login` di `data.token` (klaim `{email, _id}`), valid 30 hari, dan wajib dikirim sebagai `Authorization: Bearer <token>` ke endpoint yang diproteksi. Skenario e2e happy path: signup → login → profile → address → create product → category → add to cart → shopping cart → place order → orders → shoping-details.
- Assertion Evaluator (pure function) diberi unit test terpisah dari HTTP layer — bagian ini paling rawan bug tipe data (`"1"` vs `1`, `null` vs key tidak ada, object di operator `equals`), jadi paling penting untuk ditest.
- Kontrak error 6.4 diuji manual per kode: URL kosong, skema `file://`, assertion kosong, kombinasi type × operator invalid, body JSON malformed, body terlalu besar, header dengan newline, target resolve ke IP privat, dan rate limit terlampaui.

---

## 10. Indikator Kesuksesan (Success Metrics)
- Ketiga use case (UC-01/02/03) berhasil didemokan terhadap target uji tetap tanpa error tak terduga.
- Unit test Assertion Evaluator lolos semua.
- 20 request campuran (JSON valid, non-JSON, timeout, 404) tidak menghasilkan satu pun `500 Internal Server Error` di proxy input yang salah harus keluar sebagai `400`/`403`/`429` sesuai 6.4, bukan crash.
- Percobaan manual mengarahkan target ke `http://169.254.169.254` dan `http://localhost:PORT` (saat `ALLOW_LOCAL_TARGETS=false`) berhasil diblokir dengan `LOCAL_TARGET_BLOCKED`.
