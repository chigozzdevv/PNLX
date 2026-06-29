const intervals = ["1m", "15m", "1h", "4h", "1d"];

export function ChartToolbar() {
  return (
    <div className="chart-toolbar">
      <span className="chart-label">Price</span>

      <div className="toolbar-group">
        {intervals.map((interval) => (
          <button className={`time-chip ${interval === "15m" ? "time-chip-active" : ""}`} key={interval} type="button">
            {interval}
          </button>
        ))}
      </div>
    </div>
  );
}
