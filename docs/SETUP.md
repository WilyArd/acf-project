# Setup Guide — ACF Workbench (Lokal + VPS + CI/CD)

Panduan end-to-end untuk menjalankan ACF Workbench di komputer lokal dan men-deploy-nya ke VPS dengan GitLab CI/CD + Cloudflare. Semua langkah di bawah adalah langkah yang benar-benar dijalankan pada setup produksi `demo-acf-project.ard6j1.my.id` — bukan teori.

> **Arsitektur akhir yang dihasilkan panduan ini:**
>
> ```
> Browser → Cloudflare (A record, Proxied)
>         → edge_nginx VPS1 (HTTPS, Cloudflare Origin Cert)
>         → acf-frontend (static Astro) / acf-backend (Fastify) di network "acf_net"
> ```
>
> Pipeline GitLab: **test + build image di runner VPS2**, **deploy di runner VPS1** (VPS1 tidak terbebani build).

---

## 1. Prasyarat

Diasumsikan lingkungan sudah siap:

| Alat | Versi minimum | Dipakai untuk |
|---|---|---|
| Node.js | `>= 22` (frontend `>= 22.23.4`) | dev, test, build |
| Docker + Compose | Docker 29+, Compose v5 | container, deploy |
| Git | v2.4+ | clone, push |
| Akun GitLab | gratis | repo, CI/CD, Container Registry |
| Domain di Cloudflare | plan free | DNS, HTTPS (Origin Cert) |
| 2 VPS (opsional, lihat §6) | Ubuntu 24/26, 2 GB RAM | runner + produksi |

> Panduan ini memakai **2 VPS** (build di VPS2, deploy di VPS1). Kalau hanya punya satu VPS, ikuti §4–§7 semuanya di satu server — pipeline-nya tinggal satu tag runner.

---

## 2. Menjalankan Lokal (tanpa Docker)

```bash
# Backend
cd backend
npm install
npm run dev                 # http://127.0.0.1:3001

# Frontend (terminal kedua)
cd frontend
npm install
npm run dev                 # http://localhost:4321 (proxy /api → :3001)
```

Uji target API yang berjalan di localhost saat dev:

```powershell
# PowerShell
$env:ALLOW_LOCAL_TARGETS="true"; npm run dev
```

> `ALLOW_LOCAL_TARGETS` **wajib `false` di produksi** — itu SSRF guard-nya.

---

## 3. Menjalankan Lokal dengan Docker (satu perintah)

```bash
docker compose up --build
```

Buka `http://localhost:8080`. Compose menjalankan:

- `frontend` — Nginx menyajikan static Astro + mem-proxy `/api/` ke backend
- `backend` — Fastify, tidak publish port ke host

---

## 4. Menyiapkan Repo di GitLab

1. Push project ke GitLab (contoh remote: `git@gitlab.com:<user>/acf-project.git`).
2. Pastikan `.gitignore` mengabaikan `node_modules/`, `dist/`, `.astro/`, `.env*`, `*.pem`, `*.key`.
3. **CI/CD Variables** (`Settings → CI/CD → Variables`):
   - `PROXY_API_KEY` — biarkan **kosong** (frontend belum mengirim `x-proxy-key`; mengisinya mematikan UI).

File pipeline lengkap ada di `.gitlab-ci.yml` di repo; file compose produksi di `deploy/docker-compose.prod.yml`.

---

## 5. Dockerfile & Compose Produksi

Sudah tersedia di repo:

- `backend/Dockerfile` — multi-stage, runtime non-root, `HOST=0.0.0.0`
- `frontend/Dockerfile` — build Astro → runtime `nginx:alpine`
- `deploy/docker-compose.prod.yml` — network `acf_net` khusus ACF, tanpa publish port
- `deploy/40-acf.conf` — vhost Nginx untuk domain demo

Tidak ada yang perlu diubah kecuali nama domain di `40-acf.conf`.

---

## 6. Setup Runner GitLab (di VPS)

### 6.1 Instalasi dasar (di kedua VPS)

```bash
docker run -d --name gitlab-runner --restart always \
  -v /srv/gitlab-runner/config:/etc/gitlab-runner \
  -v /var/run/docker.sock:/var/run/docker.sock \
  gitlab/gitlab-runner:latest
```

### 6.2 Register runner per project

Buat token via `glab` (atau UI: `Settings → CI/CD → Runners → New project runner`):

```bash
glab api --method POST "user/runners" \
  -f "runner_type=project_type" -f "project_id=<PROJECT_ID>" \
  -f "description=acf-vps1 deploy runner" -f "tag_list=vps1" \
  -f "run_untagged=false" -f "locked=true" -f "access_level=not_protected"
```

> Workflow GitLab baru: `tag_list` dan `locked` di-set saat pembuatan token, bukan saat `register`.

Register di server:

```bash
docker exec gitlab-runner gitlab-runner register \
  --non-interactive \
  --url "https://gitlab.com/" \
  --token "<TOKEN>" \
  --executor "shell" \
  --request-concurrency=2
```

### 6.3 VPS2 — runner build (executor docker)

Runner di VPS2 memakai **executor docker** dengan docker.sock di-mount. Tambahkan di `config.toml` runner VPS2:

```toml
[[runners]]
  executor = "docker"
  [runners.docker]
    image = "docker:29-cli"
    privileged = false
    volumes = ["/var/run/docker.sock:/var/run/docker.sock", "/cache"]
```

### 6.4 VPS1 — runner deploy (executor shell + docker CLI)

Job deploy menjalankan `docker` & `docker compose` langsung di host VPS1 via docker.sock. **Image resmi gitlab-runner tidak menyertakan docker CLI** — gunakan image kustom:

```dockerfile
# Dockerfile.runner
FROM gitlab/gitlab-runner:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 987 dockerhost \
 && usermod -aG dockerhost gitlab-runner
```

> Sesuaikan `987` dengan GID `docker.sock` di host: `stat -c '%g' /var/run/docker.sock`.

Build & jalankan:

```bash
docker build -t gitlab-runner-docker:latest .
docker stop gitlab-runner && docker rm gitlab-runner

docker run -d --name gitlab-runner --restart always \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -v /srv/gitlab-runner/config:/etc/gitlab-runner \
  -v /srv/acf:/srv/acf \
  -v /var/run/docker.sock:/var/run/docker.sock \
  gitlab-runner-docker:latest \
  run --user=gitlab-runner --working-directory=/home/gitlab-runner
```

Siapkan direktori deploy dengan ownership yang benar:

```bash
sudo mkdir -p /srv/acf
sudo chown 999:999 /srv/acf    # uid gitlab-runner di dalam container
```

---

## 7. Edge Nginx + Cloudflare + Domain

### 7.1 Vhost HTTPS di VPS1

`deploy/40-acf.conf` dipasang ke Nginx edge:

```bash
sudo cp deploy/40-acf.conf /srv/edge/conf.d/40-acf.conf
docker exec edge_nginx nginx -t && docker exec edge_nginx nginx -s reload
```

Izinkan container ACF dijangkau Nginx edge via nama container:

```bash
docker network create acf_net
docker network connect acf_net edge_nginx
```

### 7.2 Cloudflare Origin Certificate

1. Dashboard Cloudflare → `SSL/TLS → Origin Server → Create Certificate`
2. Hostnames: `*.domain-anda.com` + `domain-anda.com`
3. Validity: sesuai kebijakan (panduan ini pakai **90 hari** — catat tanggal kadaluarsanya!)
4. Pasang di server:

```bash
sudo install -m 644 origin-cert.pem /srv/edge/tls/domain-origin.pem
sudo install -m 600 origin-key.pem /srv/edge/tls/domain-origin.key
docker exec edge_nginx nginx -t && docker exec edge_nginx nginx -s reload
```

### 7.3 DNS

`DNS → Add record`:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `demo` (atau sesuai) | **IP publik VPS1** | Proxied |

> A record tidak membawa port — Cloudflare otomatis menghubungi origin di 80/443 standar. Pastikan Security Group AWS mengizinkan 80/443 (idealnya hanya dari [CIDR Cloudflare](https://www.cloudflare.com/ips/) supaya origin tidak bisa di-bypass).

### 7.4 SSL/TLS mode

`SSL/TLS → Overview` → **Full**. 

> **Full (strict)** hanya setelah *semua* vhost di origin listen 443 dengan cert valid. Kalau ada vhost lain di Nginx edge yang masih HTTP saja, strict akan mematikan mereka.

---

## 8. Verifikasi Akhir

```bash
# 1. Container hidup & healthy
docker ps --filter name=acf --format "{{.Names}}: {{.Status}}"

# 2. Frontend via nginx (di dalam VPS)
curl -sk -o /dev/null -w "%{http_code}\n" \
  --resolve demo.domain-anda.com:443:127.0.0.1 https://demo.domain-anda.com/

# 3. Backend kontrak 400 via nginx
curl -sk --resolve demo.domain-anda.com:443:127.0.0.1 \
  -X POST https://demo.domain-anda.com/api/proxy/execute \
  -H "Content-Type: application/json" \
  -d '{"request":{"method":"GET","url":"file:///x"}}'

# 4. Publik end-to-end
curl -s https://demo.domain-anda.com/ -o /dev/null -w "%{http_code}\n"
```

Pipeline hijau + 4 verifikasi di atas lolos = deploy selesai.

---

## 9. Troubleshooting (semua pernah terjadi sungguhan)

| Gejala | Penyebab | Solusi |
|---|---|---|
| `can't create /srv/acf/.env: nonexistent directory` | `/srv/acf` tidak di-mount ke job container | Tambahkan ke `volumes` di `config.toml` runner, restart runner |
| `compose file ... no such file or directory` | File compose belum ada di host | Job deploy harus `cp` dari checkout CI ke `/srv/acf` (lihat `.gitlab-ci.yml`) |
| `Permission denied /srv/acf` | Ownership bukan uid gitlab-runner | `chown 999:999 /srv/acf` |
| `docker: command not found` (job vps1) | Image gitlab-runner resmi tanpa docker CLI; CLI terpasang manual hilang saat container di-recreate | Pakai image kustom (§6.4) |
| `permission denied ... docker.sock` (hanya di `docker compose`, bukan `docker ps`) | gitlab-runner tidak masuk group socket | `groupadd -g <GID> dockerhost && usermod -aG dockerhost gitlab-runner` di Dockerfile (§6.4) |
| Job deploy stuck `pending` berjam-jam | Runner belum ter-attach ke project, atau `resource_group` tertahan pipeline lain | Cek `Settings → Runners`; cancel pipeline lama |
| `waiting_for_resource` | Ada job lain di `resource_group: production` | Tunggu atau cancel pipeline penahan lock |
| `521` dari Cloudflare | Origin tidak merespons di port yang dituju | Pastikan container hidup & `edge_nginx` listen di IP yang diarahkan DNS |
| UI tiba-tiba semua `401` | `PROXY_API_KEY` diisi tapi frontend tidak mengirim `x-proxy-key` | Kosongkan variable, atau tambahkan pengiriman header di `frontend/src/lib/apiClient.ts` |
| Tag mismatch, job tidak pernah dipick | Tag di `.gitlab-ci.yml` ≠ tag runner | Samakan (panduan ini: `vps1` untuk deploy, `vps2` untuk build) |

---

## 10. Rotasi Origin Certificate (90 hari)

1. ~2 minggu sebelum kadaluarsa, buat cert baru di Cloudflare (hostname & validity sama).
2. Pasang dengan nama file baru lalu update `ssl_certificate` di vhost, atau langsung timpa file lama.
3. `nginx -t && nginx -s reload`.
4. Hapus file cert lama.

**Tanggal kadaluarsa cert saat ini: 21 Februari 2027.**

---

## Lampiran: Peta File Infrastruktur

| File | Fungsi |
|---|---|
| `.gitlab-ci.yml` | Pipeline: test (vps2) → build (vps2) → deploy (vps1) |
| `deploy/docker-compose.prod.yml` | Stack produksi, network `acf_net`, tanpa publish port |
| `deploy/40-acf.conf` | Vhost Nginx edge: HTTPS + redirect + proxy `/api` |
| `backend/Dockerfile` | Image backend (multi-stage, non-root) |
| `frontend/Dockerfile` | Image frontend (Astro → Nginx) |
| `frontend/deploy/nginx.conf` | Nginx internal container frontend (proxy ke backend) |
| `docker-compose.yml` | Compose lokal (dev/demo di laptop) |
