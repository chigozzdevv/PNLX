import Link from "next/link";

export function LandingCtaSection() {
  return (
    <section className="landing-cta-section">
      <div className="landing-cta-copy">
        <h2>Trade private perps on Stellar.</h2>
        <p>Connect your Stellar wallet and trade with shielded state, private execution, and proof-backed settlement.</p>
      </div>

      <Link className="landing-cta-button" href="/trade">
        Start Trading
      </Link>
    </section>
  );
}
