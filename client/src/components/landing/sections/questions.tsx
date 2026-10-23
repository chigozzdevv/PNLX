const questions = [
  {
    answer:
      "PNLX publishes commitments, nullifiers, and proofs so accepted state transitions can be checked. The current operator and hosted provers can read the underlying trading data.",
    question: "Does private trading mean the market cannot verify trades?",
  },
  {
    answer:
      "The default collateral path is USDC on Stellar. Underlying perp markets can include XLM, BTC, ETH, SOL, and XRP without making those assets the collateral.",
    question: "What backs a position on PNLX?",
  },
  {
    answer:
      "Position and margin details are represented by commitments on-chain. PNLX operators and hosted provers receive plaintext proof inputs. Boundless input uploads may also be retrievable through their storage URLs. Wallet transfers and settlement metadata remain public.",
    question: "What stays private?",
  },
  {
    answer:
      "The matcher processes trading inputs off-chain and produces a RISC0 batch execution proof. Soroban verifies accepted proofs. A ZK proof does not hide its input from the service producing it.",
    question: "Where does ZK fit?",
  },
  {
    answer:
      "No. Oracle prices, commitments, nullifiers, settlement timing, fee totals, and maker/taker intent relationships are public. Funding and withdrawal transactions can link activity to a wallet.",
    question: "Is everything hidden?",
  },
  {
    question: "Is matching threshold encrypted?",
    answer:
      "The current testnet uses operator-run matching and hosted proving. Threshold-encrypted intake and operator-blind matching remain future design work.",
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
