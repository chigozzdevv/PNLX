import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const PRIVATE_FIELDS = new Map([
  [
    "batch-match",
    [
      "execution_count",
      "execution_sizes",
      "execution_prices",
      "long_limit_prices",
      "short_limit_prices",
      "maker_is_long",
      "long_margins",
      "short_margins",
      "total_long_size",
      "total_short_size",
      "initial_margin_rate",
      "max_leverage",
    ],
  ],
  [
    "conditional-close",
    ["is_long", "is_take_profit", "market_digest", "trigger_price", "size", "salt_digest"],
  ],
  ["deposit-note", ["owner_digest", "rho_digest", "blinding"]],
  ["disclosure", ["value", "salt_digest", "path_siblings", "path_indices"]],
  [
    "intent-validity",
    [
      "size",
      "margin",
      "limit_price",
      "is_long",
      "expiry_batch",
      "owner_digest",
      "nonce_digest",
      "salt_digest",
    ],
  ],
  [
    "liquidation-check",
    [
      "is_long",
      "size",
      "entry_price",
      "margin",
      "funding_index",
      "funding_payment_abs",
      "funding_is_credit",
      "market_digest",
      "owner_digest",
      "rho_digest",
      "blinding",
      "spend_secret_digest",
      "path_siblings",
      "path_indices",
    ],
  ],
  ["margin-check", ["size", "margin"]],
  [
    "position-close",
    [
      "is_long",
      "size",
      "close_size",
      "entry_price",
      "margin",
      "funding_index",
      "funding_payment_abs",
      "funding_is_credit",
      "fee",
      "new_margin",
      "remaining_margin",
      "margin_output_amount",
      "market_digest",
      "owner_digest",
      "rho_digest",
      "blinding",
      "spend_secret_digest",
      "new_position_rho_digest",
      "new_position_blinding",
      "margin_output_asset_digest",
      "margin_output_rho_digest",
      "margin_output_blinding",
      "path_siblings",
      "path_indices",
    ],
  ],
  ["position-transition", ["old_margin", "added_margin", "fee", "new_margin"]],
  [
    "withdraw",
    [
      "note_amount",
      "asset_digest",
      "owner_digest",
      "rho_digest",
      "blinding",
      "spend_secret_digest",
      "path_siblings",
      "path_indices",
      "change_rho_digest",
      "change_blinding",
    ],
  ],
]);

describe("circuit privacy boundary", () => {
  test("keeps sensitive witness fields private", () => {
    for (const [circuit, fields] of PRIVATE_FIELDS) {
      const source = readFileSync(join(process.cwd(), "circuits", circuit, "src/main.nr"), "utf8");

      for (const field of fields) {
        expect(source).not.toContain(`${field}: pub`);
      }
    }
  });
});
