import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

const signalItems = ["Private Margin", "RISC0 Matching", "ZK Settlement", "Soroban-Native"];

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div className="landing-hero-content">
        <h1>Private Perpetuals on Stellar</h1>
        <p className="landing-hero-copy">
          Trade perpetuals without exposing your position, margin, strategy, or account state, with proof-backed settlement on Stellar.
        </p>

        <div className="landing-hero-actions">
          <Link className="landing-primary-cta" href="/trade">
            Launch App
            <ArrowRight size={18} />
          </Link>
        </div>

        <div className="landing-signal-row" aria-label="PNLX capabilities">
          {signalItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>

      <div className="landing-app-preview landing-trade-ui-preview" aria-label="PNLX trading interface preview">
        <Image alt="PNLX trading interface" height={1718} priority src="/trade-ui.png" width={3024} />
      </div>
    </section>
  );
}
