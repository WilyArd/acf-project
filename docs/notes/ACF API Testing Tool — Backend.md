---
title: ACF API Testing Tool — Backend
date: 2026-11-22
tags:
  - project/acf
  - backend
  - security
  - status/disetujui
status: approved
---

# ACF API Testing Tool — Backend

Backend proxy `POST /api/proxy/execute` untuk tool pengujian API satu-endpoint. Stack: Fastify 5 + TypeScript, Node 24.

> [!note] Cakupan & Status
> Backend berdiri sendiri, telah melalui hardening keamanan, dan dibuktikan lewat **155/155 unit & integration test** (`npm test`), `npm run typecheck`, dan `npm run build` (`dist/`). Frontend Workbench (`Astro + React + Tailwind`) juga sudah terimplementasi penuh di `frontend/`.

## Pipeline (`onRequest` → `preParsing` → Handler → Pure Evaluator)

```mermaid
flowchart TD
    A[POST /api/proxy/execute] --> B[onRequest: Optional PROXY_API_KEY + Rate limit 30/menit + Concurrency cap]
    B -->|API key invalid| B0[401 UNAUTHORIZED]
    B -->|limit terlampaui| B1[429 RATE_LIMIT_EXCEEDED]
    B --> C[preParsing: Hitung wire bytes + Fastify bodyLimit 1MB]
    C -->|melebihi 1MB / invalid JSON| C1[400 REQUEST_BODY_TOO_LARGE / INVALID_JSON_BODY]
    C --> D[Validasi payload: Method, RFC9110 Header, URL, Assertions max 100]
    D -->|gagal| D1[400 kode error kontrak]
    D --> E[DNS resolve timeout 5s + SSRF guard fail-closed]
    E -->|IP privat/terlarang| E1[403 LOCAL_TARGET_BLOCKED]
    E -->|DNS gagal| F1[overallStatus ERROR]
    E --> F[Dispatch node:http/https pinned IP + BLOCKED_PORTS + 15s timeout + cap 2MB]
    F -->|gagal transport| F1
    F --> G[Evaluate assertion - pure function aman container/primitive]
    G --> H[PASS / FAIL + header nosniff / no-store / DENY]
```

## Keputusan teknis & hardening utama

| Topik | Aturan final | Bukti / Lokasi |
| --- | --- | --- |
| Timer latency | **Mencakup DNS** | `backend/src/api/proxy.routes.ts` & `docs/02` §1 |
| Reason path hilang | Satu string `path tidak ditemukan` untuk semua operator | `backend/src/core/assertion/evaluate.ts` & `docs/04` §2 |
| HTTP client & DNS rebinding | `node:http` / `node:https` langsung (`agent: false`) dengan custom `createPinnedLookup` ke IP hasil `checkTarget()`, mempertahankan hostname untuk TLS SNI | `backend/src/services/dispatcher.ts` |
| Pre-parse DoS guard | Rate limit, concurrency cap (`MAX_IN_FLIGHT_REQUESTS`), & `FASTIFY_BODY_LIMIT_BYTES=1MB` dievaluasi sebelum `JSON.parse` | `backend/src/api/proxy.routes.ts`, `backend/src/app.ts` |
| SSRF fail-closed | Malformed IPv4/IPv6 ditolak, `%zone` dibersihkan, `::ffff:0:0/96` (`0xffff`), NAT64, Teredo, 6to4, multicast/reserved diblokir, DNS lookup dibatasi 5s | `backend/src/services/ssrfGuard.ts` |
| Assertion crash safety | `TYPE_OPERATORS` memakai `Map`; `expectedValue` wajib primitif finite; `safePrimitiveString` cegah HTTP 500 pada `{toString: null}` | `backend/src/services/validator.ts`, `evaluate.ts` |
| DNS gagal | `overallStatus: "ERROR"` dengan pesan tersanitasi | `backend/src/services/ssrfGuard.ts` & `docs/04` §3 |
| Cap 2MB vs timeout | Dua kondisi terpisah (stream dihancurkan segera saat >= 2MB dengan `truncated: true`) | `backend/src/services/dispatcher.ts` |

> [!warning] Aturan Emas Keamanan
> Tidak ada penyimpanan payload/header request di server maupun `localStorage`, header hop-by-hop/forwarding/`Proxy-*`/`Accept-Encoding` di-strip, port layanan terbatas (`BLOCKED_PORTS`, termasuk port 22) diblokir, dan URL ber-userinfo ditolak sebelum dispatch.

## Tautan

- Desain: `docs/superpowers/specs/2026-11-18-backend-proxy-design.md`
- Kontrak: `docs/03-api-contracts.md`
- Semantik asersi: `docs/04-assertion-engine-spec.md`
- Scope v1.5: `requirement/PRD_API_Testing_Tool_v1.5_Final.md`
