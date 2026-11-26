# Imagen única para front y backend. Corre como usuario sin privilegios.
FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY demo.ts tsconfig.json ./

# out/ es el único directorio en el que la aplicación escribe.
RUN mkdir -p out && chown -R bun:bun out
USER bun

ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["bun", "src/server.ts"]
