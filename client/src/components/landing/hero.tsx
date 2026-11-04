"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { AppLink } from "./app-link";
import styles from "./hero.module.css";

export function Hero() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionPreference = () => {
      if (preference.matches) {
        video.pause();
      } else {
        void video.play().catch(() => video.pause());
      }
    };

    updateMotionPreference();
    preference.addEventListener("change", updateMotionPreference);
    return () => preference.removeEventListener("change", updateMotionPreference);
  }, []);

  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.media} aria-hidden="true">
        <video
          ref={videoRef}
          width={1920}
          height={1080}
          src="/landing/coast-hero.mp4"
          poster="/landing/coast-hero.jpg"
          muted
          loop
          playsInline
          preload="metadata"
          disablePictureInPicture
          tabIndex={-1}
        />
      </div>
      <div className={styles.shade} aria-hidden="true" />

      <div className={styles.content}>
        <h1 id="hero-title">
          <span>Usual markets, </span>
          <span>now private.</span>
        </h1>
        <div className={styles.actions}>
          <AppLink>Start trading</AppLink>
          <span className={styles.network}>
            on <Image src="/landing/stellar.png" alt="Stellar" width={80} height={20} />
          </span>
        </div>
      </div>
    </section>
  );
}
