import { LandingHeader } from "@/components/landing/sections/header";
import { LandingHero } from "@/components/landing/sections/hero";
import { LandingInfrastructureSection } from "@/components/landing/sections/infrastructure";
import { LandingPrivacySection } from "@/components/landing/sections/privacy";
import { LandingTradingExperienceSection } from "@/components/landing/sections/trading-experience";

export function LandingPage() {
  return (
    <main className="landing-shell">
      <LandingHeader />
      <LandingHero />
      <LandingPrivacySection />
      <LandingInfrastructureSection />
      <LandingTradingExperienceSection />
    </main>
  );
}
