import { ExternalLink, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { formatNumber, formatUsd, shortAddress } from "@/lib/format";
import type {
  PositionRow,
  ServerOwnerActivitySnapshot,
  ServerOwnerOrderSnapshot,
} from "@/types/trading";

interface PositionsTableProps {
  accountEventCount?: number;
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
  const visibleActivity = activity.filter((item) => item.kind !== "account-event");
  const rowCount = view === "positions" ? positions.length : view === "orders" ? orders.length : visibleActivity.length;
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
            Trades ({positions.length})
          </button>
          <button
            className={`positions-tab ${view === "orders" ? "positions-tab-active" : ""}`}
            type="button"
            onClick={() => selectView("orders")}
          >
            Orders ({orders.length})
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
            positions={positions}
          />
        ) : view === "orders" ? (
          <OrdersView cancellingOrderId={cancellingOrderId} onCancelOrder={onCancelOrder} orders={orders} />
        ) : (
          <HistoryView activity={visibleActivity} />
        )}

        {rowCount === 0 ? (
          <div className="empty-positions">
            <ShieldCheck size={22} />
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
      <div className="positions-head">
        <span>Time</span>
        <span>Market & Side</span>
        <span>Size</span>
        <span>Collateral</span>
        <span>Entry Price</span>
        <span>Market Price</span>
        <span>Net Value</span>
        <span>Status</span>
        <span>Evidence</span>
        <span />
      </div>

      {positions.map((position) => {
        const closeUnavailableReason = position.status === "open"
          ? closeDisabledReason(position, onClosePosition)
          : undefined;
        return (
          <div className="positions-row" key={position.id}>
            <span>{position.time}</span>
            <strong>
              {position.market}
              {position.side ? ` / ${position.side}` : ""}
            </strong>
            <span>{privateNumber(position.size, (value) => formatNumber(value, 6), position.privateDetails)}</span>
            <span>{privateNumber(position.collateral, formatUsd, position.privateDetails)}</span>
            <span>{privateNumber(position.entryPrice, (value) => formatNumber(value, 1), position.privateDetails)}</span>
            <span>{privateNumber(position.marketPrice, (value) => formatNumber(value, 1), position.privateDetails)}</span>
            <span>{privateNumber(position.netValue, formatUsd, position.privateDetails)}</span>
            <span>{statusLabel(position.status)}</span>
            <span>
              <span className="evidence-stack">
                {position.lifecycleTxHash ? (
                  <TransactionLink
                    hash={position.lifecycleTxHash}
                    label={position.lifecycleKind === "liquidation" ? "Liquidated" : "Closed"}
                  />
                ) : position.settlementTxHash ? (
                  <TransactionLink hash={position.settlementTxHash} label="Opened" />
                ) : position.commitment ? (
                  <span title={position.commitment}>{shortAddress(position.commitment)}</span>
                ) : "--"}
                {position.boundlessRequestId ? (
                  <BoundlessLink requestId={position.boundlessRequestId} />
                ) : null}
              </span>
            </span>
            <span>
              {position.status === "open" ? (
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
              ) : (
                "--"
              )}
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
      <div className="positions-head">
        <span>Created</span>
        <span>Market</span>
        <span>Status</span>
        <span>Type</span>
        <span>Intent</span>
        <span>Residual</span>
        <span>Batch</span>
        <span>Updated</span>
        <span>Matcher</span>
        <span>Transaction</span>
      </div>

      {orders.map((order) => (
        <div className="positions-row" key={order.intentCommitment}>
          <span>{formatTime(order.createdAt)}</span>
          <strong>{pairFromMarketId(order.marketId)}</strong>
          <span>{statusLabel(order.status)}</span>
          <span>{order.isResidual ? "Residual" : "Intent"}</span>
          <span title={order.intentCommitment}>
            {shortAddress(order.intentCommitment)}
          </span>
          <span title={order.residualCommitment}>
            {order.residualCommitment ? shortAddress(order.residualCommitment) : "--"}
          </span>
          <span title={order.batchId}>
            {order.batchId}
          </span>
          <span>{formatTime(order.updatedAt)}</span>
          <span title={order.matching?.reason ?? order.matchingPayloadCommitment}>
            {order.matching ? matcherLabel(order.matching) : shortAddress(order.matchingPayloadCommitment)}
          </span>
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
              {!order.submissionTxHash && !order.cancellationTxHash && order.status !== "open" && order.status !== "partially-filled"
                ? "--"
                : null}
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
      <div className="positions-head">
        <span>Time</span>
        <span>Type</span>
        <span>Market</span>
        <span>Status</span>
        <span>ID</span>
        <span>Batch</span>
        <span>ZK Proof</span>
        <span>Updated</span>
        <span>Proof Tx</span>
        <span>Settlement Tx</span>
      </div>

      {activity.map((item) => (
        <div className="positions-row" key={`${item.kind}:${item.id}`}>
          <span>{formatTime(item.timestamp)}</span>
          <strong>{activityKind(item.kind)}</strong>
          <span>{item.marketId ? pairFromMarketId(item.marketId) : "--"}</span>
          <span>{statusLabel(item.status)}</span>
          <span title={item.id}>
            {shortAddress(item.id)}
          </span>
          <span title={item.batchId}>
            {item.batchId ?? "--"}
          </span>
          <span>
            {item.boundlessRequestId ? (
              <BoundlessLink requestId={item.boundlessRequestId} />
            ) : item.proofDigest ? (
              <span title={`${proofLabel(item.proofSystem)}: ${item.proofDigest}`}>
                {proofLabel(item.proofSystem)} {shortAddress(item.proofDigest)}
              </span>
            ) : "--"}
          </span>
          <span>{formatTime(item.updatedAt)}</span>
          <span>
            {item.proofTxHash ? <TransactionLink hash={item.proofTxHash} label="Verified" /> : "--"}
          </span>
          <span>
            {item.txHash ? <TransactionLink hash={item.txHash} label="View" /> : "--"}
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

function activityKind(kind: ServerOwnerActivitySnapshot["kind"]): string {
  if (kind === "position") return "Trade opened";
  if (kind === "position-close") return "Trade closed";
  if (kind === "liquidation") return "Liquidated";
  return kind
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function emptyText(view: TableView): string {
  if (view === "orders") return "No orders";
  if (view === "history") return "No history";
  return "No open trades";
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
