import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { formatUsd, shortAddress } from "@/lib/format";
import { positionLegs, positionSourceOrder } from "@/lib/position-groups";
import type { Hex, PositionRow, ServerOwnerOrderSnapshot } from "@/types/trading";

export function PositionFillDetails({
  className,
  id,
  orders,
  position,
}: {
  className: string;
  id: string;
  orders: readonly ServerOwnerOrderSnapshot[];
  position: PositionRow;
}) {
  const fills = positionLegs(position);

  return (
    <div className={`${className} position-fill-details`} id={id}>
      {fills.map((fill, index) => {
        const order = positionSourceOrder(fill, orders);
        const fillNumber = index + 1;
        const filledAt = Number.isFinite(fill.openedAt) ? new Date(fill.openedAt) : null;

        return (
          <section aria-label={`Fill ${fillNumber}`} className="position-fill" key={fill.id}>
            <strong className="position-fill-heading">Fill {fillNumber}</strong>
            <dl className="position-fill-metrics">
              <FillField label="Size">
                {privateNumber(fill.size, (size) => `${number(size, 8)} ${fill.market.split("/")[0]}`, fill.privateDetails)}
              </FillField>
              <FillField label="Margin">
                {privateNumber(fill.collateral, (margin) => formatUsd(margin, {
                  maximumFractionDigits: 7, minimumFractionDigits: 2,
                }), fill.privateDetails)}
              </FillField>
              <FillField label="Entry">
                {privateNumber(fill.entryPrice, (price) => formatUsd(price, {
                  maximumFractionDigits: 8, minimumFractionDigits: price < 1 ? 4 : 2,
                }), fill.privateDetails)}
              </FillField>
              <FillField label="Filled">
                {filledAt && Number.isFinite(filledAt.getTime()) ? (
                  <time dateTime={filledAt.toISOString()} title={filledAt.toISOString()}>
                    {new Intl.DateTimeFormat("en-GB", {
                      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                      second: "2-digit", hour12: false,
                    }).format(filledAt)}
                  </time>
                ) : "—"}
              </FillField>
            </dl>
            <dl className="position-fill-evidence">
              {order?.submissionTxHash ? (
                <FillField label="Order">
                  <ReceiptLink hash={order.submissionTxHash} label={`Order submission for fill ${fillNumber}`} />
                </FillField>
              ) : null}
              {fill.proofVerificationTxHash ? (
                <FillField label="Proof">
                  <ReceiptLink hash={fill.proofVerificationTxHash} label={`Proof transaction for fill ${fillNumber}`} />
                </FillField>
              ) : null}
              {fill.settlementTxHash ? (
                <FillField label="Settlement">
                  <ReceiptLink hash={fill.settlementTxHash} label={`Settlement transaction for fill ${fillNumber}`} />
                </FillField>
              ) : null}
              {fill.boundlessRequestId ? (
                <FillField label="Boundless">
                  <ReceiptLink boundless hash={fill.boundlessRequestId} label={`Boundless request for fill ${fillNumber}`} />
                </FillField>
              ) : null}
              <FillField label="Batch">{fill.batchId}</FillField>
              {fill.proofSystem ? (
                <FillField label="Proof system">
                  {fill.proofSystem === "risc0-groth16" ? "RISC Zero Groth16" : "Noir UltraHonk"}
                </FillField>
              ) : null}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function FillField({ children, label }: { children: ReactNode; label: string }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function ReceiptLink({ boundless = false, hash, label }: { boundless?: boolean; hash: Hex; label: string }) {
  return (
    <a
      aria-label={label}
      href={boundless
        ? `https://explorer.boundless.network/orders/${hash}`
        : `https://stellar.expert/explorer/testnet/tx/${hash.replace(/^0x/i, "")}`}
      rel="noreferrer"
      target="_blank"
      title={hash}
    >
      <span>{shortAddress(hash)}</span>
      <ExternalLink aria-hidden="true" size={12} strokeWidth={2} />
    </a>
  );
}

function number(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function privateNumber(value: number | undefined, formatter: (value: number) => string, shielded?: boolean): string {
  return typeof value === "number" && Number.isFinite(value) ? formatter(value) : shielded ? "Shielded" : "—";
}
