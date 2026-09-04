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
| `shielded-pool` | Escrows collateral (Circle USDC SAC) and tracks margin commitments | [`CBMD5FIWYPLJYKGU657O2G57AMZWVGJQ3RTSIH5P62GM6CYXY7CA3L6H`](https://stellar.expert/explorer/testnet/contract/CBMD5FIWYPLJYKGU657O2G57AMZWVGJQ3RTSIH5P62GM6CYXY7CA3L6H) |
| `batch-settlement` | Validates off-chain matched journals and settles private trades | [`CDHZ54A2RG3IHWVPJYQO6MKBIHGMGSRHS7EP2X66KWMFZ3F6OU5MSCVV`](https://stellar.expert/explorer/testnet/contract/CDHZ54A2RG3IHWVPJYQO6MKBIHGMGSRHS7EP2X66KWMFZ3F6OU5MSCVV) |
| `market` | Configures perpetual market risk profiles and leverage | [`CAS5TXBKI7IR6JXUWWGSLKNBJ225JU4RCVYBF3YL5LPCZM2GDFBWBVNE`](https://stellar.expert/explorer/testnet/contract/CAS5TXBKI7IR6JXUWWGSLKNBJ225JU4RCVYBF3YL5LPCZM2GDFBWBVNE) |
| `price-oracle` | Pulls Pyth price feeds on-chain via the SEP-40 interface | [`CCESWLP4X62QUSMLEUIN5F6LBDR4XV6KXPHLW3BCRSSNNUDMHHEIU7QO`](https://stellar.expert/explorer/testnet/contract/CCESWLP4X62QUSMLEUIN5F6LBDR4XV6KXPHLW3BCRSSNNUDMHHEIU7QO) |
| `funding-settlement` | Manages periodic peer-to-peer funding rate accruals | [`CCMD3YQUSU7EBUVCSENT5VQ4UVL7QBRJCT4FHXCOLU5JAXSOZ7QQV4KN`](https://stellar.expert/explorer/testnet/contract/CCMD3YQUSU7EBUVCSENT5VQ4UVL7QBRJCT4FHXCOLU5JAXSOZ7QQV4KN) |
| `liquidation` | Executes private position liquidations when margins are breached | [`CCZJ4SWOJ5WUZMFUNFEFVTLP2PHFUNLBFSEAHDDYHNKFWDPUIQZFJCBK`](https://stellar.expert/explorer/testnet/contract/CCZJ4SWOJ5WUZMFUNFEFVTLP2PHFUNLBFSEAHDDYHNKFWDPUIQZFJCBK) |
| `position-close` | Processes voluntary close requests and unlocks collateral | [`CALVYQVCP3T7FQG3HS4A4BMQ7QAMGNX2T2MKZBTU5W22ZDNBOINKPAYP`](https://stellar.expert/explorer/testnet/contract/CALVYQVCP3T7FQG3HS4A4BMQ7QAMGNX2T2MKZBTU5W22ZDNBOINKPAYP) |
| `conditional-order` | Registers and triggers private Stop-Loss/Take-Profit targets | [`CCQ7RJOEVGYANHBCUIZHLLN52P43PAG4NMCI22LBX5P56PQ2FKGG2FQB`](https://stellar.expert/explorer/testnet/contract/CCQ7RJOEVGYANHBCUIZHLLN52P43PAG4NMCI22LBX5P56PQ2FKGG2FQB) |
| `disclosure-verifier` | Verifies and logs proof-backed selective disclosure receipts | [`CD4ATKYNSKEICPLPQLURPEBKCMOKSC3XWXZAR5ZA6XF5AKNWC7SLNH5O`](https://stellar.expert/explorer/testnet/contract/CD4ATKYNSKEICPLPQLURPEBKCMOKSC3XWXZAR5ZA6XF5AKNWC7SLNH5O) |
| `position-state` | Stores the active commitments of the shielded pool | [`CBUEACTRQNS23N2O5EOCJKAEQV5EITA5M3WCK3DTHIWEH6W2MT4JSAQI`](https://stellar.expert/explorer/testnet/contract/CBUEACTRQNS23N2O5EOCJKAEQV5EITA5M3WCK3DTHIWEH6W2MT4JSAQI) |
| `proof-ledger` | Registers settled proof digests to prevent double-spending | [`CC27GWF6G5IATCEDFP3SQJHU3UKJ2XGSA2MXN5I4NNBB64Q5SAMW7FDG`](https://stellar.expert/explorer/testnet/contract/CC27GWF6G5IATCEDFP3SQJHU3UKJ2XGSA2MXN5I4NNBB64Q5SAMW7FDG) |
| `governance` | Enforces timelocked multisig controls for upgrades/configs | [`CBQZZU2WLW7DREIMRZGXAGJ4LP7KL2RRYE6VS4RG346MIT4YHIADS52F`](https://stellar.expert/explorer/testnet/contract/CBQZZU2WLW7DREIMRZGXAGJ4LP7KL2RRYE6VS4RG346MIT4YHIADS52F) |
| `intent-registry` | Registers trade intents for off-chain matching and execution | [`CCSK3M5MY4QYVIOIXYU3UCP6VGFWJWZU464IDZRJCDUFNHW47DNBSPEG`](https://stellar.expert/explorer/testnet/contract/CCSK3M5MY4QYVIOIXYU3UCP6VGFWJWZU464IDZRJCDUFNHW47DNBSPEG) |

### 3.2 RISC Zero Verifier Stack

| Component | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| RISC0 router | Routes matcher guest execution proofs | [`CDCZMFWQAXKCTNJN6EGN5RIRAK267EW4PORFI6UNM774EXSEAWDPZOKR`](https://stellar.expert/explorer/testnet/contract/CDCZMFWQAXKCTNJN6EGN5RIRAK267EW4PORFI6UNM774EXSEAWDPZOKR) |
| RISC0 Groth16 verifier | Verifies the math checks of the RISC Zero SNARK proof | [`CDPYA5WBEP2F6DKYQGDZT626CDEXVY2EGCOXZOFNGIDFNTC4C4I3KWQ4`](https://stellar.expert/explorer/testnet/contract/CDPYA5WBEP2F6DKYQGDZT626CDEXVY2EGCOXZOFNGIDFNTC4C4I3KWQ4) |
| RISC0 emergency stop | Allows admin-pausing of the proof pipeline if needed | [`CBX36TWMIQOD6ZDWKTAZKBFQFUR4QKTTQBPLPAYGKZKTY3ABQ5BRTZJ7`](https://stellar.expert/explorer/testnet/contract/CBX36TWMIQOD6ZDWKTAZKBFQFUR4QKTTQBPLPAYGKZKTY3ABQ5BRTZJ7) |

### 3.3 On-Chain ZK Proof Verifiers (Noir + RISC Zero)

| Verifier | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| `batch-match-risc0-verifier` | Verifies the zkVM batch matching execution proof | [`CBWEVGBDFWIM5C6VSA7ECQI3FJGLRSS4SJQSKOC2L47A3K3GCTVM3ZEO`](https://stellar.expert/explorer/testnet/contract/CBWEVGBDFWIM5C6VSA7ECQI3FJGLRSS4SJQSKOC2L47A3K3GCTVM3ZEO) |
| `intent-validity-proof-verifier` | Noir verifier ensuring order sizes and keys are sound | [`CCNFLQVEOWHNB2KLNHFQ4L26PD3HYVAVNQ736OQHJGFJGHRKYORJRF3Z`](https://stellar.expert/explorer/testnet/contract/CCNFLQVEOWHNB2KLNHFQ4L26PD3HYVAVNQ736OQHJGFJGHRKYORJRF3Z) |
| `margin-check-proof-verifier` | Noir verifier checking that margin matches requested size | [`CAWZ3OCWZF74CDBX7CPRPYR4ZRLZ62WJRRIEXECGVP7BEPR64AFLSXCJ`](https://stellar.expert/explorer/testnet/contract/CAWZ3OCWZF74CDBX7CPRPYR4ZRLZ62WJRRIEXECGVP7BEPR64AFLSXCJ) |
| `position-transition-proof-verifier` | Noir verifier checking state transitions on note updates | [`CAEIHMIQDDOP4T6MOGDRJFK43TUULN2Y2KQYIPAU3W4ULMBTRHZGJVNE`](https://stellar.expert/explorer/testnet/contract/CAEIHMIQDDOP4T6MOGDRJFK43TUULN2Y2KQYIPAU3W4ULMBTRHZGJVNE) |
| `position-close-proof-verifier` | Noir verifier checking close parameters on voluntary exit | [`CCR3E4MRTV7WKY2PHAY33GRHCR747LODI7EDX3YIXWQ2J7T6A2OGMXFG`](https://stellar.expert/explorer/testnet/contract/CCR3E4MRTV7WKY2PHAY33GRHCR747LODI7EDX3YIXWQ2J7T6A2OGMXFG) |
| `withdraw-proof-verifier` | Noir verifier checking withdrawal proofs from shielded vault | [`CDFIEEMQOB6ZGHTFQZYMID4AGXLHAGVUOHPWBTPLIINPNTPR663LKSND`](https://stellar.expert/explorer/testnet/contract/CDFIEEMQOB6ZGHTFQZYMID4AGXLHAGVUOHPWBTPLIINPNTPR663LKSND) |
| `conditional-close-proof-verifier` | Noir verifier gating Stop-Loss/Take-Profit triggers | [`CDY6TMYESJ4DDFNQDBEOSJ2SWUAVZ2XQ6S2OLNFJDQIHWJ6JMQLW3UPU`](https://stellar.expert/explorer/testnet/contract/CDY6TMYESJ4DDFNQDBEOSJ2SWUAVZ2XQ6S2OLNFJDQIHWJ6JMQLW3UPU) |
| `deposit-note-proof-verifier` | Noir verifier ensuring valid collateral shielded deposits | [`CAVZZKESODO5AX5ERLWTI6UAWURAT2DDW4CUUPMZDRUWOSK46T4CKX57`](https://stellar.expert/explorer/testnet/contract/CAVZZKESODO5AX5ERLWTI6UAWURAT2DDW4CUUPMZDRUWOSK46T4CKX57) |
| `disclosure-proof-verifier` | Noir verifier gating selective data disclosures | [`CAUZ43GJD5RO7NYYSVUNU2BSFROZXWLG3JV4HLIMSLXDB2G56UX6ZLB7`](https://stellar.expert/explorer/testnet/contract/CAUZ43GJD5RO7NYYSVUNU2BSFROZXWLG3JV4HLIMSLXDB2G56UX6ZLB7) |
| `funding-update-proof-verifier` | Noir verifier validating fee distributions across pool notes | [`CAXMI7XL3VWTGYTG2PGRTNIR3Y5EKJH5MZO36YSL4R4PPB2WNSOIJLZN`](https://stellar.expert/explorer/testnet/contract/CAXMI7XL3VWTGYTG2PGRTNIR3Y5EKJH5MZO36YSL4R4PPB2WNSOIJLZN) |
| `liquidation-check-proof-verifier` | Noir verifier checking position status on liquidations | [`CD7HGTIUJWBOSLEQSEKG3E7M3DO7VV5KGJVKRTWQYO34U3DKAGZLZQIQ`](https://stellar.expert/explorer/testnet/contract/CD7HGTIUJWBOSLEQSEKG3E7M3DO7VV5KGJVKRTWQYO34U3DKAGZLZQIQ) |

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
