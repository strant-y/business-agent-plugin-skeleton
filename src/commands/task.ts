import {
  buildTaskContext,
  checkpointTask,
  finishTask,
  loadTaskSession,
  predictTaskImpact,
  recordTaskTest,
  runTaskValidation,
  startTask,
  updateTaskSession,
  type TaskSession,
} from '../core/task.js';

export interface TaskCommandOptions {
  json?: boolean;
  dryRun?: boolean;
  files?: string[];
  command?: string;
  message?: string;
  passed?: boolean;
  summary?: string;
  learn?: string;
  sessionId?: string;
}

function output(value: unknown, json?: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
}

function printContext(context: Awaited<ReturnType<typeof buildTaskContext>>, json?: boolean): void {
  if (json) {
    output(context, true);
    return;
  }
  console.log(`Task: ${context.task}`);
  console.log(`Entities: ${context.entities.map((entity) => entity.name).join(', ') || 'None'}`);
  console.log(
    `Rules: ${context.rules.map((rule) => `${rule.name} (${rule.status ?? 'candidate'})`).join('; ') || 'None'}`,
  );
  console.log(
    `Relations: ${context.relations.map((relation) => `${relation.source}->${relation.target}`).join(', ') || 'None'}`,
  );
  console.log(`History: ${context.history.join(', ') || 'None'}`);
  if (context.questions.length) console.log(`Questions: ${context.questions.join('; ')}`);
}

function printSession(session: TaskSession, json?: boolean): void {
  if (json) output(session, true);
  else console.log(`Task session ${session.sessionId}: ${session.phase} (${session.status})`);
}

export async function taskCommand(
  root: string,
  subcommand: string | undefined,
  args: string[],
  options: TaskCommandOptions = {},
): Promise<void> {
  if (!subcommand || subcommand === 'help') {
    console.log('Usage: business-agent task start|context|predict-impact|checkpoint|test|finish [options]');
    return;
  }
  if (subcommand === 'start') {
    const task = args.join(' ').trim();
    if (!task) throw new Error('Usage: business-agent task start <description>');
    const result = await startTask(root, task, options.sessionId, options.dryRun);
    if (options.dryRun) {
      printContext(result.context, options.json);
      return;
    }
    output({ session: result.session, context: result.context }, options.json);
    if (!options.json) {
      printSession(result.session);
      printContext(result.context);
    }
    return;
  }

  const session = await loadTaskSession(root, options.sessionId);
  if (subcommand === 'context') {
    const context = await buildTaskContext(root, session.task);
    if (!options.dryRun) await updateTaskSession({ ...session, context }, 'before_context');
    printContext(context, options.json);
    return;
  }
  if (subcommand === 'predict-impact') {
    const updated = await predictTaskImpact(root, session, options.files ?? [], options.dryRun);
    printSession(updated, options.json);
    return;
  }
  if (subcommand === 'checkpoint') {
    const updated = await checkpointTask(root, session, options.files ?? [], options.dryRun);
    printSession(updated, options.json);
    return;
  }
  if (subcommand === 'test') {
    if (!options.command)
      throw new Error('Usage: business-agent task test --command <command> [--passed true|false] [--summary <text>]');
    const updated =
      options.passed === undefined
        ? await runTaskValidation(session, [options.command], options.dryRun)
        : await recordTaskTest(
            session,
            {
              command: options.command,
              passed: options.passed,
              summary: options.summary,
            },
            options.dryRun,
          );
    printSession(updated, options.json);
    return;
  }
  if (subcommand === 'finish') {
    if (options.dryRun) {
      printSession({ ...session, phase: 'after_task', status: 'completed' }, options.json);
      return;
    }
    const updated = await finishTask(session, options.message, options.learn);
    printSession(updated, options.json);
    return;
  }
  throw new Error(`Unknown task phase: ${subcommand}`);
}
