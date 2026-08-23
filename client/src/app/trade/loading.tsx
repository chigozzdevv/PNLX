import Image from "next/image";
import Link from "next/link";

export default function TradeLoading() {
  return (
    <div
      aria-label="Opening trading terminal"
      aria-live="polite"
      className="min-h-screen bg-[var(--surface-page)] text-[var(--text-primary)]"
      role="status"
    >
      <header className="sticky top-0 z-40 border-b border-white/7 bg-[rgba(12,12,11,0.9)] backdrop-blur-xl">
        <div className="app-header-inner flex min-h-[72px] min-w-0 items-center gap-3 px-3 md:gap-4 md:px-5">
          <Link aria-label="PNLX home" className="app-brand" href="/">
            <Image
              alt="PNLX"
              className="app-brand-logo"
              height={25}
              priority
              src="/pnlx-logo.png"
              width={138}
            />
          </Link>
          <nav className="hidden items-center gap-1 lg:flex">
            <span className="nav-item nav-item-active">Trade</span>
            <span className="nav-item">Portfolio</span>
          </nav>
          <div className="header-controls ml-auto">
            <span className="trade-loading-pill" />
          </div>
        </div>
      </header>

      <div className="px-2 pb-12 pt-2 md:px-3">
        <main className="trade-grid trade-loading-grid">
          <section className="main-column">
            <div className="market-header trade-loading-market-header">
              <span className="trade-loading-block trade-loading-market" />
              <span className="trade-loading-block trade-loading-price" />
              <span className="trade-loading-block trade-loading-metrics" />
            </div>
            <section className="panel chart-panel">
              <div className="chart-toolbar">
                <span className="trade-loading-block trade-loading-intervals" />
                <span className="trade-loading-block trade-loading-tools" />
              </div>
              <ChartShell />
            </section>
          </section>

          <aside className="order-column">
            <div className="trade-loading-ticket">
              <span className="trade-loading-block trade-loading-ticket-title" />
              <span className="trade-loading-block trade-loading-ticket-tabs" />
              <span className="trade-loading-block trade-loading-ticket-field" />
              <span className="trade-loading-block trade-loading-ticket-field" />
              <span className="trade-loading-block trade-loading-ticket-field" />
              <span className="trade-loading-block trade-loading-ticket-button" />
            </div>
          </aside>

          <div className="positions-workspace trade-loading-positions">
            <span className="trade-loading-block trade-loading-position-tabs" />
          </div>
        </main>
      </div>
    </div>
  );
}

function ChartShell() {
  return (
    <div className="chart-loading-placeholder">
      <span className="chart-loading-axis" />
      <span className="chart-loading-price-line" />
    </div>
  );
}
