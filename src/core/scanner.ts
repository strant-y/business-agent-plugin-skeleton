import path from 'node:path';
import fs from 'node:fs/promises';
import type { AgentConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';

export interface SampleFile {
  file: string;
  text: string;
}

export interface ProjectScan {
  files: string[];
  sampleText: string;
  samples: SampleFile[];
}

function isBinary(text: string): boolean {
  return text.includes('\u0000');
}

/** Max concurrent file reads during scanning. */
const READ_CONCURRENCY = 8;

export async function scanProject(root: string, config: AgentConfig = DEFAULT_CONFIG): Promise<ProjectScan> {
  const ignoreDirs = new Set(config.ignoreDirs);
  const allowedExt = new Set(config.allowedExt);
  const candidates: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // Sort for deterministic traversal: file list, sample selection and
    // analyzer input must not depend on the OS readdir order.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && ignoreDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!allowedExt.has(path.extname(entry.name))) continue;
      candidates.push(path.relative(root, full));
    }
  }

  await walk(root);

  // Read file contents with bounded concurrency; slot i always holds
  // candidates[i], so results stay deterministic regardless of timing.
  const contents: Array<string | null> = new Array(candidates.length).fill(null);
  let next = 0;
  const workerCount = Math.min(READ_CONCURRENCY, Math.max(1, candidates.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      if (index >= candidates.length) break;
      const full = path.join(root, candidates[index]);
      try {
        const stat = await fs.stat(full);
        if (stat.size > config.maxFileBytes) continue;
        const text = await fs.readFile(full, 'utf8');
        contents[index] = isBinary(text) ? null : text;
      } catch {
        // Ignore unreadable files during discovery.
      }
    }
  });
  await Promise.all(workers);

  const files: string[] = [];
  const samples: SampleFile[] = [];
  const perExt = new Map<string, number>();
  for (let i = 0; i < candidates.length; i++) {
    const text = contents[i];
    if (text === null) continue;
    const rel = candidates[i];
    files.push(rel);
    const ext = path.extname(rel).toLowerCase();
    const extCount = perExt.get(ext) ?? 0;
    if (samples.length < config.maxSampleFiles && extCount < config.maxSamplesPerExt) {
      samples.push({ file: rel, text: text.slice(0, config.maxSampleChars) });
      perExt.set(ext, extCount + 1);
    }
  }

  const sampleText = samples.map((s) => `\n--- ${s.file} ---\n${s.text}`).join('\n');
  return { files, sampleText, samples };
}
