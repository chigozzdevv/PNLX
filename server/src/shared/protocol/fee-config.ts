import { contractPublicInputHash, publicU128 } from "@pnlx/proof-system";
import { INSURANCE_FEE_PPM, MAKER_REBATE_PPM, TAKER_FEE_PPM } from "@pnlx/market-math";

export const FEE_EPOCH = 1n;
export const FEE_CONFIG_HASH = contractPublicInputHash([
  publicU128(FEE_EPOCH),
  publicU128(TAKER_FEE_PPM),
  publicU128(MAKER_REBATE_PPM),
  publicU128(INSURANCE_FEE_PPM),
]);
