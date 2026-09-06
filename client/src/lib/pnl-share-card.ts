import { formatNumber, formatPct, formatSignedSettlementUsd } from "@/lib/format";

const CARD_WIDTH = 1122;
const CARD_HEIGHT = 1402;
const FONT_FAMILY = 'Inter, "Helvetica Neue", Arial, sans-serif';

export interface PnlShareCardInput {
  closePrice: number;
  entryPrice: number;
  marketId: string;
  netRealizedPnl: number;
  pnlPercent?: number;
  side: "long" | "short";
  txHash?: string;
}

export function pnlShareCardContent(input: PnlShareCardInput) {
  const asset = input.marketId.split("-")[0]?.toUpperCase() || "PERP";
  const txHash = input.txHash?.replace(/^0x/, "");

  return {
    entry: formatNumber(input.entryPrice, 4),
    exit: formatNumber(input.closePrice, 4),
    fileName: `pnlx-${asset.toLowerCase()}-pnl.png`,
    market: `${asset}/USD`,
    pnl: formatSignedSettlementUsd(input.netRealizedPnl),
    pnlPercent: input.pnlPercent === undefined ? undefined : formatPct(input.pnlPercent),
    side: `${input.side === "long" ? "Long" : "Short"} · Market`,
    txHash: txHash ? `${txHash.slice(0, 4)}...${txHash.slice(-4)}`.toUpperCase() : undefined,
  };
}

export async function createPnlShareCardFile(input: PnlShareCardInput): Promise<File> {
  const content = pnlShareCardContent(input);
  const background = await loadImage("/pnlx-pnl-modal-bg.png");
  await document.fonts?.ready;

  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");

  context.drawImage(background, 0, 0, CARD_WIDTH, CARD_HEIGHT);
  context.textBaseline = "alphabetic";

  drawText(context, "PNL", 74, 424, 22, 700, "rgba(235, 230, 220, 0.58)");
  drawText(context, content.pnl, 74, 530, 96, 800, "#ebe6dc");
  if (content.pnlPercent) {
    drawText(
      context,
      content.pnlPercent,
      74,
      586,
      47,
      700,
      input.netRealizedPnl < 0 ? "#ef4560" : "#27d68b",
    );
  }

  drawText(context, content.market, 74, 704, 38, 600, "#ebe6dc");
  drawText(context, content.side.toUpperCase(), 74, 778, 29, 500, "rgba(235, 230, 220, 0.66)");

  drawText(context, "ENTRY", 74, 912, 28, 500, "rgba(235, 230, 220, 0.62)");
  drawText(context, content.entry, 342, 912, 31, 700, "#ebe6dc");
  drawText(context, "EXIT", 74, 990, 28, 500, "rgba(235, 230, 220, 0.62)");
  drawText(context, content.exit, 342, 990, 31, 700, "#ebe6dc");

  if (content.txHash) {
    context.beginPath();
    context.moveTo(74, 1098);
    context.lineTo(470, 1098);
    context.strokeStyle = "rgba(235, 230, 220, 0.13)";
    context.lineWidth = 2;
    context.stroke();
    drawText(context, "SETTLEMENT TX", 74, 1160, 22, 700, "rgba(235, 230, 220, 0.58)");
    drawText(context, content.txHash, 74, 1205, 28, 700, "#ebe6dc");
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("PNL image could not be created"));
    }, "image/png");
  });

  return new File([blob], content.fileName, { type: "image/png" });
}

function drawText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  weight: number,
  color: string,
) {
  context.fillStyle = color;
  context.font = `${weight} ${size}px ${FONT_FAMILY}`;
  context.fillText(text, x, y);
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("PNL card background could not be loaded"));
    image.src = source;
  });
}
