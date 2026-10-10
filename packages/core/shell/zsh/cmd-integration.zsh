# cmd shell integration hooks (sourced from .zshenv for interactive shells).
#
#  - OSC 7: report the working directory on every prompt, so cmd knows where
#    each terminal is (titles, "New Terminal" in the same folder, …).
#  - OSC 133: mark prompt and command boundaries.
#  - open <path>: folders open in a cmd file window, text files in a text
#    window, html/images/pdf in a browser window. Everything else (other files,
#    apps, flags, several arguments) goes to /usr/bin/open.
#    `command open .` always uses Finder.
#
# Requests to cmd carry the pane's secret token, so text that merely gets
# printed (cat a file, curl output) can't trigger them.

_cmd_osc() { printf '\e]%s\a' "$1" > /dev/tty }

# Every byte but RFC 3986's unreserved ones and / percent-encoded (#, ?, %, spaces, UTF-8).
_cmd_report_cwd() {
  emulate -L zsh -o extendedglob
  local LC_ALL=C MATCH MBEGIN MEND
  _cmd_osc "7;file://${HOST}${PWD//(#m)[^A-Za-z0-9\/._~-]/%${(l:2::0:)$(( [##16] #MATCH ))}}"
}

_cmd_precmd() {
  local ret=$?
  _cmd_osc "133;D;$ret"
  _cmd_report_cwd
  _cmd_osc "133;A"
}

# The command line, so a terminal brought back after a restart can offer it again.
_cmd_preexec() {
  _cmd_osc "133;C"
  _cmd_request exec "${1//[[:cntrl:]]/ }"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _cmd_precmd
add-zsh-hook preexec _cmd_preexec
add-zsh-hook chpwd _cmd_report_cwd
_cmd_report_cwd

# Ask cmd to do something: OSC 777;cmd;<token>;<action>;<argument>
_cmd_request() { _cmd_osc "777;cmd;${CMD_PANE_TOKEN};$1;$2" }

# Each terminal also keeps its own history ($CMD_PANE_HISTFILE), next to your
# usual one (left as you configured it). A terminal brought back after a restart
# loads it at its first prompt, after your config, so Up gives what ran there.
# zsh writes the file itself, through a pushed history list saved when popped
# (its format encodes some bytes, so appending by hand would corrupt them); not
# from zshaddhistory, where adding to history is ignored, but at the next prompt.
if [[ -n $CMD_PANE_HISTFILE ]]; then
  _cmd_hist_line=
  _cmd_hist_add() {
    local line=${1%%$'\n'}
    [[ -o histignorespace && $line == ' '* ]] || _cmd_hist_line=$line
    return 0
  }
  _cmd_hist_save() {
    [[ -n $_cmd_hist_line ]] || return 0
    fc -p -a -- "$CMD_PANE_HISTFILE" 1000 1000
    print -sr -- "$_cmd_hist_line"
    _cmd_hist_line=
  }
  add-zsh-hook zshaddhistory _cmd_hist_add
  add-zsh-hook precmd _cmd_hist_save
  if [[ -s $CMD_PANE_HISTFILE ]]; then
    _cmd_hist_load() {
      add-zsh-hook -d precmd _cmd_hist_load
      fc -R -- "$CMD_PANE_HISTFILE"
    }
    add-zsh-hook precmd _cmd_hist_load
  fi
fi

# A terminal brought back after a restart: what ran there goes on the first
# command line, to run again with Return (or not).
if [[ -n $CMD_RESTORE_COMMAND ]]; then
  _cmd_restore_command=$CMD_RESTORE_COMMAND
  unset CMD_RESTORE_COMMAND
  _cmd_restore() {
    add-zsh-hook -d precmd _cmd_restore
    print -z -- "$_cmd_restore_command"
    unset _cmd_restore_command
  }
  add-zsh-hook precmd _cmd_restore
fi

# Would cmd open this itself? The rules come from cmd's settings and window type
# registry: CMD_OPEN_FOLDERS/FILES/URLS, CMD_OPEN_EXTS, CMD_OPEN_HANDLES_FOLDERS/TEXT,
# CMD_OPEN_PACKAGES.
# They start in the environment; cmd keeps $CMD_OPEN_RULES current as settings
# change, and `open` re-reads it on every call.
_cmd_handles() {
  local p=$1
  if [[ -d $p ]]; then
    local pkg=${${p%/}:e:l}
    [[ -n $pkg && " $CMD_OPEN_PACKAGES " == *" $pkg "* ]] && return 1   # Foo.app: the system's
    [[ "$CMD_OPEN_FOLDERS" == 1 && "$CMD_OPEN_HANDLES_FOLDERS" == 1 ]]; return
  fi
  [[ "$CMD_OPEN_FILES" == 1 && -f $p ]] || return 1
  local name=${${p:t}:l}
  local ext=${name:e}
  [[ -z $ext ]] && ext=$name   # Makefile, Dockerfile
  [[ " $CMD_OPEN_EXTS " == *" $ext "* ]] && return 0
  [[ "$CMD_OPEN_HANDLES_TEXT" == 1 ]] || return 1
  local size=$(wc -c < "$p" 2>/dev/null)
  (( ${size:-0} <= 10485760 )) || return 1
  (( ${size:-0} == 0 )) && return 0
  local mime=$(file -b --mime-type -- "$p" 2>/dev/null)
  [[ $mime == text/* || $mime == application/json || $mime == application/xml || $mime == application/javascript || $mime == application/x-ndjson ]]
}

open() {
  [[ -n $CMD_OPEN_RULES && -r $CMD_OPEN_RULES ]] && source "$CMD_OPEN_RULES"
  if (( $# == 1 )) && [[ -e "$1" ]] && _cmd_handles "$1"; then
    _cmd_request open "${1:A}"
  elif (( $# == 1 )) && [[ "$CMD_OPEN_URLS" == 1 && ( "$1" == http://* || "$1" == https://* ) ]]; then
    _cmd_request open "$1"
  else
    command open "$@"
  fi
}
