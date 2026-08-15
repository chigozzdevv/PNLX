"use client";

import { useEffect, useState } from "react";

const WORDS = ["intent", "size", "margin", "strategy"];
const TYPE_MS = 85;
const DELETE_MS = 42;
const HOLD_MS = 1700;

export function HeroRotator() {
  const [wordIndex, setWordIndex] = useState(0);
  const [length, setLength] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const word = WORDS[wordIndex];
    if (!deleting && length === word.length) {
      const hold = window.setTimeout(() => setDeleting(true), HOLD_MS);
      return () => window.clearTimeout(hold);
    }
    if (deleting && length === 0) {
      const next = window.setTimeout(() => {
        setWordIndex((current) => (current + 1) % WORDS.length);
        setDeleting(false);
      }, 260);
      return () => window.clearTimeout(next);
    }
    const step = window.setTimeout(
      () => setLength((current) => current + (deleting ? -1 : 1)),
      deleting ? DELETE_MS : TYPE_MS,
    );
    return () => window.clearTimeout(step);
  }, [deleting, length, wordIndex]);

  return (
    <span className="landing-hero-rotator" aria-label={WORDS[wordIndex]}>
      {WORDS[wordIndex].slice(0, length)}
      <span className="landing-hero-caret" aria-hidden="true" />
    </span>
  );
}
