"use client";

import { ExternalLink } from "lucide-react";
import type { OwnerOrderGroup } from "@/lib/order-groups";

export function OrderCapacityDetails({
  cancelling,
  id,
  onCancelOrder,
  order,
}: {
  cancelling: boolean;
  id: string;
  onCancelOrder?: (order: OwnerOrderGroup) => Promise<void> | void;
  order: OwnerOrderGroup;
}) {
  const transactions = [...new Set(order.orders.map((item) => item.submissionTxHash))]
    .filter((hash): hash is `0x${string}` => Boolean(hash && /^(?:0x)?[a-f0-9]{64}$/i.test(hash)));
  const hasCompletedFills = order.orders.some((item) =>
    item.status === "filled" || item.status === "partially-filled"
  );
  const capacity = order.matching.capacity;
  const recordedLimit = /batch proof supports at most (\d+) public items/i.exec(order.matching.reason ?? "")?.[1];
  const checks = capacity ? [
    ["Position outputs", capacity.positionOutputs],
    ["Filled intents", capacity.filledIntents],
    ["Notes to spend", capacity.notesToSpend],
    ["Margin-change outputs", capacity.marginChangeOutputs],
  ] as const : [];

  return (
    <div aria-label="Order processing details" className="order-capacity-details" id={id} role="region">
      <div className="order-capacity-copy">
        <h3>Trade couldn’t be processed</h3>
        <p>The batch containing this order exceeded the current Testnet processing limit.</p>
        {capacity ? (
          <>
            {capacity.matchedExecutions !== undefined ? (
              <p>{capacity.matchedExecutions} matched executions would create {capacity.positionOutputs} position outputs.</p>
            ) : null}
            <table className="order-capacity-breakdown">
              <caption>Batch capacity check</caption>
              <thead><tr><th scope="col">Settlement list</th><th scope="col">Required</th><th scope="col">Limit</th></tr></thead>
              <tbody>
                {checks.map(([label, count]) => (
                  <tr className={count > capacity.limit ? "order-capacity-exceeded" : undefined} key={label}>
                    <th scope="row">{label}</th>
                    <td>{count}{count > capacity.limit ? <span className="order-capacity-over-label"> · over limit</span> : null}</td>
                    <td>{capacity.limit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p>{recordedLimit ? `The recorded limit is ${recordedLimit} items per settlement list. ` : ""}This older failure did not record the batch counts.</p>
        )}
        <p>You can cancel the unfilled order. Its reserved balance becomes available when cancellation is confirmed.</p>
        <p className="order-capacity-note">
          {hasCompletedFills
            ? "Any completed fills remain in your positions."
            : "The released balance stays in your private PNLX account."}
        </p>
      </div>
      <div className="order-capacity-actions">
        <button
          className="trade-records-secondary-action"
          disabled={!onCancelOrder || cancelling}
          onClick={() => onCancelOrder?.(order)}
          type="button"
        >
          {cancelling ? "Cancelling…" : "Cancel order"}
        </button>
      </div>
      {transactions.length > 0 ? (
        <details className="order-capacity-transactions">
          <summary>On-chain order submissions ({transactions.length})</summary>
          <p>These transactions registered the private intents for this order. They do not confirm a completed trade.</p>
          <div>
            {transactions.map((hash) => (
              <a
                className="order-capacity-link"
                href={`https://stellar.expert/explorer/testnet/tx/${hash.replace(/^0x/, "")}`}
                key={hash}
                rel="noreferrer"
                target="_blank"
                aria-label={`View order submission transaction ${hash}`}
              >
                {hash.slice(0, 8)}…{hash.slice(-6)}
                <ExternalLink aria-hidden="true" size={12} />
              </a>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
