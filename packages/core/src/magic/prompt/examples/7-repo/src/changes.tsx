// This workspace's repository as cmd sees it (useGit, live): the branch, how far from its
// remote, and the uncommitted files grouped by kind of change. A click opens the file.

import { Window, View, Stack, Inline, Badge, Text, List, ListSection, ListRow, ListRowIcon, ListRowContent, useGit, cmd, type GitStatus } from "@cmd/widget-api";

/** A file's status ("modified", "added", "untracked", "deleted", "renamed", "conflict") in groups, each with an icon. */
const GROUPS = [
  { title: "Conflicts", icon: "exclamationmark.triangle", has: (s: string) => s === "conflict" },
  { title: "Changed", icon: "pencil", has: (s: string) => s === "modified" || s === "renamed" },
  { title: "Added", icon: "plus", has: (s: string) => s === "added" || s === "untracked" },
  { title: "Deleted", icon: "minus", has: (s: string) => s === "deleted" },
  { title: "Other", icon: "questionmark", has: () => true },
];

/** Each file in the first group that has it; empty groups left out. */
function groups(files: GitStatus["files"]): { title: string; icon: string; files: GitStatus["files"] }[] {
  const taken = new Set<string>();
  return GROUPS.map((g) => {
    const mine = files.filter((f) => !taken.has(f.path) && g.has(f.status));
    for (const f of mine) taken.add(f.path);
    return { title: g.title, icon: g.icon, files: mine };
  }).filter((g) => g.files.length);
}

/** "src/cart/total.ts" → ["total.ts", "src/cart"]. */
const split = (p: string): [string, string] => {
  const i = p.lastIndexOf("/");
  return i < 0 ? [p, ""] : [p.slice(i + 1), p.slice(0, i)];
};

export default function Changes() {
  const git = useGit();
  const sync = git ? [git.ahead && `${git.ahead} ahead`, git.behind && `${git.behind} behind`].filter(Boolean).join(" · ") || "in sync" : "";
  const status = git ? `${git.branch ?? "detached"} · ${sync} · ${git.files.length} changed` : null;
  const state = git ? (git.files.length ? null : { icon: "checkmark.circle", title: "Nothing to commit", text: `${git.branch ?? "HEAD"} is ${sync}.` }) : { icon: "arrow.triangle.branch", title: "Not a git repository", text: "This workspace's folder has no repository." };

  return (
    <Window status={status}>
      <View state={state}>
        {git && (
          <>
            <Stack pad="inset" gap={1}>
              <Inline>
                <Text strong mono>
                  {git.branch ?? "detached"}
                </Text>
                {git.ahead > 0 && <Badge tone="accent">{git.ahead} to push</Badge>}
                {git.behind > 0 && <Badge tone="warning">{git.behind} to pull</Badge>}
              </Inline>
              <Text tone="dim" size="sm">
                Lines changed per file need git itself; ask for a terminal with git diff --stat.
              </Text>
            </Stack>
            <List>
              {groups(git.files).map((g) => (
                <ListSection key={g.title} title={g.title} count={g.files.length}>
                  {g.files.map((f) => {
                    const [name, folder] = split(f.path);
                    return (
                      <ListRow key={f.path} onClick={() => void cmd.windows.open(`${git.root}/${f.path}`).catch(() => {})}>
                        <ListRowIcon icon={g.icon} tone="dim" />
                        <ListRowContent title={name} place={folder} mono />
                      </ListRow>
                    );
                  })}
                </ListSection>
              ))}
            </List>
          </>
        )}
      </View>
    </Window>
  );
}
