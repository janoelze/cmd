Request: follow system errors live
Notes: `log stream` follows the log until it is stopped, which `cmd.run` won't run (it runs read-only commands that end), and it already does this well and interactively, so a terminal fits better than a widget.
