"use client";

import { motion } from "framer-motion";
import { CircleDollarSign } from "lucide-react";
import { useMemo, useState } from "react";
import { formatNumber, formatUsd, shortAddress } from "@/lib/format";
import type { SubmitTradeIntentResult, TradeSubmitStage } from "@/lib/trade-submit";
import type { MarketDisplay, OrderDraft, Side } from "@/types/trading";

interface OrderTicketProps {
  connected?: boolean;
  market: MarketDisplay;
  onDeposit?: (input: OrderTicketDepositInput) => Promise<void>;
  onSubmit?: (input: OrderTicketSubmitInput) => Promise<SubmitTradeIntentResult>;
  order: OrderDraft;
  privateBalance?: number | null;
}

export interface OrderTicketSubmitInput {
  collateralAsset: "USDC";
  leverage: number;
  limitPrice: number;
  margin: number;
  onProgress?: (stage: TradeSubmitStage) => void;
  orderType?: "market" | "limit";
  side: Side;
  sizingPrice?: number;
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
}

export interface OrderTicketDepositInput {
  amount: number;
  collateralAsset: "USDC";
  onProgress?: (stage: TradeSubmitStage) => void;
}

type ConditionMode = "percent" | "price";

export function OrderTicket({
  connected = false,
  market,
  onDeposit,
  onSubmit,
  order,
  privateBalance,
}: OrderTicketProps) {
  const [side, setSide] = useState<Side>(order.side);
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [tpSlEnabled, setTpSlEnabled] = useState(false);
  const [conditionMode, setConditionMode] = useState<ConditionMode>("percent");
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [submitStage, setSubmitStage] = useState<TradeSubmitStage | undefined>();
  const [submitSuccess, setSubmitSuccess] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [margin, setMargin] = useState(order.collateral);
  const [limitPrice, setLimitPrice] = useState(market.price);
  const [slippagePercent, setSlippagePercent] = useState(0.5);
  const [leverage, setLeverage] = useState(Math.min(order.leverage, market.maxLeverage));
  const [takeProfitPrice, setTakeProfitPrice] = useState(
    order.takeProfitPrice ?? defaultTakeProfit(order.side, market.price, order.leverage),
  );
  const [stopLossPrice, setStopLossPrice] = useState(
    order.stopLossPrice ?? defaultStopLoss(order.side, market.price, order.leverage),
  );

  const activePrice = orderType === "market" ? market.price : limitPrice;
  const executionLimitPrice = orderType === "market"
    ? marketLimitPrice(side, market.price, slippagePercent)
    : limitPrice;
  const exposure = margin * leverage;
  const size = activePrice > 0 ? exposure / activePrice : 0;
  const takeProfitPnl = estimatePnl(side, size, activePrice, takeProfitPrice);
  const stopLossPnl = estimatePnl(side, size, activePrice, stopLossPrice);
  const takeProfitPercent = percentFromPnl("tp", takeProfitPnl, margin);
  const stopLossPercent = percentFromPnl("sl", stopLossPnl, margin);
  const canSubmit = connected && Boolean(onSubmit) && !submitting && !depositing;
  const canDeposit = connected && Boolean(onDeposit) && !depositing && margin > 0;
  const liquidationPrice = useMemo(() => {
    const riskMove = leverage > 0 ? 1 / leverage - market.maintenanceMarginRate : 0;
    return side === "long" ? activePrice * (1 - riskMove) : activePrice * (1 + riskMove);
  }, [activePrice, leverage, market.maintenanceMarginRate, side]);

  function selectSide(nextSide: Side) {
    setSide(nextSide);
    setTakeProfitPrice(defaultTakeProfit(nextSide, activePrice, leverage));
    setStopLossPrice(defaultStopLoss(nextSide, activePrice, leverage));
  }

  function updateLeverage(value: number) {
    const nextLeverage = clampLeverage(value, market.maxLeverage);
    const currentTakeProfitPercent = takeProfitPercent;
    const currentStopLossPercent = stopLossPercent;

    setLeverage(nextLeverage);

    if (conditionMode === "percent") {
      setTakeProfitPrice(priceFromPercent("tp", side, activePrice, currentTakeProfitPercent, nextLeverage));
      setStopLossPrice(priceFromPercent("sl", side, activePrice, currentStopLossPercent, nextLeverage));
    }
  }

  function updateTakeProfitPercent(value: number) {
    setTakeProfitPrice(priceFromPercent("tp", side, activePrice, value, leverage));
  }

  function updateStopLossPercent(value: number) {
    setStopLossPrice(priceFromPercent("sl", side, activePrice, value, leverage));
  }

  async function submitOrder() {
    if (!connected) {
      setSubmitError("Connect a wallet first");
      return;
    }
    if (!onSubmit) {
      setSubmitError("Trading submission is not configured");
      return;
    }

    setSubmitError(undefined);
    setSubmitSuccess(undefined);
    setSubmitStage("hashing");
    setSubmitting(true);
    try {
      const result = await onSubmit({
        collateralAsset: order.collateralAsset,
        leverage,
        limitPrice: executionLimitPrice,
        margin,
        onProgress: setSubmitStage,
        orderType,
        side,
        sizingPrice: activePrice,
        stopLossPrice: tpSlEnabled ? stopLossPrice : null,
        takeProfitPrice: tpSlEnabled ? takeProfitPrice : null,
      });
      setSubmitStage("done");
      setSubmitSuccess(`Intent ${shortAddress(result.intent.intentCommitment)} submitted`);
    } catch (error) {
      setSubmitStage(undefined);
      setSubmitError(error instanceof Error ? error.message : "Trade submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function depositMargin() {
    if (!connected) {
      setSubmitError("Connect a wallet first");
      return;
    }
    if (!onDeposit) {
      setSubmitError("Deposit is not configured");
      return;
    }

    setSubmitError(undefined);
    setSubmitSuccess(undefined);
    setSubmitStage("shielding");
    setDepositing(true);
    try {
      await onDeposit({
        amount: margin,
        collateralAsset: order.collateralAsset,
        onProgress: setSubmitStage,
      });
      setSubmitStage("done");
      setSubmitSuccess(`${formatUsd(margin, { maximumFractionDigits: 2 })} deposited`);
    } catch (error) {
      setSubmitStage(undefined);
      setSubmitError(error instanceof Error ? error.message : "Deposit failed");
    } finally {
      setDepositing(false);
    }
  }

  return (
    <section className="panel order-ticket">
      <div className="ticket-heading">
        <p>Trade</p>
        <span>{market.pair}</span>
      </div>

      <div className="side-selector">
        <button
          className={`side-button side-button-long ${side === "long" ? "side-button-active" : ""}`}
          type="button"
          onClick={() => selectSide("long")}
        >
          <span>Long</span>
        </button>
        <button
          className={`side-button side-button-short ${side === "short" ? "side-button-active" : ""}`}
          type="button"
          onClick={() => selectSide("short")}
        >
          <span>Short</span>
        </button>
      </div>

      <div className="execution-selector">
        <div
          aria-label="Order type"
          className="grid grid-cols-2 gap-1 rounded-[6px] border border-white/10 bg-white/[0.035] p-1"
        >
          <button
            className={`min-h-9 rounded-[4px] text-sm font-black ${
              orderType === "market" ? "bg-[var(--surface-soft)] text-white" : "text-[var(--text-muted)]"
            }`}
            type="button"
            onClick={() => setOrderType("market")}
          >
            Market
          </button>
          <button
            className={`min-h-9 rounded-[4px] text-sm font-black ${
              orderType === "limit" ? "bg-[var(--surface-soft)] text-white" : "text-[var(--text-muted)]"
            }`}
            type="button"
            onClick={() => setOrderType("limit")}
          >
            Limit
          </button>
        </div>
      </div>

      {orderType === "limit" ? (
        <div className="ticket-field">
          <div className="field-label">
            <span>Limit Price</span>
          </div>
          <div className="field-control">
            <input
              aria-label="Limit price"
              inputMode="decimal"
              value={limitPrice}
              onChange={(event) => setLimitPrice(Number(event.target.value) || 0)}
            />
            <span className="asset-pill">{market.quoteAsset}</span>
          </div>
        </div>
      ) : (
        <div className="ticket-field">
          <div className="field-label">
            <span>Slippage</span>
          </div>
          <div className="field-control">
            <input
              aria-label="Market slippage"
              inputMode="decimal"
              value={slippagePercent}
              onChange={(event) => setSlippagePercent(clamp(Number(event.target.value) || 0, 0.01, 20))}
            />
            <span className="asset-pill">%</span>
          </div>
        </div>
      )}

      <div className="ticket-field">
        <div className="field-label">
          <span>Private Margin</span>
          <strong className="field-balance">
            {privateBalance === null || privateBalance === undefined
              ? "Private"
              : formatUsd(privateBalance, { maximumFractionDigits: 2 })}
          </strong>
        </div>
        <div className="field-control">
          <input
            aria-label="Private margin"
            inputMode="decimal"
            value={margin}
            onChange={(event) => setMargin(Math.max(Number(event.target.value) || 0, 0))}
          />
          <div className="asset-pill">
            <CircleDollarSign size={18} />
            {order.collateralAsset}
          </div>
        </div>
        <button
          className="secondary-ticket-button"
          disabled={!canDeposit}
          type="button"
          onClick={depositMargin}
        >
          {depositing ? "Depositing" : "Deposit"}
        </button>
      </div>

      <div className="ticket-field">
        <div className="field-label">
          <span>Leverage</span>
          <strong>{formatNumber(leverage, 2)}x</strong>
        </div>
        <div className="leverage-control">
          <div className="leverage-buttons" aria-label="Leverage presets">
            {[2, 3, 5, 10].map((preset) => (
              <button
                className={`leverage-button ${leverage === preset ? "leverage-button-active" : ""}`}
                disabled={preset > market.maxLeverage}
                key={preset}
                type="button"
                onClick={() => updateLeverage(preset)}
              >
                {preset}x
              </button>
            ))}
          </div>
          <div className="leverage-input">
            <input
              aria-label="Custom leverage"
              inputMode="decimal"
              max={market.maxLeverage}
              min={1}
              step={0.1}
              type="number"
              value={leverage}
              onChange={(event) => updateLeverage(Number(event.target.value) || 1)}
            />
            <span>x</span>
          </div>
        </div>
      </div>

      <div className="ticket-field">
        <div className="field-label">
          <span>Position Size</span>
        </div>
        <div className="field-control">
          <strong className="field-value">{formatNumber(size, 6)}</strong>
          <span className="asset-pill">{market.baseAsset}</span>
        </div>
      </div>

      <div className="ticket-field conditional-field">
        <div className="field-label">
          <span>TP / SL</span>
          <button
            aria-pressed={tpSlEnabled}
            className={`toggle-switch ${tpSlEnabled ? "toggle-switch-active" : ""}`}
            type="button"
            onClick={() => setTpSlEnabled((enabled) => !enabled)}
          >
            <span />
          </button>
        </div>
        {tpSlEnabled ? (
          <>
            <div className="condition-mode-control" aria-label="TP SL input mode">
              <button
                className={`condition-mode-button ${
                  conditionMode === "percent" ? "condition-mode-button-active" : ""
                }`}
                type="button"
                onClick={() => setConditionMode("percent")}
              >
                %
              </button>
              <button
                className={`condition-mode-button ${conditionMode === "price" ? "condition-mode-button-active" : ""}`}
                type="button"
                onClick={() => setConditionMode("price")}
              >
                Price
              </button>
            </div>
            <div className="condition-grid">
              <ConditionInput
                label="TP"
                mode={conditionMode}
                pnl={takeProfitPnl}
                percent={takeProfitPercent}
                price={takeProfitPrice}
                onPercentChange={updateTakeProfitPercent}
                onPriceChange={setTakeProfitPrice}
              />
              <ConditionInput
                label="SL"
                mode={conditionMode}
                pnl={stopLossPnl}
                percent={stopLossPercent}
                price={stopLossPrice}
                onPercentChange={updateStopLossPercent}
                onPriceChange={setStopLossPrice}
              />
            </div>
          </>
        ) : null}
      </div>

      <motion.button
        className="primary-trade-button"
        data-side={side}
        disabled={!canSubmit}
        type="button"
        onClick={submitOrder}
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.99 }}
      >
        {!connected ? "Connect Wallet" : submitting ? "Submitting" : side === "long" ? "Submit Long" : "Submit Short"}
      </motion.button>

      <TradeProgress stage={submitStage} />

      {submitError ? (
        <p className="ticket-message ticket-message-error" role="alert" title={submitError}>
          {submitError}
        </p>
      ) : null}
      {submitSuccess ? <p className="ticket-message ticket-message-success">{submitSuccess}</p> : null}

      <div className="ticket-summary">
        <SummaryRow label="Position Size" value={`${formatNumber(size, 6)} ${market.baseAsset}`} />
        <SummaryRow label="Exposure" value={formatUsd(exposure, { maximumFractionDigits: 2 })} />
        <SummaryRow label="Private Margin" value={formatUsd(margin, { maximumFractionDigits: 2 })} />
        <SummaryRow label="Leverage" value={`${formatNumber(leverage, 2)}x`} />
        <SummaryRow label="Liquidation Price" value={formatNumber(liquidationPrice, market.price < 10 ? 4 : 1)} />
        {orderType === "market" ? (
          <SummaryRow
            label={side === "long" ? "Max Fill" : "Min Fill"}
            value={formatNumber(executionLimitPrice, market.price < 10 ? 4 : 1)}
          />
        ) : null}
      </div>
    </section>
  );
}

const TRADE_PROGRESS: Array<{ id: TradeSubmitStage; label: string }> = [
  { id: "hashing", label: "Hash" },
  { id: "shielding", label: "Shield" },
  { id: "signing", label: "Sign" },
  { id: "proving", label: "Proof" },
  { id: "matching", label: "Match" },
];

function TradeProgress({ stage }: { stage?: TradeSubmitStage }) {
  if (!stage) return null;
  const activeIndex = stage === "done"
    ? TRADE_PROGRESS.length
    : TRADE_PROGRESS.findIndex((step) => step.id === stage);

  return (
    <div className="trade-progress" aria-label="Private trade progress">
      {TRADE_PROGRESS.map((step, index) => (
        <div
          className={`trade-progress-step ${
            index <= activeIndex ? "trade-progress-step-active" : ""
          } ${index === activeIndex ? "trade-progress-step-current" : ""}`}
          key={step.id}
        >
          <span />
          <strong>{step.label}</strong>
        </div>
      ))}
    </div>
  );
}

function ConditionInput({
  label,
  mode,
  pnl,
  percent,
  price,
  onPercentChange,
  onPriceChange,
}: {
  label: "TP" | "SL";
  mode: ConditionMode;
  pnl: number;
  percent: number;
  price: number;
  onPercentChange: (value: number) => void;
  onPriceChange: (value: number) => void;
}) {
  const positive = pnl >= 0;
  const title = label === "TP" ? "Take Profit" : "Stop Loss";
  const previewValue =
    mode === "percent" ? formatNumber(price, price < 10 ? 4 : 2) : `${formatInputNumber(percent)}%`;

  return (
    <div className={`condition-input condition-input-${label.toLowerCase()}`}>
      <div className="condition-topline">
        <span className="condition-label">{title}</span>
        <strong className={`condition-pnl ${positive ? "metric-positive" : "metric-negative"}`}>
          {positive ? "+" : ""}
          {formatUsd(pnl, { maximumFractionDigits: 2 })}
        </strong>
      </div>
      <div className="condition-control-row">
        <label className="condition-value-input">
          {mode === "percent" ? (
            <div className="condition-input-shell">
              <input
                aria-label={`${label} percent`}
                inputMode="decimal"
                value={formatInputNumber(percent)}
                onChange={(event) => onPercentChange(Number(event.target.value) || 0)}
              />
              <em>%</em>
            </div>
          ) : (
            <div className="condition-input-shell">
              <input
                aria-label={`${label} price`}
                inputMode="decimal"
                value={price}
                onChange={(event) => onPriceChange(Number(event.target.value) || 0)}
              />
            </div>
          )}
        </label>
        <div className="condition-preview">
          <strong>{previewValue}</strong>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function clampLeverage(value: number, maxLeverage: number) {
  return clamp(value, 1, maxLeverage);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function marketLimitPrice(side: Side, price: number, slippagePercent: number) {
  const slippage = Math.max(slippagePercent, 0) / 100;
  return side === "long" ? price * (1 + slippage) : price * (1 - slippage);
}

function defaultTakeProfit(side: Side, price: number, leverage: number) {
  return priceFromPercent("tp", side, price, 40, leverage);
}

function defaultStopLoss(side: Side, price: number, leverage: number) {
  return priceFromPercent("sl", side, price, 20, leverage);
}

function estimatePnl(side: Side, size: number, entryPrice: number, exitPrice: number) {
  const delta = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return size * delta;
}

function roundPrice(value: number, marketPrice: number) {
  const decimals = marketPrice < 1 ? 5 : marketPrice < 10 ? 4 : 2;
  return Number(value.toFixed(decimals));
}

function priceFromPercent(kind: "tp" | "sl", side: Side, entryPrice: number, percent: number, leverage: number) {
  const distance = leverage > 0 ? Math.max(percent, 0) / 100 / leverage : 0;
  const multiplier =
    kind === "tp"
      ? side === "long"
        ? 1 + distance
        : 1 - distance
      : side === "long"
        ? 1 - distance
        : 1 + distance;

  return roundPrice(entryPrice * multiplier, entryPrice);
}

function percentFromPnl(kind: "tp" | "sl", pnl: number, margin: number) {
  if (margin <= 0) {
    return 0;
  }

  const normalizedPnl = kind === "tp" ? Math.max(pnl, 0) : Math.abs(Math.min(pnl, 0));
  return (normalizedPnl / margin) * 100;
}

function formatInputNumber(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number(value.toFixed(2));
}
