#!/bin/bash
# Lets a Safehouse-sandboxed agent record the screen and post input, for cmd's
# scripted tours (packages/tours). Run it yourself, outside the sandbox, from
# the app your agents run in (cmd): macOS grants these permissions to that app.
#
#   safehouse-screen.sh check     the probe outside and inside the sandbox
#   safehouse-screen.sh learn     run the probe in the sandbox, turn its denials
#                                 into ~/.config/safehouse/screen.sb (repeats until
#                                 nothing new is denied); shows the profile
#   safehouse-screen.sh install   add an opt-in line to safe() in ~/.zshrc
#                                 (a backup is kept), then: SAFEHOUSE_SCREEN=1 claude
#   safehouse-screen.sh uninstall remove the line and the profile
#
# Opt-in per session on purpose: with this profile and cmd's Screen Recording
# and Accessibility grants, a sandboxed agent can see your screen and move your
# mouse. Sessions started without SAFEHOUSE_SCREEN=1 stay as they are.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
profile="${SAFEHOUSE_SCREEN_PROFILE:-$HOME/.config/safehouse/screen.sb}"
zshrc="${SAFEHOUSE_ZSHRC:-$HOME/.zshrc}"
marker="# cmd tours: screen recording and input, opt-in per session"
build="${TMPDIR:-/tmp}/cmd-tours-probe"
probe="$build/probe"

build_probe() {
  mkdir -p "$build"
  if [ ! -x "$probe" ] || [ "$here/../helper/probe.swift" -nt "$probe" ]; then
    echo "building the probe…"
    swiftc -O "$here/../helper/probe.swift" -o "$probe"
  fi
}

# The flags safe() passes that matter here, plus the profile being learned.
in_sandbox() {
  local -a extra=()
  [ -f "$HOME/.config/safehouse/browser-fix.sb" ] && extra+=(--append-profile="$HOME/.config/safehouse/browser-fix.sb")
  [ -f "$profile" ] && extra+=(--append-profile="$profile")
  safehouse --enable=electron,macos-gui "${extra[@]}" -- "$@"
}

check() {
  build_probe
  echo "== outside the sandbox (macOS permissions for this app)"
  "$probe" --request || {
    echo
    echo "Grant the app you're running this in (cmd) Screen Recording and Accessibility,"
    echo "then quit and reopen it. Opening the two settings panes…"
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" || true
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true
    return 1
  }
  echo
  echo "== inside the sandbox"
  in_sandbox "$probe" || { echo; echo "Blocked by the sandbox: run '$0 learn'."; return 1; }
}

# Sandbox denials for the probe since a time, as allow rules (mach and IOKit
# only; anything else is printed for you to look at, not allowed).
rules_since() {
  local since="$1"
  /usr/bin/log show --start "$since" --style compact \
    --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny(" AND eventMessage CONTAINS "probe"' 2>/dev/null |
    sed -nE 's/.*deny\([0-9]+\) ([a-z*-]+) (.*)$/\1 \2/p' | sort -u |
    while read -r op arg; do
      case "$op" in
        mach-lookup) echo "(allow mach-lookup (global-name \"$arg\"))" ;;
        mach-register) echo "(allow mach-register (global-name \"$arg\"))" ;;
        iokit-open | iokit-open-user-client) echo "(allow iokit-open (iokit-user-client-class \"$arg\"))" ;;
        user-preference-read) echo "(allow user-preference-read (preference-domain \"$arg\"))" ;;
        *) echo ";; not allowed automatically, look at it: $op $arg" ;;
      esac
    done
}

learn() {
  build_probe
  mkdir -p "$(dirname "$profile")"
  [ -f "$profile" ] || printf ';; Safehouse: screen recording and input for cmd tours (packages/tours/scripts/safehouse-screen.sh).\n;; Learned from the sandbox denials of a probe that records a frame and posts an event.\n' >"$profile"
  for round in 1 2 3 4 5 6; do
    local since
    since="$(date '+%Y-%m-%d %H:%M:%S')"
    sleep 1
    if in_sandbox "$probe" >/dev/null 2>&1; then
      echo "round $round: the probe passes in the sandbox"
      break
    fi
    sleep 2 # denials reach the log a moment later
    local new
    new="$(rules_since "$since" | while read -r line; do grep -qxF "$line" "$profile" || echo "$line"; done)"
    if [ -z "$new" ]; then
      echo "round $round: still failing, but nothing new was denied. Probably macOS permissions: run '$0 check'."
      break
    fi
    echo "round $round: adding"
    echo "$new" | sed 's/^/  /'
    echo "$new" >>"$profile"
  done
  echo
  echo "== $profile"
  cat "$profile"
  echo
  echo "Look it over, then: $0 install"
}

install() {
  [ -f "$profile" ] || { echo "No $profile yet: run '$0 learn' first."; exit 1; }
  if grep -qF "$marker" "$zshrc"; then
    echo "Already in $zshrc."
  else
    local anchor='safehouse --add-dirs="$rw" --add-dirs-ro="$ro" --enable="$features" "${extra[@]}" "$@"'
    grep -qF "$anchor" "$zshrc" || { echo "Couldn't find the safehouse line in safe() in $zshrc; add this yourself before it:"; echo "    $marker"; echo '    [ -n "$SAFEHOUSE_SCREEN" ] && [ -f ~/.config/safehouse/screen.sb ] && extra+=(--append-profile="$HOME/.config/safehouse/screen.sb")'; exit 1; }
    cp "$zshrc" "$zshrc.bak-$(date +%Y%m%d%H%M%S)"
    # Insert the two lines right before safe()'s safehouse call.
    awk -v anchor="$anchor" -v marker="$marker" '
      index($0, anchor) && !done {
        print "    " marker
        print "    [ -n \"$SAFEHOUSE_SCREEN\" ] && [ -f ~/.config/safehouse/screen.sb ] && extra+=(--append-profile=\"$HOME/.config/safehouse/screen.sb\")"
        done = 1
      }
      { print }
    ' "$zshrc" >"$zshrc.tmp" && mv "$zshrc.tmp" "$zshrc"
    echo "Added to safe() in $zshrc (backup next to it)."
  fi
  echo "Open a new shell, then start a session with it: SAFEHOUSE_SCREEN=1 claude"
}

uninstall() {
  if grep -qF "$marker" "$zshrc"; then
    cp "$zshrc" "$zshrc.bak-$(date +%Y%m%d%H%M%S)"
    awk -v marker="$marker" 'index($0, marker) { skip = 1; next } skip { skip = 0; next } { print }' "$zshrc" >"$zshrc.tmp" && mv "$zshrc.tmp" "$zshrc"
    echo "Removed from $zshrc (backup next to it)."
  fi
  rm -f "$profile" && echo "Removed $profile."
  echo "cmd keeps its Screen Recording and Accessibility grants; remove them in System Settings if you like."
}

case "${1:-}" in
  check) check ;;
  learn) learn ;;
  install) install ;;
  uninstall) uninstall ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
