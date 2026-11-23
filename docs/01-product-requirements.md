# 01 — Product Requirements & Scope v1

## 1. Executive Summary & Vision

### 1.1 Overview
**ACF Automated API Testing Tool** adalah aplikasi berbasis web yang dirancang untuk menyederhanakan proses pengujian RESTful API. Alat ini memungkinkan developer, QA tester, dan mahasiswa IT untuk mengirimkan HTTP request (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), memeriksa respon, dan secara otomatis mengevaluasi status pengujian (**PASS** atau **FAIL**) berdasarkan serangkaian *expected result* (assertions) yang dikonfigurasi secara deklaratif tanpa memerlukan penulisan skrip pengujian yang rumit.

### 1.2 Problem Statement
- Browser modern memblokir request langsung ke domain lain karena kebijakan **CORS**, sehingga pengujian API murni dari sisi client sering gagal.
- Tool ini dibangun sebagai artefak pembelajaran REST API testing sekaligus tool internal yang fokus pada validasi cepat satu endpoint dengan verdict yang deterministik dan konsisten.
- Posisinya **bukan pengganti Postman**, melainkan pelengkap ringan (layaknya *third-party* internal) untuk kasus validasi cepat tanpa harus membuka aplikasi desktop yang berat.

### 1.3 Value Proposition
- **Ringan & Fokus:** Satu endpoint, satu verdict, tanpa fitur collection/workspace yang berat.
- **No-Code Assertions:** Konfigurasi validasi visual tanpa perlu menulis kode uji manual.
- **Bypass CORS via Proxy:** Backend proxy internal mengeksekusi request secara independen dan akurat.
- **Visual Feedback Instan:** Badge `PASS` / `FAIL` / `ERROR` beserta tabel rincian per kriteria.

---

## 2. User Personas & Use Cases

### 2.1 Target Personas
1. **Backend Developer:** Menguji endpoint lokal maupun staging saat proses development atau debugging.
2. **QA Engineer:** Melakukan validasi cepat satu endpoint saat verifikasi bugfix (bukan batch/collection run — di luar scope v1).
3. **Pelajar / Mahasiswa IT:** Mempelajari konsep REST API, HTTP status code, dan validasi struktur data JSON.

### 2.2 Core Use Cases
- **UC-01 (Happy Path):**  
  `GET /api/users/1` → status `200`, `data.id equals 1` → **PASS**.
- **UC-02 (Assertion Failure):**  
  `POST /api/auth/login` dengan kredensial salah, expected `401`, actual `500` → **FAIL** beserta rincian expected vs actual.
- **UC-03 (Request Tidak Terkirim):**  
  Endpoint tidak terjangkau (timeout / DNS gagal / SSL invalid) → status **ERROR** (bukan FAIL biasa), disertai alasan teknis yang jelas, dan assertion tidak dievaluasi sama sekali.

---

## 3. User Stories & Acceptance Criteria

| ID | User Story | Acceptance Criteria |
|---|---|---|
| **US-01** | Memilih HTTP Method dan memasukkan URL endpoint. | - Method yang didukung: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.<br>- Frontend memvalidasi prefix `http://` atau `https://` (catatan: ini bukan kontrol keamanan; backend tetap melakukan validasi ulang). |
| **US-02** | Menambahkan Header dan Query Parameter. | - Tersedia key-value editor dengan tombol hapus per baris.<br>- Query param di-append ke URL satu arah saat request dikirim (URL bar tidak di-parse balik ke tabel).<br>- Nilai header ditolak backend jika mengandung karakter newline (`\r` / `\n`). |
| **US-03** | Mengirim Request Body JSON. | - Editor dilengkapi validasi sintaks JSON.<br>- Aktif untuk `POST`, `PUT`, `PATCH`; untuk `GET` body diabaikan backend; untuk `DELETE` body bersifat opsional dan diteruskan apa adanya.<br>- Body ditolak backend jika ukurannya melebihi batas yang ditentukan. |
| **US-04** | Menentukan assertion. | - Assertion berbentuk array seragam: `{ type, operator, target?, expectedValue }`.<br>- Tipe assertion: `STATUS_CODE`, `LATENCY`, `BODY_JSON_PATH`.<br>- Kombinasi `type × operator` wajib mengikuti matriks valid; kombinasi di luar matriks ditolak backend dengan HTTP `400`. |
| **US-05** | Melihat hasil `PASS` / `FAIL` / `ERROR`. | - `PASS` = semua assertion lolos.<br>- `FAIL` = request terkirim tetapi ≥1 assertion gagal.<br>- `ERROR` = request gagal terkirim (network/timeout/SSL) dan assertion tidak dievaluasi.<br>- Tabel breakdown menampilkan kolom **Type, Target/Field, Operator, Expected, Actual, Status** (kolom Target/Field wajib ada agar dua assertion `BODY_JSON_PATH` pada path berbeda dapat dibedakan). |
| **US-06** | Melihat riwayat pengujian lokal. | - Riwayat (`localStorage`) hanya menyimpan: `method`, `url`, `timestamp`, `overallStatus`, serta jumlah assertion lolos/gagal.<br>- **Tidak menyimpan** request body maupun header sama sekali untuk mencegah kebocoran data sensitif dari akarnya. |

---

## 4. Ruang Lingkup Versi Awal (Scope v1)

### 4.1 Must-Have (Inti Brief — Wajib Ada untuk Demo)
- Request builder: HTTP method, URL, header, dan body JSON.
- Proxy eksekusi + validasi & keamanan input (rate limit, body size limit, validasi header, SSRF via DNS resolve) + pengukuran latency.
- Assertion dasar: `STATUS_CODE` (`equals`) dan `BODY_JSON_PATH` (`equals`, `exists`).
- Verdict badge (`PASS` / `FAIL` / `ERROR`) + tabel breakdown + response viewer (body + headers).

### 4.2 Nice-to-Have (Urutan Prioritas Jika Waktu Mencukupi)
1. **Query param table (append satu arah):** Dipindahkan dari must-have karena nilainya paling rendah dibanding item inti lainnya, sementara URL bar sudah dapat menampung query string secara manual.
2. **Assertion `LATENCY` (`less_than_or_equal`).**
3. **Operator tambahan `not_equals` dan `contains`** pada `BODY_JSON_PATH`.
4. **Riwayat pengujian `localStorage`** (versi ringkas tanpa body maupun header).

### 4.3 Out of Scope v1 (Belum Termasuk)
- Array index pada JSON path (contoh: `items[0].name`).
- Multi-value / duplicate query parameter dan header.
- Batch / collection run untuk banyak endpoint sekaligus.
- Import collection/folder penuh Postman maupun Bruno, spesifikasi OpenAPI/Swagger, dan file HAR. (Import **satu request** dari Postman v2.1 sudah disetujui di PRD v1.5 §4.5 — lihat `docs/07-proposal-import-single-request.md`; detail implementasinya menyusul di `docs/05`.)
- Export riwayat pengujian ke format JSON atau CSV.
- Proteksi terhadap DNS rebinding (IP pinning pada level HTTP client).
- Autentikasi akses proxy & mekanisme keamanan level infrastruktur lainnya (TBD).
