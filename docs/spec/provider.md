# Provider contract

This file specifies how broke-code talks to a provider: the HTTP contract, the settings, the API keys, and TLS.

- broke-code speaks one contract: streaming `POST /v1/chat/completions` and `GET /v1/models`. It covers the
  internal service and Ollama.
- Never send `tools` or read `tool_calls`, even to a provider that supports them. See ADR 0001.
- Providers (name and base URL) live in the VS Code user settings only (`application` scope). A workspace
  `settings.json` must not override them, because keys are stored by provider name and a repository could
  otherwise point that name at its own URL. Each API key lives in `SecretStorage`, never in `settings.json`.
- One writer of `brokeCode.providers`: "broke-code: Add provider" (`broke-code.addProvider`, in the Command Palette,
  beside "Open provider settings" in the no-provider state, and under the skipped providers while a valid provider
  exists; without one, the empty state's button is the only one, maintainer decision). A Quick Pick offers
  "Ollama on this machine" (`ollama`, `http://localhost:11434/v1`, the empty key; never probed) and "Other
  OpenAI-compatible service", which asks the name, the base URL, then the key in a password box, no Back. A box
  accepts a value when `parseProviders`, given the user value plus the candidate entry, keeps it (`readCandidate`),
  each reason with a short message of its own; the key passes the shape check and may be empty. When a valid
  `ollama` exists, the preset writes nothing and selects it. On completion, in order: the key is stored under the
  name (`""` for no key, so no key prompt follows), then the entry `{ name, baseUrl }`, base URL as the parser
  normalizes it, is appended to the user value (`ConfigurationTarget.Global`); other entries, skipped ones and
  `caFile` included, keep their order and fields, and a value that is not an array becomes the one-entry array. Key
  first because keys are never deleted with their provider: a setting written first would send a removed provider's
  leftover key to a new URL of the same name. A failed key write is shown and writes no setting; a failed settings
  write is shown and deletes the key just stored. The entry is checked against the setting before the key is stored
  and again after, and the write appends to that second read, so a providers change made meanwhile (another window,
  a `settings.json` edit) is kept; an entry refused by then (its name taken) is shown and deletes the key, writing
  nothing. Accepted race: a change landing between that read and the write is overwritten, since settings have no
  compare-and-swap. Then the host applies the settings and selects the new provider,
  except while a reply is in flight. The flow runs in the API key dialog queue, so the missing-key prompt the settings
  write triggers runs after it and finds the key. Escape at any step writes nothing. Editing or removing a provider
  stays in `settings.json`.
- Requests never follow HTTP redirects; a redirect is reported as an error. Provider response bodies are read
  under size caps that cancel the download when exceeded. Responses may be compressed with gzip, deflate, or br;
  the caps count decoded bytes, and any other `Content-Encoding` is reported as an error.
- The API does not report a model's context size. The `brokeCode.contextSizes` user setting (`application` scope,
  read from `globalValue` like the providers) maps model names to sizes in tokens; a model absent from it, or with an
  entry that is not a positive integer, uses 32,768. While such a model is selected, the chat shows "Unknown context
  size, using 32k" with a link: the host asks for the size in an input box and merges it into the user value of the
  setting. The header shows the next request's estimated size, as it would be sent (older tool results left out
  included, see `docs/spec/harness.md`), against the model's size.
- Every provider request goes through Node's `http`/`https` modules. VS Code patches them in place in the
  extension host, adding its proxy support and, to requests without a `ca` option, the OS certificate store. A
  provider without a CA file sends no `ca`, so it trusts exactly what VS Code trusts.
- Each provider has an optional `caFile`: an absolute or `~/` path to a PEM file. It applies to that provider's
  requests only. Node's `ca` option replaces the default store, so the client passes
  `tls.getCACertificates("default")` (bundled roots and `NODE_EXTRA_CA_CERTS`), `tls.getCACertificates("system")`
  (the OS store, expired certificates dropped), and every certificate of the file together. A provider with a CA
  file always trusts the OS store, whatever VS Code's `http.systemCertificates` setting says. The file is read and
  checked with `X509Certificate` on every request, because Node ignores an invalid `ca` silently. A relative
  path, an unreadable file, or a file without a valid PEM certificate is reported naming the path, and no
  request is sent.
- Never disable certificate verification. Report a certificate failure (unknown issuer, self-signed, expired,
  hostname mismatch) as a certificate error with its code, never as a generic network error. Connection refused,
  DNS failures, and timeouts stay `unreachable`.
- A request gets 300 seconds from its start to the response headers, DNS, connect, and TLS included; past that it
  is `unreachable` and says it timed out. After the headers, 300 seconds without a byte cut the reply off, with a
  cause saying how long nothing came. Node `fetch` used the same 300-second limits.
