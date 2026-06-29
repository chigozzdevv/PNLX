import type { PortfolioInput } from "@/features/portfolio/portfolio.model";

export function parsePortfolioRequest(request: Request): PortfolioInput {
  const ownerCommitment = new URL(request.url).searchParams.get("ownerCommitment");
  if (!ownerCommitment || !/^0x[0-9a-fA-F]+$/.test(ownerCommitment)) {
    throw new Error("ownerCommitment must be hex");
  }
  return {
    ownerCommitment: ownerCommitment.toLowerCase() as `0x${string}`,
  };
}
