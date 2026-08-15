import { describe, expect, it } from 'vitest';
import { parseArgs, parsePromoteOptions, rejectUnexpectedArgs } from '../src/cli-args.js';

describe('parseArgs', () => {
  it('collects global flags and leaves positionals in order', () => {
    const { flags, positional } = parseArgs(['--json', 'discover', '--deep', '--dry-run']);
    expect(flags.json).toBe(true);
    expect(flags.deep).toBe(true);
    expect(flags.dryRun).toBe(true);
    expect(positional).toEqual(['discover']);
  });

  it('supports short aliases for help and version', () => {
    expect(parseArgs(['-h']).flags.help).toBe(true);
    expect(parseArgs(['-v']).flags.version).toBe(true);
  });

  it('treats unknown tokens as positionals (validated per command later)', () => {
    const { flags, positional } = parseArgs(['context', 'Plan', '--bogus']);
    expect(flags.json).toBe(false);
    expect(positional).toEqual(['context', 'Plan', '--bogus']);
  });

  it('returns all flags false for an empty argv', () => {
    const { flags, positional } = parseArgs([]);
    expect(flags).toEqual({ dryRun: false, json: false, help: false, version: false, deep: false, force: false });
    expect(positional).toEqual([]);
  });
});

describe('parsePromoteOptions', () => {
  it('parses known --key value pairs', () => {
    const opts = parsePromoteOptions(['--type', 'relation', '--source', 'A', '--target', 'B']);
    expect(opts).toEqual({ type: 'relation', source: 'A', target: 'B' });
  });

  it('rejects unknown option keys', () => {
    expect(() => parsePromoteOptions(['--bogus', 'x'])).toThrow(/Unknown promote option: --bogus/);
  });

  it('rejects options without a value', () => {
    expect(() => parsePromoteOptions(['--entity'])).toThrow(/--entity requires a value/);
    expect(() => parsePromoteOptions(['--entity', '--type', 'rule'])).toThrow(/--entity requires a value/);
  });
});

describe('rejectUnexpectedArgs', () => {
  it('accepts an empty argument list', () => {
    expect(() => rejectUnexpectedArgs('init', [])).not.toThrow();
  });

  it('throws with the command name for unexpected arguments', () => {
    expect(() => rejectUnexpectedArgs('init', ['extra'])).toThrow(/Unexpected argument\(s\) for init: extra/);
  });
});
