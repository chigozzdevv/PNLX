import { authenticatedAddress } from "@/shared/http/auth-context";
import { json } from "@/shared/http/json";
import { parsePortfolioRequest } from "@/features/portfolio/portfolio.schema";
import type { PortfolioService } from "@/features/portfolio/portfolio.service";

export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  get(request: Request): Response {
    return json({
      portfolio: this.portfolio.get(parsePortfolioRequest(request), authenticatedAddress(request)),
    });
  }

  orders(request: Request): Response {
    return json({
      orders: this.portfolio.orders(parsePortfolioRequest(request), authenticatedAddress(request)),
    });
  }

  positions(request: Request): Response {
    return json({
      positions: this.portfolio.positions(parsePortfolioRequest(request), authenticatedAddress(request)),
    });
  }

  activity(request: Request): Response {
    return json({
      activity: this.portfolio.activity(parsePortfolioRequest(request), authenticatedAddress(request)),
    });
  }

  balances(request: Request): Response {
    return json({
      balances: this.portfolio.balances(parsePortfolioRequest(request), authenticatedAddress(request)),
    });
  }
}
