# 02 — System Architecture, Security & Non-Functional Requirements

## 1. Diagram Arsitektur Teknis

```text
Client (Browser — AstroJS + Tailwind CSS)
  ├── Request Builder (Method, URL, Headers, Query Params, JSON Body, Token Passthrough)
  ├── Assertion Configurator
  └── Response & Assertion Viewer + LocalStorage Summary History
        │
        │  HTTP JSON Payload (POST /api/proxy/execute)
        ▼
Backend Proxy (Fastify — Modular Architecture)
  ├── 1. Rate Limiter (Sliding-window 30 req/menit per IP)
  ├── 2. Input & Header Validator (Body size, CRLF check, URL/Scheme, Assertion Matrix)
  ├── 3. DNS Resolver & SSRF Guard (Resolve hostname -> validasi IP vs ALLOW_LOCAL_TARGETS)
  ├── 4. HTTP Request Dispatch (No redirect follow, 15s timeout, 2MB response cap, timer)
  └── 5. Assertion Evaluator (Pure Function: normalized response + rules -> verdict)
        │
        │  Outbound HTTP/HTTPS Request
        ▼
Target API Server Eksternal / Lokal
```

---

## 2. Komponen & Keputusan Teknologi (Hasil Revisi)

- **Frontend — AstroJS + Tailwind CSS:** *(Direvisi dari rencana awal Next.js).* Menyediakan antarmuka web yang ringan dengan komponen interaktif untuk penyusunan request, konfigurasi assertion, dan inspeksi hasil.
- **Backend — Fastify (Node.js / TypeScript):** *(Direvisi dari rencana awal Python FastAPI).* Menerapkan arsitektur modular (`api`, `core`, `services`, `models`, `config`) dengan validasi skema JSON ketat dan performa I/O tinggi.
- **HTTP Client Engine:** Klien HTTP asinkron di sisi server proxy dengan pencatatan waktu presisi tinggi sebelum dan sesudah request dikirim untuk menghitung `responseTimeMs`.
- **JSON Path Engine:** Parser dot-notation internal (`get_json_path`) tanpa dependensi library berat untuk v1 (mendukung path bertingkat seperti `data.user.id`; array index dan query syntax di luar scope v1).
- **Assertion Evaluator sebagai Pure Function:** Modul inti terpisah sepenuhnya dari lapisan HTTP sehingga dapat diuji dengan unit test secara terisolasi tanpa memerlukan koneksi jaringan.
- **Rate Limiter & DNS Resolver:** In-memory sliding-window limiter (30 request/menit per IP) dan modul resolusi DNS asinkron bawaan runtime untuk memvalidasi alamat IP tujuan terhadap blokir IP privat dan link-local.

---

## 3. Tanggung Jawab Proxy Engine

1. **Validasi & Keamanan Input Sebelum Pengiriman:** Memeriksa rate limit per IP, ukuran body masuk, karakter pada header, format & skema URL, minimal 1 assertion, validitas matriks `type × operator`, serta resolusi DNS target sebelum menembak API eksternal.
2. **Bypass CORS:** Mengeksekusi HTTP request dari server ke target API atas nama browser.
3. **Pengukuran Latency Akurat:** Mencatat timestamp tepat sebelum dan sesudah eksekusi request di proxy.
4. **Tidak Mengikuti Redirect (`3xx`):** Respon `3xx` dikembalikan apa adanya sebagai status aktual agar assertion terhadap perilaku redirect tetap akurat dan tidak menyesatkan.
5. **Batas Ukuran Response 2MB:** Jika payload respon melebihi 2MB, body dipotong pada batas 2MB dan flag `rawResponse.truncated` diset menjadi `true`.
6. **Header Sanitization:** Menghapus (*strip*) header tertentu yang diisi user seperti `Host` dan `Content-Length` sebelum diteruskan untuk mencegah konflik protokol HTTP.
7. **Timeout 15 Detik & Perilaku Latency Assertion:** Timeout keras berada pada 15 detik. Jika waktu respon melebihi `expectedValue` dari assertion `LATENCY`, proxy **tidak** membatalkan (*abort*) request di tengah jalan, melainkan tetap menunggu sampai request selesai atau menyentuh timeout 15 detik baru mengevaluasi assertion latency.

> **Catatan Pengukuran Latency:** Nilai `responseTimeMs` diukur di **proxy backend**, bukan di browser, sehingga angkanya akan berbeda dari tab Network DevTools. Request pertama ke suatu host umumnya lebih lambat karena mencakup *DNS lookup*, *TLS handshake*, dan potensi *cold start* pada server target. Akibatnya, assertion `LATENCY` dengan batas ketat dapat gagal pada eksekusi pertama meskipun endpoint sehat — lakukan satu kali pemanasan (*warm-up*) sebelum sesi demo.

---

## 4. Kebutuhan Non-Fungsional (NFR)

### 4.1 Performance & Reliability
- Timeout default **15 detik** (15.000 ms) per request keluar.
- Batas maksimal ukuran response **2MB** (body dipotong di atas batas tersebut dan ditandai `truncated: true`).
- Evaluasi assertion berjalan murni secara *in-memory* loop sehingga tidak menjadi *bottleneck* performa.

### 4.2 Security (Pemisahan Level Aplikasi vs Level Infrastruktur)

#### A. Keamanan Level Aplikasi (Wajib Dikerjakan di Kode Proxy Sekarang)
Berlaku di mana pun aplikasi dijalankan (localhost maupun server internal) dan menjadi tanggung jawab langsung kode backend:

- **Rate Limiting per IP:** Maksimum **30 request/menit** per IP client pada endpoint `/api/proxy/execute` untuk mencegah penyalahgunaan sebagai *open proxy*.
- **Batas Ukuran Request Body Masuk:** Membatasi ukuran payload masuk dari user (misalnya maksimum **1MB**) sebelum diteruskan ke target.
- **Validasi Nilai Header User:** Menolak header (`INVALID_HEADER_VALUE`) apabila mengandung karakter newline (`\r` atau `\n`) untuk mencegah *CRLF / header / response splitting injection*.
- **Validasi Ulang URL & Skema:** Backend wajib memvalidasi ulang URL dan menolak skema selain `http://` dan `https://` (seperti `file://`, `gopher://`, dll.).
- **SSRF Protection via Resolusi DNS:** Hostname target di-resolve ke alamat IP terlebih dahulu via DNS lookup, lalu IP hasil resolve divalidasi terhadap kebijakan `ALLOW_LOCAL_TARGETS`:
  - `ALLOW_LOCAL_TARGETS=true` saat dijalankan di mesin lokal developer (mendukung pengujian API lokal).
  - `ALLOW_LOCAL_TARGETS=false` saat dideploy di luar mesin developer. Alamat yang wajib diblokir minimal mencakup:
    - `localhost`
    - `127.0.0.0/8` (termasuk bentuk ringkas seperti `127.1`)
    - `::1` dan `0.0.0.0`
    - Range IP privat: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
    - Endpoint metadata cloud: **`169.254.169.254`**
  - **Batasan Terbuka (Acknowledged Limitation):** Serangan *DNS rebinding* (perubahan IP antara waktu DNS resolve dan waktu koneksi aktual dibuka) belum tertutup sepenuhnya karena membutuhkan *IP pinning* pada level HTTP client, dan sengaja ditempatkan di luar scope v1.
- **Zero Credential Persistence:** Proxy tidak menyimpan payload body maupun header kredensial secara permanen di server.

#### B. Keamanan Level Infrastruktur (TBD — Menunggu Keputusan Deployment)
- Jika aplikasi dideploy di luar localhost developer, endpoint proxy **tidak boleh terekspos ke publik tanpa autentikasi** (opsi seperti API key sederhana, VPN, atau firewall jaringan internal akan ditentukan saat deployment).
- Penggunaan reverse proxy (misalnya **nginx**) untuk *TLS termination* dan rate limiting tambahan di level jaringan bersifat opsional sesuai infrastruktur yang tersedia.

### 4.3 Usability
- Indikator visual yang jelas saat terjadi kesalahan sintaks JSON pada body editor.
- Pembeda visual yang tegas antara badge **FAIL** (request terkirim, assertion gagal), **ERROR** (request gagal terkirim ke target), dan pesan penolakan validasi **`400` / `403` / `429`** (request ditolak sebelum dikirim karena input atau kebijakan sistem).
