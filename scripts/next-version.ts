/**
 * @module next-version
 * Compute the next release version from Conventional Commits.
 *
 * CLI: `bun scripts/next-version.ts` reads the last `v<semver>` tag merged into HEAD and the non-merge commits
 * since it, prints the next version on stdout, or prints nothing and explains why on stderr when no release is
 * due. Used by `.github/workflows/release.yml`.
 */

type Bump = "minor" | "patch" | null;

// [&]: Conventional Commits 1.0 types are case-insensitive.
const HEADER = /^(?<type>[a-z]+)(?:\([^()\r\n]*\))?(?<breaking>!)?: /i;
// [&]: Footer token; must be uppercase, `BREAKING-CHANGE` is a synonym.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;
const TAG = /^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;

/**
 * Next version after `lastTag` given the messages of the commits since it.
 * @param lastTag - Last `v<semver>` tag, or `null` before the first release.
 * @param commitMessages - Full messages (subject and body) of the non-merge commits since `lastTag`.
 * @returns The next version without the `v`, or `null` when no release is due.
 */
export function nextVersion(lastTag: string | null, commitMessages: readonly string[]): string | null {
  const bump = commitMessages.map(bumpOf).reduce(larger, null);
  if (bump === null) return null;
  if (lastTag === null) return "0.1.0";

  const tag = TAG.exec(lastTag)?.groups;
  if (!tag) throw new Error(`Last tag ${lastTag} is not v<major>.<minor>.<patch>.`);
  const [major, minor, patch] = [tag.major, tag.minor, tag.patch].map(Number);
  return bump === "minor" ? `${major}.${minor! + 1}.0` : `${major}.${minor}.${patch! + 1}`;
}

function bumpOf(message: string): Bump {
  const header = HEADER.exec(message)?.groups;
  const body = message.slice(message.indexOf("\n") + 1 || message.length);
  if (header?.breaking || BREAKING_FOOTER.test(body)) return "minor";
  const type = header?.type?.toLowerCase();
  if (type === "feat") return "minor";
  if (type === "fix") return "patch";
  return null;
}

function larger(a: Bump, b: Bump): Bump {
  if (a === "minor" || b === "minor") return "minor";
  return a ?? b;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

if (import.meta.main) {
  // [!]: A shallow clone hides tags and commits, so the version would silently restart at 0.1.0.
  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new Error("Shallow clone: fetch the full history and tags (actions/checkout fetch-depth: 0).");
  }
  const lastTag = git("tag", "--list", "v[0-9]*", "--merged", "HEAD", "--sort=-v:refname").split("\n")[0] || null;
  const log = git("log", "--no-merges", "--format=%B%x00", lastTag ? `${lastTag}..HEAD` : "HEAD");
  const messages = log.split("\0").map((message) => message.trim()).filter(Boolean);
  const version = nextVersion(lastTag, messages);
  if (version === null) {
    console.error(`No feat, fix, or breaking change since ${lastTag ?? "the first commit"}: no release is due.`);
  } else {
    console.log(version);
  }
}
