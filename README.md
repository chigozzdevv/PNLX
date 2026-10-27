# PNLX (zkVM-Backed Private Perp DEX)

PNLX is a Stellar testnet perpetuals prototype with commitment-based account state, off-chain matching, and Soroban proof verification. The current operator and hosted proving services receive plaintext trading/proof inputs. The current build does not implement threshold-encrypted matching or hide those inputs from its prover.

Those witnesses include spending material. A prover that receives note secrets or recoverable position seeds is part of the spending trust boundary, not merely a reader of trading data. Current hosted/external proving must not be described as operator-independent custody. Removing that trust requires a different authorization or confidential proving design and independent security review.

## 1. Current Privacy Boundary

| Surface | Current visibility |
| :--- | :--- |
| Position and margin commitments on Stellar | Commitments, nullifiers, roots, proof digests, fee totals, settlement timing, and maker/taker intent relationships are public. Commitments do not by themselves reveal their openings. |
| Deposits and withdrawals | Wallet addresses, token transfers, amounts, and timing are public and can support correlation. PNLX does not promise wallet anonymity. |
| Matching | PNLX's API/matcher handles plaintext side, size, margin, limit price, and private position seeds. Operators and anyone with access to that process/store can inspect them. |
| Hosted Noir proving | The configured proving service receives the witness for the requested circuit. ZK verification does not conceal that witness from the machine producing the proof. |
| Boundless batch proving | The host encodes the full request, including private intent data and position seeds, into a guest environment and uploads it through its configured storage service. Treat that data as disclosed to the prover/storage service and anyone able to retrieve its input URL. This path does not establish confidentiality against those parties or public input retrieval. |
| Account recovery | Encrypted backups reduce disclosure from recovery storage; they do not remove plaintext required by the current hosted matching/proving flow. Preserve recovery data and spending keys. |
| TP/SL and liquidation inputs | Trigger/proof data is available to the service evaluating or proving it. Do not assume it is hidden from PNLX or its proving provider. |

Threshold-encrypted order intake, a decryption committee, and operator-blind matching are future design work. The oracle publisher committee is a price-authority mechanism; it is not a threshold decryption system. RFQ routing and a maker SDK are also future work.

### Proof input retention and external disclosure

The batch prover creates local scratch directories with mode `0700` and `input.json` with mode `0600`. It checks for cached proof artifacts before creating fresh input, removes a leftover input from a previous run of that batch, and removes scratch input on normal completion or failure. Child output is bounded and excluded from surfaced prover errors because it may contain witness data or input URLs. A process deadline terminates the local prover process group. Configure `PNLX_RISC0_PROVER_TIMEOUT_MS` to change the default 65-minute limit, which accommodates the current one-hour Boundless request window.

This is normal-exit cleanup, not secure erasure: a hard crash, backups, snapshots, old proof directories, or external uploads can retain data. Existing directories need an explicit retention review; this change does not delete historical files, note recovery records, or copies held by a proving/storage provider. Killing the local host does not cancel a submitted remote proof request; its saved request ID supports reconciliation/resumption.

Avoiding external witness disclosure requires a proving path that keeps the witness within the chosen trust boundary. Running a prover on PNLX infrastructure would still expose it to PNLX. Client-local proving or a separately designed confidential computation protocol would need its own correctness, latency, and operational validation before stronger privacy claims.

## 2. Execution and Risk

1. **Account and collateral**: Traders deposit USDC collateral. The protocol uses commitments/nullifiers for note state and encrypted recovery material for the client. A commitment is not encrypted plaintext.
2. **Intent and proof**: The client prepares side, size, margin, and price constraints. The configured proof workflow proves intent validity; hosted workflows disclose the witness to their proving service.
3. **Off-chain matching**: The matcher processes plaintext eligible intents. RISC Zero proves execution of the configured batch guest. This verifies computation; it does not keep inputs secret from the prover.
4. **Soroban settlement**: Configured verifiers check proofs and contracts apply accepted state transitions. Local source changes require matching guest/circuit builds, verifier configuration, and deployment before the running testnet benefits from them.

### Stop loss and latency

Noir commands default to a 120-second deadline; `PNLX_NOIR_PROVER_TIMEOUT_MS` accepts a positive integer up to 900,000 milliseconds. Synchronous commands use a `SIGKILL` timeout; asynchronous commands terminate their process group. Command output is discarded because it can contain witness fields. Paired close proving uses the asynchronous path so proving does not block the server event loop.

TP/SL execution is best effort. A trigger is not a guaranteed execution price or insured loss cap. Fresh oracle data, an available keeper/browser workflow, valid proofs, backed liquidity, and chain inclusion are required. Gaps, slippage, service outages, and proving delays can worsen or prevent an exit. A stop loss must not be marketed as guaranteed.

The current worker caps each batch at one matched execution while retaining the eight-item public ABI. Native contract tests in `contracts/batch-settlement/src/lib.rs` (`measures_execution_capacity_under_default_resource_limits`) pass at one and two complete executions but fail at three and four under default host budgets. The separate `partial_fill_registers_cancellable_residual_margin_claim` test covers one partial execution with both margin-change outputs. Two executions with partial fills and the deployed WASM budget have not been validated; residual orders progress over later batches.

The scheduler interval is not trade latency. Matching, proof generation/remote proving queues, oracle publication, and Stellar confirmation contribute to completion time. Remote matcher requests and job polling have bounded deadlines; a timeout does not prove that an external request or transaction failed. The worker resumes exact batch selections and checks chain state before repeating settlement, failing closed when reconciliation is unavailable. Batch proofs bind new position outputs; the settlement contract appends those outputs to the current tree rather than checking a proof input root. A shared process-local mutation queue orders financial mutation and local mirroring. Unknown financial submissions block new mutations until reconciliation; proof work remains independent. Before local batch commit, the worker checks the authoritative chain append index, so an externally submitted proof cannot silently reorder the local tree.

Market ownership and source-account submission queues are process-local. Run one active scheduler per persistent store and one consistent source identifier per Stellar account until distributed leases/account coordination are implemented. Multi-process deployment is not protected by these in-memory locks.

---

## 3. Smart Contracts Index (Stellar Testnet)

The addresses below are the repository's testnet inventory. They do not establish that current local source changes are deployed or audited; verify the deployment registry, guest image, verifier keys, and contract hashes for a release. Links open the corresponding **Stellar.expert** records:

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

### Trader survey

The public survey is available at `/survey`. Its anonymous `POST /survey/responses` endpoint uses the API server's existing `MONGODB_URI` and `MONGODB_DATABASE` settings. Responses are stored in the separate `survey_responses` collection, outside protocol checkpoints. The frontend uses the same `NEXT_PUBLIC_PNLX_API_URL` as the trading app. Deploy both the client and API changes before sharing the survey.

Questions branch around past trading experience. Optional contact details are saved only when a respondent selects a follow-up purpose. There is no public response-list or export endpoint. Request identifiers prevent duplicate records on retries; they do not establish unique respondents. Spam checks use short-lived, process-local counters and a hidden field; they are not a substitute for gateway rate limits if the public form is targeted.

Export responses to a spreadsheet-compatible CSV from a trusted shell with database access:

```sh
bun run survey:export --output /private/tmp/pnlx-survey.csv
```

Contact details are excluded by default. Add `--include-contact` only for the selected follow-ups. Exports refuse to overwrite existing files, use owner-only permissions and escape spreadsheet formulas. Keep CSV files out of Git and restrict spreadsheet sharing; free-text answers can still contain information respondents chose to share. A `?utm_source=community-name` survey link records the recruitment source without collecting the referring URL.

### Test commands

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
