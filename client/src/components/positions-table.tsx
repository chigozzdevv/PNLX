import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { formatNumber, formatUsd, shortAddress } from "@/lib/format";
import type {
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

type TableView = "positions" | "orders" | "history";
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
  const view = activeView ?? internalView;
  const openPositions = positions.filter((position) => position.status === "open");
  const openOrders = orders.filter((order) => order.status === "open" || order.status === "partially-filled");
  const visibleActivity = activity.filter((item) => item.kind !== "account-event").reverse();
  const rowCount = view === "positions"
    ? openPositions.length
    : view === "orders"
      ? openOrders.length
      : visibleActivity.length;
  const selectView = (nextView: TableView) => {
    setInternalView(nextView);
    onViewChange?.(nextView);
  };

  return (
    <section className="panel positions-panel">
      <div className="positions-topbar">
        <div className="positions-tabs">
          <button
            className={`positions-tab ${view === "positions" ? "positions-tab-active" : ""}`}
            type="button"
            onClick={() => selectView("positions")}
          >
            Positions ({openPositions.length})
          </button>
          <button
            className={`positions-tab ${view === "orders" ? "positions-tab-active" : ""}`}
            type="button"
            onClick={() => selectView("orders")}
          >
            Open Orders ({openOrders.length})
          </button>
          <button
            className={`positions-tab ${view === "history" ? "positions-tab-active" : ""}`}
            type="button"
            onClick={() => selectView("history")}
          >
            History ({visibleActivity.length})
          </button>
        </div>
        {actionMessage ? (
          <p className={`positions-action-message positions-action-message-${actionMessage.tone}`} title={actionMessage.text}>
            {actionMessage.text}
          </p>
        ) : null}
      </div>

      <div className="positions-table">
        {view === "positions" ? (
          <PositionsView
            closingPositionId={closingPositionId}
            onClosePosition={onClosePosition}
            positions={openPositions}
          />
        ) : view === "orders" ? (
          <OrdersView cancellingOrderId={cancellingOrderId} onCancelOrder={onCancelOrder} orders={openOrders} />
        ) : (
          <HistoryView activity={visibleActivity} />
        )}

        {rowCount === 0 ? (
          <div className="empty-positions">
            <span>{loading ? "Loading" : emptyText(view)}</span>
          </div>
        ) : (
          null
        )}
      </div>
    </section>
  );
}

function PositionsView({
  closingPositionId,
  onClosePosition,
  positions,
}: {
  closingPositionId?: string;
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  positions: PositionRow[];
}) {
  return (
    <>
      <div className="positions-head trades-grid">
        <span>Market</span>
        <span>Size</span>
        <span>Entry</span>
        <span>Mark</span>
        <span>PnL</span>
        <span>Margin</span>
        <span>Action</span>
      </div>

      {positions.map((position) => {
        const closeUnavailableReason = position.status === "open"
          ? closeDisabledReason(position, onClosePosition)
          : undefined;
        return (
          <div className="positions-row trades-grid" key={position.id}>
            <span className="table-primary-cell">
              <strong>{position.market}</strong>
              <small className={`position-side position-side-${position.side ?? "private"}`}>
                {position.side ? position.side.toUpperCase() : "PRIVATE"}
              </small>
            </span>
            <span>{privateNumber(position.size, (value) => formatNumber(value, 6), position.privateDetails)}</span>
            <span>{privateNumber(position.entryPrice, formatPrice, position.privateDetails)}</span>
            <span>{privateNumber(position.marketPrice, formatPrice, position.privateDetails)}</span>
            <span className={(position.unrealizedPnl ?? 0) >= 0 ? "metric-positive" : "metric-negative"}>
              {typeof position.unrealizedPnl === "number" && position.unrealizedPnl >= 0 ? "+" : ""}
              {privateNumber(position.unrealizedPnl, formatUsd, position.privateDetails)}
            </span>
            <span>{privateNumber(position.collateral, formatUsd, position.privateDetails)}</span>
            <span>
              <button
                className="row-action-button"
                disabled={Boolean(closeUnavailableReason) || closingPositionId === position.id}
                title={closeUnavailableReason}
                type="button"
                onClick={() => onClosePosition?.(position)}
              >
                {closingPositionId === position.id
                  ? "Closing"
                  : closeUnavailableReason
                    ? "Key missing"
                    : "Close"}
              </button>
            </span>
          </div>
        );
      })}
    </>
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

function OrdersView({
  cancellingOrderId,
  onCancelOrder,
  orders,
}: {
  cancellingOrderId?: string;
  onCancelOrder?: (order: ServerOwnerOrderSnapshot) => Promise<void> | void;
  orders: ServerOwnerOrderSnapshot[];
}) {
  return (
    <>
      <div className="positions-head orders-grid">
        <span>Market</span>
        <span>Type</span>
        <span>Status</span>
        <span>Submitted</span>
        <span>Updated</span>
        <span>Action</span>
      </div>

      {orders.map((order) => (
        <div className="positions-row orders-grid" key={order.intentCommitment}>
          <strong>{pairFromMarketId(order.marketId)}</strong>
          <span>{order.isResidual ? "Residual" : "Private"}</span>
          <span className="table-primary-cell">
            <strong>{statusLabel(order.status)}</strong>
            <small>{matcherLabel(order.matching)}</small>
          </span>
          <span>{formatDateTime(order.createdAt)}</span>
          <span>{formatTime(order.updatedAt)}</span>
          <span>
            <span className="row-actions">
              {order.cancellationTxHash ? (
                <TransactionLink hash={order.cancellationTxHash} label="Cancelled" />
              ) : order.submissionTxHash ? (
                <TransactionLink hash={order.submissionTxHash} label="Submitted" />
              ) : null}
              {order.status === "open" || order.status === "partially-filled" ? (
                <button
                  className="row-action-button"
                  disabled={!onCancelOrder || cancellingOrderId === order.intentCommitment}
                  type="button"
                  onClick={() => onCancelOrder?.(order)}
                >
                  {cancellingOrderId === order.intentCommitment ? "Canceling" : "Cancel"}
                </button>
              ) : null}
              {!order.submissionTxHash && !order.cancellationTxHash && !onCancelOrder ? "--" : null}
            </span>
          </span>
        </div>
      ))}
    </>
  );
}

function HistoryView({ activity }: { activity: ServerOwnerActivitySnapshot[] }) {
  return (
    <>
      <div className="positions-head history-grid">
        <span>Time</span>
        <span>Event</span>
        <span>Market</span>
        <span>Status</span>
        <span>Proof</span>
        <span>Transaction</span>
      </div>

      {activity.map((item) => (
        <div className="positions-row history-grid" key={`${item.kind}:${item.id}`}>
          <span>{formatDateTime(item.timestamp)}</span>
          <strong>{activityKind(item)}</strong>
          <span>{item.marketId ? pairFromMarketId(item.marketId) : "--"}</span>
          <span>{statusLabel(item.status)}</span>
          <span>
            {item.boundlessRequestId ? (
              <BoundlessLink requestId={item.boundlessRequestId} />
            ) : item.proofDigest ? (
              <span title={`${proofLabel(item.proofSystem)}: ${item.proofDigest}`}>
                {proofLabel(item.proofSystem)} {shortAddress(item.proofDigest)}
              </span>
            ) : "--"}
          </span>
          <span>
            <span className="row-actions">
              {item.proofTxHash ? <TransactionLink hash={item.proofTxHash} label="Proof" /> : null}
              {item.txHash ? <TransactionLink hash={item.txHash} label={activityTransactionLabel(item)} /> : null}
              {!item.proofTxHash && !item.txHash ? "--" : null}
            </span>
          </span>
        </div>
      ))}
    </>
  );
}

function privateNumber(
  value: number | undefined,
  formatter: (value: number) => string,
  privateDetails?: boolean,
): string {
  if (typeof value === "number") return formatter(value);
  return privateDetails ? "Shielded" : "--";
}

function statusLabel(status?: string): string {
  if (!status) return "--";
  return status
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function matcherLabel(matching: ServerOwnerOrderSnapshot["matching"]): string {
  if (matching.state === "blocked") return matching.message;
  if (matching.state === "waiting-liquidity") return "Waiting for liquidity";
  if (matching.state === "matching") return "Matching";
  if (matching.state === "proving") return "Proving";
  if (matching.state === "settling") return "Settling";
  if (matching.state === "settled") return "Settled";
  return "Queued";
}

function TransactionLink({ hash, label }: { hash: `0x${string}`; label: string }) {
  return (
    <a
      className="transaction-link"
      href={`https://stellar.expert/explorer/testnet/tx/${hash.replace(/^0x/, "")}`}
      rel="noreferrer"
      target="_blank"
      title={hash}
    >
      <span>{label}</span>
      <ExternalLink aria-hidden="true" size={12} strokeWidth={2.5} />
    </a>
  );
}

function BoundlessLink({ requestId }: { requestId: `0x${string}` }) {
  return (
    <a
      className="transaction-link proof-evidence-link"
      href={`https://explorer.boundless.network/orders/${requestId}`}
      rel="noreferrer"
      target="_blank"
      title={`Boundless request ${requestId}`}
    >
      <span>Boundless</span>
      <ExternalLink aria-hidden="true" size={12} strokeWidth={2.5} />
    </a>
  );
}

function proofLabel(system?: "noir-ultrahonk" | "risc0-groth16"): string {
  return system === "risc0-groth16" ? "zkVM" : "Noir";
}

function activityTransactionLabel(item: ServerOwnerActivitySnapshot): string {
  if (item.kind === "order") return item.status === "cancelled" ? "Cancelled" : "Submitted";
  if (item.kind === "position-close") return "Closed";
  if (item.kind === "liquidation") return "Liquidated";
  return "Opened";
}

function activityKind(item: ServerOwnerActivitySnapshot): string {
  if (item.kind === "position") return "Position opened";
  if (item.kind === "position-close") return "Position closed";
  if (item.kind === "liquidation") return "Liquidated";
  if (item.status === "cancelled") return "Order cancelled";
  if (item.status === "filled") return "Order filled";
  if (item.status === "partially-filled") return "Order partially filled";
  return "Order submitted";
}

function emptyText(view: TableView): string {
  if (view === "orders") return "No open orders";
  if (view === "history") return "No history";
  return "No open positions";
}

function pairFromMarketId(marketId: string): string {
  return `${marketId.split("-")[0]?.toUpperCase() || "PERP"}/USD`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatPrice(value: number): string {
  return formatNumber(value, value < 1 ? 5 : value < 100 ? 3 : 1);
}
