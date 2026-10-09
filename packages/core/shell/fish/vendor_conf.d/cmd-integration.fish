# cmd shell integration for fish (the zsh one is shell/zsh; same features but
# per-terminal history: fish keeps history per $fish_history name only, and a
# name per terminal would replace your usual history instead of adding to it).
#
# The core starts fish with this folder's parent first in XDG_DATA_DIRS, so fish
# sources this file from vendor_conf.d before your config.fish. We put
# XDG_DATA_DIRS back first, so what runs in the shell never sees it.
#
#  - OSC 7 and OSC 133 (prompt, command start, command end): fish 4 sends them
#    itself; for older fish we do.
#  - exec request: the command line, so a terminal brought back after a restart
#    can offer it again.
#  - the restored command goes on the first command line, as in zsh.
#  - open <path>: as in zsh (see _cmd_handles).
#
# Requests to cmd carry the pane's secret token, so text that merely gets
# printed (cat a file, curl output) can't trigger them.

if set -q CMD_FISH_INJECT
    set -e CMD_FISH_INJECT
    if set -q CMD_USER_XDG_DATA_DIRS
        set -gx XDG_DATA_DIRS $CMD_USER_XDG_DATA_DIRS
        set -e CMD_USER_XDG_DATA_DIRS
    else
        set -e XDG_DATA_DIRS
    end
end

# Only interactive shells inside cmd get the hooks, once.
status is-interactive; and set -q CMD_PANE_TOKEN; and not functions -q _cmd_request; or exit

function _cmd_osc
    printf '\e]%s\a' $argv[1] >/dev/tty
end

# Ask cmd to do something: OSC 777;cmd;<token>;<action>;<argument>
function _cmd_request
    _cmd_osc "777;cmd;$CMD_PANE_TOKEN;$argv[1];$argv[2]"
end

# The command line, so a terminal brought back after a restart can offer it again.
function _cmd_preexec --on-event fish_preexec
    _cmd_request exec (string replace -ra '[[:cntrl:]]' ' ' -- $argv[1])
end

if test (string match -r '^\d+' -- $version) -lt 4
    # (fish 3 itself sends OSC 7 only to some terminals.)
    function _cmd_report_cwd --on-event fish_prompt --on-variable PWD
        _cmd_osc "7;file://$hostname"(string escape --style=url -- $PWD)
    end
    function _cmd_mark_prompt --on-event fish_prompt
        _cmd_osc "133;A"
    end
    function _cmd_mark_start --on-event fish_preexec
        _cmd_osc "133;C"
    end
    function _cmd_mark_end --on-event fish_postexec
        _cmd_osc "133;D;$status"
    end
end

# A terminal brought back after a restart: what ran there goes on the first
# command line, to run again with Return (or not).
if set -q CMD_RESTORE_COMMAND
    set -g _cmd_restore_command $CMD_RESTORE_COMMAND
    set -e CMD_RESTORE_COMMAND
    function _cmd_restore --on-event fish_prompt
        functions -e _cmd_restore
        commandline -r -- $_cmd_restore_command
        set -e _cmd_restore_command
    end
end

# Would cmd open this itself? The rules come from cmd's settings and window type
# registry: CMD_OPEN_FOLDERS/FILES/URLS, CMD_OPEN_EXTS, CMD_OPEN_HANDLES_FOLDERS/TEXT,
# CMD_OPEN_PACKAGES.
# They start in the environment; cmd keeps $CMD_OPEN_RULES current as settings
# change (as NAME='value' lines), and `open` re-reads it on every call.
function _cmd_read_rules
    set -q CMD_OPEN_RULES; and test -r "$CMD_OPEN_RULES"; or return
    while read -l line
        set -l kv (string match -r "^(CMD_OPEN_\w+)='(.*)'\$" -- $line); or continue
        set -gx $kv[2] (string replace -a "'\\''" "'" -- $kv[3])
    end <$CMD_OPEN_RULES
end

function _cmd_handles
    set -l p $argv[1]
    if test -d $p
        # Foo.app: the system's
        set -l pkg (string lower -- (string match -r -g '\.([^./]+)/*$' -- $p))
        test -n "$pkg"; and contains -- $pkg (string split ' ' -- "$CMD_OPEN_PACKAGES"); and return 1
        test "$CMD_OPEN_FOLDERS" = 1 -a "$CMD_OPEN_HANDLES_FOLDERS" = 1
        return
    end
    test "$CMD_OPEN_FILES" = 1 -a -f $p; or return 1
    set -l name (string lower -- (string replace -r '.*/' '' -- $p))
    set -l ext (string replace -r '.*\.' '' -- $name) # no dot: the name (Makefile, Dockerfile)
    contains -- $ext (string split ' ' -- "$CMD_OPEN_EXTS"); and return 0
    test "$CMD_OPEN_HANDLES_TEXT" = 1; or return 1
    set -l size (wc -c <$p 2>/dev/null | string trim)
    test "$size" -le 10485760; or return 1
    test "$size" -eq 0; and return 0
    set -l mime (file -b --mime-type -- $p 2>/dev/null)
    string match -q -r '^(text/.*|application/(json|xml|javascript|x-ndjson))$' -- $mime
end

# Yours wins if your config defines an `open` function.
function open
    _cmd_read_rules
    if test (count $argv) -eq 1; and test -e "$argv[1]"; and _cmd_handles $argv[1]
        _cmd_request open (builtin realpath -- $argv[1])
    else if test (count $argv) -eq 1; and test "$CMD_OPEN_URLS" = 1; and string match -q -r '^https?://' -- $argv[1]
        _cmd_request open $argv[1]
    else
        command open $argv
    end
end
