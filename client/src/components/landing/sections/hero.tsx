import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { HeroRotator } from "@/components/landing/sections/hero-rotator";

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div className="landing-hero-content">
        <h1>
          <span className="landing-hero-line">trade perpetuals with</span>
          <span className="landing-hero-line">
            fully private <HeroRotator />.
          </span>
        </h1>
        <div className="landing-hero-actions">
          <Link className="landing-primary-cta" href="/trade">
            Launch App
            <ArrowRight size={18} />
          </Link>
        </div>
      </div>
      <div className="landing-app-preview landing-trade-ui-preview" aria-label="PNLX trading interface preview">
        <Image alt="PNLX trading interface" height={1712} priority src="/trade-ui.png" width={3024} />
      </div>
    </section>
  );
}
