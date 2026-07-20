import { Monitor } from "./base";
import { NseContractSpecsMonitor } from "./nse-contract-specs";
import { NseHolidaysMonitor } from "./nse-holidays";
import { BrokerAngelOneMonitor } from "./broker-angel-one";

export * from "./base";
export * from "./nse-contract-specs";
export * from "./nse-holidays";
export * from "./broker-angel-one";

export function getMonitorsForConfig(config: any): Monitor[] {
  return [
    new NseContractSpecsMonitor(config),
    new NseHolidaysMonitor(config),
    new BrokerAngelOneMonitor(config)
  ];
}
