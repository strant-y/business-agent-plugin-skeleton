import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCommand } from '../src/commands/capture.js';
import { hookCommand } from '../src/commands/hook.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ba-capture-'));
}

describe('captureCommand', () => {
  it('writes a task-history record and an optional learning candidate', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent/memory'), { recursive: true });

    const summary = await captureCommand(dir, {
      files: ['src/views/OrderList.vue'],
      message: 'Fixed the order submission flow',
      learn: '审核中的订单不能修改',
      entity: 'Order',
      quiet: true,
    });

    expect(summary.changedFiles).toEqual(['src/views/OrderList.vue']);
    expect(await fs.readFile(summary.record, 'utf8')).toContain('Fixed the order submission flow');
    expect(path.basename(summary.record)).toMatch(/\.md$/);

    const candidates = await fs.readdir(path.join(dir, '.agent/memory/candidates'));
    expect(candidates.length).toBe(1);
    const candidate = await fs.readFile(path.join(dir, '.agent/memory/candidates', candidates[0]), 'utf8');
    expect(candidate).toContain('# Candidate: 审核中的订单不能修改');
    expect(candidate).toContain('## Entity\nOrder');
    expect(candidate).toContain('src/views/OrderList.vue');
  });

  it('respects --dry-run and writes nothing', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent/memory'), { recursive: true });

    const summary = await captureCommand(dir, {
      files: ['src/views/OrderList.vue'],
      learn: 'A fact',
      dryRun: true,
      quiet: true,
    });

    await expect(fs.readdir(path.join(dir, '.agent/memory/task-history'))).rejects.toThrow();
    await expect(fs.readdir(path.join(dir, '.agent/memory/candidates'))).rejects.toThrow();
    expect(summary.record.endsWith('.md')).toBe(true);
  });
});

describe('hookCommand', () => {
  async function gitRoot(): Promise<string> {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.git'));
    return dir;
  }

  it('installs a post-commit hook, reports already-installed, then removes it', async () => {
    const dir = await gitRoot();
    const hookFile = path.join(dir, '.git/hooks/post-commit');

    await hookCommand(dir, 'install');
    const content = await fs.readFile(hookFile, 'utf8');
    expect(content).toContain('business-agent capture --since last-commit --quiet');
    expect(content).toContain('hook-errors.log');
    expect(content).toContain('|| true');

    await hookCommand(dir, 'install');
    expect(await fs.readFile(hookFile, 'utf8')).toBe(content);

    await hookCommand(dir, 'remove');
    await expect(fs.readFile(hookFile, 'utf8')).rejects.toThrow();
  });

  it('preserves an existing hook and removes only the business-agent lines', async () => {
    const dir = await gitRoot();
    const hookFile = path.join(dir, '.git/hooks/post-commit');
    await fs.mkdir(path.dirname(hookFile), { recursive: true });
    await fs.writeFile(hookFile, '#!/bin/sh\n# my own hook\n', 'utf8');

    await hookCommand(dir, 'install');
    const combined = await fs.readFile(hookFile, 'utf8');
    expect(combined).toContain('# my own hook');
    expect(combined).toContain('business-agent capture');

    await hookCommand(dir, 'remove');
    const remaining = await fs.readFile(hookFile, 'utf8');
    expect(remaining).toContain('# my own hook');
    expect(remaining).not.toContain('business-agent');
  });

  it('rejects when the directory is not a git repository', async () => {
    const dir = await tempRoot();
    await expect(hookCommand(dir, 'install')).rejects.toThrow(/Not a git repository/);
  });
});
