export async function merklPost<T>(
  path: string,
  data: unknown,
  token?: string,
): Promise<T> {
  return merklRequest<T>("POST", path, data, token);
}

export async function merklGet<T>(path: string, token?: string): Promise<T> {
  return merklRequest<T>("GET", path, undefined, token);
}

async function merklRequest<T>(
  method: "GET" | "POST",
  path: string,
  data?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`/api/merkl/${path.replace(/^\/+/, "")}`, {
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : undefined;

  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Merkl API request failed with ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}
