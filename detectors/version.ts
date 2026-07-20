import dayjs from "dayjs";

export function incrementConfigVersion(config: any): any {
  const cloned = JSON.parse(JSON.stringify(config));
  cloned.version = (cloned.version || 0) + 1;
  cloned.lastUpdated = dayjs().format("YYYY-MM-DD");
  return cloned;
}
