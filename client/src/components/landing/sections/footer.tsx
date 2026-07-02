import Image from "next/image";
import Link from "next/link";

const footerLinks = [
  { label: "Product", href: "#product" },
  { label: "Perps", href: "#perps" },
  { label: "Protocol", href: "#protocol" },
  { label: "Questions", href: "#questions" },
  { label: "Launch App", href: "/trade" },
];

export function LandingFooter() {
  return (
    <footer className="landing-footer">
      <Link className="landing-footer-brand" href="/" aria-label="PNLX home">
        <Image alt="PNLX" height={31} src="/pnlx-logo.png" width={166} />
      </Link>

      <nav className="landing-footer-links" aria-label="Footer navigation">
        {footerLinks.map((item) => (
          <Link href={item.href} key={item.label}>
            {item.label}
          </Link>
        ))}
      </nav>

      <p>2026 PNLX. Private perpetuals with verifiable settlement.</p>
    </footer>
  );
}
