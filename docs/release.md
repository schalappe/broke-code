# Release

This file describes how a merge to `main` becomes a published version.

- Merge `develop` into `main` with a merge commit, never a squash. A squash rewrites the commits on `main`, so
  `develop` would always look ahead of `main`.
- Commit messages follow Conventional Commits in English. On each merge to `main`, `release.yml` computes the
  version from the non-merge commits since the last `v*` tag: `feat` or a breaking change (`!` or a
  `BREAKING CHANGE:` footer) bumps the minor, `fix` bumps the patch, and the major stays at 0. The first
  release is `0.1.0`. A range with no `feat`, `fix`, or breaking change publishes nothing, and the run
  succeeds with a log line saying so.
- The release builds, tests, and packages, then creates tag `v<version>` on the merged commit before any
  upload. The tag reserves that version for that commit. Then it publishes to Open VSX, to the Visual Studio
  Marketplace, and last creates a GitHub Release that carries the `.vsix`. A failed run keeps its tag; finish
  it by re-running that run, which reuses the tag's version, skips a registry that already has it, and
  completes the Release. The next merge moves to the next version. The run fails before any upload if the
  computed tag already exists on another commit.
- The git tag is the only source of the version. CI writes the version into the package at build time and
  never commits to `main`, so `package.json` keeps `0.0.0`.
- Only `main` publishes, through the GitHub environment `release`, whose branch policy allows `main` only.
  Open VSX uses the environment secret `OVSX_PAT`, passed to the publish step as an environment variable and
  never on a command line. The Visual Studio Marketplace uses Trusted Publishing (`vsce publish --oidc`), with
  no stored token.

## Packaging under Bun

- Use `bun` for everything, including packaging and publishing. The project needs no Node and no npm.
  `@vscode/vsce` and `ovsx` are exact-pinned dev dependencies, so `bun.lock` also pins their dependencies. Run
  them under the Bun runtime with `bunx --bun vsce` and `bunx --bun ovsx`, and always pass
  `--no-dependencies` to `vsce`, because it otherwise calls npm to list dependencies. The bun bundle
  already contains them.
- If a registry upload fails under Bun, switch that release step alone to the current Node LTS, and say so
  here. Packaging and the other upload stay under Bun.
