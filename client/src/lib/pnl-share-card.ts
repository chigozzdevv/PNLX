import { formatNumber, formatPct, formatSignedPnlUsd } from "@/lib/format";

export const PNL_CARD_BACKGROUND = "/pnl-card-coast.webp";
export const PNL_CARD_LOGO = "/pnlx-logo.png";
const CARD_WIDTH = 432;
const CARD_HEIGHT = 540;
const CARD_SCALE = 3;
const TEXT_COLOR = "#f3f0e8";
const MUTED_COLOR = "#a6a49b";

export interface PnlShareCardInput {
  closePrice: number;
  entryPrice: number;
  marketId: string;
  netRealizedPnl: number;
  pnlPercent?: number;
  side: "long" | "short";
  txHash?: string;
}

interface PnlCardAssets {
  background: HTMLImageElement;
  logo: HTMLImageElement;
  fontFamily: string;
}

let assetsPromise: Promise<PnlCardAssets> | undefined;

export function preloadPnlShareCardAssets(): Promise<PnlCardAssets> {
  if (!assetsPromise) {
    assetsPromise = loadPnlCardAssets().catch((error) => {
      assetsPromise = undefined;
      throw error;
    });
  }
  return assetsPromise;
}

async function loadPnlCardAssets(): Promise<PnlCardAssets> {
  const fontFamily = getComputedStyle(document.body).fontFamily || 'Inter, Arial, sans-serif';
  const [background, logo] = await Promise.all([
    loadImage(PNL_CARD_BACKGROUND),
    loadImage(PNL_CARD_LOGO),
    document.fonts?.load(`500 56px ${fontFamily}`),
  ]);
  return { background, logo, fontFamily };
}

export function pnlShareCardContent(input: PnlShareCardInput) {
  const asset = input.marketId.split("-")[0]?.toUpperCase() || "PERP";
  const txHash = input.txHash?.replace(/^0x/, "");

  return {
    entry: formatNumber(input.entryPrice, 4),
    exit: formatNumber(input.closePrice, 4),
    fileName: `pnlx-${asset.toLowerCase()}-pnl.png`,
    market: `${asset}/USD`,
    pnl: formatSignedPnlUsd(input.netRealizedPnl),
    pnlPercent: input.pnlPercent === undefined ? undefined : formatPct(input.pnlPercent),
    side: input.side === "long" ? "Long" : "Short",
    txHash: txHash ? `${txHash.slice(0, 4)}...${txHash.slice(-4)}`.toUpperCase() : undefined,
  };
}

export async function createPnlShareCardFile(input: PnlShareCardInput): Promise<File> {
  const content = pnlShareCardContent(input);
  const { background, logo, fontFamily } = await preloadPnlShareCardAssets();
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH * CARD_SCALE;
  canvas.height = CARD_HEIGHT * CARD_SCALE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.scale(CARD_SCALE, CARD_SCALE);
  context.fillStyle = "#0c0c0b";
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const imageScale = Math.max(CARD_WIDTH / background.naturalWidth, CARD_HEIGHT / background.naturalHeight);
  const imageWidth = background.naturalWidth * imageScale;
  const imageHeight = background.naturalHeight * imageScale;
  context.drawImage(background, (CARD_WIDTH - imageWidth) / 2, (CARD_HEIGHT - imageHeight) / 2, imageWidth, imageHeight);

  const horizontalShade = context.createLinearGradient(0, 0, CARD_WIDTH, 0);
  horizontalShade.addColorStop(0, "rgba(12,12,11,0.24)");
  horizontalShade.addColorStop(0.68, "rgba(12,12,11,0)");
  context.fillStyle = horizontalShade;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  const verticalShade = context.createLinearGradient(0, 0, 0, CARD_HEIGHT);
  verticalShade.addColorStop(0.48, "rgba(12,12,11,0.08)");
  verticalShade.addColorStop(0.62, "rgba(12,12,11,0.04)");
  verticalShade.addColorStop(0.84, "rgba(12,12,11,0.74)");
  verticalShade.addColorStop(1, "rgba(12,12,11,0.94)");
  context.fillStyle = verticalShade;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.drawImage(logo, 28, 28, 112, 112 * logo.naturalHeight / logo.naturalWidth);
  context.textBaseline = "top";

  function drawText(text: string, x: number, y: number, size: number, weight: number, color: string, maxWidth?: number, tracking = 0) {
    context!.fillStyle = color;
    context!.letterSpacing = `${tracking}px`;
    context!.font = `${weight} ${size}px ${fontFamily}`;
    if (maxWidth) {
      while (context!.measureText(text).width > maxWidth && size > 12) {
        size -= 1;
        context!.font = `${weight} ${size}px ${fontFamily}`;
      }
    }
    context!.fillText(text, x, y);
    return context!.measureText(text).width;
  }

  const marketWidth = drawText(content.market, 28, 77, 22, 500, TEXT_COLOR, 260, -0.77);
  context.fillStyle = "#33322c";
  context.fillRect(28 + marketWidth + 11, 79, 1, 20);
  drawText(content.side, 28 + marketWidth + 22, 82, 12, 400, MUTED_COLOR);
  drawText("Realized P&L", 28, 122, 12, 400, MUTED_COLOR);
  drawText(content.pnl, 28, 148, 56, 500, TEXT_COLOR, CARD_WIDTH - 56, -2.24);
  if (content.pnlPercent) {
    const color = input.netRealizedPnl < 0 ? "#de8390" : input.netRealizedPnl > 0 ? "#66cb9e" : MUTED_COLOR;
    const percentWidth = drawText(content.pnlPercent, 28, 222, 16, 500, color, 270);
    drawText("return", 28 + percentWidth + 6, 222, 16, 400, MUTED_COLOR);
  }

  drawText("Entry price", 28, 415, 11, 400, MUTED_COLOR);
  drawText("Exit price", 140, 415, 11, 400, MUTED_COLOR);
  drawText(`$${content.entry}`, 28, 444, 16, 450, TEXT_COLOR, 104, -0.24);
  drawText(`$${content.exit}`, 140, 444, 16, 450, TEXT_COLOR, 264, -0.24);
  drawText("pnlx.trade", 28, 495, 11, 400, TEXT_COLOR);
  context.textAlign = "right";
  drawText("Stellar Testnet", CARD_WIDTH - 28, 495, 11, 400, MUTED_COLOR);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("PNL image could not be created"));
    }, "image/png");
  });

  return new File([blob], content.fileName, { type: "image/png" });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      image.decode().then(() => resolve(image), reject);
    };
    image.onerror = () => reject(new Error("PNL card artwork could not be loaded"));
    image.src = source;
  });
}
