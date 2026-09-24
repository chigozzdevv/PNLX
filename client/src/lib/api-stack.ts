export type ApiStack = "current" | "legacy";

export function stackForPathname(pathname: string): ApiStack {
  return pathname.startsWith("/legacy/") ? "legacy" : "current";
}

export function activeApiStack(): ApiStack {
  if (typeof window === "undefined") return "current";
  return stackForPathname(window.location?.pathname ?? "/");
}

export function apiPath(path: string): string {
  return apiPathForStack(path, activeApiStack());
}

export function apiPathForStack(path: string, stack: ApiStack): string {
  const prefix = stack === "legacy" ? "/api/pnlx-legacy" : "/api/pnlx";
  return `${prefix}/${path.replace(/^\/+/, "")}`;
}
