# Usulan Perubahan Scope — Import Request Tunggal (Postman / Bruno)

> **Status:** DISETUJUI → masuk **PRD v1.5** (`requirement/PRD_API_Testing_Tool_v1.5_Final.md`).
> **Keputusan:** import satu request diterima sebagai bagian v1.5, dengan jawaban §6 di bawah.
> **Tanggal disetujui:** 2026-11-18

---

## 1. Masalah

Alur v1 memaksa user mengetik ulang method, URL, headers, query params, dan body setiap kali menguji satu endpoint. Dibandingkan Bruno/Postman yang bisa import collection JSON atau folder `.bru`, ini terasa lebih repot untuk pemakaian harian.

Akibat praktisnya: user cenderung **tidak** memakai tool ini untuk endpoint yang sering diuji, dan kembali ke Bruno/Postman — padahal nilai unik tool ini (verdict `PASS`/`FAIL`/`ERROR` baku + bypass CORS) tetap dibutuhkan.

## 2. Usulan (yang diminta)

**Import satu request dari artefak Postman/Bruno**, murni di sisi client, tanpa menyimpan apa pun:

| Aspek | Usulan |
| --- | --- |
| Input | File Postman Collection v2.1 (`.json`) atau file Bruno (`.bru`) |
| Cakupan | **Hanya satu item request** per import. Jika file berisi >1 request, user memilih satu dari daftar; yang lain dibuang |
| Hasil | Form Request Builder terisi otomatis: `method`, `url`, `queryParams`, `headers`, `body` |
| Assertion | **Tidak diimport.** Asersi tetap dipilih manual di Assertion Configurator |
| Penyimpanan | **Tidak ada.** File dibaca di memori browser, tidak di-upload ke backend, tidak ke `localStorage` |
| Backend | **Tidak berubah.** Tidak ada endpoint baru |

### Pemetaan field

| Sumber | Tujuan | Catatan |
| --- | --- | --- |
| `request.method` / `.bru method` | `method` | Divalidasi terhadap allowlist; di luar itu → tolak import dengan pesan jelas |
| `request.url.raw` (Postman) / `url` (Bruno) | `url` + `queryParams` | Query di URL **dipecah ke tabel** (kecuali skema berisi variabel `{{...}}` — lihat §3) |
| `request.header[]` | `headers` | Duplikat key → ambil kemunculan terakhir + tampilkan peringatan |
| `request.body.raw` (mode `raw`, language JSON) | `body` | Hanya jika JSON valid; mode `formdata`/`urlencoded`/`graphql` → body dikosongkan + peringatan |
| `request.auth` | `headers` (opsional) | `bearer` → header `Authorization`; tipe lain → abaikan + peringatan |

## 3. Batasan yang tetap berlaku (non-negosiasi)

- **Tetap single-endpoint.** Import tidak menghasilkan collection, tidak menyimpan daftar request, tidak ada batch run. Out-of-scope `docs/01` §4.3 ("Batch / collection run") tetap berdiri.
- **Golden Rule persistence tidak dilanggar.** Header auth dan body hasil import hanya hidup di state form React/Astro island — tidak ditulis ke `localStorage`, tidak dikirim ke server selain sebagai bagian payload `/api/proxy/execute` saat user menekan Execute.
- **Asersi tidak dipetakan otomatis.** Script test Postman (`pm.test(...)`) tidak punya padanan dan tidak akan diterjemahkan. Ini keputusan sadar: produk ini menganut matriks asersi baku, bukan script bebas.
- **Template variabel tidak dieksekusi.** `{{baseUrl}}`, `{{token}}`, `{{$.data.token}}` dari file tidak diselesaikan otomatis. Import menampilkan peringatan dan user mengisinya manual (atau memakai token passthrough yang sudah ada di `docs/05` §2).

## 4. Dampak ke spesifikasi (jika disetujui)

| Dokumen | Perubahan |
| --- | --- |
| `docs/01` | Tambah user story (mis. `US-07`) + masukkan ke nice-to-have; perjelas bahwa §4.3 "collection run" mengacu ke *eksekusi*, bukan *imbas satu request* |
| `docs/03` | **Tidak berubah** (parse murni client-side). Perlu ditulis eksplisit bahwa tidak ada endpoint import |
| `docs/04` | **Tidak berubah** (tidak ada asersi yang diimport) |
| `docs/05` | Tambah seksi "Import Request" di Request Builder: format yang didukung, aturan pemetaan, peringatan yang wajib tampil |
| `docs/06` | Tambah test case: file berisi 1 request, N request, variabel `{{}}`, body non-JSON, header duplikat, file rusak, file bukan Postman/Bruno (harus gagal dengan pesan jelas, tanpa crash) |
| `AGENTS.md` §4 | Tambah catatan: import tidak boleh menulis ke `localStorage` maupun backend |

## 5. Pertimbangan & risiko

- **Dependency baru.** Parsing `.bru` tidak trivial; parsing Postman v2.1 relatif mudah. Opsi: mulai dari Postman v2.1 saja, Bruno menyusul.
- **Ekspektasi user.** User yang biasa import collection mungkin mengira asersi di dalamnya ikut terbawa. UI harus memberi tahu secara eksplisit bahwa asersi **tidak** diimport.
- **Ukuran file.** Batas wajar (mis. 1 MB) supaya tidak macet di browser; file lebih besar ditolak dengan pesan jelas.
- **Kontradiksi produk.** Semakin lengkap fitur import, semakin dekat tool ini ke "Postman ringan" — yang bertentangan dengan posisi produk di `docs/01` §1. Karena itu cakupan dibatasi satu request dan tanpa asersi.

## 6. Keputusan yang diminta

**Keputusan (2026-11-18):**

1. Apakah import **satu request** diterima di v1? → **Ya**, masuk v1.5.
2. Postman dulu, atau Postman + Bruno sekaligus? → **Postman v2.1 dulu.** Bruno `.bru` menyusul setelahnya (parser `.bru` tidak trivial; lihat catatan riset Bruno di §7).
3. Header `Authorization` dari `request.auth` ikut diimport? → **Ya, ikut diimport** untuk tipe `bearer`, **tetapi** nilai token tidak dibaca dari environment Postman. User diminta memperbarui nilainya (atau memakai token passthrough `{{$.data.token}}`). Tipe auth lain (`oauth2`, `awsv4`, `digest`, `ntlm`) tidak diimport — form diisi `none` dengan peringatan.
4. Variabel `{{...}}` di URL/header diimport apa adanya dengan peringatan, atau ditolak? → **Diimport apa adanya + peringatan yang jelas.** Menolak seluruh import karena satu variabel akan membuat fitur ini tidak berguna untuk file Postman nyata, yang hampir selalu berisi `{{baseUrl}}`.

---

## 7. Catatan riset: bagaimana Bruno melakukannya (Bruno v2.0.0)

Diambil dari pembacaan source `D:\Coding\data-magang-sidigs\bruno` (commit `494b38a`). Berguna sebagai preseden, **bukan** sebagai alasan untuk memperbesar scope kita.

- **Deteksi format dengan *sniffing* isi file, bukan ekstensi.** Postman dikenali dari `info.schema` yang harus persis URL v2.0.0/v2.1.0 (`utils/importers/postman-collection.js:25`). Pola ini murah dan layak ditiru untuk skenario "user memilih satu file".
- **Bruno pun hanya mendukung Postman v2.0/v2.1**; versi lain → error keras (`postman-to-bruno.js:1233-1244`). Jadi membatasi ke v2.1 bukan kekurangan kita.
- **Script `pm.*` hanya diterjemahkan secara heuristik** ke `bru.*`, dan yang gagal diterjemahkan dipertahankan verbatim + peringatan (`postman-to-bruno.js:204-215`). Ini mendukung keputusan kita **tidak mengimport asersi sama sekali** — bahkan produk penuh sekelas Bruno tidak bisa menjamin script terbawa utuh.
- **"Inherit" hanya dipertahankan untuk auth**, tidak untuk header/script (`postman-to-bruno.js:270-281`). Karena kita mengambil satu request saja, konsep inherit tidak relevan bagi kita.
- **Import tidak pernah menimpa data**: folder bentrok di-rename otomatis (`utils/collection-import.js:12`). Kita tidak relevan di sini karena kita menulis ke form, bukan ke disk.
- **Bruno membutuhkan main process (Node) karena ia menulis file ke disk dan mengirim request dari Node.** Tool ini tidak menulis apa pun dan mengirim lewat proxy Fastify yang sudah ada, sehingga import cukup dilakukan di browser — tanpa endpoint backend baru, tanpa storage.

Satu hal dari riset ini yang **tidak** kita tiru: Bruno mengimport `response[]` (example) sebagai contoh respons tersimpan (`postman-to-bruno.js:808-968`). Kita tidak, karena tool ini tidak menyimpan apa pun dan example tidak dipakai oleh Assertion Engine.
