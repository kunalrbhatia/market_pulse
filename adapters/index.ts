import { RepoAdapter } from "./base";
import { NodePnpmAdapter } from "./node-pnpm";

export * from "./base";
export * from "./node-pnpm";

const adapters: RepoAdapter[] = [
  new NodePnpmAdapter()
];

export async function detectAdapter(repoDir: string): Promise<RepoAdapter | null> {
  for (const adapter of adapters) {
    if (await adapter.detect(repoDir)) {
      return adapter;
    }
  }
  return null;
}
