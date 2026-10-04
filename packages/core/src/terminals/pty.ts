// node-pty behind the slice of its API the terminals use, so tests can inject a fake.

/** The slice of node-pty we use. */
export interface Pty {
  readonly pid: number;
  /** Foreground process name. */
  readonly process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(fn: (data: string) => void): void;
  onExit(fn: (e: { exitCode: number }) => void): void;
}

export interface SpawnOptions {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyFactory = (opts: SpawnOptions) => Pty;

const isWindows = process.platform === "win32";

export async function nodePtyFactory(): Promise<PtyFactory> {
  const pty = await import("node-pty");
  return (o) => {
    const p = pty.spawn(o.shell, o.args, {
      name: "xterm-256color",
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: o.env,
    });
    return {
      get pid() {
        return p.pid;
      },
      // On Windows node-pty reports the terminal type ("xterm-256color") here, not
      // a program; until a Windows procinfo helper exists, report the shell.
      get process() {
        return isWindows ? o.shell : p.process;
      },
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      // Windows has no signals; node-pty throws if one is passed there.
      kill: (s) => (isWindows ? p.kill() : p.kill(s)),
      onData: (fn) => void p.onData(fn),
      onExit: (fn) => void p.onExit(fn),
    };
  };
}
