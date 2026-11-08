# syntax=docker/dockerfile:1
FROM nvidia/cuda:12.6.3-devel-ubuntu24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl git libssl-dev pkg-config ca-certificates protobuf-compiler \
      cmake clang libclang-dev \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/root/.risc0/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal

# rzup provides the prebuilt Groth16 prover library linked by risc0-groth16-sys.
RUN curl -L https://risczero.com/install | bash && /root/.risc0/bin/rzup install risc0-groth16 --version 0.1.0

WORKDIR /workspace
COPY risc0/batch-match/Cargo.lock risc0/batch-match/Cargo.lock
COPY risc0/batch-match/Cargo.toml risc0/batch-match/Cargo.toml
COPY risc0/batch-match/host /workspace/risc0/batch-match/host
COPY risc0/batch-match/core /workspace/risc0/batch-match/core
COPY risc0/batch-match/methods /workspace/risc0/batch-match/methods
COPY risc0/batch-match/image-id.json risc0/batch-match/image-id.json

RUN mkdir -p risc0/batch-match/target/riscv-guest/pnlx-risc0-methods/guest/riscv32im-risc0-zkvm-elf/docker
COPY risc0/batch-match/target/riscv-guest/pnlx-risc0-methods/guest/riscv32im-risc0-zkvm-elf/docker/batch_match.bin \
     risc0/batch-match/target/riscv-guest/pnlx-risc0-methods/guest/riscv32im-risc0-zkvm-elf/docker/batch_match.bin

ENV RISC0_SKIP_BUILD=1 \
    CUDA_HOME=/usr/local/cuda \
    LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH \
    CARGO_BUILD_JOBS=2 \
    NVCC_APPEND_FLAGS="-gencode arch=compute_80,code=sm_80 -gencode arch=compute_80,code=compute_80" \
    PATH=/usr/local/cuda/bin:$PATH
RUN cargo build --release --locked \
      --manifest-path risc0/batch-match/host/Cargo.toml \
      --features risc0-zkvm/cuda

FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages runpod

COPY --from=builder /root/.risc0 /root/.risc0
COPY --from=builder /workspace/risc0/batch-match/target/release/pnlx-risc0-batch-match-prover \
     /usr/local/bin/pnlx-risc0-batch-match-prover
COPY --from=builder /workspace/risc0/batch-match/target/riscv-guest/pnlx-risc0-methods/guest/riscv32im-risc0-zkvm-elf/docker/batch_match.bin \
     /risc0/batch-match.bin
COPY workloads/runpod/handler.py /app/handler.py

ENV PATH=/root/.risc0/bin:$PATH \
    RISC0_PROVER=local \
    RISC0_DEV_MODE=0 \
    RISC0_BATCH_MATCH_PROGRAM_PATH=/risc0/batch-match.bin
WORKDIR /app
CMD ["python3", "/app/handler.py"]
