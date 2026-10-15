# __TITLE__

A widget for [cmd](https://github.com/janoelze/cmd): the terminals of this workspace, the busy ones first. Pin a command from a row's menu and it comes first in every window of the widget.

## Develop

```sh
cmd widget dev        # add it to the Widget Library, put it on the board, print its console
npm test              # or: cmd widget test
cmd widget check      # package.json, permissions and types
cmd widget preview . --themes all --sizes all
```

Saves reload the widget on the board. `src/__ID__.tsx` is the widget, `src/__ID__.test.tsx` its tests against a fake cmd, `src/__ID__.story.tsx` its states for previews.

## What it asks for

- `workspace: ["read"]`: the terminals of the workspace it's in.

Pinned commands are kept by cmd for the widget (`cmd.storage.package`), which needs no permission.
