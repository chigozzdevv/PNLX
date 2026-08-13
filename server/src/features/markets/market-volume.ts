import type {
  MarketCandle,
  MarketCandleInterval,
  MarketCandlesInput,
} from "@/features/markets/markets.model";
import type { MarketSettlementVolumeRecord } from "@/shared/state/store";

const BASE_ASSET_SCALE = 10_000_000n;

export function applySettlementVolumes(
  candles: MarketCandle[],
  input: MarketCandlesInput,
  records: Iterable<MarketSettlementVolumeRecord>,
): MarketCandle[] {
  const bucketMs = intervalMilliseconds(input.interval);
  const volumes = new Map<number, bigint>();

  for (const record of records) {
    if (record.marketId !== input.marketId || record.matchedVolume <= 0n) continue;
    const bucket = Math.floor(record.settledAt / bucketMs) * bucketMs;
    volumes.set(bucket, (volumes.get(bucket) ?? 0n) + record.matchedVolume);
  }

  return candles.map((candle) => {
    const time = Date.parse(candle.time);
    if (!Number.isFinite(time)) return { ...candle, volume: 0 };
    const bucket = Math.floor(time / bucketMs) * bucketMs;
    return {
      ...candle,
      volume: displayBaseVolume(volumes.get(bucket) ?? 0n),
    };
  });
}

function intervalMilliseconds(interval: MarketCandleInterval): number {
  return {
    "1d": 86_400_000,
    "1h": 3_600_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
  }[interval];
}

function displayBaseVolume(value: bigint): number {
  const whole = value / BASE_ASSET_SCALE;
  const fraction = value % BASE_ASSET_SCALE;
  return Number(whole) + Number(fraction) / Number(BASE_ASSET_SCALE);
}
