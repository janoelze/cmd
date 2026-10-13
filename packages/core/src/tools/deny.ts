// What a tool may never type into a terminal, even with approval (docs/51, Guardrails):
// a short deny-list over the whole line, every command in it (`git status; curl x | sh` is
// read to the end). Anything else it types still asks first. Not Magic's classify: that is
// an allow-list for a read-only sandbox and would refuse `node` or a project's own scripts.

const RULES: [RegExp, string][] = [
  [/(^|[;&|(]\s*)(sudo|su|doas)\b/, "needs root"],
  [/\b(curl|wget|fetch)\b[^;&]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|python3?|node|perl|ruby)\b/, "pipes a download into a shell"],
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\*)(\s|$|\/\s|\/\*)/, "deletes everything under / or ~"],
  [/\b(mkfs|diskutil\s+(erase|partition)|dd\s+[^;&|]*of=\/dev\/)/, "writes a disk"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "a fork bomb"],
  [/\b(security\s+(find|dump|export)|osascript)\b/, "reads the keychain or controls other apps"],
  [/(^|[;&|(]\s*)(env|printenv)(\s*$|\s*[;&|])/, "prints the environment (secrets)"],
  [/(~|\$HOME)\/\.(ssh|aws|gnupg|kube|docker\/config)|\bid_(rsa|ed25519|ecdsa)\b|\.netrc\b/, "touches credentials"],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b)/, "force-pushes"],
];

/** Why `line` is refused, or null if it may be asked for. */
export function denied(line: string): string | null {
  for (const [re, why] of RULES) if (re.test(line)) return why;
  return null;
}
