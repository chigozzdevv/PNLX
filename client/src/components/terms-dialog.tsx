"use client";

import { ArrowRight, ArrowUpRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { LANDING_PAGE_HREF, TERMS_INTRO, TERMS_SECTIONS } from "@/lib/terms";
import styles from "./terms-dialog.module.css";

export function TermsDialog({ onAccept }: { onAccept: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const landingRef = useRef<HTMLAnchorElement>(null);
  const [agreed, setAgreed] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (declined) landingRef.current?.focus({ preventScroll: true });
  }, [declined]);

  return (
    <dialog
      aria-labelledby={titleId}
      aria-modal="true"
      className={styles.dialog}
      closedby="none"
      ref={dialogRef}
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          return;
        }
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
        )].filter((control) => control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {declined ? (
        <div className={styles.declined}>
          <h2 className={styles.title} id={titleId} ref={titleRef} tabIndex={-1}>You chose not to continue</h2>
          <a className={styles.landing} href={LANDING_PAGE_HREF} ref={landingRef}>
            Return to landing page
            <ArrowUpRight aria-hidden="true" size={14} />
          </a>
        </div>
      ) : (
        <>
          <h2 className={styles.title} id={titleId} ref={titleRef} tabIndex={-1}>Terms of Service</h2>
          <div aria-label="Read the Terms of Service" className={styles.reading} role="region" tabIndex={0}>
            <div className={styles.document}>
              <p>{TERMS_INTRO}</p>
              {TERMS_SECTIONS.map((section) => (
                <section key={section.title}>
                  <h3>{section.title}</h3>
                  {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                </section>
              ))}
            </div>
          </div>
          <footer className={styles.footer}>
            <label className={styles.check}>
              <input checked={agreed} onChange={(event) => setAgreed(event.currentTarget.checked)} type="checkbox" />
              <span>I have read and agree to the <strong>Terms of Service.</strong></span>
            </label>
            <div className={styles.actions}>
              <button className={styles.action} onClick={() => setDeclined(true)} type="button">Decline</button>
              <button className={`${styles.action} ${styles.primary}`} disabled={!agreed} onClick={onAccept} type="button">
                Agree and continue
                <ArrowRight aria-hidden="true" size={15} />
              </button>
            </div>
          </footer>
        </>
      )}
    </dialog>
  );
}
