import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

const landingLinks = [
  { label: "Product", href: "/trade" },
  { label: "Markets", href: "/trade" },
  { label: "Protocol", href: "/trade" },
];

export function LandingHeader() {
  return (
    <header className="landing-nav">
      <Link className="landing-brand" href="/" aria-label="Merkl home">
        <span>M</span>
        <strong>MERKL</strong>
      </Link>

      <nav className="landing-center-nav" aria-label="Landing navigation">
        {landingLinks.map((item) => (
          <Link href={item.href} key={item.label}>
            {item.label}
          </Link>
        ))}
      </nav>

      <nav className="landing-nav-actions" aria-label="Primary navigation">
        <Link className="landing-launch-button" href="/trade">
          Launch App
          <ArrowUpRight size={16} />
        </Link>
      </nav>
    </header>
  );
}
