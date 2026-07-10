"use client";

import { motion } from "framer-motion";
import { ArrowLeft, CircleDollarSign, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatNumber, formatUsd, shortAddress } from "@/lib/format";
import type { SubmitTradeIntentResult, TradeSubmitStage } from "@/lib/trade-submit";
import type { MarketDisplay, OrderDraft, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

interface OrderTicketProps {
  availableCollateral?: number | null;
  connected?: boolean;
  market: MarketDisplay;
  onDeposit?: (input: OrderTicketDepositInput) => Promise<void>;
  onSubmit?: (input: OrderTicketSubmitInput) => Promise<SubmitTradeIntentResult>;
  order: OrderDraft;
  session?: WalletSession | null;
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
  preferredNoteAmount?: number;
}

type ConditionMode = "percent" | "price";
type TicketMode = "trade" | "deposit";
const MARGIN_STORAGE_PREFIX = "pnlx.order-ticket.margin.v1";

export function OrderTicket({
  availableCollateral,
  connected = false,
  market,
  onDeposit,
  onSubmit,
  order,
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
  const [ticketMode, setTicketMode] = useState<TicketMode>("trade");
  const [margin, setMargin] = useState(() => readStoredMargin(market.marketId, order.collateral));
  const [fundAmount, setFundAmount] = useState(() => readStoredMargin(market.marketId, order.collateral));
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
  const sizingPrice = orderType === "market"
    ? market.price * (1 + Math.max(slippagePercent, 0) / 100)
    : (side === "long" ? limitPrice : Math.max(market.price, limitPrice));
  const exposure = margin * leverage;
  const size = sizingPrice > 0 ? exposure / sizingPrice : 0;
  const takeProfitPnl = estimatePnl(side, size, sizingPrice, takeProfitPrice);
  const stopLossPnl = estimatePnl(side, size, sizingPrice, stopLossPrice);
  const takeProfitPercent = percentFromPnl("tp", takeProfitPnl, margin);
  const stopLossPercent = percentFromPnl("sl", stopLossPnl, margin);
  const availableCollateralValue = availableCollateral ?? 0;
  const hasEnoughCollateral = availableCollateralValue >= margin;
  const canSubmit = connected && Boolean(onSubmit) && !submitting && !depositing && margin > 0 && hasEnoughCollateral;
  const canDeposit = connected && Boolean(onDeposit) && !submitting && !depositing && fundAmount > 0;
  const primaryDisabled = !canSubmit;
  const primaryBusy = submitting || depositing;
  const liquidationPrice = useMemo(() => {
    const riskMove = leverage > 0 ? 1 / leverage - market.maintenanceMarginRate : 0;
    return side === "long" ? sizingPrice * (1 - riskMove) : sizingPrice * (1 + riskMove);
  }, [leverage, market.maintenanceMarginRate, side, sizingPrice]);

  useEffect(() => {
    writeStoredMargin(market.marketId, margin);
  }, [margin, market.marketId]);

  useEffect(() => {
    if (!submitSuccess || submitting || depositing) return;
    const timer = window.setTimeout(() => setSubmitSuccess(undefined), 3_500);
    return () => window.clearTimeout(timer);
  }, [depositing, submitSuccess, submitting]);

  useEffect(() => {
    if (!submitError || submitting || depositing) return;
    const timer = window.setTimeout(() => setSubmitError(undefined), 5_000);
    return () => window.clearTimeout(timer);
  }, [depositing, submitError, submitting]);

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

  function updateMargin(value: number) {
    const next = Math.max(value || 0, 0);
    setMargin(next);
    setFundAmount(next);
  }

  function updateFundAmount(value: number) {
    const next = Math.max(value || 0, 0);
    setFundAmount(next);
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
        sizingPrice,
        stopLossPrice: tpSlEnabled ? stopLossPrice : null,
        takeProfitPrice: tpSlEnabled ? takeProfitPrice : null,
      });
      setSubmitStage(undefined);
      setSubmitSuccess(
        result.intents.length > 1
          ? `Submitted ${result.intents.length} private order fragments`
          : `Submitted ${shortAddress(result.intent.intentCommitment)}`,
      );
    } catch (error) {
      setSubmitStage(undefined);
      setSubmitError(error instanceof Error ? error.message : "Trade submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function primaryAction() {
    if (!connected) {
      setSubmitError("Connect a wallet first");
      return;
    }
    await submitOrder();
  }

  async function depositMargin(amount = fundAmount) {
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
    setSubmitStage(undefined);
    setDepositing(true);
    try {
      await onDeposit({
        amount,
        collateralAsset: order.collateralAsset,
        onProgress: setSubmitStage,
      });
      setSubmitStage(undefined);
      setTicketMode("trade");
      setSubmitSuccess(`${formatUsd(amount, { maximumFractionDigits: 2 })} deposited`);
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
        <p>{ticketMode === "deposit" ? "Deposit" : "Trade"}</p>
        <span>{market.pair}</span>
      </div>

      {ticketMode === "deposit" ? (
        <>
          <button
            className="secondary-ticket-button ticket-mode-back"
            disabled={depositing}
            type="button"
            onClick={() => setTicketMode("trade")}
          >
            <ArrowLeft size={16} />
            Trade
          </button>

          <div className="ticket-field">
            <div className="field-label">
              <span>Amount</span>
              <strong className="field-balance">
                Available {formatUsd(availableCollateralValue, { maximumFractionDigits: 2 })}
              </strong>
            </div>
            <div className="field-control">
              <input
                aria-label="Deposit amount"
                inputMode="decimal"
                value={fundAmount}
                onChange={(event) => updateFundAmount(Number(event.target.value) || 0)}
              />
              <div className="asset-pill">
                <CircleDollarSign size={18} />
                {order.collateralAsset}
              </div>
            </div>
          </div>

          <motion.button
            className="primary-trade-button"
            data-side="long"
            disabled={!canDeposit}
            type="button"
            onClick={() => depositMargin()}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.99 }}
          >
            {!connected ? "Connect Wallet" : depositing ? "Depositing" : "Deposit"}
          </motion.button>

          <TradeProgress depositing={depositing} stage={submitStage} />

          {submitError ? (
            <p className="ticket-message ticket-message-error" role="alert" title={submitError}>
              {submitError}
            </p>
          ) : null}
          {submitSuccess ? <p className="ticket-message ticket-message-success">{submitSuccess}</p> : null}
        </>
      ) : (
        <>
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
          <span>Margin</span>
          <div className="field-balance-group">
            <strong className={`field-balance ${hasEnoughCollateral ? "" : "field-balance-warning"}`}>
              Available {formatUsd(availableCollateralValue, { maximumFractionDigits: 2 })}
            </strong>
            <button
              aria-label="Top up available collateral"
              className="field-topup-button"
              disabled={!connected || !onDeposit || depositing || submitting}
              title="Top up collateral"
              type="button"
              onClick={() => setTicketMode("deposit")}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="field-control">
          <input
            aria-label="Margin"
            inputMode="decimal"
            value={margin}
            onChange={(event) => updateMargin(Number(event.target.value) || 0)}
          />
          <div className="asset-pill">
            <CircleDollarSign size={18} />
            {order.collateralAsset}
          </div>
        </div>
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
        disabled={primaryDisabled}
        type="button"
        onClick={primaryAction}
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.99 }}
      >
        {!connected
          ? "Connect Wallet"
            : primaryBusy
              ? depositing
                ? "Depositing"
                : "Submitting"
            : !hasEnoughCollateral
              ? "Top up first"
              : side === "long"
                ? "Submit Long"
                : "Submit Short"}
      </motion.button>

      <TradeProgress depositing={depositing} stage={submitStage} />

      {submitError ? (
        <p className="ticket-message ticket-message-error" role="alert" title={submitError}>
          {submitError}
        </p>
      ) : null}
      {submitSuccess ? <p className="ticket-message ticket-message-success">{submitSuccess}</p> : null}

      <div className="ticket-summary">
        <SummaryRow label="Position Size" value={`${formatNumber(size, 6)} ${market.baseAsset}`} />
        <SummaryRow label="Exposure" value={formatUsd(exposure, { maximumFractionDigits: 2 })} />
        <SummaryRow label="Margin" value={formatUsd(margin, { maximumFractionDigits: 2 })} />
        <SummaryRow label="Leverage" value={`${formatNumber(leverage, 2)}x`} />
        <SummaryRow label="Liquidation Price" value={formatNumber(liquidationPrice, market.price < 10 ? 4 : 1)} />
        {orderType === "market" ? (
          <SummaryRow
            label={side === "long" ? "Max Fill" : "Min Fill"}
            value={formatNumber(executionLimitPrice, market.price < 10 ? 4 : 1)}
          />
        ) : null}
      </div>
        </>
      )}
    </section>
  );
}

function TradeProgress({ depositing, stage }: { depositing: boolean; stage?: TradeSubmitStage }) {
  if (!stage) return null;
  const label = progressLabel(stage, depositing);

  return (
    <p className="ticket-message ticket-message-status" aria-live="polite">
      {label}
    </p>
  );
}

function progressLabel(stage: TradeSubmitStage, depositing: boolean): string {
  if (stage === "done") return depositing ? "Deposit confirmed" : "Order queued for matching";
  if (depositing) {
    switch (stage) {
      case "shielding":
        return "Creating shielded note";
      case "signing":
        return "Waiting for wallet signature";
      case "proving":
        return "Preparing deposit proof";
      case "matching":
        return "Finalizing deposit";
      case "hashing":
      default:
        return "Preparing deposit";
    }
  }

  switch (stage) {
    case "hashing":
      return "Preparing private order";
    case "shielding":
      return "Selecting private margin";
    case "signing":
      return "Waiting for wallet signature";
    case "proving":
      return "Generating validity proof";
    case "matching":
      return "Submitting private intent";
    default:
      return "Submitting private order";
  }
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

function readStoredMargin(marketId: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const stored = Number(window.localStorage.getItem(marginStorageKey(marketId)));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

function writeStoredMargin(marketId: string, value: number): void {
  if (typeof window === "undefined" || !Number.isFinite(value) || value <= 0) return;
  window.localStorage.setItem(marginStorageKey(marketId), String(value));
}

function marginStorageKey(marketId: string): string {
  return `${MARGIN_STORAGE_PREFIX}:${marketId}`;
}
