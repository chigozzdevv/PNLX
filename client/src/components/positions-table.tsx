"use client";

import { ChevronDown, Copy, ExternalLink } from "lucide-react";
import { Fragment, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatNumber, formatUsd, shortAddress } from "@/lib/format";
import type {
  Hex,
  PositionRow,
  ServerOwnerActivitySnapshot,
  ServerOwnerOrderSnapshot,
} from "@/types/trading";

interface PositionsTableProps {
  activity?: ServerOwnerActivitySnapshot[];
  activeView?: PositionsTableView;
  loading?: boolean;
  closingPositionId?: string;
  cancellingOrderId?: string;
  actionMessage?: { tone: "error" | "success"; text: string };
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  onCancelOrder?: (order: ServerOwnerOrderSnapshot) => Promise<void> | void;
  onViewChange?: (view: PositionsTableView) => void;
  orders?: ServerOwnerOrderSnapshot[];
  positions: PositionRow[];
}

const TABLE_VIEWS = ["positions", "orders", "activity"] as const;
type TableView = (typeof TABLE_VIEWS)[number];
export type PositionsTableView = TableView;

export function PositionsTable({
  actionMessage,
  cancellingOrderId,
  activity = [],
  activeView,
  closingPositionId,
  loading = false,
  onCancelOrder,
  onClosePosition,
  onViewChange,
  orders = [],
  positions,
}: PositionsTableProps) {
  const [internalView, setInternalView] = useState<TableView>("positions");
  const [expandedRow, setExpandedRow] = useState<string>();
  const view = activeView ?? internalView;
  const openPositions = positions.filter((position) => position.status === "open");
  const openOrders = orders.filter(isOpenOrder);
  const visibleActivity = useMemo(
    () => [...activity.filter((item) => item.kind !== "account-event")]
      .sort((left, right) => activityTimestamp(right) - activityTimestamp(left)),
    [activity],
  );

  function selectView(nextView: TableView) {
    setInternalView(nextView);
    setExpandedRow(undefined);
    onViewChange?.(nextView);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentView: TableView) {
    const currentIndex = TABLE_VIEWS.indexOf(currentView);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABLE_VIEWS.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TABLE_VIEWS.length) % TABLE_VIEWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABLE_VIEWS.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextView = TABLE_VIEWS[nextIndex];
    selectView(nextView);
    window.requestAnimationFrame(() => document.getElementById(tabId(nextView))?.focus());
  }

  function toggleDetails(key: string) {
    setExpandedRow((current) => current === key ? undefined : key);
  }

  return (
    <section className="panel positions-panel" aria-label="Trade records">
      <div className="positions-topbar">
        <div className="positions-tabs" role="tablist" aria-label="Trade records">
          <TradeRecordTab
            active={view === "positions"}
            count={openPositions.length}
            label="Positions"
            onClick={() => selectView("positions")}
            onKeyDown={(event) => handleTabKeyDown(event, "positions")}
            view="positions"
          />
          <TradeRecordTab
            active={view === "orders"}
            count={openOrders.length}
            label="Orders"
            onClick={() => selectView("orders")}
            onKeyDown={(event) => handleTabKeyDown(event, "orders")}
            view="orders"
          />
          <TradeRecordTab
            active={view === "activity"}
            count={visibleActivity.length}
            label="Activity"
            onClick={() => selectView("activity")}
            onKeyDown={(event) => handleTabKeyDown(event, "activity")}
            view="activity"
          />
        </div>
        {actionMessage ? (
          <p
            className={`positions-action-message positions-action-message-${actionMessage.tone}`}
            role="status"
            title={actionMessage.text}
          >
            {actionMessage.text}
          </p>
        ) : null}
      </div>

      <div
        aria-labelledby={tabId(view)}
        className="trade-records-panel"
        id={panelId(view)}
        role="tabpanel"
      >
        {view === "positions" ? (
          <PositionsView
            closingPositionId={closingPositionId}
            expandedRow={expandedRow}
            loading={loading}
            onClosePosition={onClosePosition}
            onToggleDetails={toggleDetails}
            orders={orders}
            positions={openPositions}
          />
        ) : view === "orders" ? (
          <OrdersView
            cancellingOrderId={cancellingOrderId}
            expandedRow={expandedRow}
            loading={loading}
            onCancelOrder={onCancelOrder}
            onToggleDetails={toggleDetails}
            orders={openOrders}
          />
        ) : (
          <ActivityView
            activity={visibleActivity}
            expandedRow={expandedRow}
            loading={loading}
            onToggleDetails={toggleDetails}
            orders={orders}
          />
        )}
      </div>
    </section>
  );
}

function TradeRecordTab({
  active,
  count,
  label,
  onClick,
  onKeyDown,
  view,
}: {
  active: boolean;
  count?: number;
  label: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  view: TableView;
}) {
  return (
    <button
      aria-controls={panelId(view)}
      aria-selected={active}
      className={`positions-tab ${active ? "positions-tab-active" : ""}`}
      id={tabId(view)}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {label}{typeof count === "number" ? ` ${count}` : ""}
    </button>
  );
}

function PositionsView({
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
    <div className="trade-records-ledger">
      <div className="trade-records-head trade-position-grid" aria-hidden="true">
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
            <div className="trade-records-row trade-position-grid">
              <div className="trade-records-primary">
                <strong>{position.market} · {sideLabel(position.side)}</strong>
                <small>Opened · {formatDateTime(position.openedAt)}</small>
              </div>
              <RecordCell label="Size">
                {privateNumber(
                  position.size,
                  (value) => `${formatNumber(value, 6)} ${baseAsset(position.market)}`,
                  position.privateDetails,
                )}
              </RecordCell>
              <RecordCell label="Entry → mark">
                <span>{positionPriceRange(position)}</span>
              </RecordCell>
              <RecordCell label="Margin">
                {privateNumber(position.collateral, portfolioUsd, position.privateDetails)}
              </RecordCell>
              <RecordCell label="PnL">
                <span className={signedValueClass(position.unrealizedPnl)}>
                  {signedPrivateUsd(position.unrealizedPnl, position.privateDetails)}
                </span>
              </RecordCell>
              <div className="trade-records-actions">
                <button
                  className="trade-records-secondary-action"
                  disabled={Boolean(closeUnavailableReason) || closingPositionId === position.id}
                  title={closeUnavailableReason}
                  type="button"
                  onClick={() => onClosePosition?.(position)}
                >
                  {closingPositionId === position.id
                    ? "Closing"
                    : !position.privateState
                      ? "Key unavailable"
                      : closeUnavailableReason
                        ? "Unavailable"
                        : "Close"}
                </button>
                <DetailsButton
                  controlsId={`trade-position-details-${position.id}`}
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
    <div className="trade-records-details" id={`trade-position-details-${position.id}`}>
      <div className="trade-records-details-heading"><strong>Position details</strong></div>
      {order?.submissionTxHash ? (
        <DetailItem label="Order submission"><TransactionLink hash={order.submissionTxHash} /></DetailItem>
      ) : null}
      {position.proofVerificationTxHash ? (
        <DetailItem label="Proof record transaction">
          <TransactionLink hash={position.proofVerificationTxHash} />
        </DetailItem>
      ) : null}
      {position.settlementTxHash ? (
        <DetailItem label="Settlement transaction"><TransactionLink hash={position.settlementTxHash} /></DetailItem>
      ) : null}
      {position.boundlessRequestId ? (
        <DetailItem label="Boundless request"><BoundlessLink requestId={position.boundlessRequestId} /></DetailItem>
      ) : null}
      <DetailItem label="Batch ID"><strong>{position.batchId}</strong></DetailItem>
      {position.proofSystem ? (
        <DetailItem label="Proof system"><strong>{proofSystemLabel(position.proofSystem)}</strong></DetailItem>
      ) : null}
    </div>
  );
}

function OrdersView({
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
  onCancelOrder?: (order: ServerOwnerOrderSnapshot) => Promise<void> | void;
  onToggleDetails: (key: string) => void;
  orders: ServerOwnerOrderSnapshot[];
}) {
  if (orders.length === 0) return <EmptyRecords loading={loading} text="No open orders" />;

  return (
    <div className="trade-records-ledger">
      <div className="trade-records-head trade-order-grid" aria-hidden="true">
        <span>Market</span>
        <span>Status</span>
        <span>Submitted</span>
        <span>Actions</span>
      </div>
      {orders.map((order) => {
        const key = `order:${order.intentCommitment}`;
        const expanded = expandedRow === key;
        return (
          <Fragment key={order.intentCommitment}>
            <div className="trade-records-row trade-order-grid">
              <div className="trade-records-primary">
                <strong>{pairFromMarketId(order.marketId)}</strong>
                <small>Private intent</small>
              </div>
              <RecordCell label="Status">
                <span>{statusLabel(order.status)}</span>
                <small>{matcherLabel(order.matching)}</small>
              </RecordCell>
              <RecordCell label="Submitted">
                <span>{formatDateTime(order.createdAt)}</span>
                <small>Updated · {formatDateTime(order.updatedAt)}</small>
              </RecordCell>
              <div className="trade-records-actions">
                <button
                  className="trade-records-secondary-action"
                  disabled={!onCancelOrder || cancellingOrderId === order.intentCommitment}
                  type="button"
                  onClick={() => onCancelOrder?.(order)}
                >
                  {cancellingOrderId === order.intentCommitment ? "Cancelling" : "Cancel"}
                </button>
                <DetailsButton
                  controlsId={`trade-order-details-${order.intentCommitment}`}
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

function OrderDetails({ order }: { order: ServerOwnerOrderSnapshot }) {
  return (
    <div className="trade-records-details" id={`trade-order-details-${order.intentCommitment}`}>
      <div className="trade-records-details-heading">
        <strong>Order details</strong>
        <span>{statusLabel(order.status)}</span>
      </div>
      {order.submissionTxHash ? (
        <DetailItem label="Submission transaction"><TransactionLink hash={order.submissionTxHash} /></DetailItem>
      ) : null}
      {order.cancellationTxHash ? (
        <DetailItem label="Cancellation transaction"><TransactionLink hash={order.cancellationTxHash} /></DetailItem>
      ) : null}
      <DetailItem label="Order batch"><strong>{order.batchId}</strong></DetailItem>
      {order.matching.batchId ? (
        <DetailItem label="Latest matching batch"><strong>{order.matching.batchId}</strong></DetailItem>
      ) : null}
      <DetailItem label="Matching status"><strong>{matcherLabel(order.matching)}</strong></DetailItem>
      {order.matching.runId ? (
        <DetailItem label="Matching run"><CopyValue value={order.matching.runId} /></DetailItem>
      ) : null}
      <DetailItem label="Residual order"><strong>{order.isResidual ? "Yes" : "No"}</strong></DetailItem>
      <DetailItem label="Intent ID"><CopyValue value={order.intentCommitment} /></DetailItem>
    </div>
  );
}

function ActivityView({
  activity,
  expandedRow,
  loading,
  onToggleDetails,
  orders,
}: {
  activity: ServerOwnerActivitySnapshot[];
  expandedRow?: string;
  loading: boolean;
  onToggleDetails: (key: string) => void;
  orders: ServerOwnerOrderSnapshot[];
}) {
  if (activity.length === 0) return <EmptyRecords loading={loading} text="No activity" />;

  return (
    <div className="trade-records-ledger">
      <div className="trade-records-head trade-activity-grid" aria-hidden="true">
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
            <div className="trade-records-row trade-activity-grid">
              <div className="trade-records-primary">
                <strong>{activityKind(item)}</strong>
                <small>{item.marketId ? pairFromMarketId(item.marketId) : "Protocol"}</small>
              </div>
              <RecordCell label="Status">{statusLabel(item.status)}</RecordCell>
              <RecordCell label="Time">{formatDateTime(activityTimestamp(item))}</RecordCell>
              <div className="trade-records-actions">
                <DetailsButton
                  controlsId={`trade-activity-details-${item.kind}-${item.id}`}
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
      <div className="trade-records-details" id={`trade-activity-details-${item.kind}-${item.id}`}>
        <div className="trade-records-details-heading">
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
      </div>
    );
  }

  const lifecycle = item.kind === "position-close" || item.kind === "liquidation";
  return (
    <div className="trade-records-details" id={`trade-activity-details-${item.kind}-${item.id}`}>
      <div className="trade-records-details-heading"><strong>{activityKind(item)}</strong></div>
      {item.proofTxHash ? (
        <DetailItem label="Proof record transaction"><TransactionLink hash={item.proofTxHash} /></DetailItem>
      ) : null}
      {item.txHash ? (
        <DetailItem label={activityTransactionLabel(item)}><TransactionLink hash={item.txHash} /></DetailItem>
      ) : null}
      {!lifecycle && item.boundlessRequestId ? (
        <DetailItem label="Boundless request"><BoundlessLink requestId={item.boundlessRequestId} /></DetailItem>
      ) : null}
      {item.batchId ? (
        <DetailItem label={lifecycle ? "Opening batch" : "Batch ID"}><strong>{item.batchId}</strong></DetailItem>
      ) : null}
      {item.proofSystem ? (
        <DetailItem label="Proof system"><strong>{proofSystemLabel(item.proofSystem)}</strong></DetailItem>
      ) : null}
    </div>
  );
}

function RecordCell({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="trade-records-cell">
      <span className="trade-records-cell-label">{label}</span>
      {children}
    </div>
  );
}

function DetailItem({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="trade-records-detail-item">
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
      className="trade-records-details-button"
      type="button"
      onClick={onClick}
    >
      <span>More details</span>
      <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
    </button>
  );
}

function TransactionLink({ hash }: { hash: Hex }) {
  return (
    <a
      className="trade-records-link"
      href={`https://stellar.expert/explorer/testnet/tx/${hash.replace(/^0x/, "")}`}
      rel="noreferrer"
      target="_blank"
      title={hash}
    >
      <span>{shortAddress(hash)}</span>
      <ExternalLink aria-hidden="true" size={12} strokeWidth={2} />
    </a>
  );
}

function BoundlessLink({ requestId }: { requestId: Hex }) {
  return (
    <a
      className="trade-records-link"
      href={`https://explorer.boundless.network/orders/${requestId}`}
      rel="noreferrer"
      target="_blank"
      title={requestId}
    >
      <span>{shortAddress(requestId)}</span>
      <ExternalLink aria-hidden="true" size={12} strokeWidth={2} />
    </a>
  );
}

function CopyValue({ value }: { value: Hex }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button className="trade-records-copy" title={value} type="button" onClick={copy}>
      <span>{copied ? "Copied" : shortAddress(value)}</span>
      <Copy aria-hidden="true" size={12} strokeWidth={2} />
    </button>
  );
}

function EmptyRecords({ loading, text }: { loading: boolean; text: string }) {
  return (
    <div className="trade-records-empty">
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

function isOpenOrder(order: ServerOwnerOrderSnapshot): boolean {
  return order.status === "open" || order.status === "partially-filled";
}

function activityTimestamp(item: ServerOwnerActivitySnapshot): number {
  if (item.kind === "order" && item.status !== "open") return item.updatedAt;
  return item.timestamp;
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

function activityTransactionLabel(item: ServerOwnerActivitySnapshot): string {
  if (item.kind === "position-close") return "Close transaction";
  if (item.kind === "liquidation") return "Liquidation transaction";
  return "Settlement transaction";
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
  return value > 0 ? "trade-records-positive" : "trade-records-negative";
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

function tabId(view: TableView): string {
  return `trade-record-tab-${view}`;
}

function panelId(view: TableView): string {
  return `trade-record-panel-${view}`;
}
