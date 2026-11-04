"use client";

import { useEffect, useState } from "react";
import { ToolIllustration, type ToolKind } from "./tool-illustrations";
import styles from "./tools-section.module.css";

interface TradingTool {
  id: ToolKind;
  title: string;
  detail: string;
}

const tools: TradingTool[] = [
  {
    id: "charts",
    title: "Charts & timeframes",
    detail: "Follow XLM/USD with candles from one minute to one day. Pan through price history or zoom in on a move.",
  },
  {
    id: "indicators",
    title: "Indicators & drawing tools",
    detail: "Overlay moving averages, add RSI or MACD, and draw directly on the chart to mark a level or measure a move.",
  },
  {
    id: "orders",
    title: "Market & limit orders",
    detail: "Go long or short with a market order, or choose your entry price with a limit order. Check the maximum taker fee before submitting.",
  },
  {
    id: "leverage",
    title: "Adjustable leverage",
    detail: "Choose your margin and leverage. The ticket shows how both affect your position size and estimated liquidation price.",
  },
  {
    id: "protection",
    title: "Take profit & stop loss",
    detail: "Set a take profit, a stop loss, or both. Enter a trigger price or choose a percentage return on your margin.",
  },
  {
    id: "positions",
    title: "Position management",
    detail: "See each position’s entry price, margin and unrealized P&L. Open its fill details or close the position from the same row.",
  },
];

type OpenFolder = { id: ToolKind; pinned: boolean };

export function ToolsSection() {
  const [open, setOpen] = useState<OpenFolder | null>(null);
  const isOpen = open !== null;

  useEffect(() => {
    if (!isOpen) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(null);
    }
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [isOpen]);

  return (
    <section id="tools" className={styles.section} aria-labelledby="tools-title">
      <h2 id="tools-title" className={styles.heading}>Everything you need<br />for your next trade.</h2>
      <div className={styles.folders}>
        {tools.map(({ id, title, detail }) => {
          const expanded = open?.id === id;
          const detailId = `tool-${id}-detail`;

          return (
            <article
              key={id}
              className={styles.folder}
              data-open={expanded}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") {
                  setOpen((current) => current?.id === id ? current : { id, pinned: false });
                }
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") {
                  setOpen((current) => current?.id === id && !current.pinned ? null : current);
                }
              }}
            >
              <div className={styles.pocket}>
                <div className={styles.sheet} id={detailId} aria-hidden={!expanded}>
                  <p>{detail}</p>
                </div>
                <div className={styles.cover} aria-hidden="true">
                  <div className={styles.art}><ToolIllustration kind={id} /></div>
                </div>
              </div>
              <h3 className={styles.label}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  aria-describedby={expanded ? detailId : undefined}
                  onClick={() => setOpen((current) => current?.id === id && current.pinned ? null : { id, pinned: true })}
                  onBlur={() => setOpen((current) => current?.id === id && current.pinned ? null : current)}
                >
                  {title}
                </button>
              </h3>
            </article>
          );
        })}
      </div>
    </section>
  );
}
