#!/usr/bin/env node
import process from 'node:process';
import { getVersion } from './version.js';
import { initCommand } from './commands/init.js';
import { discoverCommand } from './commands/discover.js';
import { contextCommand } from './commands/context.js';
import { evolveCommand } from './commands/evolve.js';
import { validateCommand } from './commands/validate.js';
import { promoteCommand } from './commands/promote.js';
import { parseArgs, parsePromoteOptions, rejectUnexpectedArgs } from './cli-args.js';

const VERSION = getVersion();

const HELP: Record<string, string> = {
  init: 'Usage: business-agent init [--force]\n\nInitialize the .agent/ structure in the current project.\n\nOptions:\n  --force     Re-apply template files to an existing .agent/ directory.',
  discover:
    'Usage: business-agent discover [--deep] [--dry-run] [--json]\n\nScan source files and create initial business entity/rule/relation candidates.\n\nOptions:\n  --deep      Run deep analyzers (SQL, API routes, TS AST, Vue SFC, Java, MyBatis XML, cross-end linkage, conflict detection).\n  --dry-run   Do not write any files.\n  --json      Emit the manifest as JSON.',
  context:
    'Usage: business-agent context <subject> [--json] [--dry-run]\n\nBuild a task-oriented business context package for <subject>.',
  evolve:
    'Usage: business-agent evolve [candidate] [--dry-run]\n\nCreate a candidate knowledge item, or print the candidates directory.',
  promote:
    'Usage: business-agent promote <candidate> [--type rule|relation] [--entity <name>] [--dry-run]\n\nPromote a verified candidate into .agent/business/ as confirmed knowledge.\nFor relations, also pass --source <name> --target <name> [--cardinality 1:N].',
  validate:
    'Usage: business-agent validate [--json]\n\nValidate the discovery manifest and the confirmed knowledge files against the JSON schemas.',
};

function printGeneralHelp(): void {
  console.log(`business-agent ${VERSION}

A Business-First, Project-aware Agent Harness CLI.

Usage: business-agent <command> [options]

Commands:
  init                  Initialize .agent/
  discover              Scan project and create initial business knowledge
  context <subject>     Build active business context
  evolve [candidate]    Create a candidate knowledge item
  promote <candidate>   Promote verified candidate into confirmed knowledge
  validate              Validate the discovery manifest against schemas

Global options:
  --help, -h            Show help for a command or this overview
  --version, -v         Print the version
  --dry-run             Do not write any files
  --deep                Run deep analyzers (discover)
  --json                Emit machine-readable output
`);
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command, ...args] = positional;
  const root = process.cwd();

  if (flags.version || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (!command || flags.help || command === 'help') {
    printGeneralHelp();
    return;
  }

  if (flags.help && HELP[command]) {
    console.log(HELP[command]);
    return;
  }

  switch (command) {
    case 'init':
      rejectUnexpectedArgs('init', args);
      await initCommand(root, { force: flags.force });
      break;
    case 'discover':
      rejectUnexpectedArgs('discover', args);
      await discoverCommand(root, { dryRun: flags.dryRun, json: flags.json, deep: flags.deep });
      break;
    case 'context':
      if (args.length !== 1 || args[0].startsWith('--')) {
        throw new Error('Usage: business-agent context <subject>');
      }
      await contextCommand(root, args[0], { dryRun: flags.dryRun, json: flags.json });
      break;
    case 'evolve':
      if (args.length > 1) throw new Error('Usage: business-agent evolve [candidate]');
      await evolveCommand(root, args[0], { dryRun: flags.dryRun });
      break;
    case 'promote': {
      if (!args[0] || args[0].startsWith('--')) {
        throw new Error('Usage: business-agent promote <candidate> [--type rule|relation] [--entity <name>]');
      }
      const opts = parsePromoteOptions(args.slice(1));
      await promoteCommand(root, args[0], {
        type: (opts.type as 'rule' | 'relation' | undefined) ?? 'rule',
        entity: opts.entity,
        source: opts.source,
        target: opts.target,
        relationship: opts.relationship,
        cardinality: opts.cardinality,
        json: flags.json,
        dryRun: flags.dryRun,
      });
      break;
    }
    case 'validate':
      rejectUnexpectedArgs('validate', args);
      await validateCommand(root, { json: flags.json });
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printGeneralHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
