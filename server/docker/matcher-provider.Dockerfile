FROM oven/bun:1.3.9

WORKDIR /app

COPY package.json bun.lock ./
COPY client/package.json ./client/package.json
COPY packages ./packages
COPY server ./server

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
ENV MATCHER_PROVIDER_PORT=4103

EXPOSE 4103

CMD ["bun", "server/src/matcher-provider-server.ts"]
