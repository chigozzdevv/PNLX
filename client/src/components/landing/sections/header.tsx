"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

const landingLinks = [
  { label: "Product", href: "#product" },
  { label: "Perps", href: "#perps" },
  { label: "Protocol", href: "#protocol" },
];

export function LandingHeader() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const updateScrollState = () => setIsScrolled(window.scrollY > 8);

    updateScrollState();
    window.addEventListener("scroll", updateScrollState, { passive: true });

    return () => window.removeEventListener("scroll", updateScrollState);
  }, []);

  return (
    <header className={`landing-nav${isScrolled ? " landing-nav-scrolled" : ""}`}>
      <Link className="landing-brand" href="/" aria-label="PNLX home">
        <Image
          alt="PNLX"
          className="landing-brand-logo"
          height={31}
          priority
          src="/pnlx-logo.png"
          width={166}
        />
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
