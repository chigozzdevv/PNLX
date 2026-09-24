# PNLX (zkVM-Backed Private Perp DEX)

PNLX is a confidential perpetual futures DEX on Stellar. It keeps trader identity, margin, positions, order intents, and liquidation thresholds private by default, while exposing only the public market aggregates necessary for pricing and funding rate calculations.

By utilizing off-chain matching verified by **RISC Zero zkVM** execution proofs, PNLX settles private position updates on-chain via **Soroban**.

---

## 1. What Stays Private vs. What is Public

| 🔒 Private by Default | 🌐 Public on-chain |
| :--- | :--- |
| Trader identity and account state | Active market IDs & index prices |
| Margin balances (shielded notes) | State commitments & spent nullifier hashes |
| Open position size, entry price, & side | Aggregate volume & open-interest deltas |
| Individual order intents | Verification ledger and proof digests |
| Stop-Loss & Take-Profit trigger targets | Funding rates & settlement roots |
| Realized trade PnL | Deployed verifier hashes |

---

## 2. Core Architecture

1. **Private Account & Shielded Pool**: Traders sign in with Freighter-compatible credentials and deposit USDC collateral. Their margin and positions are stored on-chain as encrypted commitments inside a UTXO-based shielded pool.
2. **Private Intent**: The client browser builds a private trade intent (side, size, margin, price constraints) and compiles an UltraHonk proof of intent validity before submitting it to the API.
3. **Off-Chain Matcher**: An off-chain matching engine pairs compatible intents and generates an execution journal. The matcher executes the match inside the **RISC Zero zkVM**, producing a Groth16 execution proof.
4. **Soroban Settlement**: The relayer submits the execution journal and proof on-chain. Soroban contracts verify the RISC Zero proof, update the shielded pool's state, and record spent note nullifiers to prevent double-spending.

---

## 3. Smart Contracts Index (Stellar Testnet)

All smart contracts are deployed and active on Stellar Testnet. Click any address to view it directly in the **Stellar.expert** explorer:

### 3.1 Core Protocol Contracts

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

### 3.2 RISC Zero Verifier Stack

| Component | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| RISC0 router | Routes matcher guest execution proofs | [`CCM3HDMOON2B3LYEVWOF4I6LUQ2OATCENYRGAIQSNYTHU3XYBNXUIJ5E`](https://stellar.expert/explorer/testnet/contract/CCM3HDMOON2B3LYEVWOF4I6LUQ2OATCENYRGAIQSNYTHU3XYBNXUIJ5E) |
| RISC0 Groth16 verifier | Verifies the math checks of the RISC Zero SNARK proof | [`CBNRSCGUJ66DDXDEQ4RJLRT7IYS5WW2JUTNELIM3Y5OLEYSEA4TW3XS6`](https://stellar.expert/explorer/testnet/contract/CBNRSCGUJ66DDXDEQ4RJLRT7IYS5WW2JUTNELIM3Y5OLEYSEA4TW3XS6) |
| RISC0 emergency stop | Allows admin-pausing of the proof pipeline if needed | [`CB5MSV4AN274COHCWCHJU5IT5MT7LIJ65PCVETKNXNHO5ATCPKHIH7XI`](https://stellar.expert/explorer/testnet/contract/CB5MSV4AN274COHCWCHJU5IT5MT7LIJ65PCVETKNXNHO5ATCPKHIH7XI) |

### 3.3 On-Chain ZK Proof Verifiers (Noir + RISC Zero)

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

---

## 4. Supported Markets

| Market | Asset | Max Leverage | Initial Margin | Maintenance Margin |
| :--- | :---: | :---: | :---: | :---: |
| `btc-usd-perp` | `BTC` | `10x` | `10%` | `5%` |
| `eth-usd-perp` | `ETH` | `10x` | `10%` | `5%` |
| `xlm-usd-perp` | `XLM` | `10x` | `10%` | `5%` |
| `sol-usd-perp` | `SOL` | `5x` | `20%` | `10%` |
| `xrp-usd-perp` | `XRP` | `5x` | `20%` | `10%` |

---

## 5. Local Setup & Running

Ensure you have the following prerequisites installed:
* **Bun** ($\ge$ v1.1.0)
* **Rust & Cargo** (for contract builds)
* **Stellar CLI** ($\ge$ v27.0.0)
* **Nargo & Barretenberg** (Noir compiler and proving system)
* **Docker** (for database running)

### 5.1 Run Local Infrastructure
You can choose to spin up only the databases (running the services locally in separate tabs) or the entire project stack:

**Option A: Start databases only (recommended for local development & debugging):**
```sh
bun run docker:infra
```

**Option B: Start the entire stack (databases, server, matcher, prover, and client):**
```sh
bun run docker:up
```

### 5.2 Build Circuits & Smart Contracts
Compile the Noir circuits and build the Soroban contracts:
```sh
bun run prove:circuits
bun run build:contracts
```

### 5.3 Run Services
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

---

## 6. Testing & Verification

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
