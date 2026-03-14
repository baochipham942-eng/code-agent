import { remindersConnector } from '../../src/main/connectors/native/reminders.ts';
import {
  finishWithError,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
} from './_helpers.ts';

function usage(): void {
  console.log(`Reminders smoke

Usage:
  npm run acceptance:reminders -- <command> [options]

Commands:
  status
  lists
  items [--list <name>] [--include-completed true|false] [--limit <n>]
  create --list <name> --title <text> [--notes <text>] [--remind-at-ms <ts>]
  update --list <name> --reminder-id <id> [--title <text>] [--notes <text>] [--completed true|false] [--remind-at-ms <ts>] [--clear-remind-at]
  delete --list <name> --reminder-id <id>

Options:
  --json   Print JSON only.
  --help   Show this help.
`);
}

async function run(): Promise<unknown> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help') || args.positionals.length === 0) {
    usage();
    return null;
  }

  const command = args.positionals[0];
  const json = hasFlag(args, 'json');
  let action = '';
  let payload: Record<string, unknown> = {};

  switch (command) {
    case 'status':
      action = 'get_status';
      break;
    case 'lists':
      action = 'list_lists';
      break;
    case 'items':
      action = 'list_reminders';
      payload = {
        list: getStringOption(args, 'list'),
        include_completed: getBooleanOption(args, 'include-completed'),
        limit: getNumberOption(args, 'limit'),
      };
      break;
    case 'create':
      action = 'create_reminder';
      payload = {
        list: getStringOption(args, 'list'),
        title: getStringOption(args, 'title'),
        notes: getStringOption(args, 'notes'),
        remind_at_ms: getNumberOption(args, 'remind-at-ms'),
      };
      if (!payload.list || !payload.title) {
        throw new Error('create requires --list and --title');
      }
      break;
    case 'update':
      action = 'update_reminder';
      payload = {
        list: getStringOption(args, 'list'),
        reminder_id: getStringOption(args, 'reminder-id'),
        title: getStringOption(args, 'title'),
        notes: getStringOption(args, 'notes'),
        completed: getBooleanOption(args, 'completed'),
        remind_at_ms: getNumberOption(args, 'remind-at-ms'),
        clear_remind_at: hasFlag(args, 'clear-remind-at'),
      };
      if (!payload.list || !payload.reminder_id) {
        throw new Error('update requires --list and --reminder-id');
      }
      break;
    case 'delete':
      action = 'delete_reminder';
      payload = {
        list: getStringOption(args, 'list'),
        reminder_id: getStringOption(args, 'reminder-id'),
      };
      if (!payload.list || !payload.reminder_id) {
        throw new Error('delete requires --list and --reminder-id');
      }
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  const result = await remindersConnector.execute(action, payload);
  if (json) {
    printJson(result);
  } else {
    console.log(result.summary || `Reminders action ${action} completed.`);
    if (result.data !== undefined) {
      console.log(JSON.stringify(result.data, null, 2));
    }
  }

  return result;
}

run().catch(finishWithError);
