import fs from 'node:fs/promises';
import path from 'node:path';

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
}

export async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

export async function writeText(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf8');
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, JSON.stringify(value, null, 2) + '\n');
}
