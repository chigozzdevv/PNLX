/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { pnlShareCardContent, preloadPnlShareCardAssets } from "@/lib/pnl-share-card";

describe("PNL card sharing", () => {
  test("builds the values rendered into the shared image", () => {
    const content = pnlShareCardContent({
      closePrice: 0.1612,
      entryPrice: 0.1594,
      marketId: "xlm-usd-perp",
      netRealizedPnl: 2.894314,
      pnlPercent: 12.4,
      side: "long",
      txHash: "0x7e897199956b77aa908bf4a437baa41ff464909ec155b5fd93a9e5c28a306763",
    });

    expect(content).toEqual({
      entry: "0.1594",
      exit: "0.1612",
      fileName: "pnlx-xlm-pnl.png",
      market: "XLM/USD",
      pnl: "+$2.89",
      pnlPercent: "+12.40%",
      side: "Long",
      txHash: "7E89...6763",
    });
  });

  test("supports a negative card without a settlement hash", () => {
    const content = pnlShareCardContent({
      closePrice: 0.16,
      entryPrice: 0.17,
      marketId: "xlm-usd-perp",
      netRealizedPnl: -3.25,
      side: "short",
    });

    expect(content.pnl).toBe("−$3.25");
    expect(content.side).toBe("Short");
    expect(content.txHash).toBeUndefined();
  });

  test("preloads decoded images and the font, reuses them, and retries failed loads", async () => {
    const originals = new Map(["Image", "document", "getComputedStyle"].map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const images: ControlledImage[] = [];
    const font = Promise.withResolvers<void>();
    class ControlledImage {
      decoding = "";
      src = "";
      onload = () => {};
      onerror = () => {};
      decoded = Promise.withResolvers<void>();
      constructor() { images.push(this); }
      decode() { return this.decoded.promise; }
    }
    Object.defineProperties(globalThis, {
      Image: { configurable: true, value: ControlledImage },
      document: { configurable: true, value: { body: {}, fonts: { load: () => font.promise } } },
      getComputedStyle: { configurable: true, value: () => ({ fontFamily: "Inter" }) },
    });
    try {
      const failed = preloadPnlShareCardAssets();
      images[0].onerror();
      await expect(failed).rejects.toThrow("artwork");
      const retry = preloadPnlShareCardAssets();
      expect(preloadPnlShareCardAssets()).toBe(retry);
      expect(images).toHaveLength(4);
      let ready = false;
      void retry.then(() => { ready = true; });
      images[2].onload();
      images[3].onload();
      images[2].decoded.resolve();
      images[3].decoded.resolve();
      await Promise.resolve();
      expect(ready).toBe(false);
      font.resolve();
      const assets = await retry;
      expect(ready).toBe(true);
      expect(Object.is(assets.background, images[2])).toBe(true);
      expect(Object.is(assets.logo, images[3])).toBe(true);
      expect(preloadPnlShareCardAssets()).toBe(retry);
      expect(images).toHaveLength(4);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
