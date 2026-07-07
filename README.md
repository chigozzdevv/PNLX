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
| `shielded-pool` | Escrows collateral (Circle USDC SAC) and tracks margin commitments | [`CCKMN7O4NETE7UTAQU4X23YMR5XMFGJHHL4RMHL3JKWFY5JNCMMDLG73`](https://stellar.expert/explorer/testnet/contract/CCKMN7O4NETE7UTAQU4X23YMR5XMFGJHHL4RMHL3JKWFY5JNCMMDLG73) |
| `batch-settlement` | Validates off-chain matched journals and settles private trades | [`CAJNJFQFGDNXEJXYJSSAQ73F44LRXOS4YACF2PCEIT33GSLBFZSEVK5H`](https://stellar.expert/explorer/testnet/contract/CAJNJFQFGDNXEJXYJSSAQ73F44LRXOS4YACF2PCEIT33GSLBFZSEVK5H) |
| `market` | Configures perpetual market risk profiles and leverage | [`CCXTAD5VND6ANNWKGSYDC77BHNMBYNF7DZJNSELVDZYYCJ5TVLUTM3HO`](https://stellar.expert/explorer/testnet/contract/CCXTAD5VND6ANNWKGSYDC77BHNMBYNF7DZJNSELVDZYYCJ5TVLUTM3HO) |
| `price-oracle` | Pulls Pyth price feeds on-chain via the SEP-40 interface | [`CAMDZVNCICW6VAYZR6VNMJXEKGM3WEGKESYQOXEU5BIGLSLZWPPHBYRZ`](https://stellar.expert/explorer/testnet/contract/CAMDZVNCICW6VAYZR6VNMJXEKGM3WEGKESYQOXEU5BIGLSLZWPPHBYRZ) |
| `funding-settlement` | Manages periodic peer-to-peer funding rate accruals | [`CCHMPJYUI65ELKJSXXUOINRYE2WCYB7C2FLX7GZMZP723JGV6SVTZRCA`](https://stellar.expert/explorer/testnet/contract/CCHMPJYUI65ELKJSXXUOINRYE2WCYB7C2FLX7GZMZP723JGV6SVTZRCA) |
| `liquidation` | Executes private position liquidations when margins are breached | [`CAQ4FW5NYJOFQWHRDOHONUEYFPXOOPQQDUK6AW6DU3LWL5EJJ2CTOJCU`](https://stellar.expert/explorer/testnet/contract/CAQ4FW5NYJOFQWHRDOHONUEYFPXOOPQQDUK6AW6DU3LWL5EJJ2CTOJCU) |
| `position-close` | Processes voluntary close requests and unlocks collateral | [`CCQKRD2VHAEAECPCO4RLF3EUYZ5JDU2BNUJ2PT65FD6THTGFEIWTWUUP`](https://stellar.expert/explorer/testnet/contract/CCQKRD2VHAEAECPCO4RLF3EUYZ5JDU2BNUJ2PT65FD6THTGFEIWTWUUP) |
| `conditional-order` | Registers and triggers private Stop-Loss/Take-Profit targets | [`CBOGL3S4YQW5ZHZJY2W5VWYPGW6BOZY655L3TAP6ZWQGJDVUTBAWQBMC`](https://stellar.expert/explorer/testnet/contract/CBOGL3S4YQW5ZHZJY2W5VWYPGW6BOZY655L3TAP6ZWQGJDVUTBAWQBMC) |
| `disclosure-verifier` | Verifies and logs proof-backed selective disclosure receipts | [`CAJYKNAK6JRB5O7CVR2INOTWERQLJ7T4OROBTARCLHPWQDFXD4W5HFKT`](https://stellar.expert/explorer/testnet/contract/CAJYKNAK6JRB5O7CVR2INOTWERQLJ7T4OROBTARCLHPWQDFXD4W5HFKT) |
| `position-state` | Stores the active commitments of the shielded pool | [`CAR733CQNSMIYNZJP4I5C255WLRA4RO4LMVTLEYZG5CSYGGBVHEGVUXN`](https://stellar.expert/explorer/testnet/contract/CAR733CQNSMIYNZJP4I5C255WLRA4RO4LMVTLEYZG5CSYGGBVHEGVUXN) |
| `proof-ledger` | Registers settled proof digests to prevent double-spending | [`CCMMEPEINZUOAG4GWCXINXOXPIMKIR6I42JPWFHM4OOUSU2AARRZMUD3`](https://stellar.expert/explorer/testnet/contract/CCMMEPEINZUOAG4GWCXINXOXPIMKIR6I42JPWFHM4OOUSU2AARRZMUD3) |
| `governance` | Enforces timelocked multisig controls for upgrades/configs | [`CDS7LCDOSJTCVXWIKUVMSZJASCAWX6CBJ5DM65YJB42P4QK37ACCNYMN`](https://stellar.expert/explorer/testnet/contract/CDS7LCDOSJTCVXWIKUVMSZJASCAWX6CBJ5DM65YJB42P4QK37ACCNYMN) |

### 3.2 RISC Zero Verifier Stack

| Component | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| RISC0 router | Routes matcher guest execution proofs | [`CCGBYZWBLNVS6R6AFUGDDFU46RORQXYJHRVLVQP6TU3TZ7QCRAB2XSH3`](https://stellar.expert/explorer/testnet/contract/CCGBYZWBLNVS6R6AFUGDDFU46RORQXYJHRVLVQP6TU3TZ7QCRAB2XSH3) |
| RISC0 Groth16 verifier | Verifies the math checks of the RISC Zero SNARK proof | [`CACLGO5CSPWBPTE3GA34VCEURVSHVC7EJJ6Y3ECYQ6HV5OXA5Y3QTJFV`](https://stellar.expert/explorer/testnet/contract/CACLGO5CSPWBPTE3GA34VCEURVSHVC7EJJ6Y3ECYQ6HV5OXA5Y3QTJFV) |
| RISC0 emergency stop | Allows admin-pausing of the proof pipeline if needed | [`CA6T5WV2YKV4KAQ6ONMYSYIHULHINF6RI7F7PRRT2FXPOSKUUAKH2MR6`](https://stellar.expert/explorer/testnet/contract/CA6T5WV2YKV4KAQ6ONMYSYIHULHINF6RI7F7PRRT2FXPOSKUUAKH2MR6) |

### 3.3 On-Chain ZK Proof Verifiers (Noir + RISC Zero)

| Verifier | Description | Stellar.expert Address (Link) |
| :--- | :--- | :--- |
| `batch-match-risc0-verifier` | Verifies the zkVM batch matching execution proof | [`CDLJLRKUPULXTPX726TCMOAOXFWUNLVKFXLGIFE5SSRQZIBJDLXZJVHJ`](https://stellar.expert/explorer/testnet/contract/CDLJLRKUPULXTPX726TCMOAOXFWUNLVKFXLGIFE5SSRQZIBJDLXZJVHJ) |
| `intent-validity-proof-verifier` | Noir verifier ensuring order sizes and keys are sound | [`CAM6DPTGVRU5DE3CF4KQW5VCA4GKEYL3I5SQBIMIPPC24D3R422S2EDK`](https://stellar.expert/explorer/testnet/contract/CAM6DPTGVRU5DE3CF4KQW5VCA4GKEYL3I5SQBIMIPPC24D3R422S2EDK) |
| `margin-check-proof-verifier` | Noir verifier checking that margin matches requested size | [`CCFMWZ27H2AMU6G6OBXHJHUIVWOZZOKKLHNOM5YECQELBSGYNPZ4SU47`](https://stellar.expert/explorer/testnet/contract/CCFMWZ27H2AMU6G6OBXHJHUIVWOZZOKKLHNOM5YECQELBSGYNPZ4SU47) |
| `position-transition-proof-verifier` | Noir verifier checking state transitions on note updates | [`CCRUP4DGMECLOGIG34WWOWRFWJ6LIGHTRKWYZX2TDWCHE45WSMALQLME`](https://stellar.expert/explorer/testnet/contract/CCRUP4DGMECLOGIG34WWOWRFWJ6LIGHTRKWYZX2TDWCHE45WSMALQLME) |
| `position-close-proof-verifier` | Noir verifier checking close parameters on voluntary exit | [`CC7AFBOYAATDMZQC6ZN735BBRAVR2KXBXCKIFOBSH5BH6ZNRTMN237BB`](https://stellar.expert/explorer/testnet/contract/CC7AFBOYAATDMZQC6ZN735BBRAVR2KXBXCKIFOBSH5BH6ZNRTMN237BB) |
| `withdraw-proof-verifier` | Noir verifier checking withdrawal proofs from shielded vault | [`CDSZK4WEUOX7TJ7X2DJLXWVHRBL5OOH4LRNU4VUENGR6HYRJY47FV2OG`](https://stellar.expert/explorer/testnet/contract/CDSZK4WEUOX7TJ7X2DJLXWVHRBL5OOH4LRNU4VUENGR6HYRJY47FV2OG) |
| `conditional-close-proof-verifier` | Noir verifier gating Stop-Loss/Take-Profit triggers | [`CC3V4VCVRTX7EYJX42MH2YZUXKRFBNLXNRI4FNJFEGTG67STMU3LNQXL`](https://stellar.expert/explorer/testnet/contract/CC3V4VCVRTX7EYJX42MH2YZUXKRFBNLXNRI4FNJFEGTG67STMU3LNQXL) |
| `deposit-note-proof-verifier` | Noir verifier ensuring valid collateral shielded deposits | [`CBIQACRM6CR3Y6APAN6XIJYPLNZS53CMWPREHZWPOS4TBFAQAF5TSSWM`](https://stellar.expert/explorer/testnet/contract/CBIQACRM6CR3Y6APAN6XIJYPLNZS53CMWPREHZWPOS4TBFAQAF5TSSWM) |
| `disclosure-proof-verifier` | Noir verifier gating selective data disclosures | [`CCWBQ6RQG6PAUQ5BMYUSQVH6H5DEPLKL2ZOQPXV7R6TC6F32O3Z4GFST`](https://stellar.expert/explorer/testnet/contract/CCWBQ6RQG6PAUQ5BMYUSQVH6H5DEPLKL2ZOQPXV7R6TC6F32O3Z4GFST) |
| `funding-update-proof-verifier` | Noir verifier validating fee distributions across pool notes | [`CDB4PEYTJZ3ODMRXZOECSA6DNLI4CJQHYZP4RDLUOEZLIQQFBKECZASP`](https://stellar.expert/explorer/testnet/contract/CDB4PEYTJZ3ODMRXZOECSA6DNLI4CJQHYZP4RDLUOEZLIQQFBKECZASP) |
| `liquidation-check-proof-verifier` | Noir verifier checking position status on liquidations | [`CB6ZJ7UFXITFZ52RAP7K27KZJNTHHQA3SPOHUQ5AMUWSSM2LPFRREIWD`](https://stellar.expert/explorer/testnet/contract/CB6ZJ7UFXITFZ52RAP7K27KZJNTHHQA3SPOHUQ5AMUWSSM2LPFRREIWD) |

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
Start the MongoDB and Redis containers:
```sh
bun run docker:infra
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
