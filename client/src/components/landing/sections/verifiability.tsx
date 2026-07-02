const trustLayerItems = [
  "Commitments/nullifiers",
  "MPC-backed batch execution",
  "ZK margin, liquidation, and position circuits",
  "Soroban settlement",
  "Public aggregate market data",
];

const candleBars = [
  "landing-verifiable-candle-a",
  "landing-verifiable-candle-b",
  "landing-verifiable-candle-c",
  "landing-verifiable-candle-d",
  "landing-verifiable-candle-e",
  "landing-verifiable-candle-f",
  "landing-verifiable-candle-g",
  "landing-verifiable-candle-h",
  "landing-verifiable-candle-i",
];

export function LandingVerifiabilitySection() {
  return (
    <section className="landing-verifiable-section" id="protocol">
      <div className="landing-verifiable-candles" aria-hidden="true">
        {candleBars.map((bar) => (
          <span className={bar} key={bar} />
        ))}
      </div>

      <div className="landing-verifiable-copy">
        <h2>How PNLX stays verifiable.</h2>
        <p>
          Private execution does not remove public verification. PNLX keeps trader state hidden while commitments, ZK
          proofs, and Soroban settlement make every accepted state transition checkable.
        </p>

        <div className="landing-verifiable-list" aria-label="PNLX trust layer">
          {trustLayerItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
