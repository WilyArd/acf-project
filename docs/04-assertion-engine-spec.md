# 04 — Assertion Engine & Evaluation Algorithm

## 1. Matriks `Type × Operator` yang Valid (v1)

Kombinasi di bawah ini adalah satu-satunya kombinasi yang diizinkan pada versi 1. Kombinasi di luar matriks ini wajib ditolak oleh backend sebelum eksekusi request dengan HTTP `400` (`INVALID_ASSERTION`).

| Type | Operator yang Didukung | Cara Pembandingan |
|---|---|---|
| `STATUS_CODE` | `equals` | **Numerik.** Hanya `equals` yang didukung di v1 (`not_equals` / range di luar scope). |
| `LATENCY` | `less_than_or_equal` | **Numerik murni** (tanpa normalisasi string). `PASS` jika `responseTimeMs <= expectedValue`. `expectedValue` wajib berupa angka positif. |
| `BODY_JSON_PATH` | `equals`, `not_equals`, `contains`, `exists` | Mengikuti definisi eksplisit per-operator di Bagian 2. |

---

## 2. Definisi Eksplisit Operator untuk `BODY_JSON_PATH`

Bagian ini merupakan area paling krusial untuk mencegah *false positive* atau bug tipe data.

| Operator | Aturan Evaluasi |
|---|---|
| `equals` / `not_equals` | - Kedua nilai (`actual` dan `expectedValue`) dinormalisasi menjadi **string** sebelum dibandingkan, sehingga `"1"` dan `1` dianggap setara.<br>- **Jika `actual` bertipe `object` atau `array` → langsung `FAIL`** dengan reason `"tipe tidak didukung untuk operator equals/not_equals"` (mencegah dua object berbeda dianggap sama karena terkonversi menjadi `"[object Object]"`).<br>- **Jika `target` path tidak ditemukan → selalu `FAIL`** dengan reason `"path tidak ditemukan"`, berlaku juga untuk `not_equals` (tidak boleh diam-diam `PASS`). |
| `contains` | - Jika `actual` bertipe **string** → lakukan *substring match*.<br>- Jika `actual` berupa **array** → lakukan *membership match*.<br>- Tipe data lain (`object`, `number`, `boolean`, `null`) → **`FAIL`** dengan reason `"tipe tidak didukung untuk operator contains"`. |
| `exists` | - **`PASS`** apabila key ditemukan di struktur JSON response, **termasuk** jika nilainya `null`.<br>- **`FAIL`** apabila key sama sekali tidak ada di struktur JSON.<br>- `expectedValue` untuk operator ini selalu `null` (bukan string `"exists"`). |

### Konsekuensi Normalisasi String (Batasan Sadar)
Karena normalisasi ke string pada `equals` / `not_equals`, nilai actual `null` akan dianggap sama dengan expected string `"null"`, dan boolean `true` dianggap sama dengan `"true"`. Untuk memastikan keberadaan key secara terpisah dari nilainya, gunakan operator `exists`.

### Aturan Target Property Path
- Menggunakan sintaks *dot-notation* sederhana (contoh: `data.user.id`).
- **Batasan v1:** Key JSON yang mengandung karakter titik literal tidak didukung, pencarian bersifat *case-sensitive*, dan pengindeksan array (`items[0]`) berada di luar scope v1.

---

## 3. Alur & Algoritma Eksekusi Lengkap

```text
[Mulai Eksekusi Pengujian]
        │
        ▼
[Rate limit check per IP — batas 30 req/menit]
        │
        ├─► Melebihi batas? ──► HTTP 429 (RATE_LIMIT_EXCEEDED), SELESAI
        ▼
[Validasi Input di Backend — SEBELUM request dikirim]
        │   • Ukuran request body masuk dalam batas?
        │   • Nilai header bebas dari karakter \r / \n?
        │   • URL valid & menggunakan skema http / https?
        │   • Array assertions berisi minimal 1 item?
        │   • Kombinasi type × operator valid sesuai Matriks Bagian 1?
        │   • Resolusi DNS host target → IP hasil resolve lolos policy ALLOW_LOCAL_TARGETS?
        │
        ├─► Ada yang gagal? ──► Kembalikan HTTP 400 / 403 sesuai Kontrak Error
        │                       (Request ke server target TIDAK pernah dikirim), SELESAI
        ▼
[Kirim Request via Proxy Backend]
        │
        ├─► Gagal terkirim (timeout 15s / DNS gagal / SSL invalid)?
        │       └──► overallStatus = "ERROR", assertionDetails = [], rawResponse = null, SELESAI
        ▼
[Tangkap Response: statusCode, responseTimeMs, headers, body, bodySizeBytes, truncated]
        │
        ├─► Apakah body merupakan JSON valid?
        │       ├─► Tidak ──► Hanya assertion STATUS_CODE & LATENCY yang dievaluasi;
        │       │             Semua assertion BODY_JSON_PATH otomatis FAIL dengan reason:
        │       │               • "Response body dipotong pada 2MB, tidak bisa diparse" (jika truncated = true)
        │       │               • "Response body bukan JSON valid" (jika sebab lain)
        │       │             rawResponse.body dikirim sebagai raw string apa adanya.
        │       └─► Ya ─────► Lanjut evaluasi normal seluruh assertion.
        ▼
[Loop setiap assertion sesuai Matriks & Definisi Operator]
        │
        ▼
[Tentukan overallStatus: "PASS" jika semua lolos, "FAIL" jika minimal 1 gagal]
        │
        ▼
[Kembalikan payload hasil terstruktur ke Frontend]
```
