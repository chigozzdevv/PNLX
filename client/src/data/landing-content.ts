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
    body: "Margin, side, size and intent metadata stay out of the public mempool while the order is being prepared and matched.",
  },
  {
    title: "Keep markets verifiable",
    body: "Settlement still lands on-chain with the proof and state transitions needed for public verification.",
  },
  {
    title: "Built for perps risk",
    body: "The interface keeps margin, leverage, liquidation and position state close to the trade flow without exposing more than needed.",
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
    title: "Match privately",
    body: "Batches can match eligible intents without revealing every pre-settlement trade detail.",
  },
  {
    eyebrow: "03",
    title: "Prove settlement",
    body: "The resulting state transition is submitted with the verification data the protocol expects.",
  },
  {
    eyebrow: "04",
    title: "Manage risk",
    body: "Positions remain visible to the trader, while public state focuses on outcomes and constraints.",
  },
];

export const landingFeatureRows = [
  {
    title: "Private Margin.",
    body: "Fund trades from a shielded balance while keeping margin details and account state out of the public pre-trade path.",
  },
  {
    title: "Private Intents.",
    body: "Submit side, size and order details as private intent data instead of broadcasting them as plaintext order flow.",
  },
  {
    title: "Verified Settlement.",
    body: "Publish proof-backed state updates after matching, so the market can verify outcomes without seeing a trader's full book.",
  },
];
