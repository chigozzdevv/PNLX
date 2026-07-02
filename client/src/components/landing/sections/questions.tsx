const questions = [
  {
    answer:
      "No. PNLX hides user-level trading state by default, then publishes proof-backed state transitions so accepted outcomes remain checkable.",
    question: "Does private trading mean the market cannot verify trades?",
  },
  {
    answer:
      "The default collateral path is USDC on Stellar. Underlying perp markets can include XLM, BTC, ETH, SOL, and XRP without making those assets the collateral.",
    question: "What backs a position on PNLX?",
  },
  {
    answer:
      "Side, size, margin, leverage, TP/SL, liquidation levels, and account state stay private by default. Aggregate market data remains public.",
    question: "What stays private?",
  },
  {
    answer:
      "Matching is designed around MPC-backed batch execution, while settlement is verified with ZK proofs and finalized through Soroban contracts on Stellar.",
    question: "Where do MPC and ZK fit?",
  },
  {
    answer:
      "No. Markets still need public aggregate activity, funding, open interest, and oracle prices so traders can understand market health.",
    question: "Is everything hidden?",
  },
];

export function LandingQuestionsSection() {
  return (
    <section className="landing-questions-section" id="questions">
      <div className="landing-questions-heading">
        <h2>Questions and Answers.</h2>
        <p>Clear answers on privacy, collateral, matching, and what remains public.</p>
      </div>

      <div className="landing-questions-list">
        {questions.map((item) => (
          <details key={item.question}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
