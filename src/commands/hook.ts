import path from 'node:path';
import fs from 'node:fs/promises';
import { exists, readText, writeText } from '../utils/fs.js';

const MARKER = '# business-agent';
const HOOK_LINES = [
  '#!/bin/sh',
  `${MARKER}: auto-capture business knowledge after each commit.`,
  'business-agent capture --since last-commit --quiet 2>/dev/null || exit 0',
];

export type HookAction = 'install' | 'remove';

export async function hookCommand(root: string, action: HookAction): Promise<void> {
  const gitDir = path.join(root, '.git');
  if (!(await exists(gitDir))) {
    throw new Error('Not a git repository: .git not found. Run `git init` or `business-agent init` first.');
  }
  const hooksDir = path.join(gitDir, 'hooks');
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
    const combined = current.replace(/\s*$/, '\n') + '\n' + HOOK_LINES.slice(1).join('\n') + '\n';
    await writeText(hookFile, combined);
    console.log(`Appended business-agent capture to existing ${hookFile}.`);
  } else {
    await writeText(hookFile, HOOK_LINES.join('\n') + '\n');
    console.log(`Installed post-commit hook at ${hookFile}.`);
  }
  try {
    await fs.chmod(hookFile, 0o755);
  } catch {
    // chmod is best-effort (no-op on Windows).
  }
}
