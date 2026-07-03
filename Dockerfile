FROM rust:1-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    pkg-config \
    libssl-dev \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /app

COPY package.json bun.lock ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/market-math/package.json packages/market-math/package.json
COPY packages/proof-system/package.json packages/proof-system/package.json
COPY packages/protocol-types/package.json packages/protocol-types/package.json
COPY packages/sdk/package.json packages/sdk/package.json

RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "server/src/server.ts"]
