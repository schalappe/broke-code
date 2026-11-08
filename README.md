# broke-code

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling.

Some services speak the OpenAI chat API but reject the `tools` request field, so agent extensions that rely on
it fail against them. In broke-code, the model writes each tool call in the text of its reply, and the
extension reads and runs it. broke-code never sends `tools`, even to a service that supports them.

The current version is a streaming chat with a provider: pick a model, send a message with files and folders
attached, stop a reply, and read the model's reasoning collapsed above its answer. The agent loop, skills, and slash
commands come next.

## Requirements

- macOS. Version 1 supports macOS only; Windows and Linux are planned for version 2.
- VS Code 1.101 or later, or a compatible editor such as VSCodium.
- An LLM service with an OpenAI-compatible API: streaming `POST /v1/chat/completions` and `GET /v1/models`.
  Ollama works.

## Configure a provider

A provider is an LLM service broke-code talks to. List your providers in your **user** settings
(`settings.json`) under `brokeCode.providers`. Each entry has a unique `name` and a `baseUrl`, the API root:

```json
"brokeCode.providers": [
  { "name": "Ollama", "baseUrl": "http://localhost:11434/v1" },
  { "name": "Work", "baseUrl": "https://llm.example.com/v1" }
]
```

broke-code appends `/models` and `/chat/completions` to the base URL. It reads this list from user settings
only: a workspace `settings.json` cannot override it, so a repository cannot send your key to another URL.

## Corporate or self-signed certificates

broke-code trusts the certificates your system trusts. If a provider uses a certificate signed by a corporate
or self-signed authority that is not in the macOS Keychain, the chat reports a certificate error naming the
provider. Add a `caFile` to that provider: an absolute or `~/` path to a PEM file holding the authority's
certificate (one file can hold several).

```json
{ "name": "Work", "baseUrl": "https://llm.example.com/v1", "caFile": "~/certs/company-ca.pem" }
```

The file adds to the system certificates for that provider only; it never replaces them. Certificate
verification cannot be turned off.

## Set an API key

broke-code asks for the key of each new provider. To set, replace, or clear a key later, run
**broke-code: Set API key** from the Command Palette and pick the provider. Leave the box empty for a provider
that needs no key, such as Ollama.

Keys live in the editor's secret storage (the macOS Keychain), never in `settings.json`. broke-code sends a key
only to its own provider, as a bearer token.

## Mention files and folders

Type `@` in the message box to attach a workspace file or folder. A menu lists up to 20 files and folders whose
path contains what you type after `@`, ignoring case, shortest paths first; folders end with `/`. Move with the
arrow keys, pick with Enter, Tab, or a click, and close the menu with Escape. A picked path goes into the message
as `@<path>`, spaces included. You can also type `@path` yourself; a typed path ends at the first space.

When you send the message, broke-code reads each mention and sends it to the model with your text:

- A file is attached whole, or cut to its first 2,000 lines with a note saying how many lines were left out.
- A folder attaches the names of its direct children, not their content and not deeper levels.
- A binary file, a file over 1 MiB, a missing path, and a path outside the workspace folders (symlinks
  included) are not attached; the model gets a note saying why, and the message is still sent.

Each mention shows as a chip under your message with what was attached or why it was not.

The menu lists files from the workspace folders, except those hidden by your `files.exclude` setting and anything
inside `node_modules`, `.git`, `dist`, `out`, or `build` folders. It lists at most 5,000 files; past that, the
menu says the index is limited, and you can still type the path of a file it does not show. New and deleted
files show up in the menu without reloading the window.

## Privacy

broke-code collects no telemetry. It contacts only the providers you configure.

## Credits

The chat panel's visual style and the `@` token detection of the mention menu follow
[twinny](https://github.com/twinnydotdev/twinny), released under the MIT license.

## License

MIT. See [LICENSE](LICENSE).
