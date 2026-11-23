# Panduan Deploy VPS — GitLab CI/CD + Cloudflare (Template Generik)

Panduan ini menunjukkan **pola** untuk men-deploy aplikasi web (frontend static + backend API) ke VPS dengan:

- **GitLab CI/CD** — test dan build image di satu server, deploy ke server lain (atau sama)
- **Docker Compose** di VPS, tanpa port publik kecuali lewat reverse proxy
- **Cloudflare** untuk DNS + HTTPS via Origin Certificate
- **Nginx edge** sebagai satu-satunya pintu masuk traffic

Pola ini dipakai nyata oleh project ACF Workbench (`demo-acf-project.ard6j1.my.id`) dan bisa diadaptasi ke project lain apa pun dengan struktur serupa.

> **Cara memakai panduan ini:** setiap bagian menandai ⚙️ **SESUAIKAN** untuk hal yang berbeda-beda per project (nama, domain, port, path). Bagian tanpa tanda itu biasanya bisa disalin apa adanya.

---

## 0. Prasyarat

| Alat | Kebutuhan |
|---|---|
| VPS × 1–2 | Ubuntu 24/26, Docker 29 + Compose v5, swap disarankan ≥ 4 GB kalau build di server |
| GitLab | Repo project + Container Registry (gratis, otomatis aktif) |
| `glab` CLI | Untuk membuat runner token via API (alternatif: UI GitLab) |
| Domain | Di-manage Cloudflare (plan free cukup) |
| SSH ke VPS | Kunci `.pem` / key terkonfigurasi di `~/.ssh/config` |

**Mengapa 2 VPS?** Build image (`npm ci` + `astro build` + docker build) makan RAM besar. Menjalankannya di server produksi berisiko OOM. Pola yang dipakai: **build di VPS2 (runner docker executor), deploy di VPS1 (runner shell executor)**. Punya satu VPS saja? Semua langkah tetap jalan di satu server — cukup satu runner dengan kedua kemampuan.

---

## 1. Struktur File yang Dibutuhkan

```
project/
├── .gitlab-ci.yml              # pipeline: test → build → deploy
├── backend/
│   ├── Dockerfile              # image API
│   └── .dockerignore
├── frontend/
│   ├── Dockerfile              # image web (static build → nginx)
│   └── .dockerignore
└── deploy/
    ├── docker-compose.prod.yml # stack produksi
    └── <project>.conf          # vhost nginx edge (HTTPS)
```

---

## 2. Dockerfile Backend (contoh: Node/Fastify)

```dockerfile
# Multi-stage: build TS → runtime produksi non-root.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# WAJIB di container: default 127.0.0.1 tidak bisa diakses container lain.
ENV HOST=0.0.0.0
ENV PORT=3001          # ⚙️ SESUAIKAN

USER node
EXPOSE 3001            # ⚙️ SESUAIKAN
CMD ["node", "dist/server.js"]
```

### `.dockerignore` (backend & frontend, pola sama)

```
node_modules
dist
test
*.log
.env
.env.*
```

---

## 3. Dockerfile Frontend (contoh: Astro static → Nginx)

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY astro.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:1.29-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf   # nginx internal container
EXPOSE 80
```

Nginx **internal** frontend juga yang mem-proxy `/api` ke backend container (menggantikan proxy Vite yang hanya aktif saat `npm run dev`):

```nginx
# frontend/deploy/nginx.conf
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {                       # ⚙️ SESUAIKAN prefix API
        proxy_pass http://backend:3001;    # ⚙️ SESUAIKAN nama service + port
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /_astro/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location / { try_files $uri $uri/ /index.html; }
}
```

---

## 4. Compose Produksi

Prinsip: **network khusus project, tanpa publish port ke host** — satu-satunya jalur masuk adalah nginx edge (§6).

```yaml
# deploy/docker-compose.prod.yml
name: myapp                              # ⚙️ SESUAIKAN

networks:
  myapp_net:                             # ⚙️ SESUAIKAN nama network
    name: myapp_net

services:
  backend:
    image: ${BACKEND_IMAGE}              # dari /srv/<project>/.env (diisi CI)
    container_name: myapp-backend        # ⚙️ SESUAIKAN — dipakai nginx edge
    restart: unless-stopped
    networks: [myapp_net]
    environment:
      HOST: 0.0.0.0
      PORT: 3001                         # ⚙️ SESUAIKAN
      # Variabel env aplikasimu di sini. JANGAN hardcode secret — pakai ${VAR} dari .env.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 10s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  frontend:
    image: ${FRONTEND_IMAGE}
    container_name: myapp-frontend       # ⚙️ SESUAIKAN
    restart: unless-stopped
    networks: [myapp_net]
    depends_on:
      backend: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1/"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 5s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

> **Kenapa healthcheck backend penting:** `depends_on: condition: service_healthy` membuat frontend tidak start sebelum backend benar-benar siap. Kalau aplikasimu tidak punya endpoint health, buatkan satu — atau ganti cek TCP.

---

## 5. Pipeline GitLab CI/CD

```yaml
# .gitlab-ci.yml
stages: [test, build, deploy]

variables:
  IMAGE_BACKEND: $CI_REGISTRY_IMAGE/backend
  IMAGE_FRONTEND: $CI_REGISTRY_IMAGE/frontend
  COMPOSE_FILE: /srv/<project>/docker-compose.prod.yml   # ⚙️ SESUAIKAN path di VPS deploy

# ---------- TEST (runner build, executor docker) ----------
test:backend:
  stage: test
  tags: [build]                          # ⚙️ SESUAIKAN tag runner build
  image: node:24-alpine
  variables: { npm_config_cache: "$CI_PROJECT_DIR/backend/.npm" }
  cache:
    key: backend-$CI_COMMIT_REF_SLUG
    paths: [backend/.npm/]
  script: cd backend && npm ci && npm run typecheck && npm test

test:frontend:
  stage: test
  tags: [build]
  image: node:24-alpine
  variables: { npm_config_cache: "$CI_PROJECT_DIR/frontend/.npm" }
  cache:
    key: frontend-$CI_COMMIT_REF_SLUG
    paths: [frontend/.npm/]
  script: cd frontend && npm ci && npm run check && npm test

# ---------- BUILD (runner build) ----------
build:images:
  stage: build
  tags: [build]
  image: docker:29-cli
  needs: [test:backend, test:frontend]
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin
    - docker build -t "$IMAGE_BACKEND:$CI_COMMIT_SHORT_SHA" ./backend
    - docker build -t "$IMAGE_FRONTEND:$CI_COMMIT_SHORT_SHA" ./frontend
    - docker push "$IMAGE_BACKEND:$CI_COMMIT_SHORT_SHA"
    - docker push "$IMAGE_FRONTEND:$CI_COMMIT_SHORT_SHA"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

# ---------- DEPLOY (runner di VPS target, executor shell) ----------
deploy:vps1:
  stage: deploy
  tags: [deploy]                         # ⚙️ SESUAIKAN tag runner deploy
  image: docker:29-cli
  needs: [build:images]
  environment:
    name: production
    url: https://app.domain-anda.com     # ⚙️ SESUAIKAN
  script:
    # Sinkronkan compose dari checkout ke host (runner harus punya mount /srv/<project>).
    - cp "$CI_PROJECT_DIR/deploy/docker-compose.prod.yml" /srv/<project>/docker-compose.prod.yml
    - echo "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin
    # Tulis tag image terbaru ke .env — compose membacanya.
    - printf 'BACKEND_IMAGE=%s\nFRONTEND_IMAGE=%s\n' "$IMAGE_BACKEND:$CI_COMMIT_SHORT_SHA" "$IMAGE_FRONTEND:$CI_COMMIT_SHORT_SHA" > /srv/<project>/.env
    - docker compose -f "$COMPOSE_FILE" pull
    - docker compose -f "$COMPOSE_FILE" up -d
    # Reload nginx edge jika vhost berubah (aman, tanpa downtime).
    - docker exec edge_nginx nginx -t && docker exec edge_nginx nginx -s reload || echo "reload skipped"
    - docker image prune -f
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  resource_group: production             # cegah 2 deploy paralel
```

**CI/CD Variables** (`Settings → CI/CD → Variables`): buat variable untuk secret aplikasimu (API key, dll). `$CI_REGISTRY_*` adalah predefined — tidak perlu dibuat.

---

## 6. Runner GitLab di VPS

### 6.1 Runner build (VPS2 / executor docker)

```bash
docker run -d --name gitlab-runner --restart always \
  -v /srv/gitlab-runner/config:/etc/gitlab-runner \
  -v /var/run/docker.sock:/var/run/docker.sock \
  gitlab/gitlab-runner:latest
```

Buat token (glab, ganti `<PROJECT_ID>`):

```bash
glab api --method POST "user/runners" \
  -f "runner_type=project_type" -f "project_id=<PROJECT_ID>" \
  -f "description=build runner" -f "tag_list=build" \
  -f "run_untagged=false" -f "locked=true"
```

Register:

```bash
docker exec gitlab-runner gitlab-runner register \
  --non-interactive --url "https://gitlab.com/" \
  --token "<TOKEN>" --executor "docker" --request-concurrency=2
```

Di `config.toml`, pastikan bagian `[runners.docker]` punya `volumes = ["/var/run/docker.sock:/var/run/docker.sock", "/cache"]` supaya job bisa jalan `docker build`.

### 6.2 Runner deploy (VPS1 / executor shell) — image kustom

Image resmi gitlab-runner **tidak menyertakan docker CLI**. Pasang manual di container akan hilang saat recreate — bake ke image:

```dockerfile
# Dockerfile.runner — sesuaikan GID 987 dengan: stat -c '%g' /var/run/docker.sock
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

Build & jalankan dengan mount direktori deploy project:

```bash
docker build -t gitlab-runner-docker:latest .
docker stop gitlab-runner && docker rm gitlab-runner

docker run -d --name gitlab-runner --restart always \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -v /srv/gitlab-runner/config:/etc/gitlab-runner \
  -v /srv/<project>:/srv/<project> \
  -v /var/run/docker.sock:/var/run/docker.sock \
  gitlab-runner-docker:latest \
  run --user=gitlab-runner --working-directory=/home/gitlab-runner
```

Siapkan direktori deploy:

```bash
sudo mkdir -p /srv/<project>
sudo chown 999:999 /srv/<project>   # uid gitlab-runner di dalam container
```

> ⚠️ **Runner = project runner.** Runner yang terdaftar di project lain **tidak bisa** dipakai project-mu — "Other available project runners" hanya menampilkan instance/group runner. Daftarkan runner baru untuk project-mu (§6.1).

---

## 7. Nginx Edge + Cloudflare + HTTPS

### 7.1 Vhost

Satu file per project di nginx edge (`/srv/edge/conf.d/<project>.conf`):

```nginx
server {
    listen 80;
    server_name app.domain-anda.com;            # ⚙️ SESUAIKAN
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name app.domain-anda.com;            # ⚙️ SESUAIKAN

    ssl_certificate     /etc/nginx/tls/origin.pem;   # dari §7.3
    ssl_certificate_key /etc/nginx/tls/origin.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 2m;   # ⚙️ di atas limit body aplikasimu, agar error JSON dari app, bukan 413 nginx

    location /api/ {                             # ⚙️ SESUAIKAN
        set $upstream http://<project>-backend:3001;   # ⚙️ nama container + port
        proxy_pass $upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        set $upstream http://<project>-frontend:80;    # ⚙️
        proxy_pass $upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Jangkaukan container via nama (butuh satu kali):

```bash
docker network create myapp_net 2>/dev/null || true
docker network connect myapp_net edge_nginx
```

### 7.2 Hubungkan nginx edge ke network project

`edge_nginx` perlu di-attach ke network project (`docker network connect`) supaya bisa resolve nama container. Sekali per project.

### 7.3 Cloudflare Origin Certificate

1. Dashboard → `SSL/TLS → Origin Server → Create Certificate`
2. Hostnames: `*.domain-anda.com` + `domain-anda.com` (wildcard menutup semua subdomain)
3. Validity: pilih sesuai kebijakan; kalau 90 hari, **catat tanggal kadaluarsa** (rotasi §10)
4. Pasang:

```bash
sudo install -m 644 origin-cert.pem /srv/edge/tls/origin.pem
sudo install -m 600 origin-key.pem /srv/edge/tls/origin.key
docker exec edge_nginx nginx -t && docker exec edge_nginx nginx -s reload
```

### 7.4 DNS

`DNS → Add record`:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `app` | **IP publik VPS nginx edge** | Proxied |

A record tidak membawa port — Cloudflare menghubungi origin di 80/443 standar. Pastikan firewall/Security Group mengizinkannya, idealnya hanya dari [IP Cloudflare](https://www.cloudflare.com/ips/) supaya origin tak bisa di-bypass.

### 7.5 SSL/TLS mode

`SSL/TLS → Overview` → **Full**.

> **Full (strict)** hanya bila **semua** vhost di origin sudah listen 443 dengan cert valid. Kalau ada vhost lain yang masih HTTP-only, strict akan mematikan mereka. Naikkan ke strict setelah semua vhost pakai 443.

---

## 8. Verifikasi Akhir

```bash
# 1. Container hidup
docker ps --filter name=<project> --format "{{.Names}}: {{.Status}}"

# 2. HTTPS via origin (di dalam VPS)
curl -sk -o /dev/null -w "%{http_code}\n" \
  --resolve app.domain-anda.com:443:127.0.0.1 https://app.domain-anda.com/

# 3. Publik
curl -s -o /dev/null -w "%{http_code}\n" https://app.domain-anda.com/
```

Pipeline hijau + tiga cek di atas = deploy selesai.

---

## 9. Troubleshooting (semua pernah terjadi nyata)

| Gejala | Penyebab | Solusi |
|---|---|---|
| `can't create /srv/<project>/.env: nonexistent directory` | Direktori deploy tidak di-mount ke job container | Tambah `-v /srv/<project>:/srv/<project>` saat `docker run` runner (recreate) |
| `compose file ... no such file or directory` | Compose belum ada di host | Job deploy harus `cp` dari checkout CI dulu |
| `Permission denied /srv/<project>` | Ownership salah | `chown 999:999 /srv/<project>` (uid gitlab-runner) |
| `docker: command not found` (job deploy) | Image gitlab-runner resmi tanpa docker CLI; instalasi manual hilang saat recreate | Pakai image kustom §6.2 |
| `permission denied ... docker.sock` (di `docker compose`, tapi `docker ps` jalan) | gitlab-runner tidak masuk group socket | Bake `usermod -aG dockerhost` di image + `--group-add` saat run |
| Job deploy stuck `pending` lama | Runner tak ter-attach ke project, atau `resource_group` ditahan pipeline lain | Cek `Settings → Runners`; cancel pipeline lama |
| `waiting_for_resource` | Job lain memegang lock `resource_group` | Tunggu/cancel pipeline penahan |
| `521` dari Cloudflare | Origin tak merespons di port tujuan | Cek container hidup + nginx listen + DNS mengarah ke IP benar |
| `502` via HTTPS | Nginx upstream mati / salah nama container | `docker ps`, cek nama container vs vhost |
| Tag mismatch, job tak pernah dipick | Tag pipeline ≠ tag runner | Samakan |
| `ERR_MODULE_NOT_FOUND` saat build | `npm ci` jalan di root, bukan di folder package | Script job: `cd backend && ...` |

---

## 10. Rotasi Origin Certificate

1. ±2 minggu sebelum kadaluarsa: buat cert baru di Cloudflare (hostname sama).
2. Timpa file di `/srv/edge/tls/`, `nginx -t` → `nginx -s reload`.
3. Verifikasi `curl --resolve` §8.

---

## Checklist Adaptasi per Project

- [ ] Nama project, nama container, nama network (`myapp` → punyamu)
- [ ] Port backend & endpoint health
- [ ] Prefix API di nginx (internal + edge) dan `proxy_pass`
- [ ] Tag runner di `.gitlab-ci.yml` sesuai tag runner yang terdaftar
- [ ] Path `/srv/<project>` konsisten di: compose file variable CI, mount runner, script deploy
- [ ] Domain di vhost, DNS record, dan `environment:url` CI
- [ ] Secret aplikasi → CI/CD Variables (bukan hardcode)
- [ ] Tanggal kadaluarsa Origin Cert dicatat di dokumentasi project
