#!/usr/bin/env sh
set -eu

cd /opt/MP-SPDZ

: "${MPSPDZ_PARTY_ID:?MPSPDZ_PARTY_ID is required}"
: "${MPSPDZ_PROGRAM:=merkl_batch_match}"

mkdir -p Player-Data

if [ -n "${MPSPDZ_HOSTS:-}" ]; then
  printf "%b\n" "${MPSPDZ_HOSTS}" > Player-Data/hosts
fi

if [ "${MPSPDZ_INTERACTIVE:-0}" = "1" ]; then
  exec ./replicated-ring-party.x --ip-file-name Player-Data/hosts -I "${MPSPDZ_PARTY_ID}" "${MPSPDZ_PROGRAM}"
fi

exec ./replicated-ring-party.x --ip-file-name Player-Data/hosts "${MPSPDZ_PARTY_ID}" "${MPSPDZ_PROGRAM}"
