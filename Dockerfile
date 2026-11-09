FROM oven/bun:1.3.9 AS bun
FROM docker.io/stellar/stellar-cli:28.0.0 AS stellar-cli

FROM rust:1-trixie

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    pkg-config \
    libssl-dev \
    libdbus-1-3 \
    libudev1 \
    libsystemd0 \
    libcap2 \
    libzstd1 \
    nodejs \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=stellar-cli /usr/local/bin/stellar /usr/local/bin/stellar

WORKDIR /app

COPY package.json bun.lock ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/market-math/package.json packages/market-math/package.json
COPY packages/proof-system/package.json packages/proof-system/package.json
COPY packages/protocol-types/package.json packages/protocol-types/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/survey/package.json packages/survey/package.json

RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "server/src/server.ts"]
