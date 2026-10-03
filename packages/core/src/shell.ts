// Shell quoting for commands typed into the user's shell.

/** Shell-quote for zsh/bash. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `K='v' ` assignments to put in front of a command; "" for none. */
export function envPrefix(env: Record<string, string> | null | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${shq(v)} `)
    .join("");
}
