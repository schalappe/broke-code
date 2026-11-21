---
status: accepted
---

# Code Mode: a script chains the harness's tools, runs in a sandboxed process, and ships behind an experimental setting

Every body tool call takes one reply (ADR 0001): a task of several related calls, such as reading nine files to add
their numbers, costs one request per call, and each request resends the whole history. Code Mode lets the model write
one JavaScript script, `run_script(code)`, that calls the harness's own tools as async functions; the harness runs it
and only what the script prints or returns goes back to the model. The reply still holds one body call: the calls the
script makes are execution detail (ADR 0001's "one body call per reply" stands).

## Decision

- **Scripts chain the existing tools, nothing else.** Each tool a send offers, but `run_script`, `load_skill`, and
  `ask_user`, is an async function of the same name taking one object of its arguments. A call resolves with the
  result text and throws an `Error` holding it when the tool fails or the user rejects it. `load_skill` and
  `ask_user` stay out: their results (a skill's instructions, the user's choice) must reach the model whole. In Plan,
  `write_file`, `edit_file`, and `run_command` still exist in the script, as functions that throw
  `<tool> is not available in Plan mode.` with no approval and no step, so ordinary code gets the Plan message rather
  than a `ReferenceError` (amends ADR 0005).
- **A separate process under macOS `sandbox-exec`** (maintainer decision 1). The script runs in a child started as
  `/bin/sh -c 'ulimit -t 60 || exit 125; exec "$@"'`, then `sandbox-exec` with a default-deny profile, then the
  runtime, in `/`, with an environment built from nothing. The profile allows reading the runtime's own program, the
  system libraries, the ICU data, the metadata of the folders above the runtime (those folders alone), `/` for its
  listing, `/dev/null`, the kernel's settings, and each extra readable path; nothing else: no file of the user's, no
  write, no network, no process. The child talks JSON Lines with the host over its stdin and stdout and evaluates the
  script in a `node:vm` context, a second layer only. The host owns the policy: it admits each call (a tool the script
  may call, known arguments, at most 100 calls), runs the calls one at a time through
  the turn, and enforces the limits (10 s of the script's own running time between calls, 1 MiB of output, the
  kernel's 60 s of processor time, 512 MiB of resident memory, 32 MiB of answers left unread, 10 s to exit once its
  input has ended). The child is untrusted once the script runs: a script can leave the vm, so the host never takes
  its done frame as proof that it will exit. When the script ends, the call it did not wait for is aborted and the
  queued ones never run; the script's step waits for the aborted call to settle, so a write already handed to the
  applier lands before the turn's next call runs. macOS applies no memory limit to a process (`ulimit -v`, `-d`, and `-m` fail), so the host
  reads the child's resident memory with `ps` every 250 ms, a bound with that lag rather than a hard one. Fail closed:
  when the sandbox or a limit cannot apply, the script does not run, or stops, and the step says why.
- **Every inner call goes through the usual approvals** (maintainer decision 1). The turn runs each call a script
  makes exactly as a direct call (`runCall`): Ask's diff and Accept, Run for a command, Auto-edit, Full access with its
  denied commands and command sandbox, the step's `approval`, its line counts, and its tie to the file for "Undo
  changes". A rejection throws in the script. The turn bounds what a script makes it hold: the steps of one script's
  calls hold at most 8 MiB of arguments and result text, plus one call's result; a call whose arguments would pass it
  throws and never runs. Each step is shown, saved, and kept, so this is the bound, not the child's own limits.
- **Inner calls are recorded as steps and never sent.** Each call's step is an ordinary tool step marked `fromScript:
  true`, an optional field, so the record stays at version 2 (ADR 0003). While the script runs, the completed steps
  are staged by the turn: shown live (`ChatState.scriptSteps`) and saved after the reply in flight, so a crash keeps
  the record of a write that reached the disk, with at most one save of them in flight, since calls can complete
  faster than the disk takes a copy of the whole record. When the script ends they join the entries before the `run_script`
  step; on Stop, after the stopped reply, with no `run_script` step. The history sends a reply's group as one step:
  the `run_script` result, with a line per inner write the user undid, or, for a script with no step of its own, one
  error result the history writes (stopped, then one line per completed call, never their result text, or a line
  saying none completed).
- **The runtime is the extension host's own executable run as Node** (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`),
  with the Electron frameworks of its app bundle readable. No runtime ships with the extension, and the user installs
  nothing. Measured on VSCodium 1.143 (`docs/eval.md`): the helper starts, completes a round trip, and is refused a
  write, a home read, a socket, and a spawn, and the processor time limit kills a loop.
- **An experimental user setting, `brokeCode.codeMode`, default off** (maintainer decision 2). Read from the user
  value only, at each send. A send offers `run_script` only when the setting is on and a probe of the runtime, once
  per window and lazily at the first send that would offer it, ran a script that called a stub tool and got its answer
  back under the exact launch, within a time bound. A failed probe keeps the tool off for the window with one warning
  notification; turning the setting off and on probes again. The decision is taken once per send and gates both the
  tool list and the runtime. It combines with Ask, Auto-edit, Full access, and Plan. Off, the system prompt and every
  request are those before Code Mode, byte for byte, for every record without inner steps.
- **No rule in the prompt's Rules list.** The tool's description carries its guidance alone: the eval measured that a
  rule made `gemma4` skip `ask_user` (`docs/eval.md`).
- **Raw reads.** A `read_file` in a script resolves with the lines asked for exactly as stored, never the mention
  block the model reads, and throws when the 2,000-line cap would cut them; the step keeps the mention block. Models
  that read, replaced, and wrote back the dressed text corrupted files.
- **The bare form.** A `run_script` call may hold its code with no `<code>` tag (ADR 0001, amendment of 2026-11-21).

## Measured results and limits (maintainer decision 3)

On local Ollama, 10 runs per cell (`docs/eval.md`, "Code Mode"):

- The gain is on grouped reads, and clear on one model only: `gather`, nine files to add up, took 8.2 and 8.1
  replies per run with Code Mode on `gemma4:26b-a4b-it-qat` against 13.7 without; on `qwen3.8:27b`, 7.8 and 10.3
  against 10.1, since how often a script is written varies between runs (7, then 3 of 10). Without the prompt rule,
  a script was written for the six-file `rename` in 1 of 40 runs; it passed 9/10 or 10/10 either way.
- `gemma4` passes the `ask` scenario between 7/10 and 9/10 with Code Mode (7/10, 7/10, 9/10 without the rule)
  against 9/10 without; its failures edited both same-named functions without asking. Whether Code Mode lowers it is
  not settled by 10 runs per cell, and the cause of the 7/10 runs is open. Shipped anyway, behind an experimental
  setting whose users know it.
- The employer's models are not measured with Code Mode.

## Considered options

- **`node:vm` inside the extension host.** Rejected: a function passed into the context leads back to the host's
  realm, and the host has the user's files, keys, and network. The vm is kept as a second layer in the child only.
- **One click per script, then the calls run unasked.** Rejected: the user would approve code they cannot read as
  changes; each inner call's own diff or command is what they can judge (ADR 0002).
- **Several calls per reply without code.** Rejected: it changes the parser's one-call rule (ADR 0001) without eval
  evidence, and gives no way to compute over results, such as a sum.
- **Scripts through `run_command`.** Rejected: a command runs with the user's shell and, in Full access, writes the
  workspace; a script's every effect must go through the tools and their approvals.
- **Bundling a runtime, or using bun or node from the PATH.** Rejected: a download or a user prerequisite, and a
  binary of unknown provenance under the profile; the host's own executable is already on disk and signed.

## Consequences

- broke-code starts a child process of the editor's own executable per script, only with the setting on.
- An inner step's result is never sent: the model reads only what the script printed. An older build that opens a
  record with inner steps drops the `fromScript` field (ADR 0003) and reads them as ordinary steps: it shows them as
  rows of their own and sends their results, file text included. Accepted for an experimental setting.
- Undo stays memory-only, as for direct calls; a reload restores the rows and their saved `undone` marks.
- Windows and Linux stay out of scope (v1 is macOS only); so do background scripts and a script API beyond the tools.
