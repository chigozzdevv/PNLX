import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { LandingAppPreview } from "@/components/landing/app-preview";

const signalItems = ["Private margin", "Private matching", "Proof settlement", "Stellar native"];

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div className="landing-hero-content">
        <h1>Private Perpetuals on Stellar</h1>
        <p className="landing-hero-copy">
          Trade leveraged markets with private margin and private intents, then settle with ZK-verifiable proofs.
        </p>

        <div className="landing-hero-actions">
          <Link className="landing-primary-cta" href="/trade">
            Launch App
            <ArrowRight size={18} />
          </Link>
        </div>

        <div className="landing-signal-row" aria-label="Merkl capabilities">
          {signalItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>

      <LandingAppPreview />
    </section>
  );
}
