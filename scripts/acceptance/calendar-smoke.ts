import { calendarConnector } from '../../src/main/connectors/native/calendar.ts';
import {
  finishWithError,
  getNumberOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
} from './_helpers.ts';

function usage(): void {
  console.log(`Calendar smoke

Usage:
  npm run acceptance:calendar -- <command> [options]

Commands:
  status
  calendars
  events [--calendar <name>] [--from-ms <ts>] [--to-ms <ts>] [--limit <n>]
  create --calendar <name> --title <text> --start-ms <ts> [--end-ms <ts>] [--location <text>]
  update --calendar <name> --event-uid <uid> [--title <text>] [--start-ms <ts>] [--end-ms <ts>] [--location <text>]
  delete --calendar <name> --event-uid <uid>

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
    case 'calendars':
      action = 'list_calendars';
      break;
    case 'events':
      action = 'list_events';
      payload = {
        calendar: getStringOption(args, 'calendar'),
        from_ms: getNumberOption(args, 'from-ms'),
        to_ms: getNumberOption(args, 'to-ms'),
        limit: getNumberOption(args, 'limit'),
      };
      break;
    case 'create':
      action = 'create_event';
      payload = {
        calendar: getStringOption(args, 'calendar'),
        title: getStringOption(args, 'title'),
        start_ms: getNumberOption(args, 'start-ms'),
        end_ms: getNumberOption(args, 'end-ms'),
        location: getStringOption(args, 'location'),
      };
      if (!payload.calendar || !payload.title || !payload.start_ms) {
        throw new Error('create requires --calendar, --title, --start-ms');
      }
      break;
    case 'update':
      action = 'update_event';
      payload = {
        calendar: getStringOption(args, 'calendar'),
        event_uid: getStringOption(args, 'event-uid'),
        title: getStringOption(args, 'title'),
        start_ms: getNumberOption(args, 'start-ms'),
        end_ms: getNumberOption(args, 'end-ms'),
        location: getStringOption(args, 'location'),
      };
      if (!payload.calendar || !payload.event_uid) {
        throw new Error('update requires --calendar and --event-uid');
      }
      break;
    case 'delete':
      action = 'delete_event';
      payload = {
        calendar: getStringOption(args, 'calendar'),
        event_uid: getStringOption(args, 'event-uid'),
      };
      if (!payload.calendar || !payload.event_uid) {
        throw new Error('delete requires --calendar and --event-uid');
      }
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  const result = await calendarConnector.execute(action, payload);
  if (json) {
    printJson(result);
  } else {
    console.log(result.summary || `Calendar action ${action} completed.`);
    if (result.data !== undefined) {
      console.log(JSON.stringify(result.data, null, 2));
    }
  }

  return result;
}

run().catch(finishWithError);
