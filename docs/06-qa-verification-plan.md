# 06 — QA Verification Plan & Success Metrics

## 1. Target Uji & Lingkungan Verifikasi

### A. Target Uji Publik (Stabil)
Digunakan untuk mendemokan ketiga use case utama (`UC-01`, `UC-02`, `UC-03`):
- `https://httpbin.org`
- `https://jsonplaceholder.typicode.com`

### B. Target Uji Lokal (Docker `ecommerce-micro-service-nodejs`)
Digunakan untuk memverifikasi pengujian endpoint lokal (`ALLOW_LOCAL_TARGETS=true`) serta alur autentikasi berantai E2E menggunakan token passthrough:
- **Arsitektur Target Lokal:**
  - Gateway **nginx** pada `localhost:80`:
    - `/customer/*` → port `8001`
    - `/shopping/*` → port `8003`
    - `/*` (root) → port `8002`
  - Pendukung: **MongoDB** + **RabbitMQ**.
- **Mekanisme Autentikasi Target:**
  - **JWT HS256 (HMAC-SHA256)** dengan symmetric `APP_SECRET`.
  - Token diterbitkan oleh endpoint `/customer/signup` dan `/customer/login` pada field `data.token` (klaim `{ email, _id }`, masa berlaku 30 hari).
  - Endpoint terproteksi mewajibkan header `Authorization: Bearer <token>`.
- **Skenario E2E Happy Path:**
  `signup` → `login` → `profile` → `address` → `create product` → `category` → `add to cart` → `shopping cart` → `place order` → `orders` → `shoping-details`.

---

## 2. Rencana Pengujian Terstruktur

### 2.1 Unit Testing — Assertion Evaluator (Pure Function)
Karena Assertion Evaluator dipisahkan dari lapisan HTTP, modul ini wajib memiliki cakupan unit test menyeluruh terhadap skenario rawan bug:
- Perbandingan `STATUS_CODE` numerik (`200 === 200` → `PASS`, `200 === 404` → `FAIL`).
- Perbandingan `LATENCY` numerik (`142 <= 500` → `PASS`, `501 <= 500` → `FAIL`).
- Normalisasi string pada `BODY_JSON_PATH` dengan `equals` / `not_equals` (`"1"` vs `1` → `PASS`).
- Penolakan tipe non-primitif (`object` dan `array`) pada `equals` / `not_equals` → `FAIL` dengan reason `"tipe tidak didukung untuk operator equals/not_equals"`.
- Perilaku `exists` vs path hilang:
  - `{ "data": { "token": null } }` dengan `exists` → `PASS`, `found: true`, `actual: null`.
  - `{ "data": {} }` dengan `exists` → `FAIL`, `found: false`, `actual: null`.
  - `{ "data": {} }` dengan `not_equals` → `FAIL` dengan reason `"path tidak ditemukan"`.
- Perilaku `contains` pada `string` (substring), `array` (membership), dan penolakan pada `number`/`boolean`/`object`/`null`.
- Penanganan response body non-JSON atau terpotong 2MB (`truncated: true`).

### 2.2 Pengujian Manual Kontrak Error Pra-Eksekusi (`6.4`)
Setiap kode error di bawah wajib diuji secara manual dan diverifikasi tidak pernah memicu request keluar ke target:
1. `400 INVALID_URL_FORMAT` — URL kosong atau format rusak.
2. `400 INVALID_URL_SCHEME` — URL menggunakan `file:///etc/passwd` atau `gopher://`.
3. `400 NO_ASSERTIONS` — Array `assertions: []`.
4. `400 INVALID_ASSERTION` — Misal `STATUS_CODE` dengan operator `contains`, `BODY_JSON_PATH` tanpa `target`, atau `LATENCY` dengan `expectedValue: -10`.
5. `400 INVALID_JSON_BODY` — Payload body JSON malformed.
6. `400 INVALID_METHOD` — Method seperti `TRACE` atau `CONNECT`.
7. `400 REQUEST_BODY_TOO_LARGE` — Payload body melebihi batas ukuran masuk.
8. `400 INVALID_HEADER_VALUE` — Header berisi karakter `\r` atau `\n`.
9. `403 LOCAL_TARGET_BLOCKED` — Target diarahkan ke `http://169.254.169.254` atau `http://localhost:8001` saat `ALLOW_LOCAL_TARGETS=false`.
10. `429 RATE_LIMIT_EXCEEDED` — Mengirim >30 request dalam 1 menit dari IP yang sama.

### 2.3 Import Request Tunggal (`UC-04`, PRD v1.5 §4.5)

Berlaku setelah fitur import disetujui di PRD v1.5. Sampai saat itu, seluruh kasus di bawah belum dapat dieksekusi.

**Fixture yang dibutuhkan** (letakkan di `fixtures/import/`):
- `postman-single.json` — collection v2.1 berisi 1 request `GET https://httpbin.org/get`.
- `postman-multi.json` — collection v2.1 berisi 12 request, sebagian di dalam folder.
- `postman-variables.json` — URL `{{baseUrl}}/users/1` + header `Authorization: Bearer {{token}}`.
- `postman-formdata.json` — request `POST` dengan `body.mode: formdata`.
- `postman-dup-headers.json` — dua header `X-Trace` dengan nilai berbeda.
- `postman-v1.json` — collection skema v1 skema lama (harus ditolak).
- `not-postman.json` — JSON valid tapi bukan koleksi.
- `broken.json` — JSON sintaks rusak.
- `oversized.json` — > 1 MB.

**Kasus uji:**

| # | Skenario | Hasil yang diharapkan |
| --- | --- | --- |
| 1 | Import `postman-single.json` | Form terisi method, URL, query, header, body; daftar pilihan berisi 1 item |
| 2 | Import `postman-multi.json` lalu pilih 1 | Hanya request terpilih yang mengisi form; 11 sisanya tidak tersimpan dan tidak tampil lagi |
| 3 | Import `postman-variables.json` | Nilai `{{baseUrl}}` / `{{token}}` diimport apa adanya, **disertai peringatan** |
| 4 | Import `postman-formdata.json` | Body kosong + peringatan; method & URL tetap terisi |
| 5 | Import `postman-dup-headers.json` | Satu header tersisa (nilai terakhir) + peringatan |
| 6 | Auth `bearer` pada file | Header `Authorization: Bearer …` terisi; auth tipe lain → tidak diimport + peringatan |
| 7 | Assertion setelah import | Assertion Configurator **kosong**; ada pesan eksplisit bahwa asersi tidak diimport |
| 8 | Import `postman-v1.json` | Ditolak dengan pesan versi tidak didukung; form tidak berubah |
| 9 | Import `not-postman.json` | Ditolak dengan pesan format tidak dikenali |
| 10 | Import `broken.json` | Ditolak dengan pesan file rusak; tidak ada crash dan tidak ada `500` |
| 11 | Import `oversized.json` | Ditolak dengan pesan ukuran melebihi batas |
| 12 | Eksekusi setelah import | Request terkirim melalui `POST /api/proxy/execute` seperti biasa; kontrak `6.1`–`6.4` tidak berubah |
| 13 | **Pemeriksaan `localStorage`** setelah import + execute | Tidak ada header, token, maupun body di `localStorage`; hanya whitelist `US-06` (method, url, timestamp, overallStatus, passedCount, failedCount) |
| 14 | Pemeriksaan jaringan (DevTools) saat import | File tidak di-upload; tidak ada request keluar saat proses import terjadi |
| 15 | Script Postman (`pm.test`, `pm.sendRequest`) pada file | Diabaikan sepenuhnya; tidak dijalankan, tidak ditampilkan sebagai asersi |

**Cara verifikasi #13–#14:** buka DevTools → tab Application (`localStorage`) dan Network selama proses import. Tidak boleh ada entri jaringan selain aset halaman.

---

## 3. Indikator Kesuksesan (Success Metrics)

Proyek v1 dinyatakan memenuhi kriteria keberhasilan apabila seluruh poin berikut tercapai:
1. **Demo Use Case Sukses:** Ketiga use case (`UC-01`, `UC-02`, `UC-03`) berhasil didemokan terhadap target uji tetap tanpa error tak terduga.
2. **100% Unit Test Pass:** Seluruh suite unit test pada pure function Assertion Evaluator lulus tanpa kegagalan.
3. **Zero `500 Internal Server Error`:** Pengujian 20 request campuran (JSON valid, non-JSON, timeout, 404, serta berbagai input invalid) tidak menghasilkan satu pun `500 Internal Server Error` pada backend proxy — seluruh input salah keluar sebagai `400` / `403` / `429` sesuai kontrak.
4. **Proteksi SSRF Terbukti:** Percobaan mengarahkan target ke `http://169.254.169.254` dan `http://localhost:PORT` (saat `ALLOW_LOCAL_TARGETS=false`) berhasil diblokir dengan kode `LOCAL_TARGET_BLOCKED` (`403`).
5. **(v1.5) Import tanpa penyimpanan:** `UC-04` berhasil (satu request dimuat dari file Postman dan dieksekusi tanpa mengetik ulang field), dengan **nol** data sensitif tersimpan — diverifikasi lewat kasus #13 dan #14 di §2.3. Masih berlaku: tidak ada `500` pada seluruh input invalid import.
