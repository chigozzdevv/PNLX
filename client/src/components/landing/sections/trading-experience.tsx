const tradingTools = [
  "Market and limit orders",
  "Private margin and leverage",
  "Hidden TP/SL and liquidation levels",
  "Batch execution",
  "Proof-backed settlement",
];

export function LandingTradingExperienceSection() {
  return (
    <section className="landing-dark-section landing-trading-experience-section" id="perps">
      <div className="landing-trading-copy">
        <h2>Built for serious perps flow.</h2>
        <span>PNLX ships with the tools traders expect, while sensitive trading state stays private by default.</span>
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
