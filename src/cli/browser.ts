import { spawn } from 'node:child_process';

/** Opens a URL in the person's browser. Rejects when it cannot, and the caller prints the URL instead. */
export type Opener = (url: string) => Promise<void>;

/** True on a remote shell with no display, where a browser cannot open on this machine. */
export function headless(env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  return remote && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

function launch(command: string, args: string[], options: { verbatim?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: options.verbatim === true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    } catch (error) { reject(error); }
  });
}

/** macOS `open`, Linux `xdg-open`, Windows `start` through cmd. $BROWSER wins when set. */
export function systemOpener(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Opener {
  return async url => {
    if (headless(env, platform)) throw new Error('no display');
    if (env.BROWSER && !/\s/.test(env.BROWSER)) return launch(env.BROWSER, [url]);
    if (platform === 'darwin') return launch('open', [url]);
    if (platform === 'win32') {
      // The URL is quoted so cmd does not treat & as a command separator. The empty first quotes are start's window title.
      if (url.includes('"')) throw new Error('unsafe URL');
      return launch('cmd.exe', ['/c', 'start', '""', `"${url}"`], { verbatim: true });
    }
    return launch('xdg-open', [url]);
  };
}
