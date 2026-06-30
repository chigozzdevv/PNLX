FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG MPSPDZ_REF=master

RUN apt-get update && apt-get install -y --no-install-recommends \
    automake \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    git \
    libboost-dev \
    libboost-filesystem-dev \
    libboost-iostreams-dev \
    libboost-thread-dev \
    libgmp-dev \
    libntl-dev \
    libsodium-dev \
    libssl-dev \
    libtool \
    openssl \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${MPSPDZ_REF}" https://github.com/data61/MP-SPDZ.git /opt/MP-SPDZ

WORKDIR /opt/MP-SPDZ

RUN make setup
RUN make -j"$(nproc)" replicated-ring-party.x

COPY server/mpspdz/merkl_batch_match.mpc /opt/MP-SPDZ/Programs/Source/merkl_batch_match.mpc
RUN python3 ./compile.py -R 64 merkl_batch_match

COPY server/docker/mpspdz-party-entrypoint.sh /usr/local/bin/mpspdz-party-entrypoint
COPY server/docker/mpspdz-setup.sh /usr/local/bin/mpspdz-setup
RUN chmod +x /usr/local/bin/mpspdz-party-entrypoint /usr/local/bin/mpspdz-setup

ENTRYPOINT ["mpspdz-party-entrypoint"]
