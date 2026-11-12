/**
 * @module git
 * The host side of the Git API lookup (`src/core/git.ts`): the `vscode.git` extension handle and the URIs it takes.
 * The commit message command and the `@diff` mention share `lookUpGit`; `gitDiffs` is the `@diff` port.
 */
import * as vscode from "vscode";
import { type GitLookup, gitDiffReader, lookUpGit as lookUpGitIn } from "../core/git";

export type { GitRepository } from "../core/git";

/** Look the Git API up now, in the installed Git extension. Never rejects. */
export function lookUpGit(): Promise<GitLookup> {
  return lookUpGitIn(vscode.extensions.getExtension<unknown>("vscode.git"));
}

export const gitDiffs = gitDiffReader(lookUpGit, (path) => vscode.Uri.file(path));
