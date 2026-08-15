/**
 * CLI argument parsing, extracted from cli.ts so it can be unit-tested
 * without executing the CLI entry point.
 */

export interface Flags {
  dryRun: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  deep: boolean;
  force: boolean;
}

export function parseArgs(raw: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = { dryRun: false, json: false, help: false, version: false, deep: false, force: false };
  const positional: string[] = [];
  for (const arg of raw) {
    switch (arg) {
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--deep':
        flags.deep = true;
        break;
      case '--force':
        flags.force = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-v':
      case '--version':
        flags.version = true;
        break;
      default:
        positional.push(arg);
    }
  }
  return { flags, positional };
}

export const PROMOTE_KEYS = new Set(['type', 'entity', 'source', 'target', 'relationship', 'cardinality']);

export function parsePromoteOptions(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    if (!PROMOTE_KEYS.has(key)) {
      throw new Error(`Unknown promote option: --${key}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option --${key} requires a value`);
    }
    opts[key] = value;
    i++;
  }
  return opts;
}

export function rejectUnexpectedArgs(command: string, args: string[]): void {
  if (args.length === 0) return;
  throw new Error(`Unexpected argument(s) for ${command}: ${args.join(' ')}. Run \`business-agent help ${command}\`.`);
}
