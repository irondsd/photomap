FROM oven/bun:1.4.4-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates ffmpeg libheif-examples libimage-exiftool-perl libraw-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4747 \
    PHOTOMAP_DATA=/app/data

USER bun
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD bun -e 'const r = await fetch("http://127.0.0.1:4747/api/stats"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "start"]
