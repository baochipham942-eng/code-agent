import { mailConnector } from '../../src/main/connectors/native/mail.ts';
import {
  finishWithError,
  getNumberOption,
  getStringArrayOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
} from './_helpers.ts';

function usage(): void {
  console.log(`Mail smoke

Usage:
  npm run acceptance:mail -- <command> [options]

Commands:
  status
  accounts
  mailboxes [--account <name>]
  messages --mailbox <name> [--account <name>] [--query <text>] [--limit <n>]
  read --mailbox <name> --message-id <id> [--account <name>]
  draft --subject <text> --to <a@x.com,b@y.com> [--cc ...] [--bcc ...] [--content <text>] [--attachments <path1,path2>]
  send --subject <text> --to <a@x.com,b@y.com> [--cc ...] [--bcc ...] [--content <text>] [--attachments <path1,path2>]

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
    case 'accounts':
      action = 'list_accounts';
      break;
    case 'mailboxes':
      action = 'list_mailboxes';
      payload = {
        account: getStringOption(args, 'account'),
      };
      break;
    case 'messages':
      action = 'list_messages';
      payload = {
        account: getStringOption(args, 'account'),
        mailbox: getStringOption(args, 'mailbox'),
        query: getStringOption(args, 'query'),
        limit: getNumberOption(args, 'limit'),
      };
      if (!payload.mailbox) throw new Error('messages requires --mailbox');
      break;
    case 'read':
      action = 'read_message';
      payload = {
        account: getStringOption(args, 'account'),
        mailbox: getStringOption(args, 'mailbox'),
        message_id: getNumberOption(args, 'message-id'),
      };
      if (!payload.mailbox || !payload.message_id) throw new Error('read requires --mailbox and --message-id');
      break;
    case 'draft':
      action = 'draft_message';
      payload = {
        subject: getStringOption(args, 'subject'),
        to: getStringArrayOption(args, 'to'),
        cc: getStringArrayOption(args, 'cc'),
        bcc: getStringArrayOption(args, 'bcc'),
        content: getStringOption(args, 'content') ?? '',
        attachments: getStringArrayOption(args, 'attachments'),
      };
      if (!payload.subject || (payload.to as string[]).length === 0) {
        throw new Error('draft requires --subject and --to');
      }
      break;
    case 'send':
      action = 'send_message';
      payload = {
        subject: getStringOption(args, 'subject'),
        to: getStringArrayOption(args, 'to'),
        cc: getStringArrayOption(args, 'cc'),
        bcc: getStringArrayOption(args, 'bcc'),
        content: getStringOption(args, 'content') ?? '',
        attachments: getStringArrayOption(args, 'attachments'),
      };
      if (!payload.subject || (payload.to as string[]).length === 0) {
        throw new Error('send requires --subject and --to');
      }
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  const result = await mailConnector.execute(action, payload);
  if (json) {
    printJson(result);
  } else {
    console.log(result.summary || `Mail action ${action} completed.`);
    if (result.data !== undefined) {
      console.log(JSON.stringify(result.data, null, 2));
    }
  }

  return result;
}

run().catch(finishWithError);
