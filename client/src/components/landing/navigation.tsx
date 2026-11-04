"use client";

import { useEffect, useRef } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { AppLink } from "./app-link";
import styles from "./navigation.module.css";

const links = [
  { label: "Product", href: "#product" },
  { label: "Privacy", href: "#protocol" },
  { label: "Tools", href: "#tools" },
  { label: "Survey", href: "/survey" },
];

export function Navigation() {
  const mobileMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeMenuOutside = (event: PointerEvent) => {
      const menu = mobileMenuRef.current;
      if (menu && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };

    document.addEventListener("pointerdown", closeMenuOutside);
    return () => document.removeEventListener("pointerdown", closeMenuOutside);
  }, []);

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="PNLX home">
        <Image alt="PNLX" src="/pnlx-logo.png" width={166} height={31} priority />
      </Link>

      <nav className={styles.navigation} aria-label="Main navigation">
        {links.map((link) => (
          <a href={link.href} key={link.label}>
            {link.label}
          </a>
        ))}
      </nav>

      <div className={styles.headerActions}>
        <AppLink>Launch app</AppLink>

        <details
          ref={mobileMenuRef}
          className={styles.mobileMenu}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-label="Toggle navigation menu">
            <Menu className={styles.menuOpen} size={19} aria-hidden="true" />
            <X className={styles.menuClose} size={19} aria-hidden="true" />
          </summary>
          <nav className={styles.mobileNavigation} aria-label="Mobile navigation">
            {links.map((link) => (
              <a
                href={link.href}
                key={link.label}
                onClick={() => {
                  if (mobileMenuRef.current) mobileMenuRef.current.open = false;
                }}
              >
                {link.label}
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            ))}
          </nav>
        </details>
      </div>
    </header>
  );
}
