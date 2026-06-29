import { BadgeCheck, LockKeyhole } from "lucide-react";

const tradingControls = [
  ["Order type", "Market / Limit"],
  ["Margin", "Private balance"],
  ["Leverage", "Before submit"],
  ["Risk", "Checked"],
];

export function LandingTradingExperienceSection() {
  return (
    <section className="landing-dark-section landing-trading-experience-section">
      <div className="landing-section-copy landing-section-copy-front">
        <h2>
          Trading stays familiar.
          <br />
          Privacy stays built in.
        </h2>
        <span>
          Use market or limit orders, set margin and leverage, review size and risk, then submit. The protocol
          handles private intent flow and proof-backed settlement behind the trade.
        </span>
      </div>

      <div className="landing-trading-visual" aria-hidden="true">
        <div className="landing-execution-panel">
          <div className="landing-execution-controls">
            {tradingControls.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <div className="landing-execution-flow">
            <div className="landing-flow-node">
              <span>
                <LockKeyhole size={22} />
              </span>
              <strong>Private intent</strong>
              <em>Trade details stay off the public path</em>
            </div>

            <i />

            <div className="landing-flow-node landing-flow-node-proof">
              <span>
                <BadgeCheck size={22} />
              </span>
              <strong>Proof settlement</strong>
              <em>Outcome becomes verifiable</em>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
