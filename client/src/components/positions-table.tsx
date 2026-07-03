import { ShieldCheck } from "lucide-react";
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
  actionMessage?: { tone: "error" | "success"; text: string };
  onClosePosition?: (position: PositionRow) => Promise<void> | void;
  onViewChange?: (view: PositionsTableView) => void;
  orders?: ServerOwnerOrderSnapshot[];
  positions: PositionRow[];
}

type TableView = "positions" | "orders" | "history";
export type PositionsTableView = TableView;

export function PositionsTable({
  accountEventCount = 0,
  actionMessage,
  activity = [],
  activeView,
  closingPositionId,
  loading = false,
  onClosePosition,
  onViewChange,
  orders = [],
  positions,
}: PositionsTableProps) {
  const [internalView, setInternalView] = useState<TableView>("positions");
  const view = activeView ?? internalView;
  const rowCount = view === "positions" ? positions.length : view === "orders" ? orders.length : activity.length;
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
            History ({activity.length || accountEventCount})
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
          <OrdersView orders={orders} />
        ) : (
          <HistoryView activity={activity} />
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
        <span>Commitment</span>
        <span />
      </div>

      {positions.map((position) => (
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
          <span>{position.commitment ? shortAddress(position.commitment) : "--"}</span>
          <span>
            {position.status === "open" ? (
              <button
                className="row-action-button"
                disabled={!onClosePosition || !position.privateState || closingPositionId === position.id}
                type="button"
                onClick={() => onClosePosition?.(position)}
              >
                {closingPositionId === position.id ? "Closing" : "Close"}
              </button>
            ) : (
              "--"
            )}
          </span>
        </div>
      ))}
    </>
  );
}

function OrdersView({ orders }: { orders: ServerOwnerOrderSnapshot[] }) {
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
        <span />
      </div>

      {orders.map((order) => (
        <div className="positions-row" key={order.intentCommitment}>
          <span>{formatTime(order.createdAt)}</span>
          <strong>{pairFromMarketId(order.marketId)}</strong>
          <span>{statusLabel(order.status)}</span>
          <span>{order.isResidual ? "Residual" : "Intent"}</span>
          <span>{shortAddress(order.intentCommitment)}</span>
          <span>{order.residualCommitment ? shortAddress(order.residualCommitment) : "--"}</span>
          <span>{order.batchId}</span>
          <span>{formatTime(order.updatedAt)}</span>
          <span>{shortAddress(order.matchingPayloadCommitment)}</span>
          <span />
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
        <span>Data</span>
        <span>Updated</span>
        <span />
        <span />
      </div>

      {activity.map((item) => (
        <div className="positions-row" key={`${item.kind}:${item.id}`}>
          <span>{formatTime(item.timestamp)}</span>
          <strong>{activityKind(item.kind)}</strong>
          <span>{item.marketId ? pairFromMarketId(item.marketId) : "--"}</span>
          <span>{statusLabel(item.status)}</span>
          <span>{shortAddress(item.id)}</span>
          <span>{item.batchId ?? "--"}</span>
          <span>{item.dataCommitment ? shortAddress(item.dataCommitment) : "--"}</span>
          <span>{formatTime(item.updatedAt)}</span>
          <span />
          <span />
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

function activityKind(kind: ServerOwnerActivitySnapshot["kind"]): string {
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
