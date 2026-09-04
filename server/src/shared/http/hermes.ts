export function hermesEndpoint(baseUrl: string, path: string): URL {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const relativePath = path.replace(/^\/+/, "");
  return new URL(`${base}/${relativePath}`);
}
