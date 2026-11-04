import type { Metadata } from "next";
import Link from "next/link";
import { TERMS_SECTIONS } from "@/lib/terms";
import styles from "./terms.module.css";

export const metadata: Metadata = {
  title: "Terms of Service | PNLX",
};

export default function TermsPage() {
  return (
    <main className={styles.document}>
      <Link href="/#footer">Back to PNLX</Link>
      <h1>Terms of Service</h1>
      {TERMS_SECTIONS.map(({ title, paragraphs }) => (
        <section key={title}>
          <h2>{title}</h2>
          {paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </section>
      ))}
    </main>
  );
}
