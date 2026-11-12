# Eval bench

This file describes `bun run eval`: what it runs, its sandbox, its scenarios, its flags, and the results measured per commit. Add each new measurement here.

- `bun run eval` plays each scenario 10 times per model against the local Ollama at `http://localhost:11434/v1`,
  on `qwen3.8:27b` then `gemma4:26b-a4b-it-qat`, all runs of one model before the next. Each run drives the
  chat controller with the read and write tools, `run_command`, and `load_skill` over a throwaway copy of the scenario's
  fixture, each write applied at once, each command approved at once through the run context (the bench plays the
  model, not the user; nothing in the product auto-approves a command; `range` rejects each instead) and run with `/bin/sh` in the copy with a
  10-second timeout, no instruction file, and a step limit of 10. Since `--base-url` lets replies come from a remote
  server, a command runs with a minimal environment inside a macOS sandbox (`benchCommandEnv`): its environment holds
  only `PATH`, `LANG`, and each `LC_*` of the bench's when set there, `HOME`, the run's home copy, and `TMPDIR`, a
  folder of the run's throwaway folder beside the workspace copy, removed with it (`BENCH_API_KEY` and everything else
  stay out); it runs under `/usr/bin/sandbox-exec`, which replaces itself with the shell, with a profile that denies all
  network access, every write outside the run's folder but `/dev/null`, and every read under the user's real home
  folder, `/private/var/folders`, and `/Volumes`, the run's folder excepted, and allows the rest, so the system's tools
  run as before. The profile's paths are real paths passed as `-D` parameters, never spliced into its text. Fail
  closed: when `sandbox-exec` is missing or cannot apply the profile (exit 71 when the bench itself runs inside a
  sandbox), the bench exits 1 before any run, naming the cause; a sandbox failure during a run is that command's
  `error` result. Accepted limits: files readable outside the denied folders (`/etc`, `/private/tmp`, `/Applications`,
  ...) stay readable, and a command's output still goes back to the provider and into the dump; a tool installed under
  the home folder (`~/.bun/bin`, `~/.cargo/bin`) cannot run in a bench command even when `PATH` names it; Apple marks
  `sandbox-exec` deprecated, with no supported replacement for a command-line tool. The tests that run a bench command
  need `sandbox-exec` to apply a profile, so they fail inside a harness that is itself sandboxed. Skills are discovered as the extension
  does, but with a throwaway copy of the scenario's home fixture as the home folder, so the bench never reads the real
  `~/.agents`; a scenario without one gets no skill, and its prompt has neither the Skills section nor `load_skill`.
  Eight scenarios, each judged on the turn ending `done` and on the workspace after it: every file the scenario writes
  holds its exact expected text, byte for byte, and every other entry is unchanged. The workspace is read back without
  following symlinks: every entry but a folder counts, a file by its text, a symlink by its target (`{ symlink }`), any
  other kind, such as a FIFO, by its kind (`{ special }`), so a command that adds a symlink fails `workspaceChanged`.
  - `read`: the model must read a setting it cannot guess and answer with its value. Passes when a tool step got the
    value, the answer holds it, and no file changed.
  - `edit`: rename a function named once in `src/pricing.py`. Passes when exactly that line changed.
  - `create`: create `docs/call-format.md` with a text stated in the message that holds double quotes, backslashes,
    `<content>...</content>`, `</write_file>`, and a fenced code block. Passes when the file is exactly that text
    plus one line break.
  - `skill`: the home fixture holds one personal skill, `depot-codes`, whose description matches the message (the
    dispatch code of a depot) and whose body sends the model to `reference/depots.md` in its folder, the only file
    holding the code. The message names neither the skill nor the tool. Passes when an `ok` `load_skill` step ran, a
    read step got the code, the answer holds it, and no file changed; without an `ok` `load_skill` step it is
    `wrongTool`.
  - `command`: count the files under `logs/`, subfolders included: 61 files in 18 month folders under two year folders,
    more folders than the step limit lets the model list, and none hidden. The message does not name the tool. Passes
    when an `ok` `run_command` step ran, the answer holds 61 as a number token of its own (the answer is split into runs of digits, letters, `.`, `,`, `_`, `+`, `-`, and U+2212 holding a digit, trailing `.` and `,` dropped, so `161`, `61,000`, `61.5`, `0,61`, `-61`, `61e3`, and `61k` fail and `61.` passes), and no file changed. Without an `ok`
    `run_command` step it is `wrongTool`, its detail led by the first line of the last command step when one ran (a
    rejection, `stopped after 10 seconds`, an exit code).
  - `slash`: the `skill` fixture and home, the message `/depot-codes` then the `skill` question, so the user loads the
    skill. Passes when a read step got the code, the answer holds it, and no file changed; no `load_skill` step is
    required, and an `ok` one is allowed. A first user entry without a `loaded` skill is `wrongTool`, its detail
    saying so, since the run then measures nothing of the slash path.
  - `hidden`: `slash` with `disable-model-invocation: true` in the skill's frontmatter, beside a second personal skill,
    `release-notes`, unrelated to depots and listed, so the prompt has the Skills section and offers `load_skill` while
    `depot-codes` stays off its list; judged the same way. It measures that the model follows a skill the user loaded
    although it was never listed to it, instead of refusing the loaded text as injected: live, a `load_skill` of it
    answered an error and the model refused (#50); it now answers "already loaded".
  - `range`: `dispatch.log` holds 2,400 lines, `<depot> <state>` in plain words drawn from a fixed seed, and a README
    names it; its last line, `nice seal VX7Q-K2RM`, alone holds a code. The message asks to read the file and give the
    code on its last line, and names neither the tool, its arguments, a line number, nor a word of that line, so
    `search` has no pattern for it. Passes when an `ok` `read_file` step called with a `start_line` holds the code, the
    answer holds it, and no file changed; without such a step it is `wrongTool`, a `search` that found the code
    included: it measures that the model follows the note of a cut read (#100). The bench rejects every command
    approval of this scenario, as the user's Reject does (the model gets "The user rejected this command."); writes
    are unchanged (maintainer decision, 2026-11-12). On 2bda260, before that rule, the full run passed 158 of 160 in
    54 min 07 s: every other scenario 10/10 on both models, `range` 10/10 on `qwen3.8:27b` and 8/10 on `gemma4`, whose
    two misses ran `tail -n 1 dispatch.log` with `run_command` and answered without reading the file, so they measured
    nothing of the note. The lines are plain words
    because a first fixture of numbered random codes (`0001 98UJ-YCK7`) cost about 25,900 tokens for the first read on
    `gemma4`, close to the 32,768-token context with the second, and its prefill took `qwen3.8:27b` over the
    300-second reply timeout on its first run (twice in 2 tries).

  A failed run shows one category and a one-line detail: `malformed`, `wrongTool`, `wrongAnswer`, `stepLimit`,
  `contextFull`, `providerError`, `wrongEdit` (a file the scenario writes is missing or holds other text, with the
  first differing line), or `workspaceChanged` (the written files are right, or none was asked for, but another file
  changed). The bar is 9 runs of 10 per model and scenario; the bench exits 1 when a model is under it, and before
  any run when the sandbox cannot be applied, or Ollama is unreachable or does not list a model. `--model <name>`, `--scenario <name>` (both
  repeatable; an unknown scenario exits 1 naming the others), and `--runs <n>` shorten a local iteration;
  `--base-url <url>` plays against another OpenAI-compatible server instead of the local Ollama, such as a rented vLLM
  started with `--max-model-len 32768` (#58), its key read from `BENCH_API_KEY`, never a flag; `--dump <file>` appends each run's entries (tool steps with their call's arguments), verdict,
  `planned` (each change handed to the applier, in call order: tool, path, `before` (`null` for a new file), `after`,
  and the applier's status), and `changes` (each entry that differs from the fixture after the run, with its text,
  `{ symlink }`, or `{ special }`, `null` when removed) as JSON Lines, to read the
  failing replies; an incomplete last line left by an interrupted run is removed, with a notice, before the first
  append. A full run of the five scenarios took 22 min 48 s on the maintainer's Mac on 394042c, the first run of each
  model including its load; the bench has no time limit per run, and one `gemma4` run whose reasoning ran on for about
  98,000 characters once took 18 min on its own (b1049a2). It runs locally on demand and never in CI. On 394042c every
  model met the bar on every scenario, 10/10 everywhere; every `command` run counted with `find logs -type f | wc -l`,
  most after listing a level or two. On 9a67dd7, `gemma4` once failed `skill` (`wrongTool`: it listed the skill folder
  and answered without reading the reference file). Live, `qwen3.8:27b` proposes a command for that count, but on a
  small tree (7 files in 4 folders) it walks the folders with `list_files` instead, even when asked to count the
  subfolders (#9 verification). On 9db1a52 the six scenarios took 55 min 45 s, one `gemma4` `edit` run alone 22 min 56 s
  before it failed `malformed` (a `<read_file>` call never closed); every model met the bar: `slash` 10/10 on both
  models, `command` 9/10 on `qwen3.8:27b` (`wrongTool`: it listed the folders, then searched, and ran no command),
  `edit` 9/10 on `gemma4`, every other scenario 10/10. On 9f6ae23 plus the `release-notes` skill, `hidden` alone
  took 5 min 38 s, 10/10 on both models: `qwen3.8:27b` read the reference file at once in every run; `gemma4` called
  `load_skill(depot-codes)` in 2 runs, got "already loaded", then read the file, and listed the skill folder first in 4.
  On edc18b5 the seven scenarios took 56 min 39 s, 10/10 for every scenario on both models (140 of 140 runs); one
  `gemma4` `edit` run alone took 19 min 19 s and passed. With `--base-url` against `gemma-4-31b-it` on vLLM 0.28 (a rented A100, #58), before the
  wrapper and forged-result rules `skill` passed 6/10 and `command` 9/10; with them, 70 of 70 in 6 min 32 s, and the
  local bench stayed at 140 of 140 (58 min 23 s). `qwen-latest`, measured as `Qwen/Qwen3.8-27B-FP8` on vLLM 0.28
  without a reasoning parser (`--max-num-seqs 16` on 48 GB), passed `create` 4/10 and `command` 8/10 with those
  rules; with the bare `</think>` rule, `create` 10/10 and `edit` 9/10, `command` still 8/10 (it walked `logs/` with
  `list_files` until the step limit). With the `run_command` sentence about folder trees (#120), `qwen-latest` passed
  70 of 70, `gemma-4-31b-it` 69 of 70 (one `edit` run halted on an invented `<tool_read_file>` tag written three
  times), and the local bench 140 of 140. `glm-latest` is not measured: renting a GPU for GLM is out of budget
  (maintainer decision, 2026-11-12), so no parser rule exists for its replies ending mid-call.
