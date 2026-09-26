import type { Router } from "@/shared/http/router";
import type { ProtocolStore } from "@/shared/state/store";
import { PointsController } from "@/features/points/points.controller";
import { PointsService } from "@/features/points/points.service";

export function registerPointsRoute(router: Router, store: ProtocolStore, makerAddress?: string): void {
  const controller = new PointsController(new PointsService(store, makerAddress));
  router.add("GET", "/points", (request) => controller.get(request), { auth: true });
}
