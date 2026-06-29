# Merkl

Merkl is a confidential perpetual futures DEX on Stellar. It keeps user
identity, margin, positions, order intent, entry price, liquidation threshold,
TP/SL strategy, and account state private by default while exposing public
market aggregates needed for a healthy perps venue.

The selected production design uses separated blind matching plus ZK proof
binding: traders secret-share intents to an executor/MPC/FHE committee, the
committee computes private fills and state transitions outside the Merkl API
server, and Soroban contracts accept only proof metadata bound to circuit key,
circuit source, registered verifier hash, public inputs, settlement state, and
an on-chain proof-ledger record written by the governance-approved verifier
authority for that circuit.

## Repo Layout

```text
merkl/
  server/
  contracts/
  circuits/
  packages/
  tests/
  README.md
  package.json
```

`client/` is intentionally left out for now. When added, deploy from the repo
root and target the app with commands such as `bun --filter client build` or
`bun --filter server start` so both apps can use shared packages.

## Server

The server owns the API and off-chain workers.

```text
server/
  src/
    app.ts
    server.ts
    config/
    features/
      batches/
      conditional-orders/
      disclosures/
      health/
      intents/
      liquidations/
      markets/
      notes/
      proofs/
    shared/
      http/
      state/
    workers/
      batch-matcher/
      matcher/
        nilcc/
        remote/
        remote-compute/
      executor/
      indexer/
      threshold-shares/
      proof-coordinator/
      prover/
      relayer/
```

`GET /proofs/verifiers` returns circuit keys, circuit hashes, verifier hashes,
verifier contract instance names, and the reusable verifier contract artifact.

Server proof flows for withdrawals, batch settlement, conditional TP/SL closes,
liquidations, and disclosures generate request-specific Noir witnesses and
Barretenberg UltraHonk proofs. The returned proof metadata includes proof,
witness, bytecode, public input, and VK hashes.

Wallet auth is Freighter-compatible signed-message auth:

- `POST /auth/challenge` returns a domain-bound message containing the Stellar
  address, domain, URI, network passphrase, nonce, and expiry.
- Wallets sign the returned message with the account Ed25519 key and submit it
  to `POST /auth/session`.
- The server verifies the Stellar public key signature, persists only a hash of
  the bearer token, and returns `ownerCommitment(address)` for private account
  state encryption/indexing.
- Governed mutations such as market creation and manual funding updates check
  `PROTOCOL_ADMIN_ADDRESSES` when `AUTH_REQUIRED=true`, so a signed trader
  session is not enough to change protocol markets.
- In custody-required mode, plain commitment-only deposits/withdrawals are
  disabled. Users must use `deposit_asset` / `withdraw_asset`, which move the
  configured collateral token through the Soroban shielded-pool contract.

The execution store mirrors the contract invariant: withdrawals, settlements,
conditional closes, liquidations, and disclosures are rejected unless their
proof digest has first been recorded in the local proof ledger. In
development/production it is file-backed under `MERKL_RUNTIME_DIR` by default,
so markets, notes, intents, proofs, settlements, account events, and relay
history survive server restarts. Tests stay in-memory unless a test explicitly
sets a store path.

Matching backend modes:

- `MATCHING_BACKEND=threshold-recovery` is a local/dev backend. It validates
  threshold shares and creates settlements, but it recovers enough shares
  inside the server process, so it is not executor-blind.
- `MATCHING_BACKEND=external-blind` is the production path. The Merkl API server
  refuses to recover shares for `/batches/settle`; an external MPC/FHE matcher
  posts a proven transcript to `POST /batches/settle-external`.
- `MATCHER_SERVICE_URL` points the API/batch executor at the separate matcher
  service. When `PRIVATE_MATCHING_REQUIRED=true` and `MATCHING_BACKEND=external-blind`,
  the API refuses to start without this URL, so private deployments cannot
  silently fall back to in-process matching.
- Run the matcher process with `bun run matcher:server`. It exposes
  `POST /match/settlement`, reads the persisted protocol/share state, and
  returns the settlement transcript. Use `MATCHER_PORT` and
  `MATCHER_API_TOKEN` for the matcher service, and `MATCHER_SERVICE_TOKEN` for
  the API client bearer token.
- The matcher service has its own compute backend boundary. Use
  `MATCHER_COMPUTE_BACKEND=remote-blind` plus `MATCHER_COMPUTE_URL` to delegate
  private matching computation to an isolated MPC/FHE/blind-compute service at
  `POST /compute/settlement`. Use `MATCHER_COMPUTE_BACKEND=nilcc` plus
  `NILCC_WORKLOAD_URL` to call the Merkl blind-compute workload running inside
  Nillion nilCC confidential compute. `MATCHER_COMPUTE_BACKEND=local-threshold`
  is only for development and tests because it recovers threshold shares inside
  the matcher process.
- When `PRIVATE_MATCHING_REQUIRED=true`, `bun run matcher:server` refuses to
  start unless `MATCHER_COMPUTE_BACKEND` is `remote-blind` or `nilcc`. In nilCC
  mode it also requires `NILCC_WORKLOAD_URL` and an attestation pin through
  `NILCC_ATTESTATION_REPORT_SHA256` or `NILCC_ATTESTATION_CONTAINS`.
- `PRIVATE_MATCHING_REQUIRED=true` makes startup reject `threshold-recovery`.
  Health also reports matching readiness under `GET /health`.
- `MATCHER_COMMITTEE_REQUIRED=true` makes external settlement ingestion require
  threshold Ed25519/Stellar-address signatures over the batch settlement public
  input hash. Defaults to `PRIVATE_MATCHING_REQUIRED`.
- `MATCHER_COMMITTEE_ADDRESSES` and `MATCHER_COMMITTEE_THRESHOLD` configure the
  authorized matcher/executor committee.
- The nilCC workload image is built from
  `server/docker/blind-compute.Dockerfile`; run
  `bun run docker:blind-compute` for a local image tag. The compose payload for
  nilCC is `server/docker/nilcc-blind-compute.compose.yml`; set
  `MERKL_BLIND_COMPUTE_IMAGE`, `MATCHER_COMPUTE_TOKEN`,
  `THRESHOLD_SHARE_NODE_IDS`, and `THRESHOLD_SHARE_THRESHOLD` before submitting
  it to nilCC.
- External settlement transcripts are checked against current roots, active
  order commitments, spent nullifiers, new position commitments, owner
  commitments, residual order records, encrypted owner account events, and the
  batch proof public-input hash before indexing. Matcher committee attestations
  sign both the public-input hash and a full transcript hash covering indexed
  position/residual records plus the encrypted account event commitments.
- `BATCH_EXECUTOR_ENABLED=true` starts the automated batch executor. It scans
  markets with open private orders, asks the matcher service to create a
  settlement transcript, relays settlement on-chain when configured, commits
  only after the proof/finality rule is satisfied, and writes a durable
  `BatchExecutionRunRecord` for settled, skipped, and failed attempts.
- `BATCH_EXECUTOR_INTERVAL_MS` controls the loop interval and
  `BATCH_EXECUTOR_PREFIX` controls generated batch ids.
- External blind settlements must include one owner-encrypted account event for
  each opened position and residual order. The server binds each ciphertext to
  the settlement digest, position/residual commitment, owner commitment, and
  event id before it will index the batch. This gives the authenticated owner a
  private client-side path to reconstruct position notes for close/TP/SL flows
  without exposing `positionNullifier` in public portfolio snapshots.

Private dashboard state is backed by encrypted account events:

- After wallet auth, the browser creates a non-extractable P-256 ECDH private
  key, stores it in IndexedDB, and registers the raw public key at
  `POST /account-keys`. Reads and writes are bound to
  `ownerCommitment(address)` when auth is required.
- `POST /account-events` stores `{ ownerCommitment, eventId, dataCommitment,
  ciphertext }` without inspecting the encrypted payload.
- `GET /account-events?ownerCommitment=...` returns the encrypted event stream
  for client-side decryption.
- `GET /portfolio?ownerCommitment=...` returns that encrypted stream plus public
  roots/counts from the indexer. Balances, orders, realized PnL, TP/SL strategy,
  and per-position details remain inside client-encrypted payloads.
- When `AUTH_REQUIRED=true`, account event writes and portfolio/event reads are
  bound to the signed Stellar account by checking
  `ownerCommitment(address) == ownerCommitment`.
- External matcher account events use a `merkl-account-event-v1` envelope:
  ephemeral P-256 ECDH, AES-GCM payload encryption, and event commitments bound
  to settlement digest, owner commitment, and ciphertext.

Conditional TP/SL flow:

- `POST /conditional-orders` stores only `{ marketId, positionNullifier,
  closeCommitment }`.
- `POST /conditional-orders/trigger` proves the committed close is reduce-only
  and triggered at the public mark price.
- `POST /position-closes/proven` settles a triggered TP/SL close.
- `POST /position-closes/manual-proven` settles a normal close-now action
  without requiring a conditional trigger. The same position-close proof still
  consumes the old position nullifier and records new private position/margin
  commitments.
- Side, take-profit/stop-loss kind, trigger price, close size, and salt are
  witness data and are not returned by the API.
- The web client stores pending TP/SL strategy locally, keyed by intent
  commitment. After the owner decrypts the private position-opening event, the
  browser computes the close commitments locally and registers only
  `{ marketId, positionNullifier, closeCommitment }`.
- Clients can compute local PnL previews with shared `market-math`, but the
  protocol accepts only the ZK proof that recomputes the final margin.

Feature files follow:

```text
{feature}.model.ts
{feature}.schema.ts
{feature}.service.ts
{feature}.controller.ts
{feature}.route.ts
{feature}.index.ts
```

Workers follow:

```text
{worker}.model.ts
{worker}.service.ts
{worker}.worker.ts
{worker}.index.ts
```

## Contracts

Soroban contracts live outside the server.

```text
contracts/
  shielded-pool/
  intent-registry/
  market/
  batch-settlement/
  liquidation/
  position-close/
  disclosure-verifier/
  proof-verifier/
  governance/
  proof-ledger/
  price-oracle/
  ultrahonk-verifier/
  governance-interface/
  proof-ledger-interface/
  intent-registry-interface/
  market-interface/
  oracle-interface/
  test-oracle/
```

Responsibilities:

- `shielded-pool`: stores commitments, nullifiers, and withdrawal records.
- `intent-registry`: records intent commitments and on-chain cancellation state.
- `market`: stores market risk parameters and SEP-40/Reflector oracle config,
  reads `lastprice` or TWAP records on-chain, scales prices, and rejects stale
  feeds with the current ledger timestamp.
- `batch-settlement`: stores settlement roots and aggregate batch output, checks
  filled intent commitments are still active in `intent-registry`, and records
  the fresh oracle price/timestamp accepted at settlement time.
- `liquidation`: records proof-backed private liquidation events.
- `position-close`: records proof-backed private close settlements, consumes
  position nullifiers, and stores new private position/margin commitments.
- `disclosure-verifier`: records selective disclosure proofs.
- `proof-verifier`: verifies UltraHonk proof bytes for a circuit VK and records
  accepted proof digests into `proof-ledger`.
- `governance`: stores admin, pause state, and verifier hashes keyed by circuit.
- `proof-ledger`: stores accepted proof digests keyed by circuit, verifier,
  public input, and proof digest.
- `price-oracle`: SEP-40-compatible adapter. It supports direct admin updates
  for local development and threshold committee publishing for live testnet:
  authorized publishers submit the same asset round, the contract publishes the
  median price only after the configured threshold, and markets read it through
  the standard `lastprice` / `prices` shape.
- `ultrahonk-verifier`: local SDK 26.1.0 UltraHonk verifier library used by
  `proof-verifier`.
- `governance-interface`, `proof-ledger-interface`, `market-interface`, and
  `oracle-interface`: narrow client interfaces used by contracts.
- `test-oracle`: test-only SEP-40 oracle fixture used to prove freshness and
  TWAP logic. It is not deployed by the normal manifest.

Proof-consuming contracts are initialized with the governance address, the
proof-ledger address, and the circuit key they accept. `batch-settlement` is
also initialized with the `market` contract address and calls `market.mark_price`
before accepting a batch. On each proof call they reject paused protocol state,
wrong circuit keys, verifier hashes that do not match governance, stale oracle
prices, inactive markets, and proof digests missing from `proof-ledger`.

`proof-verifier.verify_and_record` verifies UltraHonk proof bytes against the
stored VK, checks the SHA-256 hashes of the VK, public input bytes, and proof
bytes, then records the proof through `proof-ledger`. `proof-ledger.record`
requires authorization from the governance-approved verifier contract for the
circuit, rejects paused governance, and rejects verifier hashes that do not
match governance. The contracts are pinned to `soroban-sdk 26.1.0`, and the
test suite exercises the BN254 host-function surface exposed by Protocol 25+.

## Circuits

Noir circuits live in `circuits/`.

```text
circuits/
  batch-match/
  conditional-close/
  deposit-note/
  disclosure/
  funding-update/
  intent-validity/
  liquidation-check/
  margin-check/
  position-close/
  position-transition/
  withdraw/
```

Each circuit has a `Nargo.toml`, `Prover.toml`, and `src/main.nr`. The
TypeScript proof system loads these manifests and source files, derives circuit
keys, and uses real Barretenberg VK hashes when proof artifacts have been built.
Without built artifacts it falls back to source-bound hashes for local metadata
tests.

Sensitive fields are private witnesses unless the Soroban action itself exposes
them. Sizes, sides, margins, entry prices, realized PnL, TP/SL trigger prices,
fees, funding payments, disclosure values, and note balances stay private.
Roots, nullifiers, commitments, market prices read from SEP-40/Reflector,
funding indexes, selected thresholds, and aggregate batch outputs remain public
so contracts can bind proofs to public state.

Build and verify all circuit fixtures before deployment:

```sh
bun run prove:circuits
bun run build:contracts
bun run manifest:deploy
bun run deploy:dry
```

The proof command runs `nargo execute`, `nargo compile`, `bb prove`, and
`bb verify` for every circuit using the Keccak transcript expected by the
Soroban UltraHonk verifier. The contract build command produces Stellar WASM
artifacts under `contracts/target/stellar`, and the manifest command prints the
contract hashes, verifier registry entries, and initialization plan.

Oracle environment:

- `MERKL_RUNTIME_DIR`: directory for durable local runtime state. Defaults to
  `.merkl` outside tests.
- `FUNDING_ENGINE_ENABLED`: starts the periodic funding worker outside tests by
  default. Set `false` to keep funding manual-only.
- `FUNDING_INTERVAL_MS`: funding accrual interval. Defaults to one hour.
- `FUNDING_PREMIUM_RATE`: default premium rate used by the scheduled funding
  worker and `/funding/run` when the request does not override it. Positive
  values move the funding index up; negative values move it down.
- `FUNDING_MAX_DELTA`: optional absolute cap for each signed funding index
  update.
- `PROTOCOL_ADMIN_ADDRESSES`: comma-separated Stellar addresses allowed to
  create markets and run manual funding updates when auth is enabled.
- `PROTOCOL_ADMIN_REQUIRED`: when `true`, governed mutations fail closed if no
  protocol admin list is configured. Defaults to `true` in production.
- `CONDITIONAL_ORDERS_ONCHAIN_REQUIRED`: when `true`, TP/SL registration and
  trigger indexing require submitted Soroban transactions. Defaults to `true`
  in production.
- `SETTLEMENTS_ONCHAIN_REQUIRED`: when `true`, proof-backed closes,
  liquidations, disclosures, and funding updates require submitted Soroban
  settlement transactions before local indexing. Defaults to `true` in
  production.
- `INTENT_REGISTRY_ONCHAIN_REQUIRED`: when `true`, order submit/cancel flows
  require submitted Soroban intent-registry transactions before local active or
  cancelled order state is indexed. Defaults to `true` in production.
- `ASSET_CUSTODY_REQUIRED`: disables plain unbacked note deposits/withdrawals
  outside tests by default. Set `false` only for local circuit/API development.
- `COLLATERAL_TOKEN_CONTRACT`: Stellar token contract accepted as collateral.
  Required when `ASSET_CUSTODY_REQUIRED=true`; asset deposits/withdrawals for
  any other token are rejected.
- `ORACLE_CONTRACT_ID`: SEP-40/Reflector oracle contract used by on-chain
  market validation.
- `ORACLE_ONCHAIN_REQUIRED`: when `true`, production market pricing must use
  `ORACLE_PRICE_SOURCE=onchain-market` and on-chain relay readiness. Defaults
  to `true` in production.
- `ORACLE_KIND`: `sep40` for standard Pulse/SEP-40 feeds or `beam` for
  ReflectorBeam call shape.
- `ORACLE_PUBLISH_MODE`: `committee` for threshold publisher submissions or
  `admin` for direct local/dev price updates.
- `ORACLE_PUBLISHER_SOURCES`: comma-separated Stellar CLI identities used by
  the server/smoke runner to submit committee oracle prices.
- `ORACLE_PUBLISHER_ADDRESSES`: comma-separated Stellar addresses matching
  `ORACLE_PUBLISHER_SOURCES`; these are passed as publisher identities to the
  price-oracle adapter. Required when sources are aliases instead of addresses.
- `ORACLE_PRICE_SOURCE`: `hermes` fetches Pyth Hermes and optionally publishes
  that value into the configured Soroban oracle adapter. `onchain-market` reads
  the deployed Soroban `market.mark_price(market_id)` as the server-side
  authority for market refreshes.
- `ORACLE_BEAM_FEE_TOKEN`, `ORACLE_ASSET_TYPE`, `ORACLE_ASSET_SYMBOL`, and
  `ORACLE_ASSET_ADDRESS` are advanced overrides for ReflectorBeam or custom
  non-default oracle assets. The default multi-market setup reads per-market
  asset metadata from `server/src/config/assets.ts`.
- `ORACLE_PRICE_MAX_AGE_SECONDS`: max ledger-time staleness accepted on-chain.
- `ORACLE_TWAP_RECORDS`: `1` for spot `lastprice`, greater than `1` for TWAP
  via `prices(asset, records)`.

When `ORACLE_PRICE_SOURCE=hermes` and on-chain relaying is enabled,
`POST /markets/oracle` fetches the live Hermes price, publishes that price to
the configured SEP-40 adapter (`set_*_price` in admin mode or
`submit_*_price` in committee mode), and then upserts the Soroban market
against that oracle contract. This keeps Hermes as a transport/source for
testnet price data, while settlement still reads the on-chain
SEP-40/Reflector-compatible oracle state.

When `ORACLE_PRICE_SOURCE=onchain-market`, market refreshes read the deployed
Soroban market contract with `mark_price` and do not republish a server-fetched
price. Use this mode once the oracle adapter/Reflector feed and market config
are already live on-chain.

Initial perp assets:

| Market | Oracle asset | Max leverage | Initial margin | Maintenance margin | Pyth Hermes feed |
| --- | --- | ---: | ---: | ---: | --- |
| `btc-usd-perp` | `BTC` | `10x` | `10%` | `5%` | `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| `eth-usd-perp` | `ETH` | `10x` | `10%` | `5%` | `ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| `xlm-usd-perp` | `XLM` | `5x` | `20%` | `10%` | `b7a8eba68a997cd0210c2e1e4ee811ad2d174b3611c22d9ebf16f4cb7e9ba850` |
| `sol-usd-perp` | `SOL` | `5x` | `20%` | `10%` | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| `xrp-usd-perp` | `XRP` | `5x` | `20%` | `10%` | `ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8` |

The default smoke run uses `MERKL_SMOKE_MARKETS=BTC,ETH,XLM`. Override it with
`MERKL_SMOKE_MARKETS=BTC,ETH,XLM,SOL,XRP` or with `--markets=BTC,XLM`.

Asset custody smoke:

```sh
bun run smoke:custody:prepare -- --token=<COLLATERAL_TOKEN_CONTRACT> --source=<stellar-key-alias>
bun run smoke:custody -- --token=<COLLATERAL_TOKEN_CONTRACT> --source=<stellar-key-alias> --amount=1000000
```

The prepare command builds the wallet-signable `deposit_asset` action. The live
command requires `STELLAR_ONCHAIN_RELAY=true`, `STELLAR_RELAYER_MODE=stellar-cli`,
a funded source account, a deployed shielded-pool deployment file, and a
collateral token balance for the source. For test collateral you can pass
`--deploy-asset --asset=native`; production USDC should pass the real Stellar
asset contract through `--token` or `COLLATERAL_TOKEN_CONTRACT`.

For a real localnet deployment:

```sh
bun run deploy:local
```

That command starts/configures a local Stellar container, funds the
`merkl-admin` identity, deploys every contract, deploys one proof-verifier
instance per circuit, initializes governance/proof-ledger/proof consumers, and
runs a withdraw proof through `proof-verifier.verify_and_record`.

## Packages

Shared TypeScript code lives in `packages/` only when it is used across app
boundaries.

```text
packages/
  crypto/
  market-math/
  proof-system/
  protocol-types/
  sdk/
```

Responsibilities:

- `crypto`: commitments, nullifiers, Merkle roots, field helpers, and secret
  sharing.
- `market-math`: margin, PnL, funding, liquidation, and vAMM math.
- `proof-system`: circuit manifest loading, circuit keys, verifier registry
  entries, contract proof metadata, and proof binding.
- `protocol-types`: shared notes, intents, conditional orders, markets,
  settlements, and proof types.
- `sdk`: high-level note and intent helpers for app, worker, and test usage.

Do not put Soroban contracts or Noir circuits in `packages/`.

## Privacy Flow

```text
user creates shielded margin note
-> user deposits commitment into shielded pool
-> user creates private trade intent
-> intent fields are secret-shared for external blind compute
-> matcher delegates private batch computation to the configured MPC/FHE/blind provider
-> matcher/prover binds settlement to circuit and public inputs
-> proof digest is recorded in the proof ledger
-> market reads a fresh SEP-40/Reflector price on-chain
-> settlement checks filled intent commitments are active, not cancelled
-> settlement stores roots, nullifiers, commitments, oracle price, and aggregate market data
-> user or executor committee registers only a TP/SL close commitment
-> trigger proof closes only when the private condition is satisfied at mark price
-> position-close proof computes PnL privately and emits new state commitments
```

Private by default:

- user identity and account state
- margin and collateral amount
- position side, size, entry price, and liquidation threshold
- TP/SL side, kind, trigger price, close size, salt, and realized PnL
- individual order intent
- liquidation witness details
- selective disclosure claims

Public:

- market id
- oracle contract, asset, mark price, and oracle timestamp
- state roots
- nullifiers
- conditional close commitments
- aggregate volume, open interest delta, funding/activity metrics
- verifier, proof metadata, and proof-ledger digests

## Verification

```sh
bun test
bun run prove:circuits
bun run build:contracts
bun run manifest:deploy
cargo test --offline --workspace --manifest-path contracts/Cargo.toml
cd circuits/batch-match && nargo test
cd circuits/conditional-close && nargo test
cd circuits/deposit-note && nargo test
cd circuits/disclosure && nargo test
cd circuits/funding-update && nargo test
cd circuits/intent-validity && nargo test
cd circuits/liquidation-check && nargo test
cd circuits/margin-check && nargo test
cd circuits/position-close && nargo test
cd circuits/position-transition && nargo test
cd circuits/withdraw && nargo test
```

## Naming

- Folders use kebab-case.
- TypeScript feature files use `{feature}.{role}.ts`.
- TypeScript worker files use `{worker}.{role}.ts`.
- Rust module files use snake_case.
- Noir files use snake_case.
- Shared package names use kebab-case.
- Avoid dumping-ground utility folders.
