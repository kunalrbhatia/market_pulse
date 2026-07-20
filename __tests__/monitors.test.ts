import { NseContractSpecsMonitor } from "../monitors/nse-contract-specs";
import { NseHolidaysMonitor } from "../monitors/nse-holidays";
import { BrokerAngelOneMonitor } from "../monitors/broker-angel-one";
import * as fs from "fs";

jest.mock("fs", () => {
  const original = jest.requireActual("fs");
  return {
    ...original,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

describe("monitors/nse-contract-specs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should run with ground truth specs and empty scrape", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({
        NIFTY: { lotSize: 75, expiryDay: 4, strikeStep: 50 },
      })
    );

    global.fetch = jest.fn().mockImplementation(() => Promise.reject(new Error("Network block")));

    const config = { indices: { NIFTY: { lotSize: 50, expiryDay: 4, strikeStep: 50 } } };
    const monitor = new NseContractSpecsMonitor(config);
    const res = await monitor.run();

    expect(res.source).toBe("nse-contract-specs");
    expect(res.changes.length).toBe(1);
    expect(res.changes[0]).toEqual({
      path: "indices.NIFTY.lotSize",
      oldValue: 50,
      newValue: 75,
    });
  });
});

describe("monitors/nse-holidays", () => {
  it("should run and return holiday changes if baseline exists and live fetch fails", async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify([{ tradingDate: "26-Jan-2026", description: "Republic Day" }])
    );

    global.fetch = jest.fn().mockImplementation(() => Promise.reject(new Error("Timeout")));

    const config = { holidays: [] };
    const monitor = new NseHolidaysMonitor(config);
    const res = await monitor.run();

    expect(res.source).toBe("nse-holidays");
    expect(res.changes.length).toBe(1);
    expect(res.changes[0].path).toBe("holidays");
  });
});

describe("monitors/broker-angel-one", () => {
  it("should skip live check if no session token is available", async () => {
    process.env.ANGEL_ONE_SESSION_TOKEN = "";
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const monitor = new BrokerAngelOneMonitor({});
    const res = await monitor.run();
    expect(res.changes.length).toBe(0);
  });
});
