export abstract class RepoAdapter {
  abstract name: string;
  abstract detect(repoDir: string): Promise<boolean>;
  abstract verify(repoDir: string, verifyCommand: string): Promise<boolean>;
  abstract updateConfig(repoDir: string, configPath: string, updatedConfig: any): Promise<void>;
}
