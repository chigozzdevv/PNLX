#!/usr/bin/env sh
set -eu

cd /opt/MP-SPDZ

mkdir -p Player-Data
cat > Player-Data/hosts <<'HOSTS'
mpspdz-party-0
mpspdz-party-1
mpspdz-party-2
HOSTS

if [ ! -f Player-Data/P0.pem ]; then
  Scripts/setup-ssl.sh 3 Player-Data
fi

printf "%s\n" "${MPSPDZ_INPUT_P0:-100000000 5100000000000}" > Player-Data/Input-P0-0
printf "%s\n" "${MPSPDZ_INPUT_P1:-75000000 5000000000000}" > Player-Data/Input-P1-0
touch Player-Data/Input-P2-0

echo "MP-SPDZ Player-Data is ready for merkl_batch_match"
