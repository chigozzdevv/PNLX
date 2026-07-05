const cwd = __dirname;

module.exports = {
  apps: [
    {
      args: "server/src/server.ts",
      cwd,
      env: {
        NODE_ENV: "production",
        PORT: "4000",
      },
      interpreter: "none",
      name: "pnlx-api",
      script: "bun",
    },
    {
      args: "server/src/matcher-server.ts",
      cwd,
      env: {
        MATCHER_PORT: "4102",
        NODE_ENV: "production",
      },
      interpreter: "none",
      name: "pnlx-matcher",
      script: "bun",
    },
    {
      args: "scripts/prover/local-client-prover.ts",
      cwd,
      env: {
        NODE_ENV: "production",
        PNLX_CLIENT_PROVER_HOST: "127.0.0.1",
        PNLX_CLIENT_PROVER_PORT: "4101",
      },
      interpreter: "none",
      name: "pnlx-prover",
      script: "bun",
    },
    {
      args: "run --filter @pnlx/client start --hostname 0.0.0.0",
      cwd,
      env: {
        NEXT_PUBLIC_PNLX_PROVER_URL: "/api/prover",
        NODE_ENV: "production",
        PNLX_API_URL: "http://127.0.0.1:4000",
        PNLX_PROVER_URL: "http://127.0.0.1:4101",
        PORT: "3000",
      },
      interpreter: "none",
      name: "pnlx-client",
      script: "bun",
    },
    {
      args: "tunnel --url http://127.0.0.1:3000",
      cwd,
      interpreter: "none",
      name: "pnlx-tunnel",
      script: "cloudflared",
    },
  ],
};
