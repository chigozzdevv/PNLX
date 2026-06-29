"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { ChartToolbar } from "@/components/chart-toolbar";
import { MarketHeader } from "@/components/market-header";
import { OrderTicket } from "@/components/order-ticket";
import { PositionsTable } from "@/components/positions-table";
import { PriceChart } from "@/components/price-chart";
import { mockTradingData } from "@/data/mock-trading-data";
import { submitTradeIntent } from "@/lib/trade-submit";
import { useTradingData } from "@/lib/use-trading-data";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { OrderTicketSubmitInput } from "@/components/order-ticket";

export function TradingPage() {
  const wallet = useWalletSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const trading = useTradingData(wallet.session, refreshKey);
  const [selectedMarketId, setSelectedMarketId] = useState("btc-usd-perp");
  const markets = trading.data.markets.length > 0 ? trading.data.markets : mockTradingData.markets;
  const activeMarketId = markets.some((market) => market.marketId === selectedMarketId)
    ? selectedMarketId
    : markets[0]?.marketId ?? "btc-usd-perp";
  const selectedMarket = useMemo(
    () => markets.find((market) => market.marketId === activeMarketId) ?? markets[0] ?? mockTradingData.markets[0],
    [activeMarketId, markets],
  );
  const candles = mockTradingData.candlesByMarket[selectedMarket.marketId] ??
    mockTradingData.candlesByMarket["btc-usd-perp"] ??
    [];

  return (
    <AppShell account={trading.data.account} wallet={wallet}>
      <main className="trade-grid">
        <section className="main-column">
          <MarketHeader
            selectedMarket={selectedMarket}
            onSelectMarket={setSelectedMarketId}
          />

          <div className="chart-trades-grid">
            <section className="panel chart-panel">
              <ChartToolbar />
              <PriceChart candles={candles} market={selectedMarket} />
            </section>
          </div>

          <PositionsTable
            activity={trading.data.activity}
            accountEventCount={trading.data.accountEventCount}
            loading={trading.loading}
            orders={trading.data.orders}
            positions={trading.data.positions}
          />
        </section>

        <aside className="order-column">
          <OrderTicket
            connected={Boolean(wallet.session)}
            key={selectedMarket.marketId}
            market={selectedMarket}
            onSubmit={async (input: OrderTicketSubmitInput) => {
              if (!wallet.session) throw new Error("Connect a wallet first");
              const result = await submitTradeIntent({
                ...input,
                market: selectedMarket,
                session: wallet.session,
              });
              setRefreshKey((value) => value + 1);
              return result;
            }}
            order={mockTradingData.orderDraft}
          />
        </aside>
      </main>

      <BottomTicker ticker={trading.data.ticker} />
    </AppShell>
  );
}
