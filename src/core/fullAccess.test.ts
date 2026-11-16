import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DENIED_COMMANDS,
  deniedCommands,
  deniedEntry,
  fullAccessSandboxProfile,
  SANDBOX_EXEC,
  sandboxedEnv,
} from "./fullAccess";

describe("deniedEntry", () => {
  test.each([
    ["sudo rm -rf /tmp/x", "sudo"],
    ["/usr/bin/sudo ls", "sudo"],
    ["make && sudo make install", "sudo"],
    ["ls | xargs sudo rm", "sudo"],
    ["echo $(sudo whoami)", "sudo"],
    ["FOO=1 env BAR=2 sudo ls", "sudo"],
    ["cd app; 'sudo' ls", "sudo"],
    ["git push --force", "git push --force"],
    ["git push origin main --force", "git push --force"],
    ["git push -f origin", "git push -f"],
    ["git reset --hard HEAD~1", "git reset --hard"],
    ["git clean -fdx", "git clean"],
    ["true\nopen -a Safari", "open"],
    ["git -C app reset --hard", "git reset --hard"],
    ["env -i /usr/bin/open .", "open"],
    ["nohup -- sudo ls", "sudo"],
  ])("denies %j as %j", (command, entry) => {
    expect(deniedEntry(command, DEFAULT_DENIED_COMMANDS)).toBe(entry);
  });

  test.each([
    "git push origin main",
    "git push --force-with-lease",
    "git status --short",
    "echo sudo",
    "grep -r open src",
    "openssl version",
    "bun test src/core/fullAccess.test.ts",
    "git reset --soft HEAD~1",
    "git log --oneline -- push",
    "",
  ])("lets %j through", (command) => {
    expect(deniedEntry(command, DEFAULT_DENIED_COMMANDS)).toBeUndefined();
  });

  test("an entry's flags may come in any order after its program", () => {
    expect(deniedEntry("rm -r -f build", ["rm -f -r"])).toBe("rm -f -r");
    expect(deniedEntry("rm -r build", ["rm -f -r"])).toBeUndefined();
  });
});

describe("deniedCommands", () => {
  test("adds the user's entries, trimmed, after the defaults", () => {
    expect(deniedCommands({ globalValue: ["  docker rm ", "kubectl delete"] })).toEqual([
      ...DEFAULT_DENIED_COMMANDS,
      "docker rm",
      "kubectl delete",
    ]);
  });

  test("keeps the defaults alone for a workspace value, no value, or a value that is not a list of words", () => {
    for (const inspected of [
      { workspaceValue: ["docker rm"] },
      { workspaceFolderValue: ["docker rm"] },
      undefined,
      {},
      { globalValue: "sudo" },
      { globalValue: [3, null, "", "   "] },
    ]) {
      expect(deniedCommands(inspected)).toEqual([...DEFAULT_DENIED_COMMANDS]);
    }
  });
});

describe("fullAccessSandboxProfile", () => {
  test("allows writes only under the folders it takes as parameters", () => {
    expect(fullAccessSandboxProfile(2)).toBe(
      [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        '(allow file-write* (subpath (param "W0")) (subpath (param "W1")))',
      ].join("\n"),
    );
  });
});

describe("sandboxedEnv", () => {
  let base: string;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "broke-code-full-access-")));
    await symlink(base, join(base, "link"));
  });
  afterAll(() => rm(base, { recursive: true, force: true }));

  test("passes each workspace folder's real path, the system folders, and the home caches as parameters", async () => {
    const env = { shell: "/bin/sh", timeoutMs: 1000 };
    const sandboxed = await sandboxedEnv(env, [join(base, "link"), join(base, "gone")], "/Users/someone");
    expect(sandboxed).toEqual({
      ...env,
      launcher: [
        SANDBOX_EXEC,
        "-p",
        fullAccessSandboxProfile(13),
        "-D",
        `W0=${base}`,
        "-D",
        "W1=/private/tmp",
        "-D",
        "W2=/private/var/folders",
        "-D",
        "W3=/dev",
        "-D",
        "W4=/Users/someone/Library/Caches",
        "-D",
        "W5=/Users/someone/.cache",
        "-D",
        "W6=/Users/someone/.bun/install/cache",
        "-D",
        "W7=/Users/someone/.npm",
        "-D",
        "W8=/Users/someone/.cargo/registry",
        "-D",
        "W9=/Users/someone/.cargo/git",
        "-D",
        "W10=/Users/someone/go/pkg/mod",
        "-D",
        "W11=/Users/someone/.gradle/caches",
        "-D",
        "W12=/Users/someone/.m2/repository",
      ],
    });
  });
});
