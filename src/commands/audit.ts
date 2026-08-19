import { runAudit, type AuditCheck, type AuditReport } from '../core/audit.js';

const STATUS_LABEL: Record<AuditCheck['status'], string> = { ok: 'OK', warn: 'WARN', error: 'ERROR' };

export async function auditCommand(root: string, json = false): Promise<AuditReport> {
  const report = await runAudit(root);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Business knowledge audit');
    for (const check of report.checks) {
      console.log(`  [${STATUS_LABEL[check.status]}] ${check.label}: ${check.message}`);
    }
    console.log(
      `Audit result: ${report.issues > 0 ? 'FAILED' : 'PASSED'} (${report.checks.length} checks, ${report.warnings} warnings)`,
    );
  }
  if (report.issues > 0) process.exitCode = 1;
  return report;
}
