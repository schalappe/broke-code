import { describe, expect, test } from "bun:test";
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
      nextVersion("v0.2.3", ["fix: rename setting\n\nLonger text.\n\nBREAKING CHANGE: brokeCode.models is now brokeCode.contextSizes"]),
    ).toBe("0.3.0");
  });

  test("BREAKING CHANGE counts only as a footer token", () => {
    expect(nextVersion("v0.2.3", ["docs: explain the BREAKING CHANGE: rule"])).toBeNull();
  });

  test("a range with no feat, fix, or breaking change releases nothing", () => {
    expect(nextVersion("v0.2.3", ["docs: readme", "chore: bump bun", "Revert \"feat: x\""])).toBeNull();
    expect(nextVersion(null, ["docs: readme"])).toBeNull();
    expect(nextVersion("v0.2.3", [])).toBeNull();
  });

  test("a last tag that is not v<semver> is an error, not a guess", () => {
    expect(() => nextVersion("v0.2", ["fix: a"])).toThrow("v0.2");
  });
});
