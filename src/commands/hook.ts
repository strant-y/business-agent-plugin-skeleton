import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exists, readText, writeText } from '../utils/fs.js';
import { findGitRoot } from '../utils/git.js';

const MARKER = '# business-agent';

/**
 * Absolute path of the plugin CLI entry (dist/cli.js). Business projects that
 * use the plugin via a local tgz/checkout usually have no global
 * `business-agent` command on PATH, so the hook must invoke the plugin CLI by
 * its own location instead of relying on PATH.
 */
function pluginCliPath(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url)).replace(/\\/g, '/');
}

/**
 * Build the post-commit hook body. Git runs hooks with the repository root as
 * cwd, but the plugin operates on the project root (which may be a
 * subdirectory of the repo), so the script cds back to the project root first.
 */
function hookLines(projectRoot: string): string[] {
  const rootPosix = path.resolve(projectRoot).replace(/\\/g, '/');
  const cliPosix = pluginCliPath();
  return [
    '#!/bin/sh',
    `${MARKER}: auto-capture business knowledge after each commit.`,
    `cd "${rootPosix}" && node "${cliPosix}" capture --since last-commit --quiet --refresh-knowledge 2>/dev/null || { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] business-agent capture failed (exit $?)" >> ".agent/memory/hook-errors.log" 2>/dev/null || true; }`,
  ];
}

export type HookAction = 'install' | 'remove';

export async function hookCommand(root: string, action: HookAction): Promise<void> {
  const gitRoot = await findGitRoot(root);
  if (!gitRoot) {
    throw new Error('Not a git repository: no .git found in this directory or any parent. Run `git init` or `business-agent init` first.');
  }
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookFile = path.join(hooksDir, 'post-commit');

  if (action === 'remove') {
    if (!(await exists(hookFile))) {
      console.log('No post-commit hook to remove.');
      return;
    }
    const current = await readText(hookFile);
    const remaining = current
      .split(/\r?\n/)
      .filter((line) => !line.includes('business-agent'))
      .join('\n');
    // A leftover lone shebang means the hook was entirely ours: delete it.
    const body = remaining
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#!'))
      .join('\n');
    if (body.trim().length === 0) {
      await fs.rm(hookFile);
      console.log(`Removed ${hookFile}`);
    } else {
      await writeText(hookFile, remaining);
      console.log(`Removed business-agent lines from ${hookFile} (existing hook preserved).`);
    }
    return;
  }

  if (await exists(hookFile)) {
    const current = await readText(hookFile);
    if (current.includes(MARKER)) {
      console.log('post-commit hook already installed.');
      return;
    }
    // Preserve an existing hook: append our section under the marker.
    const combined = current.replace(/\s*$/, '\n') + '\n' + hookLines(root).slice(1).join('\n') + '\n';
    await writeText(hookFile, combined);
    console.log(`Appended business-agent capture to existing ${hookFile}.`);
  } else {
    await writeText(hookFile, hookLines(root).join('\n') + '\n');
    console.log(`Installed post-commit hook at ${hookFile}.`);
  }
  try {
    await fs.chmod(hookFile, 0o755);
  } catch {
    // chmod is best-effort (no-op on Windows).
  }
}
