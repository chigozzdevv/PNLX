"use client";

import { ArrowLeft, CircleDollarSign, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ActionToast } from "@/components/action-toast";
import { OrderReviewDialog, type OrderReview } from "@/components/order-review-dialog";
import { USDC_SCALE, usdcToProtocolAmount } from "@/lib/asset-units";
import { formatNumber, formatUsd } from "@/lib/format";
import { useSlippagePercent } from "@/lib/trade-settings";
import { protocolOrderSize } from "@/lib/trade-submit";
import type { SubmitTradeIntentResult, TradeSubmitStage } from "@/lib/trade-submit";
import { fillFees, PRICE_SCALE } from "@pnlx/market-math";
import type { MarketDisplay, OrderDraft, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

interface OrderTicketProps {
  availableCollateral?: number | null;
  connected?: boolean;
  connecting?: boolean;
  connectionError?: string;
  market: MarketDisplay;
  mode: TicketMode;
  onConnect?: () => Promise<void>;
  onDeposit?: (input: OrderTicketDepositInput) => Promise<void>;
  onModeChange: (mode: TicketMode) => void;
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
  connecting = false,
  connectionError,
  market,
  mode,
  onConnect,
  onDeposit,
  onModeChange,
  onSubmit,
  order,
  session,
}: OrderTicketProps) {
  const [side, setSide] = useState<Side>(order.side);
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [tpSlEnabled, setTpSlEnabled] = useState(false);
  const [conditionMode, setConditionMode] = useState<ConditionMode>("price");
  const conditionSectionId = useId();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [submitSuccess, setSubmitSuccess] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [review, setReview] = useState<OrderReview | null>(null);
  const [reviewError, setReviewError] = useState<string | undefined>();
  const [depositing, setDepositing] = useState(false);
  const [margin, setMargin] = useState(() => readStoredMargin(market.marketId, order.collateral));
  const [fundAmount, setFundAmount] = useState(() => readStoredMargin(market.marketId, order.collateral));
  const [limitPrice, setLimitPrice] = useState(market.price);
  const priceInitialized = useRef(market.price > 0);
  const slippagePercent = useSlippagePercent();
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
  const protocolSize = margin > 0 && Math.round(margin * USDC_SCALE) > 0 && leverage > 0 &&
    sizingPrice > 0 && Number.isFinite(margin) && Number.isFinite(sizingPrice)
    ? protocolOrderSize(usdcToProtocolAmount(margin), leverage, sizingPrice)
    : 0n;
  const size = Number(protocolSize) / USDC_SCALE;
  const exposure = size * sizingPrice;
  const maxTakerFee = protocolSize > 0n
    ? Number(fillFees(protocolSize, BigInt(Math.round(sizingPrice * Number(PRICE_SCALE)))).grossTakerFee) / USDC_SCALE
    : 0;
  const takeProfitPnl = estimatePnl(side, size, sizingPrice, takeProfitPrice);
  const stopLossPnl = estimatePnl(side, size, sizingPrice, stopLossPrice);
  const takeProfitPercent = percentFromPnl("tp", takeProfitPnl, margin);
  const stopLossPercent = percentFromPnl("sl", stopLossPnl, margin);
  const availableCollateralValue = availableCollateral ?? 0;
  const hasEnoughCollateral = availableCollateralValue >= margin;
  const priceReady = Number.isFinite(market.price) && market.price > 0;
  const canSubmit = connected && priceReady && Number.isFinite(executionLimitPrice) && executionLimitPrice > 0 &&
    protocolSize > 0n && Number.isFinite(margin) && margin > 0 && Boolean(onSubmit) &&
    !submitting && !depositing && hasEnoughCollateral;
  const canDeposit = connected && Boolean(onDeposit) && !submitting && !depositing && fundAmount > 0;
  const primaryBusy = submitting || depositing;
  const ticketError = submitError ?? connectionError;
  const primaryDisabled = primaryBusy || connecting || (!connected
    ? !onConnect
    : !hasEnoughCollateral ? !onDeposit : !canSubmit);
  const liquidationPrice = useMemo(() => {
    const riskMove = leverage > 0 ? 1 / leverage - market.maintenanceMarginRate : 0;
    return side === "long" ? sizingPrice * (1 - riskMove) : sizingPrice * (1 + riskMove);
  }, [leverage, market.maintenanceMarginRate, side, sizingPrice]);

  useEffect(() => {
    if (!priceReady || priceInitialized.current) return;
    priceInitialized.current = true;
    setLimitPrice(market.price);
    setTakeProfitPrice((current) => current > 0 ? current : order.takeProfitPrice ?? defaultTakeProfit(side, market.price, leverage));
    setStopLossPrice((current) => current > 0 ? current : order.stopLossPrice ?? defaultStopLoss(side, market.price, leverage));
  }, [market.price, leverage, side, order.stopLossPrice, order.takeProfitPrice, priceReady]);

  useEffect(() => {
    writeStoredMargin(market.marketId, margin);
  }, [margin, market.marketId]);

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

  function openMobileTicket(nextSide: Side) {
    selectSide(nextSide);
    onModeChange("trade");
    document.getElementById("trade-order-ticket")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
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
    if (!review || submittingRef.current) return;
    if (!connected || (session?.address ?? null) !== review.walletAddress) {
      setReviewError("Your wallet changed. Close this review and reconnect before trading.");
      return;
    }
    if (!onSubmit) {
      setReviewError("Trading submission is not configured");
      return;
    }
    if (market.marketId !== review.marketId || !priceReady) {
      setReviewError("Market price is unavailable. Close this review and try again.");
      return;
    }
    if (!(availableCollateralValue >= review.input.margin)) {
      setReviewError("Insufficient available collateral. Close this review to add funds.");
      return;
    }

    submittingRef.current = true;
    setReviewError(undefined);
    setSubmitting(true);
    try {
      await onSubmit(review.input);
      setReview(null);
      setSubmitSuccess("Order submitted");
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Trade submission failed");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function primaryAction(event: React.MouseEvent<HTMLButtonElement>) {
    if (!connected) {
      await onConnect?.();
      return;
    }
    if (!hasEnoughCollateral) {
      setFundAmount(Math.max(margin - availableCollateralValue, 0));
      onModeChange("deposit");
      return;
    }
    if (!canSubmit) return;
    setSubmitError(undefined);
    setSubmitSuccess(undefined);
    setReviewError(undefined);
    setReview({
      baseAsset: market.baseAsset,
      entryPrice: activePrice,
      exposure,
      input: {
        collateralAsset: order.collateralAsset,
        leverage,
        limitPrice: executionLimitPrice,
        margin,
        orderType,
        side,
        sizingPrice,
        stopLossPrice: tpSlEnabled ? stopLossPrice : null,
        takeProfitPrice: tpSlEnabled ? takeProfitPrice : null,
      },
      inputMode: event.detail === 0 ? "keyboard" : "pointer",
      liquidationPrice,
      marketId: market.marketId,
      maxTakerFee,
      pair: market.pair,
      size,
      slippagePercent,
      walletAddress: session?.address ?? null,
    });
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
    setDepositing(true);
    try {
      await onDeposit({
        amount,
        collateralAsset: order.collateralAsset,
      });
      onModeChange("trade");
      setSubmitSuccess(`${formatUsd(amount, { maximumFractionDigits: 2 })} deposited`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Deposit failed");
    } finally {
      setDepositing(false);
    }
  }

  return (
    <section className="panel order-ticket" id="trade-order-ticket">
      <div className="mobile-trade-dock" aria-label="Choose trade side">
        <button
          className={`mobile-trade-dock-button mobile-trade-dock-long ${side === "long" ? "mobile-trade-dock-active" : ""}`}
          type="button"
          onClick={() => openMobileTicket("long")}
        >
          Long
        </button>
        <button
          className={`mobile-trade-dock-button mobile-trade-dock-short ${side === "short" ? "mobile-trade-dock-active" : ""}`}
          type="button"
          onClick={() => openMobileTicket("short")}
        >
          Short
        </button>
      </div>
      {mode === "deposit" ? <div className="ticket-heading"><p>Deposit</p><span>USDC</span></div> : null}

      {mode === "deposit" ? (
        <>
          <button
            className="secondary-ticket-button ticket-mode-back"
            disabled={depositing}
            type="button"
            onClick={() => onModeChange("trade")}
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

          <button
            className="primary-trade-button"
            aria-busy={depositing}
            data-side="long"
            disabled={connecting || (connected ? !canDeposit : !onConnect)}
            type="button"
            onClick={() => connected ? depositMargin() : onConnect?.()}
          >
            {connecting ? "Connecting…" : !connected ? "Connect Wallet" : depositing ? "Depositing" : "Deposit"}
          </button>

          {ticketError ? (
            <p className="ticket-message ticket-message-error" role="alert" title={ticketError}>
              {ticketError}
            </p>
          ) : null}
        </>
      ) : (
        <>
      <div className="side-selector">
        <button
          className={`side-button side-button-long ${side === "long" ? "side-button-active" : ""}`}
          aria-pressed={side === "long"}
          type="button"
          onClick={() => selectSide("long")}
        >
          <span>Buy / Long</span>
        </button>
        <button
          className={`side-button side-button-short ${side === "short" ? "side-button-active" : ""}`}
          aria-pressed={side === "short"}
          type="button"
          onClick={() => selectSide("short")}
        >
          <span>Sell / Short</span>
        </button>
      </div>

      <div className="execution-selector">
        <div
          aria-label="Order type"
          className="order-type-tabs"
        >
          <button
            aria-pressed={orderType === "market"}
            className={orderType === "market" ? "order-type-active" : ""}
            type="button"
            onClick={() => setOrderType("market")}
          >
            Market
          </button>
          <button
            aria-pressed={orderType === "limit"}
            className={orderType === "limit" ? "order-type-active" : ""}
            type="button"
            onClick={() => setOrderType("limit")}
          >
            Limit
          </button>
        </div>
      </div>

      <div className="ticket-balance-row">
        <span>Available</span>
        <strong>{connected ? formatUsd(availableCollateralValue, { maximumFractionDigits: 2 }) : "—"}</strong>
        <button aria-label="Add funds" className="add-funds-action" disabled={primaryBusy || connecting || (!connected && !onConnect)} type="button" onClick={() => connected ? onModeChange("deposit") : onConnect?.()}>
          <Plus aria-hidden="true" size={14} />
        </button>
      </div>

      {orderType === "limit" && (
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
      )}

      <div className="ticket-field ticket-margin-field">
        <div className="field-label">
          <span>Margin</span>
        </div>
        <div className="field-control">
          <input
            aria-label="Margin"
            inputMode="decimal"
            value={margin}
            onChange={(event) => updateMargin(Number(event.target.value) || 0)}
          />
          <strong className="field-asset">{order.collateralAsset}</strong>
        </div>
      </div>
      <div className="margin-shortcuts" aria-label="Use available collateral">
        {[25, 50, 75, 100].map((percent) => (
          <button
            disabled={!connected || availableCollateralValue <= 0 || primaryBusy}
            key={percent}
            type="button"
            onClick={() => updateMargin(Math.floor(availableCollateralValue * USDC_SCALE * percent / 100) / USDC_SCALE)}
          >
            {percent === 100 ? "Max" : `${percent}%`}
          </button>
        ))}
      </div>

      <div className="ticket-leverage-field">
        <div className="field-label">
          <span>Leverage</span>
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
        <input aria-label="Leverage" className="leverage-slider" max={market.maxLeverage} min={1} step={0.1} type="range" value={leverage} onChange={(event) => updateLeverage(Number(event.target.value))} />
        <div className="leverage-scale"><span>1x</span><span>{market.maxLeverage}x</span></div>
      </div>

      <div className="ticket-advanced">
        <div className="ticket-advanced-header">
          <label className="ticket-advanced-toggle">
            <input
              aria-controls={conditionSectionId}
              checked={tpSlEnabled}
              type="checkbox"
              onChange={(event) => setTpSlEnabled(event.target.checked)}
            />
            <span>TP / SL</span>
          </label>
          {tpSlEnabled ? (
            <div className="condition-mode-control" aria-label="TP SL input mode" role="group">
              <button
                aria-pressed={conditionMode === "price"}
                className={`condition-mode-button ${conditionMode === "price" ? "condition-mode-button-active" : ""}`}
                type="button"
                onClick={() => setConditionMode("price")}
              >
                Price
              </button>
              <button
                aria-pressed={conditionMode === "percent"}
                className={`condition-mode-button ${conditionMode === "percent" ? "condition-mode-button-active" : ""}`}
                title="Estimated return on margin before fees and funding"
                type="button"
                onClick={() => setConditionMode("percent")}
              >
                ROE %
              </button>
            </div>
          ) : null}
        </div>
        {tpSlEnabled ? (
          <div className="ticket-advanced-body" id={conditionSectionId}>
            <div className="condition-grid">
              <ConditionInput
                key={`tp:${conditionMode}`}
                label="TP"
                mode={conditionMode}
                pnl={takeProfitPnl}
                percent={takeProfitPercent}
                price={takeProfitPrice}
                quoteAsset={market.quoteAsset}
                onPercentChange={updateTakeProfitPercent}
                onPriceChange={setTakeProfitPrice}
              />
              <ConditionInput
                key={`sl:${conditionMode}`}
                label="SL"
                mode={conditionMode}
                pnl={stopLossPnl}
                percent={stopLossPercent}
                price={stopLossPrice}
                quoteAsset={market.quoteAsset}
                onPercentChange={updateStopLossPercent}
                onPriceChange={setStopLossPrice}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="ticket-order-preview" aria-label="Estimated order values">
        <div>
          <span>Position size</span>
          <strong>{priceReady ? `${formatPositionSize(size, market.price)} ${market.baseAsset}` : "—"}</strong>
        </div>
        <div>
          <span>Exposure</span>
          <strong>{priceReady ? formatUsd(exposure, { maximumFractionDigits: 2 }) : "—"}</strong>
        </div>
        <div>
          <span>Max taker fee</span>
          <strong>{priceReady ? formatUsd(maxTakerFee, { maximumFractionDigits: 4 }) : "—"}</strong>
        </div>
        <div>
          <span>Est. liquidation</span>
          <strong>{priceReady ? `$${formatNumber(liquidationPrice, market.price < 10 ? 5 : 2)}` : "—"}</strong>
        </div>
        {orderType === "market" ? <div><span>Max. slippage</span><strong>{formatNumber(slippagePercent, 2)}%</strong></div> : null}
      </div>

      <div className="ticket-primary-area">
        <button
          className="primary-trade-button"
          aria-busy={depositing}
          data-side={side}
          disabled={primaryDisabled}
          type="button"
          onClick={primaryAction}
        >
          {connecting ? "Connecting…" : !connected
            ? "Connect Wallet"
              : depositing
                ? "Depositing"
              : !hasEnoughCollateral
                ? "Add funds"
                : side === "long"
                  ? `Buy / Long ${market.baseAsset}`
                  : `Sell / Short ${market.baseAsset}`}
        </button>
      </div>

      {ticketError ? (
        <p className="ticket-message ticket-message-error" role="alert" title={ticketError}>
          {ticketError}
        </p>
      ) : null}
        </>
      )}
      <ActionToast message={submitSuccess} onDismiss={() => setSubmitSuccess(undefined)} />
      {review ? (
        <OrderReviewDialog
          error={reviewError}
          onClose={() => { if (!submittingRef.current) setReview(null); }}
          onConfirm={submitOrder}
          review={review}
          submitting={submitting}
        />
      ) : null}
    </section>
  );
}

function ConditionInput({
  label,
  mode,
  pnl,
  percent,
  price,
  quoteAsset,
  onPercentChange,
  onPriceChange,
}: {
  label: "TP" | "SL";
  mode: ConditionMode;
  pnl: number;
  percent: number;
  price: number;
  quoteAsset: string;
  onPercentChange: (value: number) => void;
  onPriceChange: (value: number) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const hasValue = Number.isFinite(price) && price > 0;
  const value = hasValue ? String(mode === "percent" ? formatInputNumber(percent) : price) : "";
  const positive = pnl >= 0;
  const title = label === "TP" ? "Take profit" : "Stop loss";
  const previewValue =
    mode === "percent"
      ? `Trigger $${formatNumber(price, price < 1 ? 5 : price < 10 ? 4 : 2)}`
      : `ROE ${positive ? "+" : "−"}${formatNumber(percent, 2)}%`;

  return (
    <div className={`condition-input condition-input-${label.toLowerCase()}`}>
      <label className="condition-label" htmlFor={inputId}>{title}</label>
      <div className="condition-input-shell">
        <input
          aria-label={`${title} ${mode === "percent" ? "ROE percent" : "price"}`}
          autoComplete="off"
          id={inputId}
          inputMode="decimal"
          placeholder="0.00"
          value={draft ?? value}
          onBlur={() => setDraft(null)}
          onChange={(event) => {
            const text = event.target.value;
            if (!/^\d*(?:\.\d*)?$/.test(text)) return;
            const amount = Number(text);
            if (text !== "." && !Number.isFinite(amount)) return;
            setDraft(text);
            if (text === "" || text === ".") onPriceChange(0);
            else if (mode === "percent") onPercentChange(amount);
            else onPriceChange(amount);
          }}
          onFocus={() => setDraft(value)}
        />
        <em>{mode === "percent" ? "%" : quoteAsset}</em>
      </div>
      <div className="condition-preview" title="Estimated return before fees and funding">
        <span>{hasValue ? previewValue : mode === "percent" ? "Trigger price" : "Est. PnL"}</span>
        <strong className={hasValue ? positive ? "metric-positive" : "metric-negative" : undefined}>
          {hasValue ? `${positive ? "+" : ""}${formatUsd(pnl, { maximumFractionDigits: 2 })}` : "—"}
        </strong>
      </div>
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

function formatPositionSize(value: number, marketPrice: number): string {
  const maximumFractionDigits = marketPrice < 1 ? 2 : marketPrice < 100 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
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
