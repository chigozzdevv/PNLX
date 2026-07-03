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
- Deployment file: `deployments/testnet-20260703-risc0-e2e.json`.
- Source identity: `pnlx-testnet`.
- Source address:
  `GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC`.

The server defaults to `deployments/testnet.json` unless
`STELLAR_DEPLOYMENT_FILE` is set. Use
`STELLAR_DEPLOYMENT_FILE=deployments/testnet-20260703-risc0-e2e.json` to run
against the RISC Zero E2E deployment listed below.

### 5.1 RISC Zero Verifier Stack

| Component | Address |
| --- | --- |
| RISC0 router | `CB5264LXAVP27I5BL226EY7AVEZQSCN2NHP5FGENVVF6K6FDFJJV6Y7P` |
| RISC0 Groth16 verifier | `CD77XEIUYPFKTEUPPM5M5X42G6ZI6MVD2EIHH6UOPU3W4W3VJWX7RFKX` |
| RISC0 emergency stop | `CAAUH37SKGXBUHGQSATGQWQSXM3YD3OG2G72MLMH4DI4MF3YDOGI3BUP` |
| RISC0 stack owner | `GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC` |
| RISC0 selector | `73c457ba` |

### 5.2 Core Protocol Contracts

| Contract | What it does | Address |
| --- | --- | --- |
| `governance` | Admin, pause state, and verifier registry | `CC55PY7WS23EZRF6SQ66GLEME2PXSC2PD3LXJHDSLXFWEVR5NXUZSXWV` |
| `proof-ledger` | Records accepted proof digests | `CB73E7UHYVMOJKFPK7X6MWJGJDLRA2MXGGOC7UQCTZ5CJOLE4SZ7OTPX` |
| `price-oracle` | SEP-40-compatible oracle adapter | `CDMKWFFEFLSKWDDRJ4QXGYME2AA5HATE2I33EDAWWSS5RKM6ZBGHR5XY` |
| `position-state` | Stores private position roots and authorized writers | `CB3LZAW2M55ZQMXLQBCEKX7TMWZQJXRXYI4NVNXU4Q7AAT2CQS6AFLD2` |
| `shielded-pool` | Stores margin commitments, nullifiers, deposits, and withdrawals | `CC4II2L3SA3DBSAIEV27H2ADAEBUJGJKN4RN7Z3N75ATB5RWZDD476HT` |
| `intent-registry` | Records active and cancelled intent commitments | `CCIOQL55F3XWLTTS2P7TVX535VIIX2NJEYHOJZC6NQMQZW3NOKNBLHJ4` |
| `conditional-order` | Stores TP/SL close commitments and trigger records | `CCKNN6IOOMBBSA5H5FWCMNQ3DCC46FHVBDNCFZJYQDZGZLEJZCO5WONU` |
| `market` | Stores market risk parameters and oracle configuration | `CD3B7VAYQ2KYRUNJTTAJENILLHPXVLFAGJCMD2D2GLV2PBECVFPAHE3C` |
| `funding-settlement` | Settles proof-backed funding updates | `CA4SSXFFHCU5QSDIJNJTOCTW4I44RTFIJ42S6JJNMDKWIE2XBLLYTAOK` |
| `batch-settlement` | Settles RISC Zero-backed matched batches | `CAIFVSDSTQSBJDUJVQ6E6ZBMJYHGJPZ3LSV3A2BSFS2F5YBW6SYNWARK` |
| `liquidation` | Records proof-backed private liquidations | `CC7ROCQSTS6KBN4OZJFPM4MCTSL2SETU2SYFT4RW3NJAJDRAWSBY5LQU` |
| `position-close` | Settles proof-backed manual and conditional closes | `CCQMJ2YXVOYFGSI7VVT26HWD6AWOXTPF26C7HQPBSNYH4HB3CNOUHBZF` |
| `disclosure-verifier` | Records selective disclosure proofs | `CBVGDUDOJNW6GSSJ4JFUR7JO27LASWJ3HA7VZDJ2WSC4WQBGHXIZ43KJ` |

### 5.3 Proof Verifier Contracts

| Verifier | Address |
| --- | --- |
| `batch-match-risc0-verifier` | `CCATN26D5WIWR3MHMVJONYITVQ3O3Q52MNSP2GGLRK764EZGLOCAABS6` |
| `conditional-close-proof-verifier` | `CC63A3TUM7HYDPNORBK3AEIM3CYVGUXZYCW43SI3PIDN526PU55YZIDF` |
| `deposit-note-proof-verifier` | `CDGGSBFNJMQQKYP2XTQICLR4HHZ5QLY3DWE4XOOFLHE3MU3GQOBMSRSU` |
| `disclosure-proof-verifier` | `CATMMPH4WNUQTH3AE4HYO6BWOOINUZULEVQM4YILQ6PGTS57ZSHZ5RYC` |
| `funding-update-proof-verifier` | `CDXVCNXMWTNWNAEX2G2SMUFXITBT4D2R4AGQIQCLM5CGP42HDLF33KEJ` |
| `intent-validity-proof-verifier` | `CAIDGG4YABGQ3UWHSCSVPYYJMAJYY6GY5UE3YT3VD5HDSTO2IBSIEI43` |
| `liquidation-check-proof-verifier` | `CCAUL4X64DIEWBLJMF6MGQDKYTSLI7WQ4PWBDF7NYXIVPJYNKJXB5V67` |
| `margin-check-proof-verifier` | `CA455IQOK2PYKSGFYKDRX75K7YIVXYAWOKKKC37FPWXRASB6MVWIOBAO` |
| `position-close-proof-verifier` | `CBXJBRXCZBD3WPXSWFL27E2347RCYVHWOYMFHIIQODY2SFM7HTUSUKYQ` |
| `position-transition-proof-verifier` | `CAMOSX2JR6DLOS6UVYPIALUSFTUM7NERRKLMOK34HJKJ6WGV6DZKJSXO` |
| `withdraw-proof-verifier` | `CAPR6GIZOHFOBEFC6MNVZOAKYIUQPJJCJBODNSLL43YP5IWAJQMYP2QZ` |

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
