# ---- Motor DGII e-CF (RECEPTOR) — imagen de producción ----
# Build multi-stage: compila TS y deja solo dist + deps de producción.
FROM node:20-slim AS build
WORKDIR /app
# libxml2-utils da xmllint (validación XSD en runtime). node-forge/xml-crypto son JS puros.
RUN apt-get update && apt-get install -y --no-install-recommends libxml2-utils && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY schemas ./schemas
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends libxml2-utils && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY schemas ./schemas
# El certificado .p12 NO se copia a la imagen: se inyecta como secreto en runtime
# (variable P12_PATH apuntando a un volumen/secreto, o P12_BASE64 decodificado al arrancar).
# Puerto configurable; por defecto 3000 (el host mapea 443->PORT con su TLS).
ENV PORT=3000
EXPOSE 3000
# Healthcheck contra /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/api.js"]
