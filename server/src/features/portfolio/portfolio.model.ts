import type { AccountEventRecord, Hex } from "@pnlx/protocol-types";
import type {
  OwnerActivitySnapshot,
  OwnerOrderSnapshot,
  OwnerPositionSnapshot,
  PublicSnapshot,
} from "@/workers/indexer/indexer.model";

export interface PortfolioInput {
  ownerCommitment: Hex;
}

export interface PortfolioSnapshot {
  accountEvents: AccountEventRecord[];
  activities: OwnerActivitySnapshot[];
  orders: OwnerOrderSnapshot[];
  ownerCommitment: Hex;
  positions: OwnerPositionSnapshot[];
  publicState: PublicSnapshot;
}

export interface PortfolioBalancesSnapshot {
  accountEvents: AccountEventRecord[];
  marginMembershipRoot: Hex;
  marginRoot: Hex;
  ownerCommitment: Hex;
  privateByDefault: true;
  serverReadableBalance: false;
}
