#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "==> Installing build dependencies (sudo required)"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential curl git libssl-dev pkg-config ca-certificates \
  protobuf-compiler cmake clang libclang-dev

if ! command -v cargo >/dev/null 2>&1; then
  echo "==> Installing Rust toolchain"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  source "$HOME/.cargo/env"
fi

echo "==> Building the batch-match prover (x86 native, CPU path)"
CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2} \
  cargo build --release --locked --manifest-path risc0/batch-match/host/Cargo.toml

echo "==> Pre-pulling the CPU Groth16 prover image (multi-GB, one-time)"
docker pull risczero/risc0-groth16-prover:v2025-04-03.1

echo "==> Verifying the build"
./risc0/batch-match/target/release/pnlx-risc0-batch-match-prover --print-image-id

echo "Setup complete. Receipt wrapping command used by the server:"
echo "  risc0/batch-match/target/release/pnlx-risc0-batch-match-prover --wrap <receipt.json> <output-dir>"
