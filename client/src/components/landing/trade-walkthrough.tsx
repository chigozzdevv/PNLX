"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from "framer-motion";
import styles from "./trade-walkthrough.module.css";

const steps = [
  {
    title: "Follow the market",
    description: "Explore price movements with charts and market data.",
    alt: "The chart and market data in the PNLX trading interface.",
    scale: 1.38,
    x: -3.82,
    y: -5.2,
  },
  {
    title: "Set up your trade",
    description: "Choose long or short, set your size and leverage, then review your order.",
    alt: "The PNLX trade ticket with margin, leverage and order controls.",
    scale: 2.6,
    x: -160,
    y: -55.3,
  },
  {
    title: "Manage your positions",
    description: "Track your positions and P&L, and close when you’re ready.",
    alt: "Open positions, P&L and close controls in PNLX.",
    scale: 1.75,
    x: -30,
    y: -75,
  },
];

const stops = [0, 0.2, 0.32, 0.42, 0.59, 0.71, 0.89, 1];
const scaleStops = [1, 1, steps[0].scale, steps[0].scale, steps[1].scale, steps[1].scale, steps[2].scale, steps[2].scale];
const xStops = ["0%", "0%", `${steps[0].x}%`, `${steps[0].x}%`, `${steps[1].x}%`, `${steps[1].x}%`, `${steps[2].x}%`, `${steps[2].x}%`];
const yStops = ["0%", "0%", `${steps[0].y}%`, `${steps[0].y}%`, `${steps[1].y}%`, `${steps[1].y}%`, `${steps[2].y}%`, `${steps[2].y}%`];

export function TradeWalkthrough() {
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  const reducedMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ["start 60%", "end 70%"],
  });
  const scale = useTransform(scrollYProgress, stops, scaleStops);
  const x = useTransform(scrollYProgress, stops, xStops);
  const y = useTransform(scrollYProgress, stops, yStops);

  useMotionValueEvent(scrollYProgress, "change", (progress) => {
    setActiveStep(progress < 0.5 ? 0 : progress < 0.8 ? 1 : 2);
  });

  return (
    <section id="product" className={styles.section} aria-labelledby="product-title">
      <h2 id="product-title" className={styles.heading}>
        Your trading desk,
        <br />
        in one view.
      </h2>
      <div ref={trackRef} className={styles.scrollTrack}>
        <div className={styles.layout}>
          <div className={styles.copy}>
            <ol className={styles.steps}>
              {steps.map((step, index) => (
                <li className={styles.step} data-active={activeStep === index} key={step.title}>
                  <div className={styles.stepText}>
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                  <div className={styles.mobileVisual}>
                    <div
                      className={styles.image}
                      style={{ transform: index === 0 ? undefined : `translate(${step.x}%, ${step.y}%) scale(${step.scale})` }}
                    >
                      <Image
                        src="/landing/trade-interface.png"
                        alt={step.alt}
                        width={3024}
                        height={1718}
                        unoptimized
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className={styles.visualColumn}>
            <div className={styles.frame}>
              <motion.div
                className={styles.image}
                style={{
                  scale: reducedMotion ? 1 : scale,
                  x: reducedMotion ? 0 : x,
                  y: reducedMotion ? 0 : y,
                }}
              >
                <Image
                  src="/landing/trade-interface.png"
                  alt="PNLX trading interface showing the XLM/USD chart, trade ticket and open positions."
                  width={3024}
                  height={1718}
                  unoptimized
                />
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
