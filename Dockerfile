# LeafLens — single-container image
FROM node:20-bookworm-slim

# build tools for better-sqlite3 (falls back to compile if no prebuilt binary)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# data (sqlite + uploaded PDFs) lives here — mount a volume over it
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8080
CMD ["node", "server.js"]
