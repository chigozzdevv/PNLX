import type { Router } from "../../shared/http/router";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";

export function registerAuthRoute(router: Router, auth: AuthService): void {
  const controller = new AuthController(auth);
  router.add("POST", "/auth/challenge", (request) => controller.challenge(request), { public: true });
  router.add("POST", "/auth/session", (request) => controller.session(request), { public: true });
  router.add("GET", "/auth/session", (request) => controller.current(request), { public: true });
}
