import { setAuthenticatedContext, type AuthContext } from "@/shared/http/auth-context";

export type Handler = (request: Request) => Response | Promise<Response>;
export type Authenticator =
  (request: Request) => AuthContext | Response | void | Promise<AuthContext | Response | void>;

interface RouteRecord {
  auth: boolean;
  handler: Handler;
  public: boolean;
}

interface AddRouteOptions {
  auth?: boolean;
  public?: boolean;
}

interface RouterOptions {
  authenticate?: Authenticator;
  protectMutations?: boolean;
}

export class Router {
  private readonly routes = new Map<string, RouteRecord>();

  constructor(private readonly options: RouterOptions = {}) {}

  add(method: string, path: string, handler: Handler, options: AddRouteOptions = {}): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, {
      auth: options.auth ?? false,
      handler,
      public: options.public ?? false,
    });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const record = this.routes.get(`${method} ${url.pathname}`);
    if (!record) return new Response("not found", { status: 404 });
    try {
      if (this.shouldAuthenticate(method, record)) {
        const authResult = await this.options.authenticate?.(request);
        if (authResult instanceof Response) return authResult;
        if (authResult?.address) setAuthenticatedContext(request, authResult);
      }
      return await record.handler(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  private shouldAuthenticate(method: string, record: RouteRecord): boolean {
    return Boolean(
      this.options.protectMutations &&
        !record.public &&
        (record.auth || (method !== "GET" && method !== "HEAD")),
    );
  }
}
