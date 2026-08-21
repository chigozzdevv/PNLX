"use client";

import { ChevronDown, Copy, ExternalLink } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { formatUsd, shortAddress } from "@/lib/format";
import {
  groupOwnerOrders,
  isActiveOrderGroup,
  type OwnerOrderGroup,
} from "@/lib/order-groups";
import type {
  Hex,
  PositionRow,
  ServerOwnerActivitySnapshot,
  ServerOwnerOrderSnapshot,
} from "@/types/trading";

type PortfolioRecordView = "positions" | "orders" | "activity";
type ActivityFilter = "all" | "positions" | "orders" | "closures";

interface PortfolioRecordsProps {
  actionMessage?: { tone: "error" | "success"; text: string };
  activity: ServerOwnerActivitySnapshot[];
  cancellingOrderId?: string;
  closingPositionId?: string;
  loading?: boolean;
  onCancelOrder?: (order: OwnerOrderGroup) => Promise<void> | void;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  orders: ServerOwnerOrderSnapshot[];
  positions: PositionRow[];
}

export function PortfolioRecords({
  actionMessage,
  activity,
  cancellingOrderId,
  closingPositionId,
  loading = false,
  onCancelOrder,
  onClosePosition,
  orders,
  positions,
}: PortfolioRecordsProps) {
  const [view, setView] = useState<PortfolioRecordView>("positions");
  const [expandedRow, setExpandedRow] = useState<string>();
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const openPositions = positions.filter((position) => position.status === "open");
  const openOrderGroups = useMemo(
    () => groupOwnerOrders(orders).filter(isActiveOrderGroup),
    [orders],
  );
  const visibleActivity = useMemo(
    () => [...activity.filter((item) => item.kind !== "account-event")].reverse(),
    [activity],
  );
  const filteredActivity = visibleActivity.filter((item) => activityMatchesFilter(item, activityFilter));

  function selectView(next: PortfolioRecordView) {
    setView(next);
    setExpandedRow(undefined);
  }

  function toggleDetails(key: string) {
    setExpandedRow((current) => current === key ? undefined : key);
  }

  return (
    <section className="portfolio-records" aria-label="Portfolio records">
      <div className="portfolio-records-toolbar">
        <div className="portfolio-record-tabs" role="tablist" aria-label="Portfolio records">
          <PortfolioTab
            active={view === "positions"}
            count={openPositions.length}
            label="Positions"
            onClick={() => selectView("positions")}
          />
          <PortfolioTab
            active={view === "orders"}
            count={openOrderGroups.length}
            label="Orders"
            onClick={() => selectView("orders")}
          />
          <PortfolioTab
            active={view === "activity"}
            label="Activity"
            onClick={() => selectView("activity")}
          />
        </div>

        {actionMessage ? (
          <p className={`portfolio-action-message portfolio-action-message-${actionMessage.tone}`} role="status">
            {actionMessage.text}
          </p>
        ) : null}
      </div>

      {view === "positions" ? (
        <PositionsLedger
          closingPositionId={closingPositionId}
          expandedRow={expandedRow}
          loading={loading}
          onClosePosition={onClosePosition}
          onToggleDetails={toggleDetails}
          orders={orders}
          positions={openPositions}
        />
      ) : view === "orders" ? (
        <OrdersLedger
          cancellingOrderId={cancellingOrderId}
          expandedRow={expandedRow}
          loading={loading}
          onCancelOrder={onCancelOrder}
          onToggleDetails={toggleDetails}
          orders={openOrderGroups}
        />
      ) : (
        <ActivityLedger
          activity={filteredActivity}
          activityFilter={activityFilter}
          expandedRow={expandedRow}
          loading={loading}
          onFilterChange={(filter) => {
            setActivityFilter(filter);
            setExpandedRow(undefined);
          }}
          onToggleDetails={toggleDetails}
          orders={orders}
        />
      )}
    </section>
  );
}

function PortfolioTab({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count?: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={active}
      className="portfolio-record-tab"
      role="tab"
      type="button"
      onClick={onClick}
    >
      {label}{count ? ` ${count}` : ""}
    </button>
  );
}

function PositionsLedger({
  closingPositionId,
  expandedRow,
  loading,
  onClosePosition,
  onToggleDetails,
  orders,
  positions,
}: {
  closingPositionId?: string;
  expandedRow?: string;
  loading: boolean;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  onToggleDetails: (key: string) => void;
  orders: ServerOwnerOrderSnapshot[];
  positions: PositionRow[];
}) {
  if (positions.length === 0) return <EmptyRecords loading={loading} text="No open positions" />;

  return (
    <div className="portfolio-ledger">
      <div className="portfolio-ledger-head portfolio-position-grid" aria-hidden="true">
        <span>Market</span>
        <span>Size</span>
        <span>Entry → mark</span>
        <span>Margin</span>
        <span>PnL</span>
        <span>Actions</span>
      </div>

      {positions.map((position) => {
        const key = `position:${position.id}`;
        const expanded = expandedRow === key;
        const sourceOrder = sourceOrderForPosition(position, orders);
        const closeUnavailableReason = closeDisabledReason(position, onClosePosition);
        return (
          <Fragment key={position.id}>
            <div className="portfolio-ledger-row portfolio-position-grid">
              <div className="portfolio-market-cell">
                <strong>{position.market} · {sideLabel(position.side)}</strong>
                <small>Opened · {formatDateTime(position.openedAt)}</small>
              </div>
              <LedgerCell label="Size">
                {privateNumber(position.size, (value) => `${formatFlexibleNumber(value, 6)} ${baseAsset(position.market)}`, position.privateDetails)}
              </LedgerCell>
              <LedgerCell label="Entry → mark">
                <span>{positionPriceRange(position)}</span>
                <small>Liq. —</small>
              </LedgerCell>
              <LedgerCell label="Margin">
                {privateNumber(position.collateral, portfolioUsd, position.privateDetails)}
              </LedgerCell>
              <LedgerCell label="PnL">
                <span className={signedValueClass(position.unrealizedPnl)}>
                  {signedPrivateUsd(position.unrealizedPnl, position.privateDetails)}
                </span>
              </LedgerCell>
              <div className="portfolio-row-actions">
                <button
                  className="portfolio-secondary-action"
                  disabled={Boolean(closeUnavailableReason) || closingPositionId === position.id}
                  title={closeUnavailableReason}
                  type="button"
                  onClick={() => onClosePosition?.(position)}
                >
                  {closingPositionId === position.id ? "Closing" : "Close"}
                </button>
                <DetailsButton
                  controlsId={`position-details-${position.id}`}
                  expanded={expanded}
                  onClick={() => onToggleDetails(key)}
                />
              </div>
            </div>
            {expanded ? <PositionDetails order={sourceOrder} position={position} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function PositionDetails({
  order,
  position,
}: {
  order?: ServerOwnerOrderSnapshot;
  position: PositionRow;
}) {
  return (
    <div className="portfolio-detail-panel" id={`position-details-${position.id}`}>
      <div className="portfolio-detail-heading"><strong>Position details</strong></div>
      {order?.submissionTxHash ? (
        <DetailItem label="Order submission">
          <TransactionLink hash={order.submissionTxHash} />
        </DetailItem>
      ) : null}
      {position.proofVerificationTxHash ? (
        <DetailItem label="Proof record transaction">
          <TransactionLink hash={position.proofVerificationTxHash} />
        </DetailItem>
      ) : null}
      {position.settlementTxHash ? (
        <DetailItem label="Settlement transaction">
          <TransactionLink hash={position.settlementTxHash} />
        </DetailItem>
      ) : null}
      {position.boundlessRequestId ? (
        <DetailItem label="Boundless request">
          <BoundlessLink requestId={position.boundlessRequestId} />
        </DetailItem>
      ) : null}
      <DetailItem label="Batch ID"><strong>{position.batchId}</strong></DetailItem>
      {position.proofSystem ? (
        <DetailItem label="Proof system"><strong>{proofSystemLabel(position.proofSystem)}</strong></DetailItem>
      ) : null}
    </div>
  );
}

function OrdersLedger({
  cancellingOrderId,
  expandedRow,
  loading,
  onCancelOrder,
  onToggleDetails,
  orders,
}: {
  cancellingOrderId?: string;
  expandedRow?: string;
  loading: boolean;
  onCancelOrder?: (order: OwnerOrderGroup) => Promise<void> | void;
  onToggleDetails: (key: string) => void;
  orders: OwnerOrderGroup[];
}) {
  if (orders.length === 0) return <EmptyRecords loading={loading} text="No open orders" />;

  return (
    <div className="portfolio-ledger">
      <div className="portfolio-ledger-head portfolio-order-grid" aria-hidden="true">
        <span>Market</span>
        <span>Origin</span>
        <span>Status</span>
        <span>Submitted</span>
        <span>Updated</span>
        <span>Actions</span>
      </div>

      {orders.map((order) => {
        const key = `order:${order.id}`;
        const expanded = expandedRow === key;
        return (
          <Fragment key={order.id}>
            <div className="portfolio-ledger-row portfolio-order-grid">
              <div className="portfolio-market-cell">
                <strong>{pairFromMarketId(order.marketId)}</strong>
                <small>Private intent</small>
              </div>
              <LedgerCell label="Origin">{order.isResidual ? "Residual" : "Private"}</LedgerCell>
              <LedgerCell label="Status">
                <span>{statusLabel(order.status)}</span>
                <small>{matcherLabel(order.matching)}</small>
              </LedgerCell>
              <LedgerCell label="Submitted">{formatDateTime(order.createdAt)}</LedgerCell>
              <LedgerCell label="Updated">{formatDateTime(order.updatedAt)}</LedgerCell>
              <div className="portfolio-row-actions">
                <button
                  className="portfolio-secondary-action"
                  disabled={!onCancelOrder || cancellingOrderId === order.id}
                  type="button"
                  onClick={() => onCancelOrder?.(order)}
                >
                  {cancellingOrderId === order.id ? "Cancelling" : "Cancel"}
                </button>
                <DetailsButton
                  controlsId={`order-details-${order.id}`}
                  expanded={expanded}
                  onClick={() => onToggleDetails(key)}
                />
              </div>
            </div>
            {expanded ? <OrderDetails order={order} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function OrderDetails({ order }: { order: OwnerOrderGroup }) {
  return (
    <div className="portfolio-detail-panel" id={`order-details-${order.id}`}>
      <div className="portfolio-detail-heading">
        <strong>Order details</strong>
        <span>{statusLabel(order.status)}</span>
      </div>
      {order.orders.length > 1 ? (
        <DetailItem label="Private balance inputs"><strong>{order.orders.length}</strong></DetailItem>
      ) : null}
      {order.orders.map((fragment, index) => fragment.submissionTxHash ? (
        <DetailItem key={`submission:${fragment.intentCommitment}`} label={order.orders.length > 1 ? `Submission ${index + 1}` : "Submission transaction"}>
          <TransactionLink hash={fragment.submissionTxHash} />
        </DetailItem>
      ) : null)}
      {order.orders.map((fragment, index) => fragment.cancellationTxHash ? (
        <DetailItem key={`cancellation:${fragment.intentCommitment}`} label={order.orders.length > 1 ? `Cancellation ${index + 1}` : "Cancellation transaction"}>
          <TransactionLink hash={fragment.cancellationTxHash} />
        </DetailItem>
      ) : null)}
      <DetailItem label="Order ID"><strong>{order.id}</strong></DetailItem>
      {order.matching.batchId ? (
        <DetailItem label="Latest matching batch"><strong>{order.matching.batchId}</strong></DetailItem>
      ) : null}
      <DetailItem label="Matching status"><strong>{matcherLabel(order.matching)}</strong></DetailItem>
      {order.matching.runId ? (
        <DetailItem label="Matching run"><CopyValue value={order.matching.runId} /></DetailItem>
      ) : null}
      <DetailItem label="Residual order"><strong>{order.isResidual ? "Yes" : "No"}</strong></DetailItem>
      {order.orders.map((fragment, index) => (
        <DetailItem key={`intent:${fragment.intentCommitment}`} label={order.orders.length > 1 ? `Intent ${index + 1}` : "Intent ID"}>
          <CopyValue value={fragment.intentCommitment} />
        </DetailItem>
      ))}
      <DetailItem label="Submitted"><strong>{formatDateTime(order.createdAt)}</strong></DetailItem>
      <DetailItem label="Last updated"><strong>{formatDateTime(order.updatedAt)}</strong></DetailItem>
    </div>
  );
}

function ActivityLedger({
  activity,
  activityFilter,
  expandedRow,
  loading,
  onFilterChange,
  onToggleDetails,
  orders,
}: {
  activity: ServerOwnerActivitySnapshot[];
  activityFilter: ActivityFilter;
  expandedRow?: string;
  loading: boolean;
  onFilterChange: (filter: ActivityFilter) => void;
  onToggleDetails: (key: string) => void;
  orders: ServerOwnerOrderSnapshot[];
}) {
  return (
    <div className="portfolio-activity">
      <div className="portfolio-activity-toolbar">
        <select
          aria-label="Activity type"
          className="portfolio-activity-filter"
          value={activityFilter}
          onChange={(event) => onFilterChange(event.target.value as ActivityFilter)}
        >
          <option value="all">All activity</option>
          <option value="positions">Positions</option>
          <option value="orders">Orders</option>
          <option value="closures">Closures</option>
        </select>
      </div>

      {activity.length === 0 ? <EmptyRecords loading={loading} text="No activity" /> : (
        <div className="portfolio-ledger">
          <div className="portfolio-ledger-head portfolio-activity-grid" aria-hidden="true">
            <span>Activity</span>
            <span>Status</span>
            <span>Time</span>
            <span>Actions</span>
          </div>
          {activity.map((item) => {
            const key = `activity:${item.kind}:${item.id}`;
            const expanded = expandedRow === key;
            const order = item.kind === "order"
              ? orders.find((candidate) => candidate.intentCommitment === item.id)
              : undefined;
            return (
              <Fragment key={key}>
                <div className="portfolio-ledger-row portfolio-activity-grid">
                  <div className="portfolio-market-cell">
                    <strong>{activityKind(item)}</strong>
                    <small>{item.marketId ? pairFromMarketId(item.marketId) : "Protocol"}</small>
                  </div>
                  <LedgerCell label="Status">{statusLabel(item.status)}</LedgerCell>
                  <LedgerCell label="Time">{formatDateTime(item.timestamp)}</LedgerCell>
                  <div className="portfolio-row-actions">
                    <DetailsButton
                      controlsId={`activity-details-${item.kind}-${item.id}`}
                      expanded={expanded}
                      onClick={() => onToggleDetails(key)}
                    />
                  </div>
                </div>
                {expanded ? <ActivityDetails item={item} order={order} /> : null}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivityDetails({
  item,
  order,
}: {
  item: ServerOwnerActivitySnapshot;
  order?: ServerOwnerOrderSnapshot;
}) {
  if (item.kind === "order") {
    return (
      <div className="portfolio-detail-panel" id={`activity-details-${item.kind}-${item.id}`}>
        <div className="portfolio-detail-heading">
          <strong>{activityKind(item)}</strong>
          <span>{statusLabel(item.status)}</span>
        </div>
        {order?.submissionTxHash ? (
          <DetailItem label="Submission transaction"><TransactionLink hash={order.submissionTxHash} /></DetailItem>
        ) : null}
        {order?.cancellationTxHash ? (
          <DetailItem label="Cancellation transaction"><TransactionLink hash={order.cancellationTxHash} /></DetailItem>
        ) : null}
        {!order && item.txHash ? (
          <DetailItem label={item.status === "cancelled" ? "Cancellation transaction" : "Submission transaction"}>
            <TransactionLink hash={item.txHash} />
          </DetailItem>
        ) : null}
        <DetailItem label="Order batch"><strong>{order?.batchId ?? item.batchId ?? "—"}</strong></DetailItem>
        <DetailItem label="Intent ID"><CopyValue value={item.id} /></DetailItem>
        {order ? <DetailItem label="Residual order"><strong>{order.isResidual ? "Yes" : "No"}</strong></DetailItem> : null}
        {order ? <DetailItem label="Last updated"><strong>{formatDateTime(order.updatedAt)}</strong></DetailItem> : null}
      </div>
    );
  }

  const lifecycle = item.kind === "position-close" || item.kind === "liquidation";
  return (
    <div className="portfolio-detail-panel" id={`activity-details-${item.kind}-${item.id}`}>
      <div className="portfolio-detail-heading"><strong>{activityKind(item)}</strong></div>
      {item.proofTxHash ? (
        <DetailItem label="Proof record transaction"><TransactionLink hash={item.proofTxHash} /></DetailItem>
      ) : null}
      {item.txHash ? (
        <DetailItem label={item.kind === "position-close" ? "Close transaction" : item.kind === "liquidation" ? "Liquidation transaction" : "Settlement transaction"}>
          <TransactionLink hash={item.txHash} />
        </DetailItem>
      ) : null}
      {!lifecycle && item.boundlessRequestId ? (
        <DetailItem label="Boundless request"><BoundlessLink requestId={item.boundlessRequestId} /></DetailItem>
      ) : null}
      {item.batchId ? (
        <DetailItem label="Opening batch"><strong>{item.batchId}</strong></DetailItem>
      ) : null}
      {item.proofSystem ? (
        <DetailItem label="Proof system"><strong>{proofSystemLabel(item.proofSystem)}</strong></DetailItem>
      ) : null}
    </div>
  );
}

function LedgerCell({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="portfolio-ledger-cell">
      <span className="portfolio-cell-label">{label}</span>
      {children}
    </div>
  );
}

function DetailItem({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="portfolio-detail-item">
      <span>{label}</span>
      {children}
    </div>
  );
}

function DetailsButton({ controlsId, expanded, onClick }: { controlsId: string; expanded: boolean; onClick: () => void }) {
  return (
    <button
      aria-controls={controlsId}
      aria-expanded={expanded}
      className="portfolio-details-button"
      type="button"
      onClick={onClick}
    >
      <span>More details</span>
      <ChevronDown aria-hidden="true" size={15} strokeWidth={2} />
    </button>
  );
}

function TransactionLink({ hash }: { hash: Hex }) {
  return (
    <a
      className="portfolio-record-link"
      href={`https://stellar.expert/explorer/testnet/tx/${hash.replace(/^0x/, "")}`}
      rel="noreferrer"
      target="_blank"
      title={hash}
    >
      <span>{shortAddress(hash)}</span>
      <ExternalLink aria-hidden="true" size={13} strokeWidth={2} />
    </a>
  );
}

function BoundlessLink({ requestId }: { requestId: Hex }) {
  return (
    <a
      className="portfolio-record-link"
      href={`https://explorer.boundless.network/orders/${requestId}`}
      rel="noreferrer"
      target="_blank"
      title={requestId}
    >
      <span>{shortAddress(requestId)}</span>
      <ExternalLink aria-hidden="true" size={13} strokeWidth={2} />
    </a>
  );
}

function CopyValue({ value }: { value: Hex }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 900);
  }

  return (
    <button className="portfolio-copy-value" title={value} type="button" onClick={copy}>
      <span>{copied ? "Copied" : shortAddress(value)}</span>
      <Copy aria-hidden="true" size={12} strokeWidth={2} />
    </button>
  );
}

function EmptyRecords({ loading, text }: { loading: boolean; text: string }) {
  return (
    <div className="portfolio-empty-state">
      <strong>{loading ? "Loading" : text}</strong>
      {!loading ? <span>Your records will appear here.</span> : null}
    </div>
  );
}

function closeDisabledReason(
  position: PositionRow,
  onClosePosition?: (position: PositionRow) => Promise<void> | void,
): string | undefined {
  if (!onClosePosition) return "Close action is unavailable";
  if (!position.privateState) return "Private position key is unavailable in this browser";
  return undefined;
}

function sourceOrderForPosition(
  position: PositionRow,
  orders: ServerOwnerOrderSnapshot[],
): ServerOwnerOrderSnapshot | undefined {
  const byIntent = new Map(orders.map((order) => [order.intentCommitment, order]));
  let current = byIntent.get(position.sourceIntentCommitment);
  const visited = new Set<Hex>();
  while (current?.sourceIntentCommitment && !visited.has(current.intentCommitment)) {
    visited.add(current.intentCommitment);
    const parent = byIntent.get(current.sourceIntentCommitment);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function activityMatchesFilter(item: ServerOwnerActivitySnapshot, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "orders") return item.kind === "order";
  if (filter === "positions") return item.kind === "position";
  return item.kind === "position-close" || item.kind === "liquidation";
}

function activityKind(item: ServerOwnerActivitySnapshot): string {
  if (item.kind === "position") return "Position opened";
  if (item.kind === "position-close") return "Position closed";
  if (item.kind === "liquidation") return "Position liquidated";
  if (item.status === "cancelled") return "Order cancelled";
  if (item.status === "filled") return "Order filled";
  if (item.status === "partially-filled") return "Order partially filled";
  return "Order submitted";
}

function matcherLabel(matching: ServerOwnerOrderSnapshot["matching"]): string {
  if (matching.state === "blocked") return matching.message;
  if (matching.state === "waiting-liquidity") return "Waiting for liquidity";
  if (matching.state === "matching") return "Matching";
  if (matching.state === "proving") return "Preparing settlement";
  if (matching.state === "settling") return "Settling";
  if (matching.state === "settled") return "Settled";
  return "Queued";
}

function proofSystemLabel(system: "noir-ultrahonk" | "risc0-groth16"): string {
  return system === "risc0-groth16" ? "RISC Zero zkVM · Groth16" : "Noir · UltraHonk";
}

function statusLabel(status?: string): string {
  if (!status) return "—";
  return status
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sideLabel(side?: "long" | "short"): string {
  if (!side) return "Private";
  return side === "long" ? "Long" : "Short";
}

function pairFromMarketId(marketId: string): string {
  return `${marketId.split("-")[0]?.toUpperCase() || "PERP"}/USD`;
}

function baseAsset(market: string): string {
  return market.split("/")[0] || "PERP";
}

function positionPriceRange(position: PositionRow): string {
  if (typeof position.entryPrice !== "number" || typeof position.marketPrice !== "number") {
    return position.privateDetails ? "Shielded" : "—";
  }
  return `${formatPrice(position.entryPrice)} → ${formatPrice(position.marketPrice)}`;
}

function privateNumber(
  value: number | undefined,
  formatter: (value: number) => string,
  privateDetails?: boolean,
): string {
  if (typeof value === "number") return formatter(value);
  return privateDetails ? "Shielded" : "—";
}

function signedPrivateUsd(value: number | undefined, privateDetails?: boolean): string {
  if (typeof value !== "number") return privateDetails ? "Shielded" : "—";
  if (Math.abs(value) < Number.EPSILON) return portfolioUsd(0);
  return `${value > 0 ? "+" : "−"}${portfolioUsd(Math.abs(value))}`;
}

function signedValueClass(value?: number): string {
  if (typeof value !== "number" || Math.abs(value) < Number.EPSILON) return "";
  return value > 0 ? "portfolio-value-positive" : "portfolio-value-negative";
}

function formatFlexibleNumber(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatPrice(value: number): string {
  return formatUsd(value, {
    maximumFractionDigits: value < 1 ? 5 : value < 100 ? 3 : 1,
    minimumFractionDigits: value < 1 ? 4 : value < 100 ? 2 : 0,
  });
}

function portfolioUsd(value: number): string {
  return formatUsd(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp));
}
