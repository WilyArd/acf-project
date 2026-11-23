# Product Requirement Document (PRD)
# ACF Automated API Testing Tool

> - **Document Version:** 1.5
> - **Status:** Draft
> - **Target Deployment:** TBD
> - **Author:** Rahmanda Ahmad Wilyan J. (Wily)
> - **Menggantikan:** `PRD_API_Testing_Tool_v1.4_Final.md` (tetap disimpan utuh sebagai riwayat)

> **Ringkasan perubahan dari v1.4:**
> - **Fitur baru: Import Request Tunggal** dari file Postman Collection v2.1 — form Request Builder terisi otomatis dari **satu** request yang dipilih user. Asersi **tidak** diimport. Murni client-side: tanpa endpoint backend baru, tanpa penyimpanan apa pun. Lihat 4.5.
> - Posisi produk **tidak berubah**: tetap single-endpoint, tetap bukan pengganti Postman. Yang ditolak tetap collection run / workspace / penyimpanan koleksi.
> - Scope v1 diperbarui (section 9): import satu request masuk **nice-to-have** dengan prioritas tertinggi; import koleksi penuh, OpenAPI, dan HAR tetap di luar scope.
> - Tambahan user story **US-07** dan use case **UC-04**.
> - Dasar keputusan: `docs/07-proposal-import-single-request.md` (status: disetujui 2026-11-18), termasuk riset pembanding terhadap source Bruno v2.0.0.

---

## 1. Executive Summary & Vision

### 1.1 Overview
ACF Automated API Testing Tool adalah aplikasi berbasis web yang dirancang untuk menyederhanakan proses pengujian RESTful API. Alat ini memungkinkan developer, QA tester, dan mahasiswa IT untuk mengirimkan HTTP request (GET, POST, PUT, PATCH, DELETE), memeriksa respon, dan secara otomatis mengevaluasi status pengujian (**PASS** atau **FAIL**) berdasarkan serangkaian *expected result* (assertions) yang dikonfigurasi secara deklaratif tanpa memerlukan penulisan skrip pengujian yang rumit.

### 1.2 Problem Statement
- Browser modern memblokir request langsung ke domain lain karena CORS, jadi pengujian API murni dari client-side sering gagal.
- Tool ini dibuat sebagai artefak pembelajaran REST API testing sekaligus tool internal fokus untuk validasi cepat satu endpoint dengan verdict yang deterministik dan konsisten. Posisinya **bukan pengganti Postman**, melainkan pelengkap untuk kasus validasi cepat tanpa perlu membuka aplikasi besar. (Bisa dibilang seperti thirdparty internal)
- **(baru di v1.5)** Mengetik ulang method/URL/headers/body setiap kali menguji membuat tool ini kalah praktis dibanding Bruno/Postman yang bisa import. Karena itu disediakan **import satu request** sebagai jembatan — tanpa membuat tool ini menjadi pengelola koleksi.

### 1.3 Value Proposition
- **Ringan & Fokus:** satu endpoint, satu verdict, tanpa fitur collection/workspace yang berat.
- **No-Code Assertions:** konfigurasi validasi visual tanpa perlu menulis kode uji manual.
- **Bypass CORS via Proxy:** backend proxy internal yang mengeksekusi request secara independen dan akurat.
- **Visual Feedback Instan:** badge PASS/FAIL/ERROR beserta rincian per kriteria.
- **(baru di v1.5) Mulai Cepat:** satu file request dari Postman bisa langsung dimuat ke form, asersi dipilih manual.

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
- **UC-04 (Import satu request):** user memilih file Postman Collection v2.1 berisi 12 request → memilih satu → form terisi (method, URL, query, header, body) beserta peringatan bila ada `{{variable}}` → user memilih asersi → Execute → verdict. Sisa 11 request dibuang; tidak tersimpan.

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
| **US-07** *(baru di v1.5)* | Mengisi form dari file Postman Collection. | - Menerima file JSON Postman Collection **v2.1** (v2.0 diterima; versi lain ditolak dengan pesan jelas).<br>- Jika file berisi lebih dari satu request, user **memilih tepat satu**; sisanya dibuang dan tidak disimpan.<br>- Form terisi: method, URL, query params (dipisah ke tabel), headers, body (hanya mode `raw` berbahasa JSON yang valid).<br>- **Asersi tidak diimport** — Assertion Configurator tetap kosong dan harus diisi user.<br>- File dibaca di browser; **tidak** di-upload ke backend dan **tidak** ditulis ke `localStorage`.<br>- Variabel `{{var}}` diimport apa adanya disertai peringatan.<br>- File rusak / bukan Postman → ditolak dengan pesan jelas, tanpa crash dan tanpa `500`. |

---

## 4. Spesifikasi Fungsional

### 4.1 Request Builder
- Method selector, URL bar, key-value table untuk header & query param (append satu arah), body editor JSON dengan validasi sintaks.
- Preset header: `Content-Type: application/json`, `Authorization: Bearer <token>`.
- **Dukungan JWT (HS256 / HMAC-SHA256):** target API yang mengautentikasi dengan JWT (mis. service lokal yang dipakai untuk demo e2e) mengeluarkan token pada response `signup`/`login` di path `data.token`, lalu endpoint yang diproteksi menerima token itu lewat header `Authorization: Bearer <token>`. Tool menyediakan mekanisme **token passthrough**: token dari response sebuah langkah diekstrak (dot-notation) dan di-inject sebagai template `{{$.data.token}}` ke header langkah berikutnya, sehingga alur multi-request berurutan (signup → login → request terproteksi) bisa diuji end-to-end. Verifikasi payload JWT hanya bersifat opsional via assertion `BODY_JSON_PATH` (mis. `decoded.exp`); tool tidak menyimpan maupun memproses token secara permanen.
- Jika body benar-benar dikirim (yaitu method `POST/PUT/PATCH`, atau `DELETE` dengan body terisi) dan header `Content-Type` belum diset, backend otomatis menambahkan `application/json`. Untuk `GET` — yang body-nya diabaikan — auto-header ini **tidak** berlaku.
- **Batasan:** `headers` dan `queryParams` direpresentasikan sebagai object JSON (lihat 6.1), sehingga **duplicate key tidak didukung**. Dua baris `tag=a` dan `tag=b` di tabel UI hanya akan menyisakan satu nilai. Multi-value query param di luar scope v1.
- **Import Request (baru di v1.5):** lihat 4.5.

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

### 4.5 Import Request Tunggal *(baru di v1.5)*

Fitur untuk mengisi Request Builder dari artefak yang sudah ada, **satu request per import**. Tujuannya mengurangi ketik ulang, bukan mengubah model produk.

**Cakupan v1.5:** Postman Collection **v2.1** (JSON). Format Bruno (`.bru`) dan format lain direncanakan menyusul, tidak di v1.5.

**Alur:**
1. User memilih file lewat `<input type="file">` atau drag-and-drop. Maksimal **1 MB**; lebih besar ditolak dengan pesan jelas.
2. Frontend mendeteksi format dari isi file: `info.schema` harus menunjuk ke skema Postman v2.0.0/v2.1.0. File lain → pesan "Format file tidak dikenali".
3. Frontend mengumpulkan seluruh request di dalam file (termasuk yang berada di folder), lalu menampilkan daftar pilihan. User memilih **tepat satu**.
4. Form terisi otomatis; request lain dibuang.
5. User mengisi assertion secara manual, lalu Execute seperti biasa.

**Pemetaan field:**

| Sumber Postman | Tujuan | Aturan |
|---|---|---|
| `request.method` | Method selector | Harus termasuk allowlist (4.3). Di luar allowlist → import ditolak. |
| `request.url.raw` | URL bar + tabel query param | Query string dipecah ke tabel (kecuali berisi `{{...}}` — lihat Peringatan). |
| `request.header[]` | Tabel headers | Key duplikat → pakai nilai terakhir + peringatan. |
| `request.body` (`mode: raw`, bahasa JSON) | Body editor | Hanya jika JSON valid. Mode `formdata`/`urlencoded`/`graphql`/`file` → body dikosongkan + peringatan. |
| `request.auth` tipe `bearer` | Header `Authorization: Bearer <token>` | Token dibaca dari `auth.bearer[].value`. Tipe lain → tidak diimport + peringatan. |
| `request.event` (scripts) | — | **Diabaikan.** Tidak ada asersi yang diimport. |

**Aturan & larangan:**
- **Asersi tidak pernah diimport.** Script `pm.test(...)` tidak diterjemahkan ke matriks 4.2. UI wajib memberi tahu ini secara eksplisit setelah import.
- **Tidak ada collection.** Sisa request di file tidak disimpan, tidak ditampilkan lagi, tidak dikirim ke backend.
- **Tidak ada penyimpanan.** Isi file dibaca di memori browser. Header, token, dan body hasil import **tidak** ditulis ke `localStorage` maupun ke server (Golden Rule 8.2.A). Satu-satunya jalur data ke server adalah payload `POST /api/proxy/execute` saat user menekan Execute.
- **Tidak ada endpoint backend baru.** Import sepenuhnya terjadi di client; kontrak 6.1–6.4 tidak berubah.
- **`{{variabel}}` tidak diselesaikan.** Tidak ada environment Postman yang diimport. Nilai `{{baseUrl}}`, `{{token}}`, dsb. ditampilkan apa adanya beserta peringatan agar user mengisinya manual (atau memakai token passthrough 4.1).

**Penanganan error (semua tanpa crash, tanpa `500`):** file rusak/JSON tidak valid, skema Postman versi lain, tidak ada request di file, file bukan Postman, ukuran melebihi batas. Masing-masing menghasilkan pesan yang menyebut penyebabnya.

**Batasan sadar (bukan bug):** import satu request tidak menjadikan tool ini pengelola koleksi. Import koleksi penuh, folder Bruno, OpenAPI/Swagger, dan HAR tetap di luar scope (lihat 9).

---

## 5. Logika & Algoritma Evaluasi Assertion

*(Tidak berubah dari v1.4. Lihat `docs/04-assertion-engine-spec.md` sebagai acuan implementasi.)*

## 6. Spesifikasi Data & Kontrak API

*(Tidak berubah dari v1.4 — termasuk 6.1 payload permintaan, 6.2/6.3 payload respon, dan 6.4 kontrak error. Import satu request tidak menambah endpoint maupun field baru pada kontrak ini. Lihat `docs/03-api-contracts.md`.)*

## 7. Arsitektur Teknis

*(Tidak berubah dari v1.4 — lihat `docs/02-system-architecture.md`.)*

Catatan untuk importer v1.5: karena import berjalan sepenuhnya di browser, tidak ada modul backend baru. Logika parse dapat ditaruh sebagai modul client yang murni dan terisolasi agar bisa diuji tanpa DOM maupun jaringan.

## 8. Kebutuhan Non-Fungsional

### 8.1 Performance & Reliability
*(Tidak berubah dari v1.4.)*

### 8.2 Security

**A. Level Aplikasi (wajib sekarang)**
- Rate limit, batas body, CRLF check, skema `http`/`https`, DNS resolve + IP policy — tidak berubah dari v1.4.
- **Tidak ada penyimpanan data sensitif**, berlaku juga untuk hasil import: header `Authorization` dan body dari file Postman hanya hidup di state form dan tidak pernah ditulis ke `localStorage` maupun ke server selain payload eksekusi.
- File import **tidak** dieksekusi sebagai kode. Script Postman diabaikan sepenuhnya — tidak ada `eval`, tidak ada sandbox script.

**B. Level Infrastruktur (TBD)** — tidak berubah dari v1.4.

### 8.3 Usability
*(Tidak berubah dari v1.4, ditambah: setiap hasil import yang mengandung peringatan wajib menampilkan ringkasan peringatan sebelum user menekan Execute.)*

---

## 9. Ruang Lingkup Versi Awal (Scope v1 + v1.5)

**Must-have (inti brief, wajib ada untuk demo):**
- Request builder: method, URL, header, body JSON
- Proxy eksekusi + validasi & keamanan input (rate limit, body size, header, SSRF via DNS resolve) + pengukuran latency
- Assertion: status code + JSON path (`equals`, `exists`)
- Verdict badge (PASS/FAIL/ERROR) + tabel breakdown + response viewer (body + headers)

**Nice-to-have (kalau waktu cukup, urutan prioritas):**
1. **Import satu request dari Postman v2.1** *(baru di v1.5 — prioritas tertinggi nice-to-have, lihat 4.5)*
2. Query param table (append satu arah)
3. Assertion latency
4. Operator `not_equals`, `contains`
5. Riwayat pengujian LocalStorage (versi ringkas, tanpa body/header)

**Belum termasuk (di luar scope v1/v1.5):**
- Array index pada JSON path (`items[0].name`)
- Multi-value / duplicate query param & header
- Batch/collection run banyak endpoint sekaligus
- **Import collection/folder penuh** (Postman atau Bruno), spesifikasi OpenAPI/Swagger, file HAR — request selalu diambil satu per satu
- **Import file Bruno `.bru`** — direncanakan setelah v1.5
- **Menyimpan atau menyinkronkan koleksi** (server, object storage, Git integration)
- **Menerjemahkan script/asersi Postman** ke matriks asersi baku
- Export riwayat ke JSON/CSV
- Proteksi terhadap DNS rebinding (IP pinning di HTTP client)
- Autentikasi akses proxy & mekanisme keamanan level infrastruktur lainnya (lihat 8.2.B) — TBD

**Rencana Verifikasi (ringkas):**
- Ketiga use case (UC-01/02/03) didemokan terhadap target uji publik yang stabil (`httpbin.org` atau `jsonplaceholder.typicode.com`).
- **Target uji lokal (docker `ecommerce-micro-service-nodejs`):** gateway nginx di `localhost:80` (path `/customer/*` → port 8001, `/shopping/*` → 8003, root `/*` → port 8002), MongoDB + RabbitMQ sebagai pendukung. Autentikasi memakai **JWT HS256 (HMAC-SHA256)** dengan `APP_SECRET` bersifat simetris (string secret biasa) — token diterbitkan `/customer/signup` & `/customer/login` di `data.token` (klaim `{email, _id}`), valid 30 hari, dan wajib dikirim sebagai `Authorization: Bearer <token>` ke endpoint yang diproteksi. Skenario e2e happy path: signup → login → profile → address → create product → category → add to cart → shopping cart → place order → orders → shoping-details.
- Assertion Evaluator (pure function) diberi unit test terpisah dari HTTP layer — bagian ini paling rawan bug tipe data (`"1"` vs `1`, `null` vs key tidak ada, object di operator `equals`), jadi paling penting untuk ditest.
- Kontrak error 6.4 diuji manual per kode: URL kosong, skema `file://`, assertion kosong, kombinasi type × operator invalid, body JSON malformed, body terlalu besar, header dengan newline, target resolve ke IP privat, dan rate limit terlampaui.
- **Import (UC-04) diuji terhadap:** file berisi 1 request; file berisi banyak request; file dengan `{{variable}}`; body non-JSON (`formdata`); header duplikat; file bukan Postman; JSON rusak; file > 1 MB. Semua harus gagal dengan pesan jelas atau terisi benar, tanpa crash. Diuji juga bahwa **tidak ada data import yang masuk ke `localStorage`**.

---

## 10. Indikator Kesuksesan (Success Metrics)
- Ketiga use case (UC-01/02/03) berhasil didemokan terhadap target uji tetap tanpa error tak terduga.
- **(v1.5)** UC-04: user dapat memuat satu request dari file Postman dan menjalankannya tanpa mengetik ulang field apa pun, dengan **nol** data sensitif tersimpan.
- Unit test Assertion Evaluator lolos semua.
- 20 request campuran (JSON valid, non-JSON, timeout, 404) tidak menghasilkan satu pun `500 Internal Server Error`; input yang salah harus keluar sebagai `400`/`403`/`429` sesuai 6.4, bukan crash.
- Percobaan manual mengarahkan target ke `http://169.254.169.254` dan `http://localhost:PORT` (saat `ALLOW_LOCAL_TARGETS=false`) berhasil diblokir dengan `LOCAL_TARGET_BLOCKED`.
