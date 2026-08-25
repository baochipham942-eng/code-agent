import { createTmeetCliDriver } from '../../../connectors/tmeet/tmeetCli';

const tmeetToolDriver = createTmeetCliDriver();

export async function executeTmeetCommand(args: string[], label: string): Promise<string> {
  const result = await tmeetToolDriver.execute(args, label);
  return result.stdout.trim();
}
