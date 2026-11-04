"use client";

import { useRef } from "react";
import { useInView } from "framer-motion";
import styles from "./privacy-section.module.css";

export function PrivacySection() {
  const illustrationRef = useRef<HTMLElement>(null);
  const entered = useInView(illustrationRef, { once: true, amount: 0.4 });

  return (
    <section id="protocol" className={styles.section} aria-labelledby="privacy-title">
      <div className={styles.copy}>
        <h2 id="privacy-title" className={styles.heading}>
          Private orders.<br /><span>Public proof.</span>
        </h2>
        <p>Your intent stays off the public order book. Proofs make settlement verifiable onchain.</p>
      </div>

      <figure
        ref={illustrationRef}
        className={styles.illustration}
        data-entered={entered}
        aria-label="Illustration of a private limit order intent and its public settlement proof"
      >
        <div className={styles.intent}>
          <div className={styles.candles} aria-hidden="true">
            <span /><span /><span />
          </div>
          <div className={styles.caption}>
            <h3 className={styles.label}>Your intent</h3>
            <p className={styles.intentText}>Buy XLM at $0.165</p>
          </div>
        </div>

        <div className={styles.connection} aria-hidden="true">
          <div className={styles.lane}><span className={styles.signal} /></div>
          <svg className={styles.lock} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path className={styles.shackle} d="M10 14v-3a6 6 0 0 1 12 0v3" />
            <rect x="7" y="14" width="18" height="14" rx="3" />
          </svg>
          <div className={styles.lane}><span className={`${styles.signal} ${styles.outputSignal}`} /></div>
        </div>

        <div className={styles.record}>
          <div className={styles.publicCandle} aria-hidden="true">
            <span>
              <code className={styles.cipher}>{`1a9e8c42
f105b36d
327a0c19
e8ab6214
0ef307a9
b5230d81
6f9a4e72
d65408cf
bd71a6f0
c82593e4
79c42a61
80ad7e26
09f56d83
b2147ca0`}</code>
            </span>
          </div>
          <div className={styles.caption}>
            <h3 className={styles.label}>Onchain record</h3>
            <code className={styles.digest}>0x1a9e8c…5408cf</code>
          </div>
        </div>
      </figure>
    </section>
  );
}
