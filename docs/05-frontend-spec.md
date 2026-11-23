# 05 — Frontend UI & Client Behavior Specification

**Stack:** AstroJS + Tailwind CSS

---

## 1. Request Builder (`US-01`, `US-02`, `US-03`)

- **Method & URL Bar:** Dropdown pilihan HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) dan input URL dengan validasi awal prefix `http://` atau `https://`.
- **Key-Value Editors (Headers & Query Params):**
  - Tabel pasangan `Key` dan `Value` dengan tombol hapus per baris.
  - **Append Satu Arah untuk Query Params:** Parameter pada tabel query di-append satu arah ke URL saat tombol eksekusi ditekan (URL bar tidak di-parse balik ke tabel).
  - **Preset Header:** Tombol/pilihan cepat untuk `Content-Type: application/json` dan `Authorization: Bearer <token>`.
- **JSON Body Editor:**
  - Editor teks dengan validasi sintaks JSON real-time dan indikator pesan error yang jelas bila sintaks belum valid.
  - Aktif untuk method `POST`, `PUT`, dan `PATCH`. Untuk `DELETE`, bersifat opsional. Untuk `GET`, diinformasikan/diabaikan karena body tidak dikirim oleh backend.
- **Import Request Tunggal (PRD v1.5 §4.5, `US-07`):** user memilih file Postman Collection v2.1, mendeteksi format dari `info.schema`, menampilkan daftar seluruh request di file, lalu mengisi form dari **tepat satu** request yang dipilih. Request lain dibuang. Asersi **tidak** diimport; script diabaikan. Maksimal file 1 MB. Semua parsing berjalan di browser — tidak ada upload, tidak ada penulisan ke `localStorage`, tidak ada endpoint backend baru. Wajib menampilkan ringkasan peringatan (variabel `{{...}}`, body non-JSON, header duplikat, auth non-bearer) sebelum user menekan Execute.
- **Tanpa Import Koleksi:** import collection/folder penuh, OpenAPI, HAR, dan file Bruno `.bru` di luar scope (lihat `docs/01` §4.3).

---

## 2. Dukungan Autentikasi JWT HS256 & Token Passthrough

Untuk mendukung pengujian alur berantai end-to-end (misalnya `signup` → `login` → mengakses endpoint yang diproteksi JWT HS256):
- Target API autentikasi umumnya mengembalikan token pada response `signup` / `login` di path seperti `data.token`, lalu endpoint terproteksi mewajibkan header `Authorization: Bearer <token>`.
- **Mekanisme Token Passthrough:** Frontend menyediakan kemampuan mengekstrak nilai token dari response langkah sebelumnya menggunakan dot-notation dan menyisipkannya melalui template variabel **`{{$.data.token}}`** ke dalam header langkah berikutnya.
- Verifikasi klaim payload JWT (misalnya `decoded.exp`) bersifat opsional melalui assertion `BODY_JSON_PATH`.
- Client maupun server **tidak** menyimpan atau memproses token secara permanen.

---

## 3. Assertion Configurator (`US-04`)

- Memungkinkan user menambah, mengubah, dan menghapus baris assertion: `{ type, operator, target?, expectedValue }`.
- Opsi `operator` menyesuaikan secara dinamis berdasarkan `type` yang dipilih agar selaras dengan matriks valid:
  - `STATUS_CODE` → `equals`
  - `LATENCY` → `less_than_or_equal`
  - `BODY_JSON_PATH` → `equals`, `not_equals`, `contains`, `exists` (saat `exists` dipilih, `expectedValue` otomatis dikunci ke `null`).

---

## 4. Test Result & Response Viewer (`US-05`)

- **Overall Verdict Badge:**
  - `PASSED` (seluruh assertion terpenuhi)
  - `FAILED (X of Y assertions failed)` (request berhasil terkirim, namun ≥1 assertion gagal)
  - `ERROR (Request Error: <alasan>)` (request gagal mencapai target)
  - Banner/alert terpisah untuk error validasi pra-eksekusi (`400` / `403` / `429`) agar user tahu request belum pernah dikirim.
- **Assertion Result Breakdown Table:**
  - Kolom wajib: **Type | Target/Field | Operator | Expected | Actual | Status**.
  - Merefleksikan langsung array `assertionDetails` dari API contract.
  - Untuk tipe `STATUS_CODE` dan `LATENCY`, kolom **Target/Field** ditampilkan sebagai `—`.
  - Bedakan tampilan antara `found: false` (field tidak ada) dan `found: true` dengan `actual: null` (field ada bernilai `null`).
- **Response Inspector (2 Tab):**
  - **Tab 1 — Body:** Menampilkan JSON terformat (*pretty-print*) jika valid JSON, atau teks mentah (*raw text*) jika non-JSON.
  - **Tab 2 — Headers:** Daftar header response dari target API.
  - **Info Panel:** Status code, response latency (`ms`), dan ukuran body (`bytes`) ditampilkan di panel ringkasan di atas/samping tab (bukan tab terpisah).
  - **Truncation Warning:** Jika `rawResponse.truncated === true`, tampilkan peringatan eksplisit bahwa body dipotong pada batas 2MB.

---

## 5. Riwayat Pengujian Lokal (`US-06`)

- Disimpan pada `localStorage` browser.
- **Data yang disimpan (Whitelist Ketat):**
  - `method`
  - `url`
  - `timestamp`
  - `overallStatus`
  - `passedCount` & `failedCount`
- **Larangan Keras:** `headers` dan `body` **tidak boleh** disimpan di `localStorage` untuk menghilangkan risiko penyimpanan kredensial/token di sisi client.
