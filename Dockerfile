# Stage 1: Meta's MMS text-to-speech voices (Swahili and English) exported to ONNX once, at build time.
FROM python:3.13-slim AS voices
WORKDIR /build
COPY scripts/tts/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY scripts/tts/export-mms-tts.py ./
RUN python export-mms-tts.py /voices swh,eng && rm -rf /root/.cache

# Stage 2: the MoranBuy API and workers; Debian slim because the ONNX runtime needs glibc.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev --no-audit --no-fund \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 node_modules/onnxruntime-node/bin/napi-v*/linux/arm64 \
  && find node_modules/onnxruntime-node -name '*providers_cuda*' -o -name '*providers_tensorrt*' | xargs -r rm -f
COPY apps ./apps
COPY database ./database
COPY scripts ./scripts
COPY --from=voices /voices ./models/tts
ENV NODE_ENV=production TTS_MODEL_DIR=/app/models/tts
EXPOSE 4000
CMD ["node", "services/api/src/server.js"]
