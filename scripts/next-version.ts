/**
 * @module next-version
 * Compute the next release version from Conventional Commits.
 *
 * CLI: `bun scripts/next-version.ts` prints on stdout the version to release for HEAD:
 * - the version of a `v<semver>` tag already on HEAD (a re-run finishing that release);
 * - else the next version from the last `v<semver>` tag merged into HEAD and the non-merge commits since it.
 * It prints nothing and explains why on stderr when no release is due, and exits 1 on a shallow clone, a git
 * failure, or a computed tag that already exists on a commit outside HEAD's history. Used by
 * `.github/workflows/release.yml`.
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

/**
 * Release version for HEAD, or `null` when no release is due.
 * @throws Error when git fails, the clone is shallow, or the computed tag already names another commit.
 */
function releaseVersion(): string | null {
  // [!]: A shallow clone hides tags and commits, so the version would silently restart at 0.1.0.
  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new Error("Shallow clone: fetch the full history and tags (actions/checkout fetch-depth: 0).");
  }
  // [>]: The tag reserves a version for a commit, so a tagged HEAD is a re-run that finishes that release.
  const headTag = firstLine(git("tag", "--list", "v[0-9]*", "--points-at", "HEAD", "--sort=-v:refname"));
  if (headTag) return headTag.slice(1);

  const lastTag = firstLine(git("tag", "--list", "v[0-9]*", "--merged", "HEAD", "--sort=-v:refname"));
  const log = git("log", "--no-merges", "--format=%B%x00", lastTag ? `${lastTag}..HEAD` : "HEAD");
  const messages = log.split("\0").map((message) => message.trim()).filter(Boolean);
  const version = nextVersion(lastTag, messages);
  if (version === null) {
    console.error(`No feat, fix, or breaking change since ${lastTag ?? "the first commit"}: no release is due.`);
    return null;
  }
  if (firstLine(git("tag", "--list", `v${version}`))) {
    throw new Error(`Tag v${version} already exists on a commit that is not in HEAD's history. Nothing is published.`);
  }
  return version;
}

function firstLine(output: string): string | null {
  return output.split("\n")[0] || null;
}

if (import.meta.main) {
  try {
    const version = releaseVersion();
    if (version !== null) console.log(version);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
