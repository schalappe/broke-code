---
status: accepted
---

# A loaded skill's folder is readable by its absolute real path, read-only, for the rest of the conversation

A skill is more than its `SKILL.md`: the Agent Skills format lets the instructions point at reference files, templates,
and scripts in the skill's folder. A personal skill lives in `~/.agents/skills/`, outside every workspace folder, and
the tools act inside the workspace only. Without an exception the model could read a skill's instructions and none
of the files they name.

`load_skill(name)` loads a skill listed to the model. Its `ok` result opens with
`Skill <name> loaded; its files live in <real folder path>; read them by that absolute path.`, then the `SKILL.md`
body without its frontmatter, cut to the mention caps (1 MiB, 2,000 lines) with the usual notice. From then on, for
the rest of the conversation, `read_file`, `list_files`, and `search` also accept an absolute path inside that folder.
Nothing else gets the exception: mentions never do, and the write tools never do, so a planned write into a loaded
skill's folder outside the workspace is refused as `outsideWorkspace`. A workspace skill's folder is part of the
workspace, so the usual workspace rules apply to it, writes included.

## One boundary check, with read-only roots

The exception lives in the shared read boundary (`workspaceFiles.ts`), which `read_file`, `list_files`, and `search`
all go through, as extra read-only roots beside the workspace folders. A path written inside a loaded skill's folder
is checked with the workspace rule: resolved with `realpath`, then opened, resolved again, and the open handle must be
the same device and inode as that path. The write boundary never takes the read-only roots.

## Symlink policy

A path written inside a loaded skill's folder must resolve inside that same folder. A symlink in it to elsewhere is
`outsideWorkspace`, also one into another loaded skill's folder or into the workspace: each folder is held to itself,
as a workspace folder is. The folder is matched by the real path discovery found, never resolved again, so a skill
folder swapped for a symlink since its discovery leads elsewhere and stays outside.

Every file of a skill lies in its own folder, `SKILL.md` included (maintainer decision, 2026-11-09). Discovery skips a
personal or workspace skill whose `SKILL.md` resolves outside the skill folder's real path, with an
`outsideSkillFolder` warning; a personal skill folder that is itself a symlink stays accepted, its real path being the
root. A listed skill is therefore loadable. `load_skill` still reads `SKILL.md` by the read rule above, as the
boundary, so a `SKILL.md` swapped for a link out after discovery gives an error saying it links outside the skill's
folder.

## Why an absolute path

The model writes the folder's absolute real path, as the load result gives it. A virtual prefix (`skill:review/…`
or `@skills/review/…`) would go through the mention resolver, where a multi-root workspace folder may hold any name,
`/` included, so a prefix could clash with a folder name. A new tool argument (`skill`) would widen the three read
tools' specs for every call. An absolute path needs neither: the resolver already takes absolute paths, and `search`
inside the folder prints the absolute paths the model reads them by.

## The loaded set is derived from the conversation

A skill is loaded in a conversation when the conversation holds an `ok` `load_skill` step for its name. An `error`
step, a step dropped by Stop, and a malformed call load nothing. Before each tool call the controller maps those names
to folders through the current send's discovery, so a load earlier in the same turn counts at the next call, a
reopened conversation keeps its loaded skills with no new record field or version, and a skill that vanished since is
simply no longer readable. Loading a skill already loaded answers `ok`, "already loaded", without the body, which the
conversation already holds.

`load_skill` is offered, with its prompt rule, only while a skill is listed to the model, like the Skills section: a
workspace without skills spends no prompt on it, and the prompt of every eval scenario without a skill stays as it was measured. Its call is then a malformed one.

## Considered options

- **A virtual path prefix.** Rejected: it clashes with multi-root folder names in the mention resolver.
- **A `skill` argument on the read tools.** Rejected: it widens three specs for a rare case.
- **A record field listing the loaded skills.** Rejected: the `load_skill` steps already say it, and a record change
  needs a version bump and a migration rule.
- **Symlinks resolving anywhere inside any loaded skill or the workspace.** Rejected: one rule per folder is simpler
  to state and check, and a skill reaching another folder through a link is reachable by its own path anyway.

## Consequences

- A personal skill's reference files are readable after its load and refused before, with the usual
  `outsideWorkspace` wording.
- `/<name>` (#11) reuses `loadSkillText` and will need to mark the user entry so that a skill the user loads also
  opens its folder.
- A skill folder with thousands of files is searched whole by `search` with that folder as its `path`; the usual
  2,000-line and 30-second caps bound it.
