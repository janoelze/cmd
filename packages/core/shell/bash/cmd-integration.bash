# cmd shell integration for bash (the zsh one is shell/zsh; same features).
#
# bash has no ZDOTDIR, so the core starts it one of two ways and this file then
# loads the user's startup files as bash would have, before adding the hooks
# (Ghostty's and Kitty's approach):
#  - bash --posix [-l], with ENV pointing here (CMD_BASH_INJECT=posix): a POSIX
#    mode interactive shell reads only $ENV. We turn POSIX mode off again.
#  - bash --rcfile <this file> (CMD_BASH_INJECT=rcfile, "rcfile login" for a
#    login shell): Apple's /bin/bash 3.2 ignores ENV. --rcfile only works for
#    non-login shells, so a login shell is emulated (profile files are read, but
#    `shopt login_shell` is off and `logout` doesn't work; use exit).
#
# Hooks:
#  - OSC 7: the working directory, at every prompt.
#  - OSC 133: prompt (A), command start (C), command end (D;exit).
#  - exec request: the command line, so a terminal brought back after a restart
#    can offer it again. bash ≥ 4.4 runs it from PS0; older bash from a DEBUG
#    trap (skipped if you have your own DEBUG trap; bash-preexec is used if loaded).
#  - per-terminal history ($CMD_PANE_HISTFILE), as in zsh.
#  - the restored command goes into history (Up gets it): unlike zsh's `print -z`,
#    bash can't put text on the next command line.
#  - open <path>: as in zsh (see _cmd_handles).
#
# Requests to cmd carry the pane's secret token, so text that merely gets
# printed (cat a file, curl output) can't trigger them.

[[ $- == *i* ]] || builtin return 0

if [[ -n $CMD_BASH_INJECT ]]; then
  _cmd_inject=$CMD_BASH_INJECT
  builtin unset CMD_BASH_INJECT ENV
  if [[ -n ${CMD_USER_ENV+x} ]]; then
    builtin export ENV=$CMD_USER_ENV
    builtin unset CMD_USER_ENV
  fi
  if [[ $_cmd_inject == posix ]]; then
    builtin set +o posix
    builtin shopt -u inherit_errexit 2>/dev/null
    # POSIX mode would have used ~/.sh_history; the core set ~/.bash_history.
    if [[ -n $CMD_BASH_UNEXPORT_HISTFILE ]]; then
      builtin export -n HISTFILE
      builtin unset CMD_BASH_UNEXPORT_HISTFILE
    fi
  fi
  # The startup files, as in INVOCATION in bash(1).
  if [[ $_cmd_inject == "rcfile login" ]] || builtin shopt -q login_shell; then
    [[ -r /etc/profile ]] && builtin source /etc/profile
    for _cmd_rc in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      [[ -r $_cmd_rc ]] && { builtin source "$_cmd_rc"; break; }
    done
  else
    # The system bashrc is a build option of bash (Debian, Arch: /etc/bash.bashrc).
    if [[ $_cmd_inject == posix ]]; then
      for _cmd_rc in /etc/bash.bashrc /etc/bash/bashrc /etc/bashrc; do
        [[ -r $_cmd_rc ]] && { builtin source "$_cmd_rc"; break; }
      done
    fi
    [[ -r $HOME/.bashrc ]] && builtin source "$HOME/.bashrc"
  fi
  builtin unset _cmd_inject _cmd_rc
fi

# Only shells inside cmd get the hooks, once.
[[ -n $CMD_PANE_TOKEN ]] && ! builtin declare -F _cmd_precmd >/dev/null || builtin return 0

_cmd_osc() { builtin printf '\e]%s\a' "$1" >/dev/tty; }

# Ask cmd to do something: OSC 777;cmd;<token>;<action>;<argument>
_cmd_request() { _cmd_osc "777;cmd;${CMD_PANE_TOKEN};$1;$2"; }

_cmd_report_cwd() {
  local p=${PWD//%/%25}
  p=${p// /%20}; p=${p//#/%23}; p=${p//\?/%3F}
  _cmd_osc "7;file://${HOSTNAME}${p}"
}

# The newest history entry: its number (_cmd_hnum) and text (_cmd_hline).
_cmd_last_hist() {
  local l
  l=$(HISTTIMEFORMAT= builtin history 1)
  l=${l#"${l%%[! ]*}"}
  _cmd_hnum=${l%%[ *]*}
  _cmd_hline=${l#*[0-9][* ] }
}

# The history number at the prompt: a command that doesn't change it wasn't
# recorded (ignorespace, history off), so it isn't reported or saved either.
_cmd_prompt_hnum=
_cmd_started=

_cmd_preexec() {
  _cmd_osc "133;C"
  _cmd_last_hist
  [[ -n $_cmd_hnum && $_cmd_hnum != "$_cmd_prompt_hnum" ]] && _cmd_request exec "${_cmd_hline//[[:cntrl:]]/ }"
}

_cmd_precmd() {
  local ret=${_cmd_status:-$?}
  _cmd_status=
  _cmd_osc "133;D;$ret"
  _cmd_last_hist
  if [[ -z $_cmd_started ]]; then
    _cmd_started=1
    _cmd_first_prompt
  elif [[ -n $CMD_PANE_HISTFILE && -n $_cmd_hnum && $_cmd_hnum != "$_cmd_prompt_hnum" ]]; then
    builtin printf '%s\n' "$_cmd_hline" >>"$CMD_PANE_HISTFILE"
  fi
  _cmd_prompt_hnum=$_cmd_hnum
  _cmd_report_cwd
  _cmd_osc "133;A"
  _cmd_at_prompt=1
}
_cmd_ret() { builtin return "$1"; }

# Once, after your config: what this terminal ran before a restart goes into
# history, and the command that was running on top, so Up gets it.
_cmd_restore_command=$CMD_RESTORE_COMMAND
builtin unset CMD_RESTORE_COMMAND
_cmd_first_prompt() {
  if [[ -n $CMD_PANE_HISTFILE && -s $CMD_PANE_HISTFILE ]]; then
    if (( $(wc -l <"$CMD_PANE_HISTFILE") > 1000 )); then
      tail -n 1000 "$CMD_PANE_HISTFILE" >"$CMD_PANE_HISTFILE.tmp" && command mv -f "$CMD_PANE_HISTFILE.tmp" "$CMD_PANE_HISTFILE"
    fi
    builtin history -r "$CMD_PANE_HISTFILE"
  fi
  [[ -n $_cmd_restore_command ]] && builtin history -s -- "$_cmd_restore_command"
  builtin unset _cmd_restore_command
  _cmd_last_hist
}

# Run first in PROMPT_COMMAND (to see the command's status) and last (so nothing
# of yours runs between the prompt and the DEBUG trap below). Errors are
# silenced for subshells that inherit an exported PROMPT_COMMAND but not these.
if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND=('_cmd_status=$?; _cmd_ret "$_cmd_status" 2>/dev/null' "${PROMPT_COMMAND[@]}" '_cmd_precmd 2>/dev/null')
else
  PROMPT_COMMAND='_cmd_status=$?; _cmd_ret "$_cmd_status" 2>/dev/null'$'\n'"${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}"'_cmd_precmd 2>/dev/null'
fi

if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0=${PS0}'$(_cmd_preexec)'
elif builtin declare -p preexec_functions >/dev/null 2>&1; then
  preexec_functions+=(_cmd_preexec)
elif [[ -z $(builtin trap -p DEBUG) ]]; then
  # The first command after the prompt, unless it is PROMPT_COMMAND's (an empty line).
  _cmd_debug() {
    [[ -n $_cmd_at_prompt && -z $COMP_LINE ]] || return 0
    _cmd_at_prompt=
    [[ $BASH_COMMAND == _cmd_status=* ]] || _cmd_preexec
  }
  builtin trap '_cmd_debug' DEBUG
fi

# Would cmd open this itself? The rules come from cmd's settings and window type
# registry: CMD_OPEN_FOLDERS/FILES/URLS, CMD_OPEN_EXTS, CMD_OPEN_HANDLES_FOLDERS/TEXT,
# CMD_OPEN_PACKAGES.
# They start in the environment; cmd keeps $CMD_OPEN_RULES current as settings
# change, and `open` re-reads it on every call.
_cmd_handles() {
  local p=$1 name ext size mime
  if [[ -d $p ]]; then
    name=${p%/}; name=${name##*/}
    [[ $name == *.* ]] && ext=$(builtin printf '%s' "${name##*.}" | tr '[:upper:]' '[:lower:]')
    [[ -n $ext && " $CMD_OPEN_PACKAGES " == *" $ext "* ]] && return 1   # Foo.app: the system's
    [[ $CMD_OPEN_FOLDERS == 1 && $CMD_OPEN_HANDLES_FOLDERS == 1 ]]; return
  fi
  [[ $CMD_OPEN_FILES == 1 && -f $p ]] || return 1
  name=$(builtin printf '%s' "${p##*/}" | tr '[:upper:]' '[:lower:]')
  ext=${name##*.}   # no dot: the name (Makefile, Dockerfile)
  [[ " $CMD_OPEN_EXTS " == *" $ext "* ]] && return 0
  [[ $CMD_OPEN_HANDLES_TEXT == 1 ]] || return 1
  size=$(wc -c <"$p" 2>/dev/null)
  size=${size//[!0-9]/}
  (( ${size:-0} <= 10485760 )) || return 1
  (( ${size:-0} == 0 )) && return 0
  mime=$(file -b --mime-type -- "$p" 2>/dev/null)
  [[ $mime == text/* || $mime == application/json || $mime == application/xml || $mime == application/javascript || $mime == application/x-ndjson ]]
}

# Absolute path, symlinked folders resolved.
_cmd_abs() {
  if [[ -d $1 ]]; then
    (CDPATH= builtin cd -P -- "$1" && builtin pwd -P)
  else
    local dir
    dir=$(CDPATH= builtin cd -P -- "$(dirname -- "$1")" && builtin pwd -P) || return
    builtin printf '%s/%s\n' "${dir%/}" "${1##*/}"
  fi
}

# Yours wins if your config already has an `open`.
if [[ -z $(builtin type -t open) || $(builtin type -t open) == file ]]; then
  function open {
    [[ -n $CMD_OPEN_RULES && -r $CMD_OPEN_RULES ]] && builtin source "$CMD_OPEN_RULES"
    if (( $# == 1 )) && [[ -e $1 ]] && _cmd_handles "$1"; then
      _cmd_request open "$(_cmd_abs "$1")"
    elif (( $# == 1 )) && [[ $CMD_OPEN_URLS == 1 && ( $1 == http://* || $1 == https://* ) ]]; then
      _cmd_request open "$1"
    else
      command open "$@"
    fi
  }
fi
