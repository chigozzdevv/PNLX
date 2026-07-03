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
- Deployment file: `deployments/testnet-20260703-fresh.json`.
- Source identity: `pnlx-testnet`.
- Source address:
  `GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC`.

The server defaults to `deployments/testnet.json` unless
`STELLAR_DEPLOYMENT_FILE` is set. Use
`STELLAR_DEPLOYMENT_FILE=deployments/testnet-20260703-fresh.json` to run
against the RISC Zero E2E deployment listed below.

### 5.1 RISC Zero Verifier Stack

| Component | Address |
| --- | --- |
| RISC0 router | `CCV2P2O4B4KBWSBNH34DISK5PHNBIGUU2ZVFJ46BBC3ICJNJQTZRQ2D4` |
| RISC0 Groth16 verifier | `CDOPJNX2ZG3PJMK23RFT5JMZEW6NVFXX3ZRB6VHPQRRTLIVHSSRXECHZ` |
| RISC0 emergency stop | `CCPRBWQQR4W3JM2R7JT3PXJTNEJ45NOOEU6APIDPFS6PTCL2DAPIQA3P` |
| RISC0 stack owner | `GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC` |
| RISC0 selector | `73c457ba` |

### 5.2 Core Protocol Contracts

| Contract | What it does | Address |
| --- | --- | --- |
| `governance` | Admin, pause state, and verifier registry | `CDDTFRBQIDYZZPHM4JCFEBBU6KAUFPDV76TQJC5GXNMHDL25D7CFHFTP` |
| `proof-ledger` | Records accepted proof digests | `CBZPKRRE73G3QW3WI2PZRYBJ3ZFH3VBKLJXF2R2UNJETR27OLDC7ULQX` |
| `price-oracle` | SEP-40-compatible oracle adapter | `CC6CO5OZF3KCUMHWHR7TYP5GT7DP2U4PZF5M25OXYUXJHEHD4EBEZTH4` |
| `position-state` | Stores private position roots and authorized writers | `CDLXNH7N7HH2W3UBCUQJNHUFF355FVTPTDJHVPQV64JVJHM3J5U2CHS2` |
| `shielded-pool` | Stores margin commitments, nullifiers, deposits, and withdrawals | `CDORFGZBQCFC6JGYK27SSUCPTNI35J6MPCHROTYHUCQ7NE356HIODUKP` |
| `intent-registry` | Records active and cancelled intent commitments | `CCVWEJ5KQZYN4TUZT5OPUU4LPPO6423ARYHG4BBURYT237YJSUZFOSPN` |
| `conditional-order` | Stores TP/SL close commitments and trigger records | `CC452XWNLK3K2UDXMXWU654P5442I3HAY7YM4U7C2IPETBUG72BPRQ5X` |
| `market` | Stores market risk parameters and oracle configuration | `CBHMLMTRXPWUUHNWKD3Z53CAWUGFWWQ4QJP7OT23XWKQFFRGMQTXFH6J` |
| `funding-settlement` | Settles proof-backed funding updates | `CDCRJXYBA4DGRZMPPQZLH3POHFWJQMNK5N2BQIPYC3ACD4JHYMRGZ7WX` |
| `batch-settlement` | Settles RISC Zero-backed matched batches | `CD7XFWQCQ4BLEV37VWUBPYWOGUQAVLQHPRG7UTY4QC2ARBTCW4JFJEYX` |
| `liquidation` | Records proof-backed private liquidations | `CA6STC3WL6WAS5STXSS7QRP4MBXUEDYNBCZFQ2JVG27G2EJMP6ABDQ54` |
| `position-close` | Settles proof-backed manual and conditional closes | `CAQIVZ5SASXTOLZLJKM7XWFFHUGOJM6TWFP6NY6SYDDCWT2OZ6QK2O6P` |
| `disclosure-verifier` | Records selective disclosure proofs | `CDRJ4ERVFMGUY73M2WHKBH5RYFFMXUKITSC6PE6AWGTOMZBTDOAXQ7LG` |

### 5.3 Proof Verifier Contracts

| Verifier | Address |
| --- | --- |
| `batch-match-risc0-verifier` | `CABATKODYIZHQQIVLXRGXX3XZT7KMJLJJYDV2AMBLCGMFCCFTIWNCS2W` |
| `conditional-close-proof-verifier` | `CAVJ4OOD6FJCA7W4RYFL4KVBD4FNF5GYXLJK3XI2ZUBKVDVMIEXEJVQW` |
| `deposit-note-proof-verifier` | `CDJJOXWRUSPA432U5APWLY6RTEWI4SDDREPDYN4ULC523KPX4WAH5AWR` |
| `disclosure-proof-verifier` | `CCP6ZP5SKPBGVEIAI2ODWSR3WZHUGV5NMTXANOIDGKNAKWKFQUDUKHEQ` |
| `funding-update-proof-verifier` | `CBBIHVVGYRBQJ4235HSPHMJETLVANQVXJ2ZG5UWDO23PQO3KP47PMF45` |
| `intent-validity-proof-verifier` | `CDASIF3LFOJKRYCUPGIJ55ABJMLFO4ZI2BCFVKIJ7ERJHHJQTB2RDXBF` |
| `liquidation-check-proof-verifier` | `CAYCNSER2RDCQFDU4K5755O64UWLLK2RKWQFKKCTI6JEOYKJ6DPBC6YY` |
| `margin-check-proof-verifier` | `CADD2AVKOQLTDXQKTA5MJHQNYMDBSKDGZY65SRJGNM7KY5TIWWCSWEOK` |
| `position-close-proof-verifier` | `CCIVAYOXOA3Y5OBU35MYE2HAPCTMNS3JHNEBUKO4SCZTWSZIAIQNZEUC` |
| `position-transition-proof-verifier` | `CC34QA7WI6KAKNYFL7CX3QSAT4CKOVXA5AI32XX7S5AO4ZOZXOFHMCIT` |
| `withdraw-proof-verifier` | `CDVETLREEKM425MEFX3FQTG4XSFCYZQJYXBEHLUOAK2EAKZQIAB2A4MT` |

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
