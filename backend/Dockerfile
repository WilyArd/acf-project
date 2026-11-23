# Backend proxy Fastify — image produksi (stateless, tanpa DB/disk persistence).
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

# server.ts membaca config.HOST; 127.0.0.1 tidak dapat dijangkau dari container lain.
ENV HOST=0.0.0.0
ENV PORT=3001

USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
