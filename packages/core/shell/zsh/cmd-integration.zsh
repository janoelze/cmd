# cmd shell integration hooks (sourced from .zshenv for interactive shells).
#
#  - OSC 7: report the working directory on every prompt, so cmd knows where
#    each terminal is (titles, "New Terminal" in the same folder, …).
#  - OSC 133: mark prompt and command boundaries.
#  - open <folder>: opens a cmd file window instead of Finder. Everything else
#    (files, apps, flags, several arguments) goes to /usr/bin/open.
#    `command open .` always uses Finder.
#
# Requests to cmd carry the pane's secret token, so text that merely gets
# printed (cat a file, curl output) can't trigger them.

_cmd_osc() { printf '\e]%s\a' "$1" > /dev/tty }

_cmd_report_cwd() {
  local url_path=${PWD// /%20}
  _cmd_osc "7;file://${HOST}${url_path}"
}

_cmd_precmd() {
  local ret=$?
  _cmd_osc "133;D;$ret"
  _cmd_report_cwd
  _cmd_osc "133;A"
}

_cmd_preexec() { _cmd_osc "133;C" }

autoload -Uz add-zsh-hook
add-zsh-hook precmd _cmd_precmd
add-zsh-hook preexec _cmd_preexec
add-zsh-hook chpwd _cmd_report_cwd
_cmd_report_cwd

# Ask cmd to do something: OSC 777;cmd;<token>;<action>;<argument>
_cmd_request() { _cmd_osc "777;cmd;${CMD_PANE_TOKEN};$1;$2" }

if [[ "$CMD_OPEN_FOLDERS" == 1 ]]; then
  open() {
    if (( $# == 1 )) && [[ -d "$1" ]]; then
      _cmd_request open "${1:A}"
    elif (( $# == 1 )) && [[ "$CMD_OPEN_URLS" == 1 && ( "$1" == http://* || "$1" == https://* ) ]]; then
      _cmd_request open "$1"
    else
      command open "$@"
    fi
  }
fi
