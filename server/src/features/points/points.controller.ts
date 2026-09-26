import { ownerCommitment } from "@pnlx/crypto";
import { authenticatedAddress } from "@/shared/http/auth-context";
import { json } from "@/shared/http/json";
import { parsePointsRequest } from "@/features/points/points.schema";
import type { PointsService } from "@/features/points/points.service";

export class PointsController {
  constructor(private readonly points: PointsService) {}

  get(request: Request): Response {
    parsePointsRequest(request);
    const address = authenticatedAddress(request);
    if (!address) return json({ error: "Connect your wallet to view Points" }, 401);
    return json({ points: this.points.snapshot(ownerCommitment(address)) });
  }
}
