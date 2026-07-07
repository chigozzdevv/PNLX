# PNLX Overview

PNLX is a confidential perpetual futures DEX on Stellar. Traders can go long or
short on any supported pair with private margin notes, private intents, and batch
settlement backed by RISC Zero zkVM proofs.

The protocol is designed so the market can verify solvency, matching, settlement,
and risk rules without exposing a trader's identity, margin amount, position
details, entry price, liquidation threshold, TP/SL strategy, or order intent.

## 1. What PNLX Provides

- Private perpetual futures trading on Stellar.
- Long and short exposure on supported markets.
- Private margin notes instead of public account balances.
- Private trade intents instead of public order details.
- Client-side UltraHonk proofs for note and intent validity.
- RISC Zero zkVM proofs for deterministic batch matching.
- Soroban contracts for proof-gated custody, market state, settlement, closes,
  liquidations, disclosures, and governance.

## 2. What Stays Private

PNLX keeps the following data private by default:

- Trader identity and account state.
- Margin amount and collateral note witnesses.
- Position side, size, entry price, and liquidation threshold.
- Individual order intent.
- TP/SL kind, trigger price, close size, salt, and realized PnL.
- Liquidation witness details.
- Selective disclosure claim values.

The protocol exposes only the data contracts need to verify state transitions:

- Market id, oracle contract, mark price, and oracle timestamp.
- State roots, commitments, and nullifiers.
- Proof metadata and proof-ledger digests.
- Aggregate batch output such as volume, open-interest deltas, and settlement
  roots.

## 3. How It Works

### 3.1 Private Account And Margin

A trader authenticates with a Freighter-compatible Stellar signed message. The
server verifies the signature and derives an `ownerCommitment(address)` for
private indexing and encrypted account state.

The trader deposits collateral into the shielded pool. Instead of exposing the
full margin balance, the client creates private margin notes. The browser keeps
note witnesses locally, while contracts and the server track only commitments,
nullifiers, encrypted account events, and proof-bound metadata.

### 3.2 Private Intent

When a trader opens or updates a position, the browser builds a private intent.
The intent includes private fields such as side, size, margin, price constraints,
and note data.

The client proves intent validity with an UltraHonk proof. The server accepts the
intent only after checking the proof, the note nullifier, the margin root, and the
public binding data. The public registry records the intent commitment, not the
full order.

If a larger margin note funds a smaller trade, the proof binds a private change
commitment. That change note becomes spendable only after settlement records it.

### 3.3 RISC Zero zkVM Matching

Batch matching runs off-chain in a separate matcher service. The matcher reads
eligible private order payloads, executes deterministic matching and risk checks,
and requests a RISC Zero Groth16 receipt for the batch-match zkVM program.

The RISC Zero public journal binds the batch id, market id, position roots,
settlement digest, filled intents, new commitments, spent nullifiers, residual
size, and aggregate volume. This lets the chain verify the batch result without
seeing the private order details.

### 3.4 Proof Ledger And On-Chain Settlement

Proof-consuming contracts require an accepted proof digest in the proof ledger
before they update protocol state. The proof ledger is governed, and each circuit
is tied to a verifier authority approved by governance.

For batch settlement, the `batch-settlement` contract checks:

- The RISC Zero proof path and proof-ledger entry.
- Active intent commitments in `intent-registry`.
- Current market configuration and fresh oracle price.
- Position roots and state transitions through `position-state`.
- New commitments, spent nullifiers, residual orders, and aggregate outputs.

Only after those checks pass does the protocol index the settlement.

### 3.5 Private Closes, TP/SL, And Liquidations

Conditional TP/SL orders store only close commitments on-chain. The trigger and
position-close proofs prove that a private close is valid at the public mark
price without revealing the trader's full strategy or realized PnL.

Liquidations follow the same proof-gated pattern. The public contract receives
only the proof-bound liquidation result and the commitments needed to update
state.

### 3.6 Selective Disclosure

Selective disclosure lets a trader prove a specific claim about private account
or position data without opening the rest of the account state. The disclosure
contract records only the verified disclosure proof metadata.

## 4. Runtime Services

PNLX is split into a few clear runtime parts:

- `client`: browser trading app, wallet auth, local note witnesses, client-side
  proofs, encrypted account events, and portfolio reconstruction.
- `server`: API, private state index, proof coordination, on-chain relay, market
  refresh, and worker orchestration.
- `matcher`: private batch-matching service that produces RISC Zero-backed
  settlement transcripts.
- `contracts`: Soroban custody, market, settlement, proof, and governance
  contracts.
- `circuits`: Noir circuits used for UltraHonk proofs.
- `risc0`: RISC Zero batch-match guest and host code.

## 5. Contracts And Addresses

Address source:

- Network: Stellar testnet.
- Deployment file: `deployments/testnet.json`.
- Source identity: `pnlx-testnet`.
- Source address:
  `GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC`.

The server defaults to `deployments/testnet.json` unless
`STELLAR_DEPLOYMENT_FILE` is set. Use
`STELLAR_DEPLOYMENT_FILE=deployments/testnet.json` to run
against the RISC Zero E2E deployment listed below.

### 5.1 RISC Zero Verifier Stack

| Component | Address |
| --- | --- |
| RISC0 router | `CCGBYZWBLNVS6R6AFUGDDFU46RORQXYJHRVLVQP6TU3TZ7QCRAB2XSH3` |
| RISC0 Groth16 verifier | `CACLGO5CSPWBPTE3GA34VCEURVSHVC7EJJ6Y3ECYQ6HV5OXA5Y3QTJFV` |
| RISC0 emergency stop | `CA6T5WV2YKV4KAQ6ONMYSYIHULHINF6RI7F7PRRT2FXPOSKUUAKH2MR6` |
| RISC0 stack owner | `GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC` |
| RISC0 selector | `73c457ba` |

### 5.2 Core Protocol Contracts

| Contract | What it does | Address |
| --- | --- | --- |
| `governance` | Admin, pause state, and verifier registry | `CDS7LCDOSJTCVXWIKUVMSZJASCAWX6CBJ5DM65YJB42P4QK37ACCNYMN` |
| `proof-ledger` | Records accepted proof digests | `CCMMEPEINZUOAG4GWCXINXOXPIMKIR6I42JPWFHM4OOUSU2AARRZMUD3` |
| `price-oracle` | SEP-40-compatible oracle adapter | `CAMDZVNCICW6VAYZR6VNMJXEKGM3WEGKESYQOXEU5BIGLSLZWPPHBYRZ` |
| `position-state` | Stores private position roots and authorized writers | `CAR733CQNSMIYNZJP4I5C255WLRA4RO4LMVTLEYZG5CSYGGBVHEGVUXN` |
| `shielded-pool` | Stores margin commitments, nullifiers, deposits, and withdrawals | `CCKMN7O4NETE7UTAQU4X23YMR5XMFGJHHL4RMHL3JKWFY5JNCMMDLG73` |
| `intent-registry` | Records active and cancelled intent commitments | `CBHPOBN6QL5RE56TXJ2HGK2GVXDTGH5PROC47C446ECXZXTGJSXXQMYS` |
| `conditional-order` | Stores TP/SL close commitments and trigger records | `CBOGL3S4YQW5ZHZJY2W5VWYPGW6BOZY655L3TAP6ZWQGJDVUTBAWQBMC` |
| `market` | Stores market risk parameters and oracle configuration | `CCXTAD5VND6ANNWKGSYDC77BHNMBYNF7DZJNSELVDZYYCJ5TVLUTM3HO` |
| `funding-settlement` | Settles proof-backed funding updates | `CCHMPJYUI65ELKJSXXUOINRYE2WCYB7C2FLX7GZMZP723JGV6SVTZRCA` |
| `batch-settlement` | Settles RISC Zero-backed matched batches | `CAJNJFQFGDNXEJXYJSSAQ73F44LRXOS4YACF2PCEIT33GSLBFZSEVK5H` |
| `liquidation` | Records proof-backed private liquidations | `CAQ4FW5NYJOFQWHRDOHONUEYFPXOOPQQDUK6AW6DU3LWL5EJJ2CTOJCU` |
| `position-close` | Settles proof-backed manual and conditional closes | `CCQKRD2VHAEAECPCO4RLF3EUYZ5JDU2BNUJ2PT65FD6THTGFEIWTWUUP` |
| `disclosure-verifier` | Records selective disclosure proofs | `CAJYKNAK6JRB5O7CVR2INOTWERQLJ7T4OROBTARCLHPWQDFXD4W5HFKT` |

### 5.3 Proof Verifier Contracts

| Verifier | Address |
| --- | --- |
| `batch-match-risc0-verifier` | `CDLJLRKUPULXTPX726TCMOAOXFWUNLVKFXLGIFE5SSRQZIBJDLXZJVHJ` |
| `conditional-close-proof-verifier` | `CC3V4VCVRTX7EYJX42MH2YZUXKRFBNLXNRI4FNJFEGTG67STMU3LNQXL` |
| `deposit-note-proof-verifier` | `CBIQACRM6CR3Y6APAN6XIJYPLNZS53CMWPREHZWPOS4TBFAQAF5TSSWM` |
| `disclosure-proof-verifier` | `CCWBQ6RQG6PAUQ5BMYUSQVH6H5DEPLKL2ZOQPXV7R6TC6F32O3Z4GFST` |
| `funding-update-proof-verifier` | `CDB4PEYTJZ3ODMRXZOECSA6DNLI4CJQHYZP4RDLUOEZLIQQFBKECZASP` |
| `intent-validity-proof-verifier` | `CAM6DPTGVRU5DE3CF4KQW5VCA4GKEYL3I5SQBIMIPPC24D3R422S2EDK` |
| `liquidation-check-proof-verifier` | `CB6ZJ7UFXITFZ52RAP7K27KZJNTHHQA3SPOHUQ5AMUWSSM2LPFRREIWD` |
| `margin-check-proof-verifier` | `CCFMWZ27H2AMU6G6OBXHJHUIVWOZZOKKLHNOM5YECQELBSGYNPZ4SU47` |
| `position-close-proof-verifier` | `CC7AFBOYAATDMZQC6ZN735BBRAVR2KXBXCKIFOBSH5BH6ZNRTMN237BB` |
| `position-transition-proof-verifier` | `CCRUP4DGMECLOGIG34WWOWRFWJ6LIGHTRKWYZX2TDWCHE45WSMALQLME` |
| `withdraw-proof-verifier` | `CDSZK4WEUOX7TJ7X2DJLXWVHRBL5OOH4LRNU4VUENGR6HYRJY47FV2OG` |

## 6. Supported Markets

The initial configured perpetual markets are:

| Market | Oracle asset | Max leverage | Initial margin | Maintenance margin |
| --- | --- | ---: | ---: | ---: |
| `btc-usd-perp` | `BTC` | `10x` | `10%` | `5%` |
| `eth-usd-perp` | `ETH` | `10x` | `10%` | `5%` |
| `xlm-usd-perp` | `XLM` | `10x` | `10%` | `5%` |
| `sol-usd-perp` | `SOL` | `5x` | `20%` | `10%` |
| `xrp-usd-perp` | `XRP` | `5x` | `20%` | `10%` |

## 7. Short Flow

```text
wallet signs in
-> client creates private margin note
-> collateral commitment is deposited into shielded pool
-> client proves private intent validity
-> intent commitment is registered
-> matcher builds a private batch off-chain
-> RISC Zero zkVM proves deterministic matching
-> proof ledger records the accepted proof digest
-> batch-settlement verifies roots, active intents, oracle price, and proof binding
-> private positions, margin changes, residual orders, and aggregate market data are indexed
```
