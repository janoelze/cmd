import type { Pty, PtyFactory, SpawnOptions } from "../src/panes.ts";

export class FakePty implements Pty {
  static last: FakePty | null = null;
  pid = Math.floor(Math.random() * 90000) + 1000;
  process = "zsh";
  written: string[] = [];
  opts: SpawnOptions;
  #data: ((d: string) => void)[] = [];
  #exit: ((e: { exitCode: number }) => void)[] = [];

  constructor(opts: SpawnOptions) {
    this.opts = opts;
  }
  write(d: string) { this.written.push(d); }
  resize() {}
  kill() { this.exit(0); }
  onData(fn: (d: string) => void) { this.#data.push(fn); }
  onExit(fn: (e: { exitCode: number }) => void) { this.#exit.push(fn); }

  output(d: string) { for (const f of this.#data) f(d); }
  exit(code: number) { for (const f of this.#exit) f({ exitCode: code }); }
}

export function fakeFactory(): { factory: PtyFactory; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  return {
    ptys,
    factory: (o) => {
      const p = new FakePty(o);
      ptys.push(p);
      return p;
    },
  };
}
