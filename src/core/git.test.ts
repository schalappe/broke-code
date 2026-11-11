import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionHandle,
  type GitApi,
  type GitLookup,
  type GitRepository,
  type GitUri,
  gitDiffReader,
  lookUpGit,
} from "./git";

type Listener = (state: "uninitialized" | "initialized") => void;

/** An API in `state`, with `repositories`; `fire` changes its state, `listening` counts its live listeners. */
function fakeApi(state: GitApi["state"], getRepository: GitApi["getRepository"] = () => null) {
  const listeners = new Set<Listener>();
  const api: GitApi & { state: GitApi["state"] } = {
    state,
    repositories: [],
    getRepository,
    onDidChangeState: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const fire = (next: GitApi["state"]) => {
    api.state = next;
    for (const listener of [...listeners]) listener(next);
  };
  return { api, fire, listening: () => listeners.size };
}

/** An active extension exporting `exports`; activating it again would give nothing usable. */
const active = (exports: unknown): ExtensionHandle => ({
  isActive: true,
  exports,
  activate: async () => undefined,
});

const gitExports = (api: GitApi, enabled = true) => ({ enabled, getAPI: () => api });

describe("lookUpGit", () => {
  test("reports gitUnavailable without the Git extension", async () => {
    expect(await lookUpGit(undefined)).toEqual({ kind: "gitUnavailable" });
  });

  test("reports gitUnavailable for exports of another shape", async () => {
    for (const exports of [undefined, null, "git", { enabled: "yes", getAPI: () => ({}) }, { enabled: true }]) {
      expect(await lookUpGit(active(exports))).toEqual({ kind: "gitUnavailable" });
    }
  });

  test("activates an inactive extension, and reports gitUnavailable when activation fails", async () => {
    const { api } = fakeApi("initialized");
    const inactive: ExtensionHandle = { isActive: false, exports: undefined, activate: async () => gitExports(api) };
    expect(await lookUpGit(inactive)).toEqual({ kind: "found", api });
    const failing: ExtensionHandle = {
      isActive: false,
      exports: undefined,
      activate: async () => {
        throw new Error("activation failed");
      },
    };
    const error = console.error;
    console.error = () => {};
    try {
      expect(await lookUpGit(failing)).toEqual({ kind: "gitUnavailable" });
    } finally {
      console.error = error;
    }
  });

  test("reports gitUnavailable when getAPI returns an API of another shape", async () => {
    const { api } = fakeApi("initialized");
    const shapes = [undefined, null, "api", { ...api, state: 1 }, { ...api, onDidChangeState: undefined }];
    for (const shape of [...shapes, { ...api, repositories: {} }, { ...api, getRepository: "repo" }]) {
      expect(await lookUpGit(active({ enabled: true, getAPI: () => shape }))).toEqual({ kind: "gitUnavailable" });
    }
  });

  test("reports gitDisabled when git is disabled, or when getAPI throws", async () => {
    const { api } = fakeApi("initialized");
    expect(await lookUpGit(active(gitExports(api, false)))).toEqual({ kind: "gitDisabled" });
    const throwing = {
      enabled: true,
      getAPI: () => {
        throw new Error("Git model not found");
      },
    };
    expect(await lookUpGit(active(throwing))).toEqual({ kind: "gitDisabled" });
  });

  test("finds an initialized API at once", async () => {
    const { api, listening } = fakeApi("initialized");
    expect(await lookUpGit(active(gitExports(api)))).toEqual({ kind: "found", api });
    expect(listening()).toBe(0);
  });

  test("waits for an uninitialized API to initialize, then stops listening", async () => {
    const { api, fire, listening } = fakeApi("uninitialized");
    let settled: GitLookup | undefined;
    const lookup = lookUpGit(active(gitExports(api)), 60_000).then((result) => {
      settled = result;
      return result;
    });
    await Bun.sleep(5);
    expect(settled).toBeUndefined();
    fire("uninitialized");
    await Bun.sleep(5);
    expect(settled).toBeUndefined();
    fire("initialized");
    expect(await lookup).toEqual({ kind: "found", api });
    expect(listening()).toBe(0);
  });

  test("goes on with the API once the wait times out, never initialized", async () => {
    const { api, listening } = fakeApi("uninitialized");
    const started = performance.now();
    expect(await lookUpGit(active(gitExports(api)), 20)).toEqual({ kind: "found", api });
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(listening()).toBe(0);
  });
});

describe("gitDiffReader", () => {
  const scratch = mkdtempSync(join(tmpdir(), "broke-code-git-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const repositoryRoot = join(scratch, "repo");
  mkdirSync(join(repositoryRoot, "packages", "app"), { recursive: true });
  const linked = join(scratch, "linked-app");
  symlinkSync(join(repositoryRoot, "packages", "app"), linked);

  const uri = (path: string): GitUri => ({ fsPath: path, toString: () => `file://${path}` });

  /** A repository at `root` answering `diffWith` with `answer`, recording each call's path. */
  function repository(root: string, answer: (path: string) => Promise<string>) {
    const paths: string[] = [];
    const repo: GitRepository = {
      rootUri: uri(root),
      inputBox: { value: "" },
      diff: async () => "",
      diffWith: async (ref, path) => {
        expect(ref).toBe("HEAD");
        paths.push(path);
        return answer(path);
      },
    };
    return { repo, paths };
  }

  const found = (getRepository: GitApi["getRepository"]) => async (): Promise<GitLookup> => ({
    kind: "found",
    api: fakeApi("initialized", getRepository).api,
  });

  test("reports gitUnavailable when the lookup finds no usable Git extension", async () => {
    for (const kind of ["gitUnavailable", "gitDisabled"] as const) {
      const reader = gitDiffReader(async () => ({ kind }), uri);
      expect(await reader.read([{ name: "app", path: repositoryRoot }])).toEqual({ kind: "gitUnavailable" });
    }
  });

  test("reports noRepository for a folder no open repository holds, asking with the folder's URI", async () => {
    const asked: string[] = [];
    const reader = gitDiffReader(
      found((folder) => {
        asked.push(folder.fsPath);
        return null;
      }),
      uri,
    );
    expect(await reader.read([{ name: "app", path: repositoryRoot }])).toEqual({
      kind: "read",
      folders: [{ kind: "noRepository" }],
    });
    expect(asked).toEqual([repositoryRoot]);
  });

  test("diffs the repository root as `.` and a folder below it by its literal path relative to the real root", async () => {
    const { repo, paths } = repository(repositoryRoot, async (path) => `+${path}\n`);
    const reader = gitDiffReader(
      found(() => repo),
      uri,
    );
    const roots = [
      { name: "repo", path: repositoryRoot },
      { name: "app", path: join(repositoryRoot, "packages", "app") },
      { name: "linked", path: linked },
    ];
    expect(await reader.read(roots)).toEqual({
      kind: "read",
      folders: [
        { kind: "diff", text: "+:(literal).\n" },
        { kind: "diff", text: "+:(literal)packages/app\n" },
        { kind: "diff", text: "+:(literal)packages/app\n" },
      ],
    });
    // [>]: The folders are diffed concurrently, so the calls may come in any order.
    expect(paths.toSorted()).toEqual([":(literal).", ":(literal)packages/app", ":(literal)packages/app"]);
  });

  describe("against real git", () => {
    const gitRoot = join(scratch, "git");
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: gitRoot, encoding: "utf8" });
      if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
      return run.stdout;
    };
    // [>]: Each folder a repository could name to read as a wildcard or pathspec magic, beside the path it would match.
    const folders = ["app*", "k[x]", "m?", ":e", ":(glob)d"];
    const siblings = ["app-private/secret.txt", "kx", "mz", "e/secret.txt", "d/secret.txt", "f/g/secret.txt"];
    mkdirSync(gitRoot);
    git("init", "-q");
    for (const path of [...folders.map((folder) => `${folder}/own.txt`), ...siblings, "f\\g/own.txt"]) {
      mkdirSync(join(gitRoot, path, ".."), { recursive: true });
      writeFileSync(join(gitRoot, path), "one\n");
    }
    git("add", "-A");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    );
    for (const path of [...folders.map((folder) => `${folder}/own.txt`), ...siblings, "f\\g/own.txt"]) {
      writeFileSync(join(gitRoot, path), "two\n");
    }

    /** `diffWith` as the Git extension runs it: `git diff <ref> -- <path>`, each backslash of the path turned into `/`. */
    const { repo, paths } = repository(gitRoot, async (path) => git("diff", "HEAD", "--", path.replace(/\\/g, "/")));
    const reader = gitDiffReader(
      found(() => repo),
      uri,
    );
    const changedFiles = (text: string) => [...text.matchAll(/^diff --git a\/(.*) b\//gm)].map((match) => match[1]);

    test("diffs only the folder's own files, whatever wildcard or magic its name holds", async () => {
      const read = await reader.read(folders.map((name) => ({ name, path: join(gitRoot, name) })));
      if (read.kind !== "read") throw new Error(`unexpected ${read.kind}`);
      expect(read.folders.map((folder) => (folder.kind === "diff" ? changedFiles(folder.text) : folder))).toEqual(
        folders.map((folder) => [`${folder}/own.txt`]),
      );
    });

    test("refuses a folder whose name holds a backslash, without running git", async () => {
      const before = paths.length;
      const read = await reader.read([{ name: "f\\g", path: join(gitRoot, "f\\g") }]);
      expect(read).toEqual({
        kind: "read",
        folders: [
          { kind: "failed", cause: "its path holds a backslash, which the Git extension reads as a folder separator" },
        ],
      });
      expect(paths.length).toBe(before);
    });
  });

  test("gives git's own stderr as a failed folder's cause, else the error's message", async () => {
    const gitError = Object.assign(new Error("Failed to execute git"), { stderr: "fatal: bad revision 'HEAD'\n" });
    const causes = [
      gitError,
      Object.assign(new Error("Failed to execute git"), { stderr: "  " }),
      Object.assign(new Error("Failed to execute git"), {
        stderr: "fatal: bad revision 'HEAD'\r\n\nhint: commit first\n",
      }),
      new Error("spawn git ENOENT"),
      "plain failure",
    ];
    const folders = await Promise.all(
      causes.map(async (cause) => {
        const { repo } = repository(repositoryRoot, () => Promise.reject(cause));
        const read = await gitDiffReader(
          found(() => repo),
          uri,
        ).read([{ name: "repo", path: repositoryRoot }]);
        return read.kind === "read" ? read.folders[0] : undefined;
      }),
    );
    expect(folders).toEqual([
      { kind: "failed", cause: "fatal: bad revision 'HEAD'" },
      { kind: "failed", cause: "Failed to execute git" },
      { kind: "failed", cause: "fatal: bad revision 'HEAD' hint: commit first" },
      { kind: "failed", cause: "spawn git ENOENT" },
      { kind: "failed", cause: "plain failure" },
    ]);
  });

  test("reports a folder that no longer exists as failed, without running git", async () => {
    const { repo, paths } = repository(repositoryRoot, async () => "");
    const read = await gitDiffReader(
      found(() => repo),
      uri,
    ).read([{ name: "gone", path: join(scratch, "gone") }]);
    expect(read).toMatchObject({
      kind: "read",
      folders: [{ kind: "failed", cause: expect.stringContaining("ENOENT") }],
    });
    expect(paths).toEqual([]);
  });
});
