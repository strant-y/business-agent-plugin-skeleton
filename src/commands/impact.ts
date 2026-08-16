import { buildImpactReport, writeImpactReport } from '../core/impact.js';
import { gitDiffFiles } from '../utils/git.js';

export async function impactCommand(root: string, files: string[] = [], json = false): Promise<void> {
  const changedFiles = files.length ? files : await gitDiffFiles(root);
  const report = await buildImpactReport(root, changedFiles);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const output = await writeImpactReport(root, report);
  console.log(`Impact report written to ${output}`);
  if (report.warnings.length) for (const warning of report.warnings) console.warn(`Warning: ${warning}`);
}
