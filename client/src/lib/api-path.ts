export function apiPath(path: string): string {
  const base = process.env.NEXT_PUBLIC_PNLX_API_URL || (process.env.NODE_ENV === "production"
    ? "https://api.pnl.family"
    : "http://127.0.0.1:4000");
  return new URL(path.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).toString();
}
