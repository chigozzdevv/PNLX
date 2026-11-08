#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "==> Installing build dependencies (sudo required)"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential curl git libssl-dev pkg-config ca-certificates \
  protobuf-compiler cmake clang libclang-dev python3

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI is required for the CPU Groth16 wrapper" >&2
  exit 1
fi

if docker info >/dev/null 2>&1; then
  docker_command=(docker)
elif sudo docker info >/dev/null 2>&1; then
  docker_command=(sudo docker)
else
  echo "Docker daemon is unavailable" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "==> Installing Rust toolchain"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  source "$HOME/.cargo/env"
fi

echo "==> Building the batch-match prover (x86 native, CPU path)"
CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2} \
  cargo build --release --locked --manifest-path risc0/batch-match/host/Cargo.toml

echo "==> Pre-pulling the CPU Groth16 prover image (multi-GB, one-time)"
"${docker_command[@]}" pull risczero/risc0-groth16-prover:v2025-04-03.1

echo "==> Verifying the build"
expected_image_id=$(python3 -c 'import json; print(json.load(open("risc0/batch-match/image-id.json"))["imageId"])')
actual_image_id=$(PNLX_EXPECTED_BATCH_MATCH_IMAGE_ID="$expected_image_id" \
  ./risc0/batch-match/target/release/pnlx-risc0-batch-match-prover --print-image-id)
if [[ "${actual_image_id,,}" != "${expected_image_id,,}" ]]; then
  echo "CPU prover image id does not match risc0/batch-match/image-id.json" >&2
  exit 1
fi

echo "==> Installing the CPU wrap service"
sudo install -m 0644 workloads/systemd/pnlx-risc0-wrap.service /etc/systemd/system/pnlx-risc0-wrap.service
sudo systemctl daemon-reload
sudo systemctl enable pnlx-risc0-wrap.service
sudo systemctl restart pnlx-risc0-wrap.service
sudo systemctl is-active --quiet pnlx-risc0-wrap.service
if [[ ! -S /run/pnlx-risc0-wrap/prover.sock ]]; then
  echo "CPU wrap service did not create its Unix socket" >&2
  exit 1
fi

echo "CPU wrap service is ready at /run/pnlx-risc0-wrap/prover.sock"
