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

# Would cmd open this itself? Mirrors packages/core/src/routing.ts.
_cmd_handles() {
  local p=$1
  if [[ -d $p ]]; then [[ "$CMD_OPEN_FOLDERS" == 1 ]]; return; fi
  [[ "$CMD_OPEN_FILES" == 1 && -f $p ]] || return 1
  case "${p:l}" in
    *.html|*.htm|*.xhtml|*.svg|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.avif|*.bmp|*.ico|*.pdf) return 0 ;;
  esac
  local size=$(wc -c < "$p" 2>/dev/null)
  (( ${size:-0} <= 10485760 )) || return 1
  (( ${size:-0} == 0 )) && return 0
  local mime=$(file -b --mime-type -- "$p" 2>/dev/null)
  [[ $mime == text/* || $mime == application/json || $mime == application/xml || $mime == application/javascript || $mime == application/x-ndjson ]]
}

if [[ "$CMD_OPEN_FOLDERS" == 1 || "$CMD_OPEN_FILES" == 1 ]]; then
  open() {
    if (( $# == 1 )) && [[ -e "$1" ]] && _cmd_handles "$1"; then
      _cmd_request open "${1:A}"
    elif (( $# == 1 )) && [[ "$CMD_OPEN_URLS" == 1 && ( "$1" == http://* || "$1" == https://* ) ]]; then
      _cmd_request open "$1"
    else
      command open "$@"
    fi
  }
fi
