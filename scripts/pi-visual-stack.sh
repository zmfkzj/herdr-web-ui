#!/usr/bin/env bash
# Starts guacd and the web UI server (desktop gateway enabled) together in the background, and
# checks or stops the pair. See docs/pi-visual-tools.md, "Start guacd and the server together".
#
#   scripts/pi-visual-stack.sh [start|status|stop|restart|logs]   (default: start)
#
# Each process runs in a session of its own (setsid) with its output in a log file, so both keep
# running after the shell that started them exits. The launcher remembers what it started as a
# pid plus the kernel's start time of that pid, and stop signals only those sessions: a guacd or
# server started by hand, on the same port or not, is never touched. Nothing here installs,
# builds or needs root.
set -u -o pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
GUACD_BIN=${HERDR_STACK_GUACD_BIN:-/opt/herdr-guacd/sbin/guacd}
# The server's desktop gateway always dials 127.0.0.1:4822 (server/pi-visual/service.ts), so
# guacd binds loopback only; the port override exists for isolated tests.
GUACD_HOST=127.0.0.1
GUACD_PORT=${HERDR_STACK_GUACD_PORT:-4822}
WEB_HOST=${HOST:-127.0.0.1}
WEB_PORT=${PORT:-7318}
STATE_ROOT=${HERDR_WEB_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-web-ui}
STACK_DIR=${HERDR_STACK_DIR:-$STATE_ROOT/pi-visual-stack}
START_TIMEOUT=${HERDR_STACK_START_TIMEOUT:-30}
STOP_TIMEOUT=${HERDR_STACK_STOP_TIMEOUT:-15}
SELF="scripts/pi-visual-stack.sh"

say() { printf '%s\n' "$*"; }
err() { printf 'pi-visual-stack: %s\n' "$*" >&2; }
die() { err "$@"; exit 1; }

valid_port() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_seconds() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 )); }

# --- process identity -------------------------------------------------------------------------

# Prints "<state> <starttime>" of a pid from /proc/<pid>/stat (the command name may hold spaces).
proc_stat() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  # shellcheck disable=SC2086
  set -- $stat
  printf '%s %s\n' "$1" "${20}"
}

boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf 'unknown\n'; }

# A recorded process is ours while that pid lives (not a zombie) in the same boot with the start
# time we recorded: a pid reused by another process, or after a reboot, never matches.
alive_as() {
  local pid=$1 start=$2 boot=$3 now
  [[ $pid =~ ^[0-9]+$ && $boot == "$(boot_id)" ]] || return 1
  now=$(proc_stat "$pid") || return 1
  [[ ${now%% *} != Z && ${now#* } == "$start" ]]
}

# Live (non-zombie) processes in session $1; each launched process leads a session of its own.
session_members() { ps -o pid=,stat= --sid "$1" 2>/dev/null | awk '$2 !~ /^Z/ { print $1 }'; }

session_of() { ps -o sid= -p "$1" 2>/dev/null | tr -d ' '; }

# --- records ----------------------------------------------------------------------------------

record_file() { printf '%s/%s.pid\n' "$STACK_DIR" "$1"; }
log_file() { printf '%s/%s.log\n' "$STACK_DIR" "$1"; }

# Sets REC_PID REC_START REC_BOOT REC_HOST REC_PORT from a record; fails when there is none or
# it does not parse (a damaged record is never acted on).
read_record() {
  local file
  file=$(record_file "$1")
  [[ -f $file ]] || return 1
  read -r REC_PID REC_START REC_BOOT REC_HOST REC_PORT <"$file" || return 1
  [[ ${REC_PID:-} =~ ^[0-9]+$ && ${REC_START:-} =~ ^[0-9]+$ && -n ${REC_BOOT:-} && -n ${REC_HOST:-} ]] && valid_port "${REC_PORT:-}"
}

# Records pid $2 with start time $3 and endpoint $4:$5 for component $1.
write_record() {
  local file tmp
  file=$(record_file "$1")
  tmp="$file.tmp.$$"
  printf '%s %s %s %s %s\n' "$2" "$3" "$(boot_id)" "$4" "$5" >"$tmp" && mv -f "$tmp" "$file"
}

# Whether component $1 is running as recorded (sets REC_* when it is).
owned_running() { read_record "$1" && alive_as "$REC_PID" "$REC_START" "$REC_BOOT"; }

# --- ports ------------------------------------------------------------------------------------

listeners() { ss -Hltnp "sport = :$1" 2>/dev/null; }
listener_pids() { listeners "$1" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u; }

# Whether a process of session $1 listens on port $2.
session_listens() {
  local pid
  for pid in $(listener_pids "$2"); do
    [[ $(session_of "$pid") == "$1" ]] && return 0
  done
  return 1
}

describe_port_owner() {
  local pid out=""
  for pid in $(listener_pids "$1"); do
    out+=" pid $pid ($(ps -o args= -p "$pid" 2>/dev/null | cut -c1-80))"
  done
  [[ -n $out ]] && printf '%s' "$out" || printf ' a process this user cannot see'
}

port_busy() { [[ -n $(listeners "$1") ]]; }

# --- start / stop -----------------------------------------------------------------------------

# Starts "$@" in a session of its own, appending to log $1's file; sets SPAWNED_PID.
spawn() {
  local name=$1 log
  shift
  log=$(log_file "$name")
  printf '\n=== %s %s started by %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$name" "$SELF" >>"$log"
  # Not a process group leader (no job control here), so setsid detaches without forking and $!
  # is the session leader itself. The lock descriptor is closed so a daemon never holds it.
  ( exec 9>&-; cd "$ROOT" || exit 1; exec setsid "$@" </dev/null >>"$log" 2>&1 ) &
  SPAWNED_PID=$!
  PENDING_PID=$SPAWNED_PID
}

# Sends signal $2 to session $1: its process group, then any member in another group.
signal_session() {
  local pid
  kill "-$2" -- "-$1" 2>/dev/null
  for pid in $(session_members "$1"); do kill "-$2" "$pid" 2>/dev/null; done
}

# Signals everything in session $1 and waits for it to end; KILL after the stop timeout.
end_session() {
  local sid=$1 deadline
  [[ -z $(session_members "$sid") ]] && return 0
  signal_session "$sid" TERM
  deadline=$((SECONDS + STOP_TIMEOUT))
  while [[ -n $(session_members "$sid") ]] && (( SECONDS < deadline )); do sleep 0.2; done
  if [[ -n $(session_members "$sid") ]]; then
    err "session $sid did not stop within ${STOP_TIMEOUT}s; sending KILL"
    signal_session "$sid" KILL
    deadline=$((SECONDS + 5))
    while [[ -n $(session_members "$sid") ]] && (( SECONDS < deadline )); do sleep 0.2; done
  fi
  [[ -z $(session_members "$sid") ]]
}

# Stops component $1 when it runs as recorded; a stale or damaged record is only removed.
stop_component() {
  local name=$1 deadline
  if ! read_record "$name"; then
    [[ -f $(record_file "$name") ]] && say "$name: unreadable record removed; nothing was signalled"
    rm -f "$(record_file "$name")"
    return 0
  fi
  if alive_as "$REC_PID" "$REC_START" "$REC_BOOT"; then
    # a child this run spawned a moment ago may not have called setsid yet
    if [[ $(ps -o ppid= -p "$REC_PID" 2>/dev/null | tr -d ' ') == "$$" ]]; then
      deadline=$((SECONDS + 3))
      while [[ $(session_of "$REC_PID") != "$REC_PID" ]] && alive_as "$REC_PID" "$REC_START" "$REC_BOOT" && (( SECONDS < deadline )); do sleep 0.1; done
    fi
    if alive_as "$REC_PID" "$REC_START" "$REC_BOOT" && [[ $(session_of "$REC_PID") != "$REC_PID" ]]; then
      err "$name (pid $REC_PID) does not lead its own session; not signalling it. Record: $(record_file "$name")"
      return 1
    fi
    say "stopping $name (pid $REC_PID)"
    end_session "$REC_PID" || { err "could not stop $name (session $REC_PID)"; return 1; }
  elif [[ $REC_BOOT == "$(boot_id)" && ! -e /proc/$REC_PID && -n $(session_members "$REC_PID") ]]; then
    # The leader is gone but its session lives on. Linux keeps a pid number in use while it
    # names a session, so these are still the processes this launcher started.
    say "stopping what remains of $name (session $REC_PID)"
    end_session "$REC_PID" || { err "could not stop $name (session $REC_PID)"; return 1; }
  else
    say "$name was not running (stale record removed)"
  fi
  rm -f "$(record_file "$name")"
}

tail_log() {
  local log
  log=$(log_file "$1")
  err "last lines of $log:"
  tail -n 20 "$log" >&2 2>/dev/null
}

# Waits until pid $2 of component $1 leads its own session and that session listens on port $3.
# Fails when the process exits or the start timeout passes.
await_listener() {
  local name=$1 pid=$2 start=$3 port=$4 deadline
  deadline=$((SECONDS + START_TIMEOUT))
  while (( SECONDS < deadline )); do
    if ! alive_as "$pid" "$start" "$(boot_id)"; then
      err "$name exited during startup"
      return 1
    fi
    [[ $(session_of "$pid") == "$pid" ]] && session_listens "$pid" "$port" && return 0
    sleep 0.2
  done
  err "$name did not listen on port $port within ${START_TIMEOUT}s"
  return 1
}

STARTED=()
PENDING_PID=

# Rolls back what this invocation started, newest first, then exits non-zero.
fail_start() {
  local i name
  trap - INT TERM HUP
  err "$1"
  [[ -n ${2:-} ]] && tail_log "$2"
  # spawned but not yet recorded (a signal between the two): it is still our direct child
  if [[ -n $PENDING_PID && $(ps -o ppid= -p "$PENDING_PID" 2>/dev/null | tr -d ' ') == "$$" ]]; then
    kill -TERM "$PENDING_PID" 2>/dev/null
  fi
  for (( i = ${#STARTED[@]} - 1; i >= 0; i-- )); do
    name=${STARTED[i]}
    err "stopping $name started by this run"
    stop_component "$name" >&2
  done
  exit 1
}

# Starts component $1 (shown as $2) that must listen on $3:$4, running "${@:5}"; reuses the one
# this launcher already runs and refuses a port that something else holds.
start_component() {
  local name=$1 label=$2 host=$3 port=$4 pid start
  shift 4
  if owned_running "$name"; then
    say "$label already running (pid $REC_PID, $REC_HOST:$REC_PORT)"
    return 0
  fi
  if read_record "$name" && [[ $REC_BOOT == "$(boot_id)" && ! -e /proc/$REC_PID && -n $(session_members "$REC_PID") ]]; then
    fail_start "$label's earlier processes (session $REC_PID) are still running without their leader; run $SELF stop first."
  fi
  rm -f "$(record_file "$name")"
  if port_busy "$port"; then
    fail_start "port $port is already in use by$(describe_port_owner "$port"), which this launcher did not start. Stop it yourself first (Ctrl-C in its terminal), then run $SELF start again."
  fi
  spawn "$name" "$@"
  pid=$SPAWNED_PID
  start=$(proc_stat "$pid") || fail_start "$label exited immediately" "$name"
  write_record "$name" "$pid" "${start#* }" "$host" "$port"
  STARTED+=("$name")
  PENDING_PID=
  await_listener "$label" "$pid" "${start#* }" "$port" || fail_start "$label failed to start" "$name"
  say "$label started (pid $pid, $host:$port)"
}

start_guacd() {
  start_component guacd guacd "$GUACD_HOST" "$GUACD_PORT" "$GUACD_BIN" -f -b "$GUACD_HOST" -l "$GUACD_PORT" -L info
}

# The repository's documented entrypoint (docs/pi-visual-tools.md); `bun run start` would add the
# self-updating supervisor, which this branch must not run.
start_web() {
  start_component web-ui "web UI" "$WEB_HOST" "$WEB_PORT" env HERDR_PI_GUACD_ENABLED=1 HOST="$WEB_HOST" PORT="$WEB_PORT" bun run server
}

# Missing programs or files are named with what to do, before anything starts.
preflight() {
  local missing=() tool
  [[ $(id -u) != 0 ]] || die "refusing to run as root: start it as the user who runs herdr and Pi."
  for tool in setsid flock ss ps awk; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  (( ${#missing[@]} == 0 )) || die "missing commands: ${missing[*]} (util-linux, iproute2, procps)."
  valid_port "$GUACD_PORT" || die "HERDR_STACK_GUACD_PORT must be a port number, got '$GUACD_PORT'"
  valid_port "$WEB_PORT" || die "PORT must be a port number, got '$WEB_PORT'"
  valid_seconds "$START_TIMEOUT" || die "HERDR_STACK_START_TIMEOUT must be whole seconds, got '$START_TIMEOUT'"
  valid_seconds "$STOP_TIMEOUT" || die "HERDR_STACK_STOP_TIMEOUT must be whole seconds, got '$STOP_TIMEOUT'"
}

preflight_start() {
  if [[ ! -e $GUACD_BIN ]]; then
    die "guacd not found at $GUACD_BIN. Build and install it first (bash install-guacd-h264-ubuntu26.04-v3.sh --resume), or set HERDR_STACK_GUACD_BIN to its path."
  fi
  [[ -x $GUACD_BIN ]] || die "$GUACD_BIN is not executable."
  local version
  if ! version=$("$GUACD_BIN" -v 2>&1); then
    die "$GUACD_BIN -v failed (missing libraries? check: ldd $GUACD_BIN): $(printf '%s' "$version" | tail -n 3)"
  fi
  # shellcheck source=bun-path.sh
  . "$ROOT/scripts/bun-path.sh"
  command -v bun >/dev/null 2>&1 || die "bun not found on PATH or in ~/.bun/bin; install it: curl -fsSL https://bun.sh/install | bash"
  [[ -d $ROOT/node_modules ]] || die "dependencies are not installed: run 'bun install' in $ROOT"
  [[ -f $ROOT/dist/index.html ]] || die "the web client is not built: run 'bun run build' in $ROOT"
}

# Takes the launcher lock so two commands never start or stop the pair at once.
lock() {
  mkdir -p "$STACK_DIR" || die "cannot create $STACK_DIR"
  chmod 700 "$STACK_DIR" 2>/dev/null
  exec 9>"$STACK_DIR/lock" || die "cannot open $STACK_DIR/lock"
  flock -n 9 || die "another $SELF command is running for $STACK_DIR; try again when it ends."
}

cmd_start() {
  preflight_start
  lock
  trap 'fail_start "interrupted during start"' INT TERM HUP
  start_guacd
  start_web
  trap - INT TERM HUP
  say ""
  say "web UI:  http://$WEB_HOST:$WEB_PORT  (desktop gateway enabled, guacd at $GUACD_HOST:$GUACD_PORT)"
  say "logs:    $(log_file guacd)"
  say "         $(log_file web-ui)"
  say "status:  $ROOT/$SELF status    stop: $ROOT/$SELF stop"
}

# Prints one component's state; fails when it is not running or not listening.
status_component() {
  local name=$1 label=$2 port=$3
  if owned_running "$name"; then
    if session_listens "$REC_PID" "$REC_PORT"; then
      say "$label: running (pid $REC_PID, listening on $REC_HOST:$REC_PORT)"
      return 0
    fi
    say "$label: running (pid $REC_PID) but not listening on port $REC_PORT"
    return 1
  fi
  if read_record "$name"; then
    say "$label: stopped (stale record: pid $REC_PID is gone)"
  else
    say "$label: stopped"
  fi
  port_busy "$port" && say "  port $port is used by$(describe_port_owner "$port"), not started by this launcher"
  return 1
}

cmd_status() {
  local ok=0
  status_component guacd guacd "$GUACD_PORT" || ok=3
  status_component web-ui "web UI" "$WEB_PORT" || ok=3
  say "logs: $(log_file guacd), $(log_file web-ui)"
  return $ok
}

cmd_stop() {
  [[ -d $STACK_DIR ]] || { say "nothing to stop (no launcher state in $STACK_DIR)"; return 0; }
  lock
  local rc=0
  stop_component web-ui || rc=1
  stop_component guacd || rc=1
  (( rc == 0 )) && say "stopped"
  return $rc
}

cmd_logs() {
  local name
  for name in guacd web-ui; do
    say "== $(log_file "$name")"
    tail -n "${LINES_SHOWN:-40}" "$(log_file "$name")" 2>/dev/null || say "(no log yet)"
  done
}

usage() {
  cat <<EOF
Usage: $SELF [start|status|stop|restart|logs]

  start    start guacd ($GUACD_HOST:$GUACD_PORT) and the web UI server with the desktop gateway
           (HERDR_PI_GUACD_ENABLED=1, http://$WEB_HOST:$WEB_PORT) in the background (default)
  status   show whether both run; exit 0 only when both run and listen
  stop     stop only the processes this launcher started
  restart  stop, then start
  logs     print the end of both logs

Environment: PORT (web UI port, default 7318), HOST (bind address, default 127.0.0.1),
HERDR_STACK_GUACD_BIN (default /opt/herdr-guacd/sbin/guacd), HERDR_STACK_DIR (logs and records,
default \${HERDR_WEB_STATE_DIR:-~/.config/herdr-web-ui}/pi-visual-stack),
HERDR_STACK_START_TIMEOUT / HERDR_STACK_STOP_TIMEOUT (seconds, default 30 / 15).
Other server variables (HERDR_SOCKET, HERDR_WEB_TOKEN, ...) pass through unchanged.
EOF
}

main() {
  local command=${1:-start}
  case $command in
    -h|--help|help) usage; return 0 ;;
    start|status|stop|restart|logs) ;;
    *) usage >&2; return 2 ;;
  esac
  preflight
  case $command in
    start) cmd_start ;;
    status) cmd_status ;;
    stop) cmd_stop ;;
    restart) cmd_stop && exec 9>&- && cmd_start ;;
    logs) cmd_logs ;;
  esac
}

main "$@"
