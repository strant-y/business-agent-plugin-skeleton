#!/usr/bin/env node
import process from 'node:process';
import { getVersion } from './version.js';
import { initCommand } from './commands/init.js';
import { discoverCommand } from './commands/discover.js';
import { contextCommand } from './commands/context.js';
import { evolveCommand } from './commands/evolve.js';
import { validateCommand } from './commands/validate.js';
import { promoteCommand } from './commands/promote.js';
import { reviewCommand } from './commands/review.js';
import { configCommand } from './commands/config.js';
import { conflictsCommand } from './commands/conflicts.js';
import { deprecateCommand } from './commands/deprecate.js';
import { statesCommand } from './commands/states.js';
import { workflowCommand } from './commands/workflow.js';
import { learnCommand } from './commands/learn.js';
import { impactCommand } from './commands/impact.js';
import { captureCommand } from './commands/capture.js';
import { hookCommand } from './commands/hook.js';
import { taskCommand } from './commands/task.js';
import {
  parseArgs,
  parsePromoteOptions,
  parseCaptureOptions,
  parseTaskOptions,
  rejectUnexpectedArgs,
} from './cli-args.js';

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
  review:
    'Usage: business-agent review [--non-interactive] [--accept high|medium|low] [--reject high|medium|low] [--json]\n\nReview candidate business rules and accept, reject, or skip them.',
  config:
    'Usage: business-agent config get [key] | config set <key> <value>\n\nRead or update .agent/business-agent.json.',
  conflicts: 'Usage: business-agent conflicts [--json]\n\nDetect rule conflicts and print resolution suggestions.',
  deprecate: 'Usage: business-agent deprecate <rule-id>\n\nMark a confirmed rule as deprecated.',
  states: 'Usage: business-agent states [--json]\n\nExtract state machines and write Mermaid diagrams.',
  workflow: 'Usage: business-agent workflow <name>\n\nCreate a workflow template.',
  learn:
    'Usage: business-agent learn <business discovery> [--entity <name>]\n\nRecord a business discovery as a candidate for review.',
  impact:
    'Usage: business-agent impact [file ...] [--json]\n\nBuild a change impact report from changed files or git diff.',
  capture:
    'Usage: business-agent capture [message...] [--learn <fact>] [--entity <name>] [--since last-commit] [--quiet] [--json] [--dry-run]\n\nRecord the closing summary of a task: writes a task-history record with the change impact chain, and optionally records a verified business fact as a reviewable candidate.',
  hook: 'Usage: business-agent hook install|remove\n\nInstall or remove the post-commit hook that runs `capture --since last-commit --quiet` after every commit.',
  task: 'Usage: business-agent task start|context|predict-impact|checkpoint|test|finish\n\nRun the Agent task lifecycle and persist structured task knowledge.',
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
  review                Review candidate rules interactively or in batch
  config                Read or update project configuration
  conflicts             Detect rule conflicts and suggestions
  deprecate             Deprecate a confirmed rule
  states                Extract state machines
  workflow              Create a workflow template
  learn                 Record a business discovery candidate
  impact                Build a change impact report
  capture               Record a task-closing summary (task-history + optional candidate)
  hook                  Install or remove the post-commit auto-capture hook
  task                  Run the Agent task lifecycle and persist task knowledge

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
    case 'review': {
      const opts = parsePromoteOptions(args);
      const validConfidence = (value: string | undefined): 'high' | 'medium' | 'low' | undefined => {
        if (!value) return undefined;
        if (value !== 'high' && value !== 'medium' && value !== 'low') throw new Error(`Invalid confidence: ${value}`);
        return value;
      };
      await reviewCommand(root, {
        nonInteractive: flags.nonInteractive,
        json: flags.json,
        accept: validConfidence(opts.accept),
        reject: validConfidence(opts.reject),
      });
      break;
    }
    case 'config':
      await configCommand(root, args[0], args[1], args[2]);
      break;
    case 'conflicts':
      rejectUnexpectedArgs('conflicts', args);
      await conflictsCommand(root, flags.json);
      break;
    case 'deprecate':
      if (args.length !== 1) throw new Error('Usage: business-agent deprecate <rule-id>');
      await deprecateCommand(root, args[0]);
      break;
    case 'states':
      rejectUnexpectedArgs('states', args);
      await statesCommand(root, flags.json);
      break;
    case 'workflow':
      if (args.length !== 1) throw new Error('Usage: business-agent workflow <name>');
      await workflowCommand(root, args[0]);
      break;
    case 'learn':
      if (!args[0] || args[0].startsWith('--')) throw new Error('Usage: business-agent learn <business discovery>');
      await learnCommand(root, args.join(' '), { dryRun: flags.dryRun });
      break;
    case 'impact':
      await impactCommand(root, args, flags.json);
      break;
    case 'capture': {
      const opts = parseCaptureOptions(args);
      const message = args
        .filter((arg) => !arg.startsWith('--'))
        .join(' ')
        .trim();
      await captureCommand(root, {
        message: message || undefined,
        learn: opts.learn,
        entity: opts.entity,
        sinceLastCommit: opts.since === 'last-commit',
        quiet: flags.quiet,
        dryRun: flags.dryRun,
        json: flags.json,
      });
      break;
    }
    case 'hook': {
      const action = args[0];
      if (action !== 'install' && action !== 'remove') throw new Error('Usage: business-agent hook install|remove');
      await hookCommand(root, action);
      break;
    }
    case 'task': {
      const subcommand = args[0];
      const optionArgs = args.slice(1);
      const opts = parseTaskOptions(optionArgs);
      const values: string[] = [];
      for (let i = 0; i < optionArgs.length; i++) {
        if (optionArgs[i].startsWith('--')) {
          i++;
        } else {
          values.push(optionArgs[i]);
        }
      }
      const files = opts.files
        ?.split(',')
        .map((file) => file.trim())
        .filter(Boolean);
      const passed = opts.passed === undefined ? undefined : opts.passed === 'true';
      await taskCommand(root, subcommand, values, {
        json: flags.json,
        dryRun: flags.dryRun,
        files,
        command: opts.command,
        passed,
        summary: opts.summary,
        message: subcommand === 'finish' ? values.join(' ').trim() || undefined : undefined,
        learn: opts.learn,
        sessionId: opts.session,
      });
      break;
    }
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
