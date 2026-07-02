import { describe, expect, test } from "bun:test";
import {
  custodyReadinessIssues,
  parseCustodySmokeOptions,
} from "../../scripts/smoke/custody";

describe("custody smoke helpers", () => {
  test("parses explicit custody smoke options", () => {
    const options = parseCustodySmokeOptions([
      "--amount=2500000",
      "--asset",
      "native",
      "--deploy-asset",
      "--from=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "--prepare-only",
      "--source",
      "pnlx-trader",
      "--token",
      "CCOLLATERAL",
    ]);

    expect(options.amount).toBe(2_500_000n);
    expect(options.asset).toBe("native");
    expect(options.deployAsset).toBe(true);
    expect(options.from).toBe("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
    expect(options.prepareOnly).toBe(true);
    expect(options.source).toBe("pnlx-trader");
    expect(options.token).toBe("CCOLLATERAL");
  });

  test("reports missing live custody prerequisites", () => {
    const issues = custodyReadinessIssues({
      assetCustodyRequired: true,
      collateralTokenContract: "",
      stellarOnchainRelay: false,
      stellarRelayerMode: "local",
    });

    expect(issues).toEqual([
      "COLLATERAL_TOKEN_CONTRACT is required",
      "STELLAR_ONCHAIN_RELAY must be true",
      "STELLAR_RELAYER_MODE must be stellar-cli",
    ]);
  });

  test("accepts a live custody-ready configuration", () => {
    const issues = custodyReadinessIssues({
      assetCustodyRequired: true,
      collateralTokenContract: "CCOLLATERAL",
      stellarOnchainRelay: true,
      stellarRelayerMode: "stellar-cli",
    });

    expect(issues).toEqual([]);
  });
});
