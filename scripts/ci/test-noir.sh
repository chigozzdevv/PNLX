#!/usr/bin/env bash

set -euo pipefail

shopt -s nullglob
manifests=(circuits/*/Nargo.toml)

if ((${#manifests[@]} == 0)); then
  echo "No Noir circuit manifests found under circuits/." >&2
  exit 1
fi

for manifest in "${manifests[@]}"; do
  circuit_dir="${manifest%/Nargo.toml}"
  echo "::group::Noir tests: ${circuit_dir}"
  (
    cd "$circuit_dir"
    nargo compile
    nargo test
  )
  echo "::endgroup::"
done
