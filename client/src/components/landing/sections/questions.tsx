const questions = [
  {
    answer:
      "No. PNLX publishes commitments, nullifiers, and proofs so accepted state transitions can be checked.",
    question: "Does private trading mean the market cannot verify trades?",
  },
  {
    answer:
      "The default collateral path is USDC on Stellar. Underlying perp markets can include XLM, BTC, ETH, SOL, and XRP without making those assets the collateral.",
    question: "What backs a position on PNLX?",
  },
  {
    answer:
      "Positions and margin are represented by commitments on-chain. In the current testnet, PNLX operators and hosted provers can read the underlying inputs. Boundless uploads may also be retrievable through their storage URLs.",
    question: "What stays private?",
  },
  {
    answer:
      "The matcher processes orders off-chain and produces a RISC0 batch execution proof. Soroban verifies the proof before finalizing settlement.",
    question: "Where does ZK fit?",
  },
  {
    answer:
      "No. Deposits and withdrawals can link activity to a wallet. Oracle prices, commitments, nullifiers, settlement timing, fee totals, and maker/taker intent relationships are also public.",
    question: "Is everything hidden?",
  },
  {
    question: "Is matching threshold encrypted?",
    answer:
      "Not yet. Threshold-encrypted intake and operator-blind matching remain future design work.",
  },
  {
    question: "Is my stop-loss price guaranteed?",
    answer:
      "No. Stops are best effort. Execution needs fresh prices, an available keeper or supported browser workflow, valid proofs, backed liquidity, and chain confirmation. Price gaps and delays can worsen or prevent an exit.",
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
