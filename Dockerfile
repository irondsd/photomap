FROM oven/bun:1.4.4-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl ffmpeg libheif-examples libimage-exiftool-perl libraw-bin libjemalloc2 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so.2

RUN python3 -m venv /opt/photomap-ml \
    && /opt/photomap-ml/bin/pip install --no-cache-dir --only-binary=:all: opencv-python-headless==5.1.0.95

RUN mkdir -p /opt/photomap-models \
    && cd /opt/photomap-models \
    && curl -fsSL --retry 3 https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx -o yunet.onnx \
    && curl -fsSL --retry 3 https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx -o sface.onnx \
    && printf '%s\n' '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  yunet.onnx' \
                     '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79  sface.onnx' | sha256sum -c - \
    && curl -fsSL --retry 3 https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_detection_yunet/LICENSE -o yunet.LICENSE \
    && curl -fsSL --retry 3 https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_recognition_sface/LICENSE -o sface.LICENSE

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4747 \
    PHOTOMAP_DATA=/app/data \
    PHOTOMAP_FACE_PYTHON=/opt/photomap-ml/bin/python \
    PHOTOMAP_FACE_MODELS=/opt/photomap-models \
    # glibc's malloc keeps what sharp frees on each render thread (~1 GB after a thumbnail burst);
    # jemalloc hands it back, and its background thread does so while the app sits idle.
    LD_PRELOAD=/usr/local/lib/libjemalloc.so.2 \
    MALLOC_CONF=background_thread:true

USER bun
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD bun -e 'const r = await fetch("http://127.0.0.1:4747/api/stats"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "start"]
