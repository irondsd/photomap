FROM oven/bun:1.4.4-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates ffmpeg libheif-examples libimage-exiftool-perl libraw-bin libjemalloc2 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so.2

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4747 \
    PHOTOMAP_DATA=/app/data \
    # glibc's malloc keeps what sharp frees on each render thread (~1 GB after a thumbnail burst);
    # jemalloc hands it back, and its background thread does so while the app sits idle.
    LD_PRELOAD=/usr/local/lib/libjemalloc.so.2 \
    MALLOC_CONF=background_thread:true

USER bun
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD bun -e 'const r = await fetch("http://127.0.0.1:4747/api/stats"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "start"]
