# Skills and slash commands

This file specifies skill discovery, `load_skill`, and the `/<name>` skill command. ADR 0003 records the decision on loaded skill folders.

- Skills follow the Agent Skills format (`<name>/SKILL.md` with `name` and `description` frontmatter). The
  extension reads them from two places only: `.agents/skills/` in each workspace folder and `~/.agents/skills/`. A
  workspace skill wins over a personal skill with the same name, and an earlier workspace folder over a later one; a
  hidden skill gives no warning, valid or not. A skipped skill hides nothing: a valid one of its name further down
  the order wins, and the skipped one warns.
- Discovery runs at each send, like the instruction files, over the direct children of `~/.agents/skills/`, then of
  each workspace folder's `.agents/skills/`. A child is a skill when it is a folder holding `SKILL.md` (1 MiB cap); a
  folder without one, a stray file, and a missing skills folder pass silently. A personal skill folder follows
  symlinks; a workspace one, the folder and its `SKILL.md` alike, is held to its own workspace folder, and one linked
  out of it, into another workspace folder included, is skipped with a warning (`outsideWorkspace`). Every file of a
  skill lies in its own folder: for a personal or a workspace skill, a `SKILL.md` that resolves outside the skill
  folder's real path (the folder's own link resolved) is skipped with an `outsideSkillFolder` warning, so the folder a
  loaded skill's files are read from holds all of it.
- A repository controls its skills folder, and each `SKILL.md` read holds a 1 MiB buffer and a file descriptor, so
  discovery reads one `SKILL.md` at a time, folder after folder, and only the first `MAX_SKILL_ENTRIES` (200) entries of
  each skills folder by name. A folder holding more gives one `tooManyEntries` warning naming it; an entry past the cap
  is never read, so it hides nothing. 5,000 entries linked to one 1 MiB file take about 90 ms per send on the
  maintainer's Mac.
- The frontmatter is the lines between a first line `---` and the next `---`, read by a hand-written subset of YAML
  (`skills.ts`), no YAML dependency: top-level `key: value` with plain, single- or double-quoted, or `>` and `|` block
  values; nested maps and unknown keys are ignored. `name` follows the spec (1 to 64 of `a-z`, `0-9`, `-`, no hyphen
  first, last, or twice in a row); `description` is 1 to 1,024 characters.
- `disable-model-invocation: true` (outside the spec) keeps a valid skill out of the model's list, and the model cannot
  load it with `load_skill`; it stays discovered for `/<name>`, and once the user loaded it that way the model's
  `load_skill` of it answers "already loaded".
- Do not read `.claude/`, `.codex/`, or any other tool's directory. The `.agents` convention is the only one.
- The system prompt lists each skill's name and description only. `load_skill` or `/<name>` loads the body.
- `load_skill(name)` loads a skill of the send's discovery that is listed to the model; a skill already loaded in the
  history sent (from the last `done` summary on, `ToolContext.sentSkillRoots`) answers "already loaded" (below),
  listed to the model or not. A skill loaded only before that summary gets its body again, also one kept from the
  model that the user loaded with `/<name>`, since the text of that load is no longer sent (maintainer decision,
  2026-11-12); its folder stayed readable all along. Its `ok` result is
  `Skill <name> loaded; its files live in <real folder path>; read them by that absolute path.`, a blank line, then the
  `SKILL.md` body without its frontmatter and the blank lines after it, cut to 2,000 lines with the mention notice
  (`SKILL.md` is read under the 1 MiB cap, inside the skill's real folder like its other files: discovery already
  skipped one linked out, so this check only catches a swap since, as `its SKILL.md could not be read (it links outside
  the skill's folder)`). A skill already loaded gives `ok`, `Skill <name> is already loaded; its files live in ...`,
  without the body, also one kept from the model that the user loaded with `/<name>`: an error there made models read
  the loaded text as injected and refuse it (#50, live). An unknown name, a skipped skill, and one kept from the model
  and not loaded give an `error` naming the skills the model may load.
- A sent message is a skill command when its trimmed text is `/`, a name of the send's discovery (listed to the model
  or not; a skipped skill is not discovered), then whitespace or the end (`findSlashSkill`, in the controller's send,
  after discovery). Any other `/word` is sent as typed, `/new`, `/model`, and `/compact` included (#51 handles them in the
  webview before any send). `args` is the text after the name, trimmed.
- The model receives one user message (role alternation): `loadSkillText(skill, args)`, the `load_skill` text with
  every `$ARGUMENTS` of the body replaced by `args`, the empty string included, before the cut to 2,000 lines and
  1 MiB (between characters, a line the byte cap cuts counted as not shown; a longer text is never built whole, since a
  repository's `SKILL.md` can hold 100,000 `$ARGUMENTS`); a body without `$ARGUMENTS` is followed, when `args` is not
  empty, by a blank line and `args`, its trailing line breaks dropped first. Mentions in `args` are read as for any
  message and their blocks follow; the `/<name>` token is never a mention. A `SKILL.md` that cannot be read at send
  (swapped since discovery) still sends the message, as an unreadable mention does: `Skill <name> could not be loaded: its SKILL.md could not be read (<reason>).`, then `args`
  after a blank line. The user entry keeps the text as typed and gets `skill: { name, status: "loaded" | "failed" }`,
  which the chat shows as a chip `Skill <name>` before the mention chips. A loaded one counts as loaded in the
  conversation from that message on (see "Workspace boundary" in `docs/spec/harness.md`); a second `/<name>` sends the whole text again, and the model's
  `load_skill` of it answers "already loaded".
- Skip a skill whose frontmatter lacks `name` or `description`, whose `name` breaks the spec or differs from its
  directory name, or whose `SKILL.md` cannot be read, and show a warning naming the file and the problem; a skills
  folder that exists but cannot be listed is one warning too. The warnings sit in `ChatState.skillWarnings`, are
  replaced at each send, and show in the panel list of skipped providers. The extension logs each send's skills
  (`broke-code: skills listed to the model: ...`) to the extension host console.
- The built-in slash commands are `/new`, `/model`, and `/compact`, run by the webview and never sent as typed or queued
  (the `/` menu, `docs/spec/mentions.md`): during a reply a message of exactly a built-in stays text in the box, and the controller
  refuses to queue one. Typing `/` lists them with every skill. A skill named `new`, `model`, or `compact` is listed too, after the built-ins, but a
  message of exactly its `/<name>` runs the built-in; picking the skill's row inserts `/<name> ` like any skill.
