import Image from "next/image";
import { HeroRotator } from "@/components/landing/sections/hero-rotator";

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div className="landing-hero-content">
        <h1>
          <span className="landing-hero-line">Trade perps with</span>
          <span className="landing-hero-line">
            proof-backed <HeroRotator />.
          </span>
        </h1>
        <p>Testnet prototype. PNLX operators and hosted proving services can access order and position data.</p>
      </div>
      <div className="landing-app-preview landing-trade-ui-preview" aria-label="PNLX trading interface preview">
        <Image
          alt="PNLX trading interface"
          height={1712}
          priority
          sizes="(max-width: 560px) calc(100vw - 28px), (max-width: 1180px) calc(100vw - 40px), min(1520px, calc(100vw - 80px))"
          src="/trade-ui.png"
          width={3024}
        />
      </div>
    </section>
  );
}
