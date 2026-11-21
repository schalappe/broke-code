# Eval bench

This file describes `bun run eval`: what it runs, its sandbox, its scenarios, its flags, and the results measured per commit. Add each new measurement here.

- `bun run eval` plays each scenario 10 times per model against the local Ollama at `http://localhost:11434/v1`,
  on `qwen3.8:27b` then `gemma4:26b-a4b-it-qat`, all runs of one model before the next. Each run drives the
  chat controller with the read and write tools, `run_command`, `load_skill`, and `ask_user` (which the extension does
  not offer yet, `docs/spec/harness.md`) over a throwaway copy of the scenario's fixture, each write applied at once,
  each `ask_user` question answered at once through the run context with the scenario's answer (`Decide yourself.` in
  a scenario that defines none, so it keeps measuring what it measured), each command approved at once through the
  run context (the bench plays the model, not the user; nothing in the product auto-approves a command; `range` and
  `ask` reject each instead) and run with `/bin/sh` in the copy with a 10-second timeout, no instruction file, and a step limit of 10 (30 in `rename` and `gather`). Since `--base-url` lets replies come from a remote
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
  The bench drives the extension's chat controller and client, so its requests carry the usage field
  (`stream_options: { include_usage: true }`) and follow its one-resend rule (`docs/spec/provider.md`); each run
  starts with a fresh `ProviderSupport`, so what one run learns of the server never changes the next run's requests.
  Within a run the bench learns each model's characters per token from the replies' reported usage as the extension
  does (`docs/spec/harness.md`), starting at 4 in every run. Results measured before 2026-11-13 were taken without the
  field, and every recorded result was measured at a fixed ratio of 4.
  Eleven scenarios, each judged on the turn ending `done` and on the workspace after it: every file the scenario writes
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
    nothing of the note. On ff1d075, with the rule, `range` alone took 16 min 12 s, 10/10 on both models: `qwen3.8:27b`
    read the whole file, then read on with a `start_line` from 2001 to 2400 in every run; `gemma4` tried a command in
    4 runs, got the rejection, and read on in all 10, once after a first read with `end_line` 1 whose header gave the
    line count. The other seven scenarios were not rerun: the rule changes only `range`, and the system prompt is
    the one of the 2bda260 run. The lines are plain words
    because a first fixture of numbered random codes (`0001 98UJ-YCK7`) cost about 25,900 tokens for the first read on
    `gemma4`, close to the 32,768-token context with the second, and its prefill took `qwen3.8:27b` over the
    300-second reply timeout on its first run (twice in 2 tries).
  - `ask`: `src/depots/labels.py` (labels for depot shelves) and `src/parcels/labels.py` (labels for parcels) each
    define a function `build_label`, beside a README that favors neither; the message asks to rename "the function
    build_label" to `make_label` and change nothing else, so nothing in the workspace or the message says which. The
    bench answers every `ask_user` question with `Rename the one in src/parcels/labels.py.` and rejects every command
    approval, as in `range`, so the rename goes through the write tools. Passes when the turn ends `done`,
    `src/parcels/labels.py` holds exactly the rename, `src/depots/labels.py` is unchanged, and an `ok` `ask_user` step
    came before the first write; a right rename without such a step is `wrongTool`, a wrong or double rename
    `wrongEdit` or `workspaceChanged` as usual. Under `--no-ask-user` the tool is not offered and `ask` is judged on the
    workspace alone. It measures that the model asks when only the user can choose, instead of guessing (#142, pull
    request #147). Each measurement below is `--scenario ask`, 10 runs per model.
    - Baseline without the tool (`--no-ask-user`), on cd6bc6a (the commits after it leave the path without the tool
      unchanged), 14 min 16 s: 0/10 on both models. `qwen3.8:27b` failed 9 runs `workspaceChanged`
      (`src/depots/labels.py` changed) and 1 `wrongEdit` (it renamed the depot function only), `gemma4` 10
      `workspaceChanged`. The dumps show both models renaming both functions rather than picking one, which the judge
      reports as the depot file changed; so the baseline came out 0/10, not the near 5/10 the issue expected from a
      guess between two files, and it shows the fixture gives nothing away (that bar is 9/10).
    - With the tool, three wordings of its description and of its rule in the system prompt, the most the issue
      allowed. Wording 1, on 03d76b8, 15 min 27 s: description "Ask the user one question and wait for the answer.
      Put the choices in options when there are a few. The result holds the user's answer.", rule "Call ask_user only
      when the request cannot be carried out without a choice only the user can make, such as which of several
      matching places to change."; `qwen3.8:27b` 3/10 (7 `workspaceChanged`: it renamed both without asking),
      `gemma4` 0/10 (10 `workspaceChanged`). Wording 2, on 8a3bec1, 18 min 43 s: the description's second sentence
      became "Use it when the request names one thing and several match it, so only the user can say which; put the
      choices in options.", the rule "When the request names one thing and several match it, such as two functions
      with the same name, call ask_user before any write instead of changing them all or picking one yourself;
      otherwise do not ask."; `qwen3.8:27b` 10/10, `gemma4` 6/10 (4 `workspaceChanged`: it renamed both, its reasoning
      taking the two definitions for one function). Wording 3, on 6c690db, 16 min 36 s: both say the matches are
      distinct, the description "several distinct ones match it, such as two definitions of the same name", the rule
      "several distinct ones match it, such as two functions defined with the same name in two files (two different
      functions, not one), call ask_user to ask which before any write"; 10/10 on both models. That text is the one in
      `src/core/askUser.ts` and `src/core/systemPrompt.ts`.
    - Decision: bar met (the issue's bar: `ask` 9/10 on both models, and every other scenario kept at 9/10 in the full
      run of the nine, recorded below). The tool, the scenario, and the flag are kept. The extension offers the tool
      since #143, with the description and the rule measured here unchanged, so that change needed no eval run.
  - `rename`: `src/weights.py` defines `parcel_weight` beside `parcel_weight_limit`, a decoy whose name holds the old
    one, and five other files call it, `src/routing.py` twice: seven occurrences in six files. The message asks to
    rename it to `shipment_weight` everywhere it is defined or called and to change nothing else. Passes when exactly
    those six files hold the new name at each occurrence, byte for byte, the decoy kept, and nothing else changed. A
    replace-all of the old name also renames the decoy and fails `wrongEdit`; an `edit_file` of `parcel_weight` alone
    in `src/weights.py` matches twice and is refused.
  - `gather`: nine files `stock/<depot>.txt`, each with a `quantity: N` line among a `depot`, an `updated`, a `shelf`,
    and a `reserved: N` line; the message asks for the total quantity across all depots (766). Passes when an `ok` tool
    step's text (a direct call's, a script's call's, or the script's output) held the total as a number token or every
    `quantity: N` line (a whole line, or a search line's end), the answer holds 766 as a number token of its own (the
    `command` scenario's check), and no file changed; without such a step it is `wrongTool`.

  `rename` and `gather` measure Code Mode (below): each takes several related calls, one per file. Both
  reject every command, so a shell command cannot stand in and a run compares direct calls with one script, and both
  have a step limit of 30 (`Scenario.maxToolSteps`), so a model calling the tools one by one can finish. Their
  verdicts are task verdicts, the same with and without `--code-mode`.

  A failed run shows one category and a one-line detail: `malformed`, `wrongTool`, `wrongAnswer`, `stepLimit`,
  `contextFull`, `providerError`, `wrongEdit` (a file the scenario writes is missing or holds other text, with the
  first differing line), or `workspaceChanged` (the written files are right, or none was asked for, but another file
  changed). Each scenario's line of the report also gives the mean number of replies per run that ended `done`
  (summaries aside), how many requests the model needed, and how many passing runs `chained`: one `ok` `run_script`
  step ran at least two `ok` calls of its own. The bar is 9 runs of 10 per model and scenario; the bench exits 1 when a model is under it, and before
  any run when the sandbox cannot be applied, or Ollama is unreachable or does not list a model. `--model <name>`, `--scenario <name>` (both
  repeatable; an unknown scenario exits 1 naming the others), and `--runs <n>` shorten a local iteration;
  `--base-url <url>` plays against another OpenAI-compatible server instead of the local Ollama, such as a rented vLLM
  started with `--max-model-len 32768` (#58), its key read from `BENCH_API_KEY`, never a flag; `--no-ask-user` leaves
  `ask_user` out of every run's tools and system prompt and judges `ask` on the workspace alone, the baseline that
  shows what the tool changes (its start line then says `ask_user not offered`); `--code-mode` offers `run_script` in
  every run (below; its start line then says `code mode (run_script offered)`); `--dump <file>` appends each run's entries (tool steps with their call's arguments), verdict,
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
  times), and the local bench 140 of 140. On 6c690db, with `ask_user` offered (#142, pull request #147), the nine
  scenarios took 75 min 02 s, 10/10 for every scenario on both models (180 of 180 runs); `range` took the longest,
  8 min 52 s on `qwen3.8:27b` and 12 min 32 s on `gemma4`, and no run of the eight other scenarios called `ask_user`,
  so none needed a second run. `glm-latest` is not measured: renting a GPU for GLM is out of budget
  (maintainer decision, 2026-11-12), so no parser rule exists for its replies ending mid-call.

## Code Mode (`--code-mode`)

Code Mode lets the model write one JavaScript script that chains several tools; the harness runs it, and only what the
script prints or returns goes back to the model (ADR 0008, `docs/spec/harness.md`). `bun run eval --code-mode` offers
the `run_script` tool in every run (`src/core/script.ts`), through the same per-send decision the extension takes
behind its experimental setting `brokeCode.codeMode`. Without the flag, the system prompt, the tool list, and every
request are the ones before it, byte for byte.

- The tool. `run_script(code)`, with no rule in the system prompt's Rules list (fourth iteration, below): its
  description carries its guidance. `code` is a multi-line argument; a call may also hold the code bare, with no `<code>`
  tag (ADR 0001, 2026-11-21): it then ends at the first `</run_script>`. The code is the body of an async function.
  Each tool offered in the send but `run_script`, `load_skill`, and `ask_user` is an async function of the same name
  taking one object of its arguments (each value converted with `String()`, an `undefined` one dropped); a call
  resolves with the result text when the result is `ok` and throws an `Error` holding it otherwise, a rejection by the
  user included. `read_file` is the exception: it resolves with the lines asked for exactly as stored (no header, no
  fence, no notice), so a script can change the text and write it back, and it throws when the 2,000-line cap would
  cut them, naming the `start_line` and `end_line` to read in parts; the recorded step keeps the mention block, so the
  chat and the dump are unchanged (`ToolResult.forScript`, set only for a call a script made). `write_file` still ends
  a file with exactly one line break; `edit_file` keeps a file without one as it is. The step's text is each `console.log` (or `console.error`) line in
  order, then the returned value (a string as is, anything else as JSON), cut at 2,000 lines with the usual notice;
  an uncaught error makes the step `error`, ending with `run_script: the script stopped on an error: <message>`.
- The host owns the policy. Each call the script asks for is checked before anything runs: a tool the script may call,
  one object of text values, no unknown argument, every required one given; a refused call throws inside the script.
  Calls run one at a time, in arrival order, through the turn, which approves and records each one as a direct call
  (`runCall` of the chat controller): the bench answers its approvals as for a direct call. Each call's step lands
  before the script's own step, marked `fromScript: true`, staged while the script runs (shown live and saved in the
  extension, `docs/spec/harness.md`); the history never sends such a step, so the model reads the script's output
  only. A script is one step toward the step limit.
- Limits, each ending the script with its own message: at most 100 calls (call 101 throws and never runs); 10 seconds
  of the script's own running time between calls (the time a call takes, such as a wait for approval, never counts);
  1 MiB of printed output, counted in the child; one protocol line over 8 MiB; and a kernel limit of 60 seconds of
  processor time (`ulimit -t`, set by `/bin/sh` before `sandbox-exec` applies the profile), which holds even if the
  host dies. Stop kills the child and aborts the call running.
- The child. `/bin/sh -c 'ulimit -t 60 || exit 125; exec "$@"'` runs `/usr/bin/sandbox-exec -p <profile> -D RUNTIME=<bun>`, which
  runs bun (`process.execPath`, its real path) with `-e <bootstrap>`, in `/`, with an empty environment: bun needs no
  variable to run the bootstrap (measured). Host and child talk JSON Lines over the child's stdin and stdout. The
  script runs in a `node:vm` context whose globals are the tool functions and `console`; the vm is a second layer
  only, since a function passed into it leads back to the child's `process`. Fail closed: without `sandbox-exec`, or
  when it cannot apply the profile, the step is an `error` naming the cause and nothing runs; before any run,
  `--code-mode` runs the runtime probe that way, a script that calls a stub tool and returns its answer, and exits 1
  when it fails (`benchScriptProblem` over `scriptProblem`).
- The profile, default deny, every allowance measured on 2026-11-20 with bun 1.4.4 and node 23.11 on macOS (Darwin
  27.2), by reading the kernel's sandbox denials (`log show --predicate 'sender == "Sandbox"'`):

      (version 1)
      (deny default)
      (allow process-exec (literal (param "RUNTIME")))
      (allow file-read* (literal (param "RUNTIME")))
      (allow file-read* (subpath "/usr/lib") (subpath "/usr/share/icu") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS"))
      (allow file-read-data (literal "/"))
      (allow file-read* file-write-data (literal "/dev/null"))
      (allow sysctl-read)
      (allow file-read-metadata (literal (param "A0")) ...)

  plus `(allow file-read* (subpath (param "R0")) ...)` for each extra readable path, none for the bench. The
  metadata line, added for Electron (below), names each folder above the runtime, those folders alone. Without
  `file-read-data` on `/`, the child's working folder, bun aborts at start (SIGABRT, exit 134); without
  `sysctl-read` it crashes; without `/usr/share/icu`, `Intl.NumberFormat` throws in bun; without `/System/Library`,
  node cannot read its OpenSSL configuration and exits; without `/dev/null`, node aborts. Bun alone starts without the
  system library paths (the dyld cache maps without a read check), but they hold no user data and node needs them.
  The script tests (`src/core/script.test.ts`) run a trusted probe under this exact launch and profile: a file write, a
  read under the home folder, a read of a workspace file, and a process spawn each get `EPERM`, and a socket to a
  server listening on 127.0.0.1 is refused (bun reports `ECONNREFUSED`; the kernel logs `deny network-outbound`, and
  the server sees no connection). A script that reaches the child's `process` from inside the vm still gets `EPERM`
  for a write. `ulimit -t 1` kills a looping child with SIGXCPU.
- First measurement, on uncommitted work over 9c625ef (the first iteration: no raw read, no bare call), local
  Ollama, 2026-11-20 and 2026-11-21, 10 runs per cell, "off" without `--code-mode`, "on" with it:
  - `qwen3.8:27b`: the nine scenarios before Code Mode 10/10 in both arms. `rename` 9/10 off (13.0 replies per run, 21 min 18 s)
    and 9/10 on (11.8 replies, 25 min 26 s, 3 chained); `gather` 10/10 off (10.1 replies, 10 min 09 s) and 10/10 on
    (5.2 replies, 8 min 40 s, 10 chained). The full bench took 67 min 09 s off and 69 min 31 s on.
  - `gemma4:26b-a4b-it-qat`: `read`, `edit`, `create`, `skill`, `command`, `slash`, and `hidden` 10/10 in both arms;
    `range` 9/10 off and 10/10 on; `ask` 9/10 off and 7/10 on; `rename` 9/10 off (13.5 replies, 66 min) and 5/10 on
    (10.1 replies, 62 min 26 s, 3 chained); `gather` 9/10 off (13.7 replies, 30 min 58 s, run on its own, since the
    full off batch was cut at the 2-hour limit of its background task during `gather`) and 10/10 on (9.0 replies,
    12 min 28 s, 9 chained). The full bench on took 117 min 20 s.
  - Causes, read from the dumps. (a) A script read a file with `read_file`, replaced the name in the text it got, and
    wrote it back with `write_file`; that text was the mention block (the `@src/labels.py (file, 5 lines)` header and
    a code fence), so the dressing landed in the files: 4 of `gemma4`'s 5 `rename` failures and `qwen3.8`'s one. (b)
    `gemma4` wrote the JavaScript straight inside `<run_script>`, with no `<code>` tag, as its first `run_script` call
    in 8 of 10 `rename` runs, got "Unexpected text inside <run_script>", and recovered after the malformed-call
    message; it also tried `require('fs')`. (c) In 2 of `gemma4`'s 3 `ask` failures it renamed both same-named
    functions through a script instead of calling `ask_user`.
  - What followed, in the second iteration: the raw `read_file` value in a script (from (a)); the bare call (from
    (b), ADR 0001, 2026-11-21); and the prompt: the description and the rule now say that `read_file` returns the
    file's exact text, that `edit_file` changes a passage and `write_file` only replaces a whole file, that a script
    has no `require` and no file system access, only the tool functions, and that a script cannot ask the user, so
    `ask_user` comes first when its rule applies (from (a), (b), and (c)).
- Second measurement, with those three changes, on uncommitted work over 9c625ef, local Ollama, 2026-11-21,
  `--code-mode`, `ask`, `rename`, and `gather` only, 10 runs per cell:
  - `qwen3.8:27b`, 42 min 09 s: `ask` 10/10 (5.6 replies per run); `rename` 9/10 (8.1 replies, 4 chained, 23 min
    08 s; its failure wrote the placeholder `<tool_name>` as a call three times in a row, unrelated to scripts);
    `gather` 10/10 (7.3 replies, 7 chained, 10 min 31 s).
  - `gemma4:26b-a4b-it-qat`, 75 min 38 s: `ask` 7/10 (6.9 replies, 1 chained; its 3 failures renamed both same-named
    functions and never called `ask_user`: two first read both files in a script, one edited both in a script);
    `rename` 9/10 (10.6 replies, 6 chained, 38 min 23 s; its failure: a script stopped on an error after the
    definition's edit, and the model then edited only 3 of the remaining files); `gather` 9/10 (9.0 replies, 6
    chained, 29 min 15 s; its failure, `wrongTool`, answered after reading one file).
  - No run of either model wrote the dressed text into a file, and of the 52 `run_script` calls `gemma4` wrote, 13
    were bare (no `<code>` tag) and were read as calls: causes (a) and (b) are fixed as measured. `gemma4` `ask` stays
    under the bar at 7/10, as in the first measurement (9/10 without `--code-mode`).
  - Third iteration, a hypothesis to test, not a finding: the `run_script` rule's example, "the same change in several
    files", competes with the `ask_user` rule ("instead of changing them all"), which came before it. The rule now
    opens "When a task takes several related tool calls, such as reading several files or making an edit at several
    places you already know, write one run_script call instead of one call per reply.", and the `ask_user` rule
    follows the `run_script` rule when both are listed; without `run_script`, the prompt is unchanged. Measured on
    2026-11-21, `gemma4` `--code-mode` `ask` only, 10 runs, 7 min 17 s: 0/10, so the hypothesis is refuted. 9 runs
    renamed both functions without ever calling `ask_user`, 8 of them opening with a script that read both files; 1
    run hit the step limit, after writing `<code...>` as the opening tag three times (`SyntaxError: Unexpected token
    '<'`), a shape not seen before. The change was reverted to the second iteration's prompt. It changed two things at
    once, the rule's wording and the rules' order, so which one hurt is not known.
  - Fourth iteration, a diagnostic: `run_script` offered with its description but without its rule in the Rules
    list. `gemma4` `--code-mode` `ask`, 10 runs, 2026-11-21: 7/10, `ask_user` called in 9 of 10 runs, and no
    `run_script` call in any run. Its 3 failures: one edited both files without asking; one asked, edited the right
    file, then searched until the step limit of 10; one changed the other file too after a malformed `edit_file` and
    an `ask_user`. Without the rule the model asks as often as without `--code-mode` (9 of 10 runs there); with it,
    it skipped `ask_user` in 3 runs of 10 in both earlier measurements, and in 9 of 10 with the third iteration's
    wording. The rule was therefore removed: the tool's description carries its guidance alone, now also saying that
    the tool is useful for several related calls in one reply, that `edit_file` changes a passage and `write_file`
    only replaces a whole file, and that a script cannot ask the user, so `ask_user` is called directly.
  - Measured with that change, `--code-mode`, `ask`, `rename`, and `gather`, 10 runs per cell, local Ollama,
    2026-11-21, uncommitted work over 9c625ef:
    - `gemma4:26b-a4b-it-qat`, 47 min 34 s: `ask` 7/10 (6.7 replies per run, 0 chained; its 3 failures edited both
      files without calling `ask_user` and wrote no script; without `--code-mode` it called `ask_user` in 10 of 10
      runs); `rename` 10/10 (14.1 replies, 0 chained, 28 min 38 s); `gather` 10/10 (8.2 replies, 9 chained, 11 min
      20 s).
    - `qwen3.8:27b`, 44 min 08 s: `ask` 10/10 (5.9 replies); `rename` 10/10 (13.8 replies, 0 chained, 24 min 17 s);
      `gather` 10/10 (7.8 replies, 7 chained, 10 min 25 s).
    - Reading. Without the rule neither model writes a script for the rename (0 of 20 runs, against 4 and 6 of 10
      with it), and both still do for the gather (16 of 20), so the measured gain of Code Mode is on grouped reads:
      `gather` replies per run, 10.1 without `--code-mode` and 7.8 with it on `qwen3.8`, 13.7 and 8.2 on `gemma4`.
      `gemma4` `ask` is under the bar in every `--code-mode` configuration measured (7/10, 7/10, 0/10, 7/10 in the
      diagnostic, 7/10), against 9/10 without; with 10 runs per cell this is a consistent tendency, not a proof, and
      its cause is open: the rule made it worse, but removing it did not restore it. The other eight scenarios were
      not replayed after the first iteration.
  - Fifth measurement, after phase 2 (the extension's Code Mode port and turn loop, the final `run_script`
    description, no rule), on uncommitted work over 9c625ef, local Ollama, 2026-11-21, `--code-mode`, `ask`,
    `rename`, and `gather`, 10 runs per cell:
    - `qwen3.8:27b`, 48 min 00 s: `ask` 10/10 (5.7 replies per run); `rename` 9/10 (11.9 replies, 1 chained, 23 min
      10 s; its failure wrote the placeholder `<tool_name>` as a call three times in a row); `gather` 10/10 (10.3
      replies, 3 chained, 14 min 10 s).
    - `gemma4:26b-a4b-it-qat`, 71 min 59 s: `ask` 9/10 (6.9 replies; its failure asked, then hit the step limit of
      10); `rename` 10/10 (13.6 replies, 0 chained, 47 min 43 s); `gather` 9/10 (8.1 replies, 6 chained, 14 min 07 s;
      its failure wrote three unreadable calls in a row).
    - Reading. Every cell met the bar. `gemma4` `ask` is 9/10 here, against 7/10 in the four earlier `--code-mode`
      measurements with a rule or without (0/10 with the third iteration's wording): across the description-only
      runs it is 7/10, 7/10 (the diagnostic), and 9/10, so it is measured between 7/10 and 9/10 with Code Mode,
      against 9/10 without, and whether Code Mode lowers it is not settled by 10 runs per cell. How often a script is
      written for the gather varies between runs of one configuration (`qwen3.8` 7 of 10, then 3 of 10; `gemma4` 9,
      then 6), and so do its replies per run (`qwen3.8` 7.8, then 10.3, against 10.1 without `--code-mode`; `gemma4`
      8.2, then 8.1, against 13.7): the gain on grouped reads is clear on `gemma4`, not on `qwen3.8`. Without the
      rule, no script was written for the rename in 39 of 40 runs. The other eight scenarios were last measured with
      `--code-mode` in the first iteration.
- The extension's runtime, measured on 2026-11-21 on VSCodium 1.143.17232 (Electron's Node 24.21.0), macOS Darwin
  27.2, from an unsandboxed shell, through the exact launch (`scriptLaunch`: the profile, `ulimit -t`, the empty
  environment but `ELECTRON_RUN_AS_NODE=1`), with `hostScriptEnv`. VS Code is not installed on the measuring machine,
  so it is not measured. The extension host runs as `VSCodium Helper` (a `node.mojom.NodeService` utility process);
  `VSCodium Helper (Plugin)` and the main executable were measured too, with the same results.
  - Readable paths it needed, found by reading the kernel's sandbox denials (`/usr/bin/log show`): the four
    frameworks of `VSCodium.app/Contents/Frameworks`, `Electron Framework.framework`, `Squirrel.framework`,
    `Mantle.framework`, and `ReactiveObjC.framework` (without each, dyld aborts at start, SIGABRT, naming the
    missing one), and the metadata of every folder above the helper (`/`, `/Applications`, … `Contents/MacOS`;
    without any one of them the helper dies with SIGTRAP). It needs nothing else of the bundle: not its own `.app`
    folder, which it lists at start and is refused, harmlessly. Denials it survives: `mach-lookup` of
    `opendirectoryd`, `logd`, and `notification_center`, `system-info`, `/dev/dtracehelper`, the metadata of `/etc`,
    `/var`, and the cryptexes, and `.GlobalPreferences.plist`; it prints one `codesign_util` error line to stderr.
  - Start: a script printing one line ran in 78 to 200 ms. Round trip (`scriptProblem`: a call to a stub tool, its
    answer returned): passed in 184 ms (Helper), 114 ms (Plugin), 86 ms (main executable).
  - Refused, by a trusted probe under the same launch: a write to `/private/tmp` and under the home folder (`EPERM`,
    no file left), a listing of the home folder and a read of a file in it (`EPERM`), a process spawn (`EPERM`), and a
    socket to a server on 127.0.0.1 (`EPERM`; the server saw no connection). A script that reaches the child's
    `process` from inside the vm gets `EPERM` for a write.
  - Limits: `ulimit -t 1` killed a looping script after 1,034 ms with the processor time message; the host's 1-second
    running-time timer stopped another after 1,007 ms.
