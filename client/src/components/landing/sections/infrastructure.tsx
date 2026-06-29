export function LandingInfrastructureSection() {
  return (
    <section className="landing-dark-section landing-infrastructure-section">
      <div className="landing-section-copy">
        <h2>Match privately. Settle with proof.</h2>
        <span>
          Merkl keeps side, size, margin, and account state away from the public pre-trade path, then publishes
          proof-bound state updates for verification.
        </span>
      </div>

      <div className="landing-proof-candle-visual" aria-hidden="true">
        <div className="landing-private-candles">
          <span />
          <span />
          <span />
        </div>
        <div className="landing-proof-path">
          <svg
            aria-hidden="true"
            className="landing-proof-lock"
            fill="none"
            stroke="#f6efe9"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            viewBox="0 0 32 32"
          >
            <path d="M10 14V11C10 7.7 12.7 5 16 5s6 2.7 6 6v3" />
            <rect x="6.5" y="14" width="19" height="14" rx="3" />
          </svg>
        </div>
        <div className="landing-settlement-candle">
          <span />
        </div>
      </div>
    </section>
  );
}
