import { expect, test } from "bun:test";
import { addressTopic, parseVaultTransfer, readI128 } from "./liquidity-vault.history";

const vault = "CAU23XCVR5EMOMCMAZ3CIKJAHS7QREUUX7QX5B5QECUPZ2NQMKOLAT2M";
const asset = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const owner = "GBVC7NWAYW4DTAF3GG6W2SPMJZO7EXHQL4LGJZPWOTHIL373PK6XQ3QJ";
const maker = "GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";

test("vault event topics match confirmed Testnet transfer topics", () => {
  expect(addressTopic(vault))
    .toBe("AAAAEgAAAAEprdxVj0jHMEwGdiQpIDy/CJKUv+F+h7AgqPzpsGKcsA==");
  expect(addressTopic(owner))
    .toBe("AAAAEgAAAAAAAAAAai+2wMW4OYC7Mb1tSexOXfJc8F8WZOX2dM6F7/t6vXg=");
  expect(readI128("AAAACgAAAAAAAAAAAAAAdGpSiAA=")).toBe(500_000_000_000n);
});

test("confirmed vault transfers become pool activity", () => {
  const event = {
    id: "0020818868625507328-0000000001", type: "contract", ledger: 4847253,
    ledgerClosedAt: "2026-09-24T12:00:00Z", contractId: asset,
    topic: ["AAAADwAAAAh0cmFuc2Zlcg==", addressTopic(owner), addressTopic(vault)],
    value: "AAAACgAAAAAAAAAAAAAAdGpSiAA=",
    txHash: "0246ae37d7ae4c419aafe1bb30e897f0595f15097705e6702238af4d8c5e6ff0",
    inSuccessfulContractCall: true,
  };
  expect(parseVaultTransfer(event, asset, addressTopic(vault), addressTopic(maker)))
    .toMatchObject({ kind: "supply", amount: "500000000000", ledger: 4847253 });
  const allocation = { ...event, ledger: 4850859, ledgerClosedAt: "2026-09-24T19:24:42Z",
    topic: [event.topic[0], addressTopic(vault), addressTopic(maker)],
    value: "AAAACgAAAAAAAAAAAAAAAk4hUy8=",
    txHash: "f494d4300ed55f638d5879c93e3bed1ccfcd3db0631563bbaf1e9f1cddb2ed00" };
  expect(parseVaultTransfer(allocation, asset, addressTopic(vault), addressTopic(maker)))
    .toMatchObject({ kind: "allocation", amount: "9900741423", ledger: 4850859 });
  expect(parseVaultTransfer({ ...event, inSuccessfulContractCall: false },
    asset, addressTopic(vault), addressTopic(maker))).toBeNull();
});
