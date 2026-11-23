# 03 — Data Specifications & API Contracts

Semua eksekusi pengujian dikirim melalui satu endpoint proxy backend: `POST /api/proxy/execute`.

---

## 1. Payload Permintaan (`POST /api/proxy/execute`)

```json
{
  "request": {
    "method": "POST",
    "url": "https://api.example.com/v1/auth/login",
    "headers": {
      "Content-Type": "application/json"
    },
    "queryParams": {
      "ref": "internal"
    },
    "body": {
      "username": "tester@example.com",
      "password": "SecretPassword123"
    }
  },
  "assertions": [
    {
      "type": "STATUS_CODE",
      "operator": "equals",
      "expectedValue": 200
    },
    {
      "type": "LATENCY",
      "operator": "less_than_or_equal",
      "expectedValue": 500
    },
    {
      "type": "BODY_JSON_PATH",
      "operator": "equals",
      "target": "status",
      "expectedValue": "success"
    },
    {
      "type": "BODY_JSON_PATH",
      "operator": "exists",
      "target": "data.token",
      "expectedValue": null
    }
  ]
}
```

### Aturan Payload Permintaan
- `headers` dan `queryParams` direpresentasikan sebagai JSON object (`Record<string, string>`), sehingga **duplicate key tidak didukung** di v1.
- Untuk `GET`, properti `body` diabaikan oleh backend dan tidak memicu penambahan header `Content-Type: application/json`.
- Untuk `POST`, `PUT`, `PATCH`, atau `DELETE` dengan body terisi, backend otomatis menyisipkan `Content-Type: application/json` apabila belum diset oleh user.

---

## 2. Payload Respon — Kasus `PASS` / `FAIL` (`HTTP 200 OK` dari Proxy)

Meskipun pengujian menghasilkan verdict `FAIL`, endpoint proxy tetap mengembalikan HTTP `200 OK` karena transaksi proxy berjalan sukses dan verdict berhasil dihitung.

```json
{
  "overallStatus": "FAIL",
  "totalAssertions": 4,
  "passedCount": 3,
  "failedCount": 1,
  "executedAt": "2026-08-28T10:00:00.000Z",
  "assertionDetails": [
    {
      "type": "STATUS_CODE",
      "target": null,
      "operator": "equals",
      "expected": 200,
      "actual": 200,
      "found": true,
      "status": "PASS"
    },
    {
      "type": "LATENCY",
      "target": null,
      "operator": "less_than_or_equal",
      "expected": 500,
      "actual": 142,
      "found": true,
      "status": "PASS"
    },
    {
      "type": "BODY_JSON_PATH",
      "target": "status",
      "operator": "equals",
      "expected": "success",
      "actual": "success",
      "found": true,
      "status": "PASS"
    },
    {
      "type": "BODY_JSON_PATH",
      "target": "data.token",
      "operator": "exists",
      "expected": null,
      "actual": null,
      "found": false,
      "status": "FAIL",
      "reason": "Field 'data.token' tidak ditemukan"
    }
  ],
  "rawResponse": {
    "statusCode": 200,
    "responseTimeMs": 142,
    "bodySizeBytes": 231,
    "truncated": false,
    "headers": {
      "content-type": "application/json; charset=utf-8"
    },
    "body": {
      "status": "success"
    }
  }
}
```

### Semantik Field `found`
Tanpa penanda `found`, kondisi *"key ada tetapi bernilai `null`"* dan *"key tidak ditemukan"* akan memiliki bentuk JSON yang identik (`"actual": null`). Aturan bakunya:
- `found: false` → path/key sama sekali tidak ada di struktur JSON response.
- `found: true` dengan `actual: null` → key ditemukan di struktur JSON dan nilainya memang `null`.
- Untuk tipe `STATUS_CODE` dan `LATENCY`, nilai `found` selalu `true`.

---

## 3. Payload Respon — Kasus `ERROR` (Request Gagal Terkirim)

Digunakan apabila request gagal mencapai server target (misalnya connection timeout, DNS failure, atau SSL certificate invalid). Seluruh assertion tidak dievaluasi.

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

---

## 4. Kontrak Error Validasi (`400` / `403` / `429`)

Dikembalikan **sebelum** request ke target dikirim. Struktur ini sengaja dipisahkan dari `overallStatus: "ERROR"` karena penyebabnya adalah input user atau kebijakan sistem, bukan kegagalan jaringan ke server target.

```json
{
  "error": {
    "code": "NO_ASSERTIONS",
    "message": "Minimal 1 assertion wajib dikonfigurasi.",
    "field": "assertions"
  }
}
```

### Tabel Kode Error Standar

| HTTP Status | `error.code` | Kondisi Terjadi |
|---|---|---|
| `400` | `INVALID_URL_FORMAT` | URL kosong atau tidak valid untuk di-parse. |
| `400` | `INVALID_URL_SCHEME` | Skema URL selain `http` atau `https` (misalnya `file://`, `gopher://`). |
| `400` | `NO_ASSERTIONS` | Array `assertions` kosong atau tidak disertakan. |
| `400` | `INVALID_ASSERTION` | Kombinasi `type × operator` di luar matriks valid, `target` kosong untuk `BODY_JSON_PATH`, atau `expectedValue` bukan angka positif untuk `LATENCY`. |
| `400` | `INVALID_JSON_BODY` | Request body bukan JSON valid (lapisan validasi kedua setelah frontend). |
| `400` | `INVALID_METHOD` | HTTP method di luar `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. |
| `400` | `REQUEST_BODY_TOO_LARGE` | Ukuran request body dari user melebihi batas yang diizinkan. |
| `400` | `INVALID_HEADER_VALUE` | Nilai header mengandung karakter newline (`\r` atau `\n`) yang berpotensi memicu header injection. |
| `403` | `LOCAL_TARGET_BLOCKED` | Hostname target me-resolve ke alamat IP internal/privat/metadata sementara `ALLOW_LOCAL_TARGETS=false`. |
| `429` | `RATE_LIMIT_EXCEEDED` | IP client melebihi batas maksimum request per menit. |

> **Catatan Keamanan:** Contoh `password` pada payload permintaan di bagian 1 hanya ilustrasi data transit ke proxy. Karena proxy tidak menyimpan payload secara permanen dan riwayat `localStorage` tidak menyimpan body maupun header, risiko kebocoran data sensitif dicegah dari sumbernya.
