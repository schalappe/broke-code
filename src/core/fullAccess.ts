/**
 * @module fullAccess
 * What Full access lets a command do without a click (ADR 0002, addendum of 2026-11-16). The sandbox is the guard:
 * a command runs under macOS `sandbox-exec` with `FULL_ACCESS_SANDBOX_PROFILE`, which refuses every write outside the
 * workspace folders and the temporary and cache folders, however the command is spelled. The denied commands only
 * catch a known risky command early with a clear refusal, such as one that would leave the sandbox through another
 * process (`open`, `osascript`, `launchctl`, `defaults`): a command can always be spelled to slip past a word match,
 * so the list is never a guard on its own. No `vscode` import: the host passes the setting's values.
 */
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { InspectedSetting } from "./approval";
import type { CommandEnv } from "./commands";

/**
 * The commands Full access refuses, before the user's own (`brokeCode.deniedCommands`), which add to them and never
 * remove one. Each entry is a program, words in order, then flags (see `deniedEntry`).
 */
export const DEFAULT_DENIED_COMMANDS: readonly string[] = [
  "sudo",
  "su",
  "doas",
  "open",
  "osascript",
  "launchctl",
  "defaults",
  "security",
  "crontab",
  "diskutil",
  "shutdown",
  "reboot",
  "halt",
  "git push --force",
  "git push -f",
  "git reset --hard",
  "git clean",
];

/**
 * The denied commands: the defaults, then each user (`globalValue`) entry of `brokeCode.deniedCommands` that is a
 * string with a word, trimmed. [!]: User settings only, like `brokeCode.mode`: a repository must not shorten or
 * reshape the list. A value that is not an array gives the defaults alone.
 */
export function deniedCommands(inspected: InspectedSetting | undefined): string[] {
  const value = inspected?.globalValue;
  const user = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return [...DEFAULT_DENIED_COMMANDS, ...user.map((entry) => entry.trim()).filter((entry) => entry !== "")];
}

/** What splits a command line into the simple commands checked one by one: `;`, `&`, `|`, newlines, and grouping. */
const SEGMENT_SEPARATOR = /[;&|\n()`{}]|\$\(/;
/** Words skipped before a simple command's program: they run the next word as the command. */
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "nice", "xargs", "builtin"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The first of `entries` that one of `command`'s simple commands matches, or `undefined`. An entry is a program, the
 * words that follow it up to the first one starting with `-`, then flags. A simple command matches when its program
 * is the entry's (compared by file name, so `/usr/bin/sudo` matches `sudo`), its later words hold the entry's other
 * words in order, other words between them allowed, and each of the entry's flags appears anywhere after the program.
 * Quotes are dropped from words, and leading variable assignments, wrappers (`env`, `command`, `exec`, `nohup`,
 * `time`, `nice`, `xargs`, `builtin`), and a wrapper's flags are skipped. So `git push --force` matches
 * `git push origin main --force`, `git reset --hard` matches `git -C app reset --hard`, and `sudo` matches
 * `make && sudo make install`. A false match only refuses the command, and the model reads which entry matched.
 */
export function deniedEntry(command: string, entries: readonly string[]): string | undefined {
  const segments = command.split(SEGMENT_SEPARATOR).map(commandWords);
  return entries.find((entry) => {
    const words = entry.split(/\s+/).filter((word) => word !== "");
    return words.length > 0 && segments.some((segment) => matches(segment, words));
  });
}

function commandWords(segment: string): string[] {
  const words = segment
    .split(/\s+/)
    .map((word) => word.replace(/["']/g, ""))
    .filter((word) => word !== "");
  let start = 0;
  let wrapped = false;
  for (; start < words.length; start++) {
    const word = words[start] ?? "";
    if (WRAPPERS.has(word)) wrapped = true;
    else if (!ASSIGNMENT.test(word) && !(wrapped && word.startsWith("-"))) break;
  }
  const [program, ...rest] = words.slice(start);
  return program === undefined ? [] : [basename(program), ...rest];
}

function matches(segment: readonly string[], entry: readonly string[]): boolean {
  const [program, ...words] = entry;
  if (segment[0] !== program) return false;
  const args = segment.slice(1);
  const flag = words.findIndex((word) => word.startsWith("-"));
  const ordered = flag === -1 ? words : words.slice(0, flag);
  const anywhere = flag === -1 ? [] : words.slice(flag);
  let next = 0;
  for (const word of args) if (word === ordered[next]) next++;
  return next === ordered.length && anywhere.every((word) => args.includes(word));
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The folders every Full access command may write besides the workspace: the shared temporary folder, the per-user
 * temporary and cache folders (`/private/var/folders`, where `TMPDIR` points), and the devices (`/dev/null`, a
 * terminal). Real paths, since the profile matches resolved paths.
 */
const SYSTEM_WRITABLE = ["/private/tmp", "/private/var/folders", "/dev"];
/**
 * The cache folders under the user's home a Full access command may write, so package managers and builds work. Caches
 * only, never a folder of installed programs (`~/.cargo/bin`, `~/.bun/bin`): a program written there would later run
 * outside the sandbox from the user's `PATH`.
 */
const HOME_WRITABLE = [
  "Library/Caches",
  ".cache",
  ".bun/install/cache",
  ".npm",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
];

/**
 * The macOS sandbox of a Full access command over `writable` folders: everything allowed but a write outside them.
 * Reads and the network stay open, so the system's tools, git, and package managers run as usual. The folders come as
 * `sandbox-exec -D` parameters `W0`, `W1`, ..., never spliced into this text, where a path holding a quote or a
 * parenthesis would change the rules.
 */
export function fullAccessSandboxProfile(writable: number): string {
  const params = Array.from({ length: writable }, (_, index) => `(subpath (param "W${index}"))`);
  return ["(version 1)", "(allow default)", "(deny file-write*)", `(allow file-write* ${params.join(" ")})`].join("\n");
}

/**
 * `env` with the launcher that runs a Full access command in the sandbox: `sandbox-exec`, which replaces itself with
 * the shell, so the spawned pid stays the shell's. Writable: the real path of each of `roots` (a root that no longer
 * resolves is left out, so nothing is written there), the system folders, and the cache folders under `home`.
 */
export async function sandboxedEnv(env: CommandEnv, roots: readonly string[], home: string): Promise<CommandEnv> {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
  const realHome = await realpath(home).catch(() => home);
  const writable = [
    ...resolved.filter((root): root is string => root !== undefined),
    ...SYSTEM_WRITABLE,
    ...HOME_WRITABLE.map((folder) => `${realHome}/${folder}`),
  ];
  const params = writable.flatMap((folder, index) => ["-D", `W${index}=${folder}`]);
  return { ...env, launcher: [SANDBOX_EXEC, "-p", fullAccessSandboxProfile(writable.length), ...params] };
}

/**
 * The line added to a sandboxed command's `error` result, so the model reads "Operation not permitted" as the sandbox's
 * refusal rather than a broken file.
 */
export const SANDBOX_NOTE =
  'The command ran in Full access mode\'s sandbox: writing outside the workspace folders, the temporary folders, and the cache folders fails with "Operation not permitted".';
