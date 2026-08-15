import Image from "next/image";

export function LandingHero() {
  return (
    <section className="landing-hero">
      <div className="landing-app-preview landing-trade-ui-preview" aria-label="PNLX trading interface preview">
        <Image alt="PNLX trading interface" height={1712} priority src="/trade-ui.png" width={3024} />
      </div>
    </section>
  );
}
