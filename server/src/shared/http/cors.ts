const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE";
const ALLOWED_HEADERS = "authorization, content-type";

export function browserCors(
  handle: (request: Request) => Response | Promise<Response>,
  allowedOrigins: ReadonlySet<string>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get("origin");
    const allowed = origin !== null && allowedOrigins.has(origin);
    if (request.method === "OPTIONS") {
      if (!allowed || !request.headers.has("access-control-request-method")) {
        return new Response(null, { status: 403 });
      }
      const method = request.headers.get("access-control-request-method")?.toUpperCase();
      if (!method || !ALLOWED_METHODS.split(", ").includes(method)) {
        return new Response(null, { status: 405 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": ALLOWED_METHODS,
          "access-control-allow-headers": ALLOWED_HEADERS,
          "access-control-max-age": "600",
          vary: "Origin",
        },
      });
    }

    const response = await handle(request);
    if (!allowed) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", [headers.get("vary"), "Origin"].filter(Boolean).join(", "));
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

export function webOrigins(value: string): ReadonlySet<string> {
  return new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean));
}
