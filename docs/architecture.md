# PNLX Protocol Architecture

PNLX is a zero-knowledge, zkVM-backed private perpetual futures exchange built on the Stellar blockchain. The platform is designed to preserve trader privacy—including account balances, margins, positions, order directions, and liquidations—while leveraging off-chain matching for throughput and on-chain Soroban smart contracts for trustless settlement.

---

## 1. System Architecture Diagram

Below is the conceptual flow diagram dividing the protocol's operations into three distinct processing domains: the Client & Actor Layer, the Off-Chain Execution Layer, and the On-Chain Settlement Layer.

```mermaid
graph TD
    %% Styling
    classDef actor fill:#f9fafb,stroke:#d1d5db,stroke-width:2px,color:#111827;
    classDef offchain fill:#f0f9ff,stroke:#0284c7,stroke-width:2px,color:#0c4a6e;
    classDef onchain fill:#f0fdf4,stroke:#16a34a,stroke-width:2px,color:#14532d;
    
    subgraph "1. Client & Actor Layer (Private Intent)"
        Trader["Trader (Browser / Freighter)"]:::actor
        Maker["Maker (LP Bot / USDC Depositor)"]:::actor
    end

    subgraph "2. Off-Chain Execution Layer (zkVM Matching)"
        API["API Server (NestJS)"]:::offchain
        Prover["Client Prover (Noir / UltraHonk)"]:::offchain
        Matcher["Matcher Engine (RISC Zero zkVM)"]:::offchain
        OracleKeeper["Oracle Keeper (Pyth Hermes)"]:::offchain
    end

    subgraph "3. On-Chain Settlement Layer (Soroban)"
        Pool["Shielded Pool (USDC Vault)"]:::onchain
        Settlement["Batch Settlement Contract"]:::onchain
        VerifierReg["Verifier Registry (Noir / Risc0)"]:::onchain
        Ledger["Proof Ledger (Double-spend Check)"]:::onchain
        PriceOracle["Price Oracle (SEP-40 Adapter)"]:::onchain
    end

    %% Flow connections
    Trader -->|1. Submit Intent| API
    Trader -->|2. Generate Proof| Prover
    Prover -->|3. Send Intent Proof| API
    
    Maker -->|Seed Liquidity Notes| API
    Maker -->|Sign Counter-Intent| API

    API -->|4. Match & Build Batch| Matcher
    OracleKeeper -->|Relay signed prices| PriceOracle
    
    Matcher -->|5. Match Journal + Groth16 Proof| Settlement
    
    Settlement -->|6. Verify zkVM execution| VerifierReg
    Settlement -->|7. Check nullifiers| Ledger
    Settlement -->|8. Settle notes & update margins| Pool
    Settlement -.->|Read mark price| PriceOracle
```

---

## 2. Structural Layer Breakdown

### 2.1 Client & Actor Layer (Private Intent)
*   **Traders**: Authenticate via Freighter-compatible wallets. The browser client creates a **Private Intent**—specifying asset, side, leverage, size, and slippage constraints—without disclosing identity or margin details on-chain.
*   **Makers**: Supply counterparty liquidity by shielding USDC collateral. Makers maintain private note commitments in the matching engine's database, allowing the matcher to auto-sign counter-intents.
*   **Proof Generation**: The client browser utilizes Noir to compile and output a succinct **UltraHonk Proof** certifying that the trader's notes have sufficient margin to cover the order size and that the owner's keys are cryptographically sound.

### 2.2 Off-Chain Execution Layer (zkVM Matching)
*   **API Gateway (NestJS)**: Serves as the central relayer. It processes incoming order intents, collects user proofs, coordinates maker counter-intents, and queues matches.
*   **Prover Worker**: Handles proof generation offloading when client hardware is resource-constrained.
*   **Matcher Engine (RISC Zero zkVM)**: 
  *   Runs deterministic matching rules inside a secure, sandboxed Guest Program.
  *   Accepts buyer/seller private intents, matches them at crossed prices, and splits margin notes.
  *   Outputs an **Execution Journal** along with a **RISC Zero Groth16 SNARK Proof** certifying the match occurred in strict compliance with the protocol rules.

### 2.3 On-Chain Settlement Layer (Soroban)
*   **Batch Settlement**: The entry point for relayer submissions. It unpacks the execution journal, reads the RISC Zero proof, and validates the match on-chain.
*   **Verifier Registry**: Holds WASM-based verifiers for both RISC Zero Groth16 proofs and Noir UltraHonk circuits.
*   **Shielded Pool**: Acts as the custody vault for collateral (USDC). It records note commitments (UTXO roots) and tracks spent note nullifiers to eliminate double-spending risks.
*   **Core Parameters**: Manages market risk specifications (max leverage, margin rates) and queries mark prices from the SEP-40 Price Oracle.

---

## 3. High-End Architecture Diagram Reference

Below is the detailed flow reference map outlining structural entities across the protocol lifecycle:

![PNLX Architecture Reference Map](architecture.png)
