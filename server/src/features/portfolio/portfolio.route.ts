import type { Router } from "../../shared/http/router";
import type { ExecutorService } from "../../workers/executor/executor.service";
import { PortfolioController } from "./portfolio.controller";
import { PortfolioService } from "./portfolio.service";

export function registerPortfolioRoute(router: Router, executor: ExecutorService): void {
  const controller = new PortfolioController(new PortfolioService(executor));
  router.add("GET", "/portfolio", (request) => controller.get(request), { auth: true });
  router.add("GET", "/portfolio/orders", (request) => controller.orders(request), { auth: true });
  router.add("GET", "/portfolio/positions", (request) => controller.positions(request), { auth: true });
  router.add("GET", "/portfolio/activity", (request) => controller.activity(request), { auth: true });
  router.add("GET", "/portfolio/balances", (request) => controller.balances(request), { auth: true });
}
