export const landingStats = [
  {
    label: "Private state",
    value: "Margin + Intent",
  },
  {
    label: "Execution",
    value: "Batched matching",
  },
  {
    label: "Settlement",
    value: "Proof verified",
  },
];

export const privacyPillars = [
  {
    title: "Trade without broadcasting your book",
    body: "Orders are matched off-chain. The current operator and hosted proving services receive plaintext trading inputs.",
  },
  {
    title: "Keep markets verifiable",
    body: "Settlement still lands on-chain with the proof and state transitions needed for public verification.",
  },
  {
    title: "Built for perps risk",
    body: "The testnet supports position and margin workflows. TP/SL execution depends on service availability, proof completion, and backed liquidity.",
  },
];

export const privatePublicRows = [
  {
    privateLabel: "Private margin balance",
    publicLabel: "Verified collateral transition",
  },
  {
    privateLabel: "Intent side and sizing",
    publicLabel: "Matched settlement outcome",
  },
  {
    privateLabel: "Pre-trade account state",
    publicLabel: "Market risk constraints",
  },
  {
    privateLabel: "Routing before match",
    publicLabel: "Proof-backed execution record",
  },
];

export const workflowSteps = [
  {
    eyebrow: "01",
    title: "Prepare intent",
    body: "Choose the market, side, margin and order type from a private trading balance.",
  },
  {
    eyebrow: "02",
    title: "Match off-chain",
    body: "The operator matches eligible plaintext intents and supplies the inputs to the configured batch prover.",
  },
  {
    eyebrow: "03",
    title: "Prove settlement",
    body: "The resulting state transition is submitted with the verification data the protocol expects.",
  },
  {
    eyebrow: "04",
    title: "Manage risk",
    body: "Positions are recoverable by the trader. Operators and hosted provers can also access the inputs used in these workflows.",
  },
];

export const landingFeatureRows = [
  {
    title: "Private Margin.",
    body: "Use commitment-based margin notes. Wallet deposits and withdrawals remain public, and hosted proof inputs are visible to their prover.",
  },
  {
    title: "Private Intents.",
    body: "Send trading inputs to the off-chain matcher. PNLX operators and hosted batch provers can read those inputs.",
  },
  {
    title: "Verified Settlement.",
    body: "Publish proofs and state updates for verification. Privacy also depends on the handling of plaintext inputs by matching and proving services.",
  },
];
