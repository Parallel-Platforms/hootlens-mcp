/*
 * The @hootlens/mcp package entry (bin: hootlens-mcp).
 *   hootlens-mcp [--project id] [--toolsets list]   run the MCP server on stdio
 *   hootlens-mcp login | logout | whoami            manage the saved sign-in
 *   hootlens-mcp --help | --version
 */
import { isCommand, runCommand } from './cli/commands.js';
import { runServer } from './serve.js';
import { storedCredential } from './stored.js';

const argv = process.argv.slice(2);
const [command, ...rest] = argv;
if (isCommand(command)) {
  process.exitCode = await runCommand(command, rest, {
    env: process.env,
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
  });
} else {
  await runServer(argv, process.env, storedCredential);
}
