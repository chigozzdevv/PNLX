const tradingTools = [
  "Market and limit orders",
  "Private margin and leverage",
  "Best effort TP/SL execution",
  "Batch execution",
  "Proof-backed settlement",
];

export function LandingTradingExperienceSection() {
  return (
    <section className="landing-dark-section landing-trading-experience-section" id="perps">
      <div className="landing-trading-copy">
        <h2>Built for serious perps flow.</h2>
        <span>Explore the testnet trading flow. Operators and hosted provers can access sensitive trading inputs; stops do not guarantee an exit price.</span>
      </div>

      <ul className="landing-trading-tool-list" aria-label="PNLX trading tools">
        {tradingTools.map((tool) => (
          <li key={tool}>
            <span aria-hidden="true" />
            <strong>{tool}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
