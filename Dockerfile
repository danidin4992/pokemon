FROM node:20-slim

# curl is required for the eBay scraper (TLS fingerprinting bypass).
# python3/make/g++ are needed to compile better-sqlite3 native bindings.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY public/ ./public/

# Railway will mount a persistent volume at /data
ENV DB_PATH=/data/pokemon.db
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 3737
CMD ["node", "src/server.js"]
