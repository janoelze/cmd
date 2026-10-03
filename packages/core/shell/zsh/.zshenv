# cmd shell integration for zsh.
#
# The core starts zsh with ZDOTDIR pointing at this folder. Restore the user's
# ZDOTDIR first, so their .zprofile/.zshrc load as usual, then add our hooks.
# Same approach as Ghostty's and VS Code's shell integration.

if [[ -n "${CMD_USER_ZDOTDIR+x}" ]]; then
  ZDOTDIR="$CMD_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset CMD_USER_ZDOTDIR

[[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

# Only interactive shells inside cmd get the hooks.
if [[ -o interactive && -n "$CMD_PANE_TOKEN" ]]; then
  source "${${(%):-%x}:A:h}/cmd-integration.zsh"
fi
