import { LandingCtaSection } from "@/components/landing/sections/cta";
import { LandingFooter } from "@/components/landing/sections/footer";
import { LandingHeader } from "@/components/landing/sections/header";
import { LandingHero } from "@/components/landing/sections/hero";
import { LandingInfrastructureSection } from "@/components/landing/sections/infrastructure";
import { LandingPrivacySection } from "@/components/landing/sections/privacy";
import { LandingQuestionsSection } from "@/components/landing/sections/questions";
import { LandingTradingExperienceSection } from "@/components/landing/sections/trading-experience";
import { LandingVerifiabilitySection } from "@/components/landing/sections/verifiability";

export function LandingPage() {
  return (
    <main className="landing-shell">
      <LandingHeader />
      <LandingHero />
      <LandingPrivacySection />
      <LandingInfrastructureSection />
      <LandingTradingExperienceSection />
      <LandingVerifiabilitySection />
      <LandingQuestionsSection />
      <LandingCtaSection />
      <LandingFooter />
    </main>
  );
}
