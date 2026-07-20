import { GitHubClient } from "../github/client";
import { exec } from "child_process";

jest.mock("child_process", () => ({
  exec: jest.fn(),
}));

describe("github/client", () => {
  let client: GitHubClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new GitHubClient();
  });

  it("should detect paper-staging branch correctly", async () => {
    const mockExec = exec as unknown as jest.Mock;
    mockExec.mockImplementation((cmd, opts, callback) => {
      callback(null, { stdout: "refs/heads/paper-staging" });
    });

    const hasBranch = await client.hasPaperStagingBranch("/tmp/work");
    expect(hasBranch).toBe(true);
  });

  it("should fail and retry operations with backoff", async () => {
    const mockExec = exec as unknown as jest.Mock;
    // Fail first 2 times, then succeed
    let calls = 0;
    mockExec.mockImplementation((cmd, opts, callback) => {
      calls++;
      const cb = typeof opts === "function" ? opts : callback;
      if (calls < 3) {
        cb(new Error("Transient connection error"), { stdout: "" });
      } else {
        cb(null, { stdout: "success" });
      }
    });

    const sub = { owner: "test", repo: "repo", cloneUrl: "", config: {} as any, lastChecked: "" };
    const dir = await client.cloneRepo(sub);
    expect(calls).toBe(3);
    expect(dir).toContain("test_repo");
  });
});
