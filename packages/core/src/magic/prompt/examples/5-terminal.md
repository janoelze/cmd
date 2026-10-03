Request: follow system errors live
Notes: `log stream` already does this well and interactively; a terminal fits better than a widget.

{"kind":"terminal","title":"System errors","command":"log stream --predicate 'messageType == error' --style compact"}
