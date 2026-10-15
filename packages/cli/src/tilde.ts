// A path as a person reads it: the home folder as ~ (the CLI's messages). Light on purpose:
// main.ts loads it for every `cmd`, a hook's included.

export const tilde = (p: string): string => {
  const home = process.env.HOME;
  return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
};
