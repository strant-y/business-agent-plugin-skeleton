import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * List files changed by git. With `sinceLastCommit` it reports the files of
 * the last commit (used by the post-commit hook); otherwise the working tree
 * diff against HEAD. Returns [] when git is unavailable or there is no diff.
 */
export async function gitBranch(root: string): Promise<string | undefined> {
  try {
    const result = await run('git', ['branch', '--show-current'], { cwd: root });
    const branch = result.stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export async function gitDiffText(root: string): Promise<string> {
  try {
    const result = await run('git', ['diff', 'HEAD', '--'], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout;
  } catch {
    return '';
  }
}

export async function gitDiffFiles(root: string, sinceLastCommit = false): Promise<string[]> {
  if (sinceLastCommit) {
    // `git show --name-only` works for any commit, including the root commit.
    try {
      const result = await run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root });
      return splitLines(result.stdout);
    } catch {
      return [];
    }
  }
  try {
    const result = await run('git', ['diff', '--name-only', 'HEAD'], { cwd: root });
    return splitLines(result.stdout);
  } catch {
    return [];
  }
}

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}
