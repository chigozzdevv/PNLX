import type { AccountSnapshot } from "@/types/trading";

export const emptyLiquidityAccount: AccountSnapshot = {
  accountValue: 0,
  address: "",
  availableShieldedUsdc: 0,
  cash: 0,
  livePnl: 0,
  lockedMargin: 0,
  marginRoot: "0x0",
  pendingShieldedUsdc: 0,
  privacyMode: "shielded",
  shieldedUsdc: 0,
  tradedVolume: null,
};
