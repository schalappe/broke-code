import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextVersion } from "./next-version";

describe("nextVersion", () => {
  test("first release is 0.1.0 whatever the bump", () => {
    expect(nextVersion(null, ["fix: handle empty reply"])).toBe("0.1.0");
  });

  test("fix bumps the patch", () => {
    expect(nextVersion("v0.1.0", ["docs: typo", "fix: handle empty reply (#20)"])).toBe("0.1.1");
  });

  test("feat bumps the minor and resets the patch", () => {
    expect(nextVersion("v0.1.4", ["fix: a", "feat: add search tool", "fix: b"])).toBe("0.2.0");
  });

  test("a scoped type counts like the bare type", () => {
    expect(nextVersion("v0.2.0", ["feat(harness): parse calls"])).toBe("0.3.0");
    expect(nextVersion("v0.2.0", ["fix(sse): flush last line"])).toBe("0.2.1");
  });

  test("a breaking change bumps the minor, never the major", () => {
    expect(nextVersion("v0.2.3", ["feat!: drop the old settings key"])).toBe("0.3.0");
    expect(nextVersion("v0.2.3", ["fix(client)!: reject redirects"])).toBe("0.3.0");
    expect(nextVersion("v0.2.3", ["refactor!: rename the protocol messages"])).toBe("0.3.0");
    expect(
      nextVersion("v0.2.3", [
        "fix: rename setting\n\nLonger text.\n\nBREAKING CHANGE: brokeCode.models is now brokeCode.contextSizes",
      ]),
    ).toBe("0.3.0");
  });

  test("BREAKING CHANGE counts only as a footer token", () => {
    expect(nextVersion("v0.2.3", ["docs: explain the BREAKING CHANGE: rule"])).toBeNull();
  });

  test("a range with no feat, fix, or breaking change releases nothing", () => {
    expect(nextVersion("v0.2.3", ["docs: readme", "chore: bump bun", 'Revert "feat: x"'])).toBeNull();
    expect(nextVersion(null, ["docs: readme"])).toBeNull();
    expect(nextVersion("v0.2.3", [])).toBeNull();
  });

  test("a last tag that is not v<semver> is an error, not a guess", () => {
    expect(() => nextVersion("v0.2", ["fix: a"])).toThrow("v0.2");
  });
});

describe("next-version CLI", () => {
  const script = join(import.meta.dir, "next-version.ts");
  // [!]: Isolated from the user's git config (signing, hooks, default branch).
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "next-version-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd, env, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  }

  function repo(...subjects: string[]): string {
    const path = join(dir, "repo");
    mkdirSync(path);
    git(path, "init", "-q", "-b", "main");
    for (const subject of subjects) commit(path, subject);
    return path;
  }

  function commit(path: string, subject: string): void {
    git(path, "commit", "-q", "--allow-empty", "-m", subject);
  }

  function run(cwd: string): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync([process.execPath, script], { cwd, env, stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  test("no tag yet releases 0.1.0", () => {
    expect(run(repo("chore: init", "feat: chat"))).toMatchObject({ exitCode: 0, stdout: "0.1.0\n" });
  });

  test("only the commits after the last merged tag count", () => {
    const path = repo("feat: chat");
    git(path, "tag", "v0.1.0");
    commit(path, "docs: readme");
    commit(path, "fix: empty reply");
    expect(run(path)).toMatchObject({ exitCode: 0, stdout: "0.1.1\n" });
  });

  test("a range without feat or fix prints nothing and says why", () => {
    const path = repo("feat: chat");
    git(path, "tag", "v0.1.0");
    commit(path, "docs: readme");
    const result = run(path);
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    expect(result.stderr).toContain("no release is due");
  });

  test("a HEAD that already carries a tag re-releases that version", () => {
    const path = repo("feat: chat");
    git(path, "tag", "v0.1.0");
    commit(path, "fix: empty reply");
    git(path, "tag", "v0.1.1");
    expect(run(path)).toMatchObject({ exitCode: 0, stdout: "0.1.1\n" });
  });

  test("a computed version whose tag exists on another commit fails", () => {
    const path = repo("feat: chat");
    git(path, "switch", "-q", "-c", "side");
    commit(path, "fix: elsewhere");
    git(path, "tag", "v0.1.0");
    git(path, "switch", "-q", "main");
    const result = run(path);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("v0.1.0 already exists");
  });

  test("a shallow clone is refused", () => {
    const path = repo("feat: chat", "fix: empty reply");
    const shallow = join(dir, "shallow");
    git(dir, "clone", "-q", "--depth", "1", `file://${path}`, shallow);
    const result = run(shallow);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Shallow clone");
  });

  test("a git failure stops the CLI with git's message", () => {
    const result = run(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not a git repository");
  });
});
