export function json(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}
