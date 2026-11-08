# PNLX (zkVM-Backed Private Perp DEX)

PNLX is a perpetual futures DEX on Stellar Testnet. It uses commitment-based account state, off-chain matching verified by RISC Zero zkVM, and Soroban settlement.

## 1. Core Architecture

1. **Accounts**: Traders connect a Freighter-compatible wallet and deposit USDC collateral.
2. **Orders**: Noir proofs validate trade intents.
3. **Matching**: An off-chain matcher pairs compatible orders, with execution verified by RISC Zero proofs.
4. **Settlement**: Soroban contracts verify proofs and apply position updates.

---

## 2. Smart Contracts Index (Stellar Testnet)

Testnet contract addresses link to their **Stellar.expert** records:

### 2.1 Core Protocol Contracts

| Contract | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| `shielded-pool` | Escrows collateral (Circle USDC SAC) and tracks margin commitments | [`CDFJLSX2UNAERPDINKMXRXSCELMXUM4MWAPDTOW3JG4RKWTKYUUFOP6B`](https://stellar.expert/explorer/testnet/contract/CDFJLSX2UNAERPDINKMXRXSCELMXUM4MWAPDTOW3JG4RKWTKYUUFOP6B) |
| `batch-settlement` | Validates off-chain matched journals and settles private trades | [`CACY35ZQYLWTEFNAZVP2MLDBT3JMT2JVLGEI4VXMSSST57ZV2CUTDUNQ`](https://stellar.expert/explorer/testnet/contract/CACY35ZQYLWTEFNAZVP2MLDBT3JMT2JVLGEI4VXMSSST57ZV2CUTDUNQ) |
| `market` | Configures perpetual market risk profiles and leverage | [`CAOTELFQMJ5OP6DZQ443AARPK2JLNM57FQ6VIE3LNVCSGXD5J77DUILL`](https://stellar.expert/explorer/testnet/contract/CAOTELFQMJ5OP6DZQ443AARPK2JLNM57FQ6VIE3LNVCSGXD5J77DUILL) |
| `price-oracle` | Pulls Pyth price feeds on-chain via the SEP-40 interface | [`CB6DM7LRVYZKY3272PKGE6JWGTCV3NB66YZ65AFPIDKKHNCREEREPOGW`](https://stellar.expert/explorer/testnet/contract/CB6DM7LRVYZKY3272PKGE6JWGTCV3NB66YZ65AFPIDKKHNCREEREPOGW) |
| `funding-settlement` | Manages periodic peer-to-peer funding rate accruals | [`CDQBNCKMO6BPADFBG73N34ETBDMEAAU6T2UTKF5TPLONWY3AK6QPLFMB`](https://stellar.expert/explorer/testnet/contract/CDQBNCKMO6BPADFBG73N34ETBDMEAAU6T2UTKF5TPLONWY3AK6QPLFMB) |
| `liquidation` | Executes private position liquidations when margins are breached | [`CCNATX32NICKSGUKM3MDEUJ7IYEZMZM3QAJEJPQ3WG4PAALRVNU3HJR4`](https://stellar.expert/explorer/testnet/contract/CCNATX32NICKSGUKM3MDEUJ7IYEZMZM3QAJEJPQ3WG4PAALRVNU3HJR4) |
| `position-close` | Processes voluntary close requests and unlocks collateral | [`CDTPAULZ2IC3427X3WGU5OAFK277HWEQ3EAL6MUDTT4QY4ZART7GTG4N`](https://stellar.expert/explorer/testnet/contract/CDTPAULZ2IC3427X3WGU5OAFK277HWEQ3EAL6MUDTT4QY4ZART7GTG4N) |
| `conditional-order` | Registers and triggers private Stop-Loss/Take-Profit targets | [`CCRHLAZURWACGPCE6JX2FCZ6JYJVFVU5OOFYTHSYER5OY2ND6N2LIEQY`](https://stellar.expert/explorer/testnet/contract/CCRHLAZURWACGPCE6JX2FCZ6JYJVFVU5OOFYTHSYER5OY2ND6N2LIEQY) |
| `disclosure-verifier` | Verifies and logs proof-backed selective disclosure receipts | [`CCWQJBFQWV63ZQMSDTQJ6NWZX4VITZNYJLSQI5AYREC7GYG3EHCCR4HZ`](https://stellar.expert/explorer/testnet/contract/CCWQJBFQWV63ZQMSDTQJ6NWZX4VITZNYJLSQI5AYREC7GYG3EHCCR4HZ) |
| `position-state` | Stores the active commitments of the shielded pool | [`CAGEDZBJ26WZISHMXKDFWMCW55CDIV3YHD6X7HPDVCKONLLGRDGZPAYW`](https://stellar.expert/explorer/testnet/contract/CAGEDZBJ26WZISHMXKDFWMCW55CDIV3YHD6X7HPDVCKONLLGRDGZPAYW) |
| `proof-ledger` | Registers settled proof digests to prevent double-spending | [`CAMYT425B3UZVDGXVJATUU35QQKXKXNOBZU4SHRMCMSJHYCJATCWZFDK`](https://stellar.expert/explorer/testnet/contract/CAMYT425B3UZVDGXVJATUU35QQKXKXNOBZU4SHRMCMSJHYCJATCWZFDK) |
| `governance` | Enforces timelocked multisig controls for upgrades/configs | [`CBDBUPESYVEB5YIBMFK5TJOW54RHMUYNL7C47TLM6DHTUCEKJGK57UBK`](https://stellar.expert/explorer/testnet/contract/CBDBUPESYVEB5YIBMFK5TJOW54RHMUYNL7C47TLM6DHTUCEKJGK57UBK) |
| `intent-registry` | Registers trade intents for off-chain matching and execution | [`CAAD5DA5XMJEMOHUGXDAGFGZPZY35ZM3QJ6DT43XM625BJWEH3ONQOWY`](https://stellar.expert/explorer/testnet/contract/CAAD5DA5XMJEMOHUGXDAGFGZPZY35ZM3QJ6DT43XM625BJWEH3ONQOWY) |
| `rewards-escrow` | Escrows trading rewards — fee rebates, referral shares and credit drops, funded from treasury fees | [`CBKR3AEFDHPXHXXZKGVZGCT7XP3CLNHMUN6CIGB4QJ32DRD34GTGVFK2`](https://stellar.expert/explorer/testnet/contract/CBKR3AEFDHPXHXXZKGVZGCT7XP3CLNHMUN6CIGB4QJ32DRD34GTGVFK2) |
| `liquidity-vault` | Maker liquidity vault: vault series principals, maker allocations and settlement controls | [`CAU23XCVR5EMOMCMAZ3CIKJAHS7QREUUX7QX5B5QECUPZ2NQMKOLAT2M`](https://stellar.expert/explorer/testnet/contract/CAU23XCVR5EMOMCMAZ3CIKJAHS7QREUUX7QX5B5QECUPZ2NQMKOLAT2M) |
| `legacy-pair-exit` | Migration exit path for pre-secure-pool paired positions (deployed as the helper instance) | [`CCSSI66X6HBQ7DC7EC2CBKYAERVLJYWTO5WV6V2EDNLZZ43XMZUEYAGJ`](https://stellar.expert/explorer/testnet/contract/CCSSI66X6HBQ7DC7EC2CBKYAERVLJYWTO5WV6V2EDNLZZ43XMZUEYAGJ) |

### 2.2 RISC Zero Verifier Stack

| Component | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| RISC0 router | Routes matcher guest execution proofs | [`CCM3HDMOON2B3LYEVWOF4I6LUQ2OATCENYRGAIQSNYTHU3XYBNXUIJ5E`](https://stellar.expert/explorer/testnet/contract/CCM3HDMOON2B3LYEVWOF4I6LUQ2OATCENYRGAIQSNYTHU3XYBNXUIJ5E) |
| RISC0 Groth16 verifier | Verifies the math checks of the RISC Zero SNARK proof | [`CBNRSCGUJ66DDXDEQ4RJLRT7IYS5WW2JUTNELIM3Y5OLEYSEA4TW3XS6`](https://stellar.expert/explorer/testnet/contract/CBNRSCGUJ66DDXDEQ4RJLRT7IYS5WW2JUTNELIM3Y5OLEYSEA4TW3XS6) |
| RISC0 emergency stop | Allows admin-pausing of the proof pipeline if needed | [`CB5MSV4AN274COHCWCHJU5IT5MT7LIJ65PCVETKNXNHO5ATCPKHIH7XI`](https://stellar.expert/explorer/testnet/contract/CB5MSV4AN274COHCWCHJU5IT5MT7LIJ65PCVETKNXNHO5ATCPKHIH7XI) |

### 2.3 On-Chain ZK Proof Verifiers (Noir + RISC Zero)

| Verifier | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| `batch-match-risc0-verifier` | Verifies the zkVM batch matching execution proof | [`CBYI35OAPFJK6H5WFLAZ36VC5KIZ6KZMCU6HMZJLJRPOJ3XKNTEDDFR7`](https://stellar.expert/explorer/testnet/contract/CBYI35OAPFJK6H5WFLAZ36VC5KIZ6KZMCU6HMZJLJRPOJ3XKNTEDDFR7) |
| `intent-validity-proof-verifier` | Noir verifier ensuring order sizes and keys are sound | [`CDQGSJJAGJG5NVPSVPVZGUG7BQ2H2SJYMVRZIZE6ZQKG6WHUK4AXPCEO`](https://stellar.expert/explorer/testnet/contract/CDQGSJJAGJG5NVPSVPVZGUG7BQ2H2SJYMVRZIZE6ZQKG6WHUK4AXPCEO) |
| `margin-check-proof-verifier` | Noir verifier checking that margin matches requested size | [`CAFW3VNK4WI7UPCG6WZEGWANMSDPYI4DCC466YNH2WFMCVL34DIL4YOH`](https://stellar.expert/explorer/testnet/contract/CAFW3VNK4WI7UPCG6WZEGWANMSDPYI4DCC466YNH2WFMCVL34DIL4YOH) |
| `position-transition-proof-verifier` | Noir verifier checking state transitions on note updates | [`CAWI6RUOQIVPQCZA3JZEJWM5MPTPKG6JPSFUAV3G6EYDMSWOOYREE5LX`](https://stellar.expert/explorer/testnet/contract/CAWI6RUOQIVPQCZA3JZEJWM5MPTPKG6JPSFUAV3G6EYDMSWOOYREE5LX) |
| `position-close-proof-verifier` | Noir verifier checking close parameters on voluntary exit | [`CDN3W3CCYB3COGWR5BNHMTDUOFGL2QBVHR6KS7XCZITYVBEMQYZADRNI`](https://stellar.expert/explorer/testnet/contract/CDN3W3CCYB3COGWR5BNHMTDUOFGL2QBVHR6KS7XCZITYVBEMQYZADRNI) |
| `withdraw-proof-verifier` | Noir verifier checking withdrawal proofs from shielded vault | [`CDPKC22GX74JE5I2FYXPA2KVKJ4XKZNMICUXG4UG7J3CDY2IBZYEMX35`](https://stellar.expert/explorer/testnet/contract/CDPKC22GX74JE5I2FYXPA2KVKJ4XKZNMICUXG4UG7J3CDY2IBZYEMX35) |
| `conditional-close-proof-verifier` | Noir verifier gating Stop-Loss/Take-Profit triggers | [`CDJIBSMUZULF6Q4QJD6IPKTFHBVZ5TRZWCUIWQOFOKBDM54563XWZDPV`](https://stellar.expert/explorer/testnet/contract/CDJIBSMUZULF6Q4QJD6IPKTFHBVZ5TRZWCUIWQOFOKBDM54563XWZDPV) |
| `deposit-note-proof-verifier` | Noir verifier ensuring valid collateral shielded deposits | [`CA6WO4BMTY7AZYVT6N4J7FABHUCMDBFVOQCDNVZKNQJK42ZEPN6THKSH`](https://stellar.expert/explorer/testnet/contract/CA6WO4BMTY7AZYVT6N4J7FABHUCMDBFVOQCDNVZKNQJK42ZEPN6THKSH) |
| `disclosure-proof-verifier` | Noir verifier gating selective data disclosures | [`CCLRH5JFLZVNYDDZR4TGYGTSJT3V36YFLWOMAIYS3VXDVM6NISV6UMEK`](https://stellar.expert/explorer/testnet/contract/CCLRH5JFLZVNYDDZR4TGYGTSJT3V36YFLWOMAIYS3VXDVM6NISV6UMEK) |
| `funding-update-proof-verifier` | Noir verifier validating fee distributions across pool notes | [`CA7ER7J3TMYYTGGVB4667AJMFGI2TDT3DOOOW6RKNXPN6JZTQX6ZZPLG`](https://stellar.expert/explorer/testnet/contract/CA7ER7J3TMYYTGGVB4667AJMFGI2TDT3DOOOW6RKNXPN6JZTQX6ZZPLG) |
| `liquidation-check-proof-verifier` | Noir verifier checking position status on liquidations | [`CACARSSG3I5J553TSN2PMNF6AQJTF5GVZCYIEBTIVZ54TQZUEZLWSDGB`](https://stellar.expert/explorer/testnet/contract/CACARSSG3I5J553TSN2PMNF6AQJTF5GVZCYIEBTIVZ54TQZUEZLWSDGB) |
| `secure-deposit-note-proof-verifier` | Noir verifier for the current-generation shielded deposit notes | [`CBUGPTG67S5DUV4G4FGXVZ2TFTICDX6MLDFWF3TNU35EMOYO47MVHNUD`](https://stellar.expert/explorer/testnet/contract/CBUGPTG67S5DUV4G4FGXVZ2TFTICDX6MLDFWF3TNU35EMOYO47MVHNUD) |
| `secure-withdraw-proof-verifier` | Noir verifier for secure-note withdrawals | [`CCKF6LEUQMKMYK5KRGDG6STSYWRIX7BN4DHBTN4XKIPTPIPZAOIM5EGX`](https://stellar.expert/explorer/testnet/contract/CCKF6LEUQMKMYK5KRGDG6STSYWRIX7BN4DHBTN4XKIPTPIPZAOIM5EGX) |
| `position-close-pair-proof-verifier` | Noir verifier for paired position closes | [`CBGYFRLMXBNLYLV52OELKZGY3ORHH4Y3CC5KKEZLZ52MS6W6VBLMM54H`](https://stellar.expert/explorer/testnet/contract/CBGYFRLMXBNLYLV52OELKZGY3ORHH4Y3CC5KKEZLZ52MS6W6VBLMM54H) |
| `legacy-position-close-pair-proof-verifier` | Noir verifier for legacy paired position closes (deployed as the verifier instance) | [`CDQ26APYCECVS4NHT5KBNG6BC2KVBWMNHQIEITGF7RJDOMPHO7F4IDIU`](https://stellar.expert/explorer/testnet/contract/CDQ26APYCECVS4NHT5KBNG6BC2KVBWMNHQIEITGF7RJDOMPHO7F4IDIU) |

---

## 3. Supported Market

| Market | Market ID | Max Leverage | Initial Margin | Maintenance Margin |
| :--- | :---: | :---: | :---: | :---: |
| **XLM/USD** | `xlm-usd-perp` | `10x` | `10%` | `5%` |

---

## 4. Local Setup & Running

Ensure you have the following prerequisites installed:

* **Bun** ($\ge$ v1.1.0)
* **Rust & Cargo** (for contract builds)
* **Stellar CLI** ($\ge$ v27.0.0)
* **Nargo & Barretenberg** (Noir compiler and proving system)
* **Docker** (for database running)

### 4.1 Run Local Infrastructure
You can choose to spin up only the databases (running the services locally in separate tabs) or the entire project stack:

**Option A: Start databases only (recommended for local development & debugging):**
```sh
bun run docker:infra
```

**Option B: Start the entire stack (databases, server, matcher, prover, and client):**
```sh
bun run docker:up
```

### 4.2 Build Circuits & Smart Contracts
Compile the Noir circuits and build the Soroban contracts:
```sh
bun run prove:circuits
bun run build:contracts
```

### 4.3 Run Services
In separate terminal tabs, launch the API server, matcher engine, prover worker, and Next.js frontend client:
```sh
# Start the API server
bun run --filter @pnlx/server start

# Start the off-chain Matcher engine
bun run matcher:server

# Start the client-side Prover daemon
bun run prover:client

# Start the client frontend (Next.js)
bun run client:dev
```

### 4.4 Hosted Domains

For a release on `pnlx.trade`, set `NEXT_PUBLIC_PNLX_API_URL=https://api.pnlx.trade` before building the frontend. Keep the API's existing domain working during migration and allow both frontend domains:

```sh
PNLX_WEB_ORIGINS=https://pnlx.trade,https://www.pnlx.trade,https://www.pnl.family,https://pnl.family
```

Keep `NEXT_PUBLIC_PNLX_PROVER_URL=/api/prover` and the existing server-side `PNLX_PROVER_URL` upstream; a hosted Vercel frontend requires its reachable HTTPS upstream. Keep the old frontend accessible until users reconnect the same wallet on the new domain and verify their private balance and position details recover. Browser storage is separate for each origin; the backend network and storage scope stay unchanged.

### 4.5 RunPod Proof Worker

Batch proofs run on a RunPod Serverless GPU endpoint using `ghcr.io/chigozzdevv/pnlx-runpod-worker`. The `Publish RunPod worker` workflow builds the pinned guest and publishes `latest` and commit-specific image tags to GHCR when worker sources change on `main`.

Keep the GHCR package private. For its first publish, add a repository secret named `GHCR_BOOTSTRAP_TOKEN` using a GitHub classic token scoped only to `write:packages`. After the package exists, grant this repository Actions `Write` access to the package, remove the bootstrap secret, and revoke that token. Subsequent workflow publishes use `GITHUB_TOKEN`. Add a separate classic token with only `read:packages` to RunPod's container registry credentials.

Create the endpoint with: RTX 4090 (Secure Cloud), FlashBoot on, workers min 0 / max 2, 1800 s execution timeout, and `PNLX_WORKER_AUTH_TOKEN` in the endpoint environment. Then set in `.env`:

```sh
PNLX_PROVER_BACKEND=runpod
RUNPOD_API_KEY=
RUNPOD_ENDPOINT_ID=
PNLX_WORKER_AUTH_TOKEN=
```

`PNLX_PROVER_BACKEND=local` proves on this machine instead (development only). Smoke-test the endpoint with a fixture:

```sh
INPUT_B64=$(base64 < risc0/batch-match/core/tests/fixtures/partial-match.json)
curl -s -X POST "https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/runsync" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H "Content-Type: application/json" \
  -d "{\"input\":{\"input_json_b64\":\"$INPUT_B64\",\"auth\":\"$PNLX_WORKER_AUTH_TOKEN\"}}"
```

---

## 5. Testing & Verification

Run the entire E2E and unit test suites:
```sh
# Run all unit/package tests
bun test

# Run E2E integration test suite
bun run test:e2e

# Run Rust contract tests
cargo test --manifest-path contracts/Cargo.toml

# Run individual circuit tests (Noir)
cd circuits/intent-validity && nargo test
```
