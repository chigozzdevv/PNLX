"use client";

import { useEffect, useState } from "react";

const WORDS = ["intent", "size", "margin", "strategy"];
const SWAP_INTERVAL_MS = 2400;

export function HeroRotator() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % WORDS.length);
    }, SWAP_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="landing-hero-rotator" key={WORDS[index]}>
      {WORDS[index]}
    </span>
  );
}
