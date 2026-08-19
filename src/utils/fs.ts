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
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rename(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;
        await fs.rm(file, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`Unable to replace JSON file: ${file}`);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
