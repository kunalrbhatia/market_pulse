import { ConfigDelta } from "../monitors/base";

export function diffConfigs(oldConfig: any, newConfig: any, pathPrefix = ""): ConfigDelta[] {
  const deltas: ConfigDelta[] = [];
  if (oldConfig === newConfig) return deltas;

  if (
    typeof oldConfig !== "object" ||
    oldConfig === null ||
    typeof newConfig !== "object" ||
    newConfig === null
  ) {
    deltas.push({
      path: pathPrefix,
      oldValue: oldConfig,
      newValue: newConfig,
    });
    return deltas;
  }

  // Handle arrays
  if (Array.isArray(oldConfig) || Array.isArray(newConfig)) {
    if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) {
      deltas.push({
        path: pathPrefix,
        oldValue: oldConfig,
        newValue: newConfig,
      });
    }
    return deltas;
  }

  const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);
  for (const key of allKeys) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (!(key in oldConfig)) {
      deltas.push({
        path: nextPath,
        oldValue: undefined,
        newValue: newConfig[key],
      });
    } else if (!(key in newConfig)) {
      deltas.push({
        path: nextPath,
        oldValue: oldConfig[key],
        newValue: undefined,
      });
    } else {
      deltas.push(...diffConfigs(oldConfig[key], newConfig[key], nextPath));
    }
  }

  return deltas;
}

export function generatePatch(deltas: ConfigDelta[]): Record<string, any> {
  const patch: Record<string, any> = {};
  for (const delta of deltas) {
    const parts = delta.path.split(".");
    let current = patch;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = delta.newValue;
  }
  return patch;
}

export function applyDeltas(config: any, deltas: ConfigDelta[]): any {
  const cloned = JSON.parse(JSON.stringify(config));
  for (const delta of deltas) {
    const parts = delta.path.split(".");
    let current = cloned;
    let pathCorrupted = false;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        // Key doesn't exist yet — safe to create
        current[part] = {};
      } else if (typeof current[part] !== "object" || current[part] === null) {
        // Intermediate path points at a scalar — skip to avoid corrupting the config
        console.warn(
          `[applyDeltas] Skipping delta "${delta.path}": intermediate key "${part}" is not an object (found: ${typeof current[part]})`
        );
        pathCorrupted = true;
        break;
      }
      current = current[part];
    }

    if (pathCorrupted) continue;

    const finalKey = parts[parts.length - 1];
    if (delta.newValue === undefined) {
      delete current[finalKey];
    } else {
      current[finalKey] = delta.newValue;
    }
  }
  return cloned;
}

