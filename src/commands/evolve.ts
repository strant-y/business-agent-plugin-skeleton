import path from 'node:path';
import { ensureDir, writeText } from '../utils/fs.js';
import { candidateSlug } from '../core/candidate.js';

export interface EvolveOptions {
  dryRun?: boolean;
}

export async function evolveCommand(root: string, candidate?: string, options: EvolveOptions = {}): Promise<void> {
  const dir = path.join(root, '.agent/memory/candidates');
  if (!candidate) {
    console.log(`Candidate directory: ${dir}`);
    console.log('Create candidate knowledge here, verify it, then promote it into .agent/business/.');
    console.log('Usage: business-agent evolve <candidate>');
    return;
  }

  const safe = candidateSlug(candidate);
  const file = path.join(dir, `${safe}.md`);
  const content = `# Candidate: ${candidate}\n\nStatus: candidate\n\n## Hypothesis\nDescribe the business rule or relationship discovered.\n\n## Evidence\n- Add concrete source evidence.\n\n## Impact\n- Describe which UI, API, service or database areas this affects.\n\n## Verification\n- Verify against frontend, backend, API and database evidence.\n`;
  if (options.dryRun) {
    console.log(`Dry run: would create ${file}`);
    return;
  }
  await ensureDir(dir);
  await writeText(file, content);
  console.log(`Candidate created: ${file}`);
}
