export const TERMS_VERSION = "2026-11-02";
export const TERMS_STORAGE_KEY = "pnlx.terms.acceptance";
export const LANDING_PAGE_HREF = "https://pnlx.trade/";

export function hasCurrentTermsAcceptance(value: string | null): boolean {
  if (!value) return false;
  try {
    const saved: unknown = JSON.parse(value);
    return Boolean(saved && typeof saved === "object" && "version" in saved && saved.version === TERMS_VERSION);
  } catch {
    return false;
  }
}

export const TERMS_INTRO = "Please read these terms before using PNLX. By selecting “Agree and continue”, you agree to follow them. If you do not agree, select “Decline”.";

export const TERMS_SECTIONS = [
  {
    title: "1. About PNLX",
    paragraphs: [
      "PNLX lets you trade perpetual futures on Stellar using private orders and settlement verified by cryptographic proofs.",
      "The testnet lets you trade using Circle’s testnet USDC as collateral on Stellar Testnet. Testnet USDC is for testing and cannot be redeemed for dollars. Testnet balances and positions may be reset as development continues.",
    ],
  },
  {
    title: "2. Who can use PNLX",
    paragraphs: [
      "You must be at least 18 and legally able to enter into this agreement. If you use PNLX for a company, you must have permission to accept these terms on its behalf.",
      "PNLX is not available to anyone located in or resident in the United States, mainland China, Algeria, Bangladesh, Nepal, Cuba, Iran or North Korea. It is also unavailable in Crimea and the parts of the Donetsk and Luhansk regions of Ukraine covered by applicable sanctions. Businesses registered or mainly based in any of these locations cannot use PNLX.",
      "You must not be subject to applicable sanctions or act for a person or company that is. These restrictions also apply anywhere the law prohibits crypto trading, crypto derivatives or access to PNLX.",
      "Do not use a VPN, false location details, another person’s account or any other method to bypass these restrictions.",
    ],
  },
  {
    title: "3. Your wallet",
    paragraphs: [
      "Use a wallet you own or are authorized to use. Check the wallet address and network before approving an action. Keep your private keys and recovery information secure. You are responsible for the transactions you authorize.",
      "Connecting a wallet does not give PNLX access to your private keys. Deposited collateral is held and managed by the protocol’s smart contracts under its trading and settlement rules.",
    ],
  },
  {
    title: "4. Orders and settlement",
    paragraphs: [
      "Margin is the collateral set aside for your trade. Your margin locks on submission, and proof verification may delay fills.",
      "“Order submitted” means your order has been accepted for processing. It does not mean the order is filled. Matching, proof verification and blockchain confirmation must complete before settlement.",
      "Market orders may fill at a different price from the estimate, within the slippage you allow. Limit orders may remain unfilled. Closing a position or cancelling an order can also take time. Collateral becomes available after the required steps are confirmed.",
    ],
  },
  {
    title: "5. Leverage and liquidation",
    paragraphs: [
      "Leverage increases both gains and losses. Your position may be liquidated if its collateral falls below the required maintenance margin. You can lose the collateral assigned to that position.",
      "Prices, profit and loss, and liquidation estimates can change. Chart prices may differ from your execution price. Take-profit and stop-loss settings do not guarantee a particular fill price.",
    ],
  },
  {
    title: "6. Fees and funding",
    paragraphs: [
      "Trading fees, network fees and funding payments may apply. Funding is a periodic payment between long and short positions. Rates can change, and funding can increase or reduce your collateral.",
      "Review the fees, funding information and order details shown in the app before submitting a trade. Estimates may differ from the final amounts.",
    ],
  },
  {
    title: "7. Deposits and withdrawals",
    paragraphs: [
      "Deposits need confirmation before they can be used. Only available collateral can be withdrawn. Collateral tied to an order or open position must be released first.",
      "A withdrawal may remain pending while proofs and blockchain confirmations are completed. Check the receiving wallet and network carefully. Confirmed blockchain transactions generally cannot be reversed.",
    ],
  },
  {
    title: "8. Privacy and availability",
    paragraphs: [
      "PNLX uses cryptographic proofs and commitments to keep parts of your trading activity private. Your wallet address and public blockchain transactions may still be visible. Privacy features do not make every action anonymous.",
      "PNLX depends on blockchain networks, price feeds, matching and proof services. Bugs, incorrect data, maintenance and service interruptions can delay trading or access to balances. Execution times, uninterrupted access and error-free operation are not guaranteed.",
    ],
  },
  {
    title: "9. Responsible use",
    paragraphs: [
      "Do not use PNLX for fraud, money laundering, sanctions evasion, market manipulation, theft or attacks on other users or the service.",
      "Market data and other information in PNLX are provided for information, not as personal investment, legal or tax advice. You are responsible for deciding whether a trade is suitable for you.",
    ],
  },
  {
    title: "10. Changes to these terms",
    paragraphs: [
      "These terms may change as PNLX develops or legal requirements change. You will be asked to review and accept a new version before continuing to use the app. If you do not agree to the updated terms, do not submit new trades.",
    ],
  },
] as const;
