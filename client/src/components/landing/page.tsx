import Image from "next/image";
import Link from "next/link";
import { AppLink } from "./app-link";
import { Hero } from "./hero";
import { Navigation } from "./navigation";
import { PrivacySection } from "./privacy-section";
import { TradeWalkthrough } from "./trade-walkthrough";
import { ToolsSection } from "./tools-section";
import styles from "./landing.module.css";

export function LandingPage() {
  return (
    <div className={styles.page} id="top">
      <Navigation />
      <main>
        <Hero />
        <TradeWalkthrough />
        <PrivacySection />
        <ToolsSection />
        <section id="get-started" className={styles.closing} aria-labelledby="closing-title">
          <h2 id="closing-title">Try PNLX on Testnet.</h2>
          <AppLink>Launch app</AppLink>
        </section>
      </main>
      <footer id="footer" className={styles.footer}>
        <a href="#top" aria-label="PNLX, back to top">
          <Image alt="" src="/pnlx-logo.png" width={92} height={17} />
        </a>
        <nav aria-label="Footer">
          <Link href="/survey">Survey</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </footer>
    </div>
  );
}
