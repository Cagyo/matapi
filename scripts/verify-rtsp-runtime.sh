#!/usr/bin/env bash
set -Eeuo pipefail

readonly REQUIRED_USER='homeworker-stream'
readonly FRAME_QUEUE_LIMIT=2
readonly MAX_PARTIAL_JPEG_BYTES=2097152
readonly TRIAL_SECONDS=4
readonly TRIAL_TIMEOUT_SECONDS=15
readonly START_TIMEOUT_SECONDS=8
readonly STOP_TIMEOUT_SECONDS=4
readonly UDP_MIN_PORT=24000
readonly UDP_MAX_PORT=24001

if [[ $(id -un) != "$REQUIRED_USER" ]] || [[ $(id -u) -eq 0 ]]; then
  echo "ERROR: run as the unprivileged $REQUIRED_USER account" >&2
  exit 2
fi

for command in ffmpeg node ps ss stat awk sed grep mkfifo; do
  command -v "$command" >/dev/null || {
    echo "ERROR: missing required command: $command" >&2
    exit 2
  }
done

umask 077
runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/homeworker-rtsp-spike.XXXXXX")
pids=()

untrack_pid() {
  local target=$1 pid
  local remaining=()
  for pid in "${pids[@]:-}"; do
    [[ $pid == "$target" ]] || remaining+=("$pid")
  done
  pids=("${remaining[@]}")
}

process_active() {
  local pid=$1 state
  state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null) || return 1
  [[ $state != Z && $state != X ]]
}

wait_until_stopped() {
  local deadline=$1 pid active
  shift
  while (( SECONDS < deadline )); do
    active=0
    for pid in "$@"; do
      if process_active "$pid"; then
        active=1
        break
      fi
    done
    (( active == 0 )) && return 0
    sleep 0.05
  done
  return 124
}

stop_all_tracked() {
  local pid deadline
  local targets=("${pids[@]:-}")
  for pid in "${targets[@]}"; do
    [[ -n $pid ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
  wait_until_stopped "$deadline" "${targets[@]}" || true
  for pid in "${targets[@]}"; do
    if [[ -n $pid ]] && process_active "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${targets[@]}"; do
    if [[ -n $pid ]]; then
      wait "$pid" 2>/dev/null || true
      untrack_pid "$pid"
    fi
  done
}

reap_pid() {
  local pid=$1 result_name=$2 status
  set +e
  wait "$pid"
  status=$?
  set -e
  untrack_pid "$pid"
  printf -v "$result_name" '%s' "$status"
}

validate_converter_status() {
  local status=$1 mode=$2 transport=$3 codec=$4 trial=$5
  if (( status != 0 )); then
    echo "ERROR: converter exited nonzero (status=$status, mode=$mode, transport=$transport, codec=$codec, trial=$trial)" >&2
    return 1
  fi
}

cleanup() {
  stop_all_tracked
  rm -rf "$runtime_dir"
}
trap cleanup EXIT INT TERM

cat >"$runtime_dir/gateway.js" <<'NODE'
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const [mode, endpoint, startedAtText, metricsPath, readyPath, queueLimitText, maxPartialBytesText] = process.argv.slice(2);
const startedAt = Number(startedAtText);
const queueLimit = Number(queueLimitText);
const maxPartialBytes = Number(maxPartialBytesText);
let bytes = Buffer.alloc(0);
let frames = 0;
let dropped = 0;
let maxQueue = 0;
let firstFrameAt = null;
let blockedUntil = null;
let completed = false;
let closeListener = () => {};
let activeStream = null;
const queue = [];

const viewer = setInterval(() => {
  if (blockedUntil !== null && Date.now() >= blockedUntil) queue.shift();
}, 200);

function ingest(chunk) {
  if (bytes.length + chunk.length > maxPartialBytes) {
    finish(new Error('partial JPEG buffer limit exceeded'));
    return;
  }
  bytes = Buffer.concat([bytes, chunk]);
  while (true) {
    const start = bytes.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      bytes = bytes.subarray(Math.max(0, bytes.length - 1));
      return;
    }
    const end = bytes.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      bytes = bytes.subarray(start);
      return;
    }
    frames += 1;
    if (firstFrameAt === null) {
      firstFrameAt = Date.now();
      blockedUntil = firstFrameAt + 1_500;
    }
    queue.push(end + 2 - start);
    if (queue.length > queueLimit) {
      queue.shift();
      dropped += 1;
    }
    maxQueue = Math.max(maxQueue, queue.length);
    bytes = bytes.subarray(end + 2);
  }
}

function finish(error) {
  if (completed) return;
  completed = true;
  clearInterval(viewer);
  const metrics = {
    frames,
    dropped,
    maxQueue,
    firstFrameLatencyMs: firstFrameAt === null ? null : firstFrameAt - startedAt,
    error: error ? String(error.message || error) : null,
  };
  fs.writeFileSync(metricsPath, `${JSON.stringify(metrics)}\n`, { mode: 0o600 });
  if (activeStream) activeStream.destroy();
  closeListener();
  if (error || frames === 0) process.exitCode = 1;
}

function consume(stream) {
  activeStream = stream;
  stream.on('data', ingest);
  stream.on('end', () => setTimeout(() => finish(), 250));
  stream.on('error', finish);
}

if (mode === 'overflow-proof') {
  ingest(Buffer.from([0xff, 0xd8]));
  ingest(Buffer.alloc(maxPartialBytes));
  if (!completed) finish(new Error('partial JPEG overflow proof did not trigger'));
} else if (mode === 'fifo') {
  fs.writeFileSync(readyPath, 'ready\n', { mode: 0o600 });
  consume(fs.createReadStream(endpoint));
} else if (mode === 'unix') {
  const server = net.createServer((socket) => consume(socket));
  closeListener = () => server.close();
  server.on('error', finish);
  server.listen(endpoint, () => {
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(readyPath, 'ready\n', { mode: 0o600 });
  });
} else if (mode === 'http') {
  fs.writeFileSync(readyPath, 'ready\n', { mode: 0o600 });
  const deadline = Date.now() + 8_000;
  const connect = () => {
    const request = http.get(endpoint, (response) => {
      if (response.statusCode !== 200) return finish(new Error(`HTTP ${response.statusCode}`));
      consume(response);
    });
    request.on('error', (error) => {
      if (Date.now() < deadline) return setTimeout(connect, 50);
      finish(error);
    });
  };
  connect();
} else {
  finish(new Error(`unsupported mode: ${mode}`));
}
NODE

wait_for_file() {
  local path=$1
  local deadline=$((SECONDS + START_TIMEOUT_SECONDS))
  until [[ -e $path ]]; do
    (( SECONDS < deadline )) || return 1
    sleep 0.05
  done
}

process_sample() {
  local converter_pid=$1 gateway_pid=$2 output=$3
  local converter_rss converter_cpu gateway_rss gateway_cpu
  read -r converter_rss converter_cpu < <(ps -o rss=,%cpu= -p "$converter_pid" | awk 'NF {print $1, $2}') || true
  read -r gateway_rss gateway_cpu < <(ps -o rss=,%cpu= -p "$gateway_pid" | awk 'NF {print $1, $2}') || true
  if [[ -n ${converter_rss:-} && -n ${gateway_rss:-} ]]; then
    awk -v cr="$converter_rss" -v cc="$converter_cpu" -v gr="$gateway_rss" -v gc="$gateway_cpu" \
      'BEGIN {printf "%d %.1f %d %.1f %d %.1f\n", cr, cc, gr, gc, cr + gr, cc + gc}' >>"$output"
  fi
}

converter_udp_ports() {
  local converter_pid=$1
  local fd_dir="/proc/${converter_pid}/fd"
  node - "$fd_dir" "$UDP_MIN_PORT" "$UDP_MAX_PORT" <<'NODE'
const fs = require('node:fs');
const [fdDir, minText, maxText] = process.argv.slice(2);
const min = Number(minText);
const max = Number(maxText);
const inodes = new Set();
for (const name of fs.readdirSync(fdDir)) {
  try {
    const target = fs.readlinkSync(`${fdDir}/${name}`);
    const match = /^socket:\[(\d+)]$/.exec(target);
    if (match) inodes.add(match[1]);
  } catch {}
}
const ports = new Set();
for (const path of ['/proc/net/udp', '/proc/net/udp6']) {
  if (!fs.existsSync(path)) continue;
  for (const line of fs.readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (!inodes.has(fields[9])) continue;
    const port = Number.parseInt(fields[1].split(':')[1], 16);
    if (port >= min && port <= max) ports.add(port);
  }
}
if (ports.has(min) && ports.has(max)) process.stdout.write(`${min},${max}`);
NODE
}

run_negative_proofs() {
  local converter_probe_pid converter_probe_status hang_pid deadline
  local overflow_metrics="$runtime_dir/overflow.metrics.json"
  sh -c 'exit 23' &
  converter_probe_pid=$!
  pids+=("$converter_probe_pid")
  deadline=$((SECONDS + 1))
  wait_until_stopped "$deadline" "$converter_probe_pid"
  reap_pid "$converter_probe_pid" converter_probe_status
  if validate_converter_status "$converter_probe_status" proof tcp h264 0 >/dev/null 2>&1; then
    echo 'ERROR: negative converter-status proof unexpectedly passed' >&2
    return 1
  fi
  echo 'NEGATIVE_CONVERTER_STATUS PASS nonzero converter status rejected'

  sleep 60 &
  hang_pid=$!
  pids+=("$hang_pid")
  deadline=$((SECONDS + 1))
  if wait_until_stopped "$deadline" "$hang_pid"; then
    echo 'ERROR: negative deadline proof exited before its deadline' >&2
    return 1
  fi
  stop_all_tracked
  if process_active "$hang_pid"; then
    echo 'ERROR: negative deadline proof left a process alive' >&2
    return 1
  fi
  echo 'NEGATIVE_TRIAL_DEADLINE PASS trial deadline exceeded; child terminated and reaped'

  if node "$runtime_dir/gateway.js" overflow-proof ignored 0 "$overflow_metrics" ignored \
    "$FRAME_QUEUE_LIMIT" "$MAX_PARTIAL_JPEG_BYTES" >/dev/null 2>&1; then
    echo 'ERROR: negative partial-JPEG proof unexpectedly passed' >&2
    return 1
  fi
  if ! grep -q 'partial JPEG buffer limit exceeded' "$overflow_metrics"; then
    echo 'ERROR: negative partial-JPEG proof returned the wrong failure' >&2
    return 1
  fi
  echo 'NEGATIVE_PARTIAL_JPEG PASS malformed partial frame rejected at byte limit'
}

run_trial() {
  local mode=$1 transport=$2 codec=$3 trial=$4 control_port=$5
  local prefix="$runtime_dir/${mode}-${transport}-${codec}-${trial}"
  local endpoint output_url publisher_codec publisher_options
  local gateway_pid converter_pid publisher_pid sampler_pid started_at trial_deadline
  local publisher_status converter_status gateway_status sampler_status
  local socket_mode='n/a' bind_scope='n/a' udp_ports='n/a'

  trial_deadline=$((SECONDS + TRIAL_TIMEOUT_SECONDS))
  case "$mode" in
    fifo)
      endpoint="$prefix.fifo"
      mkfifo -m 0600 "$endpoint"
      output_url="$endpoint"
      ;;
    unix)
      endpoint="$prefix.sock"
      output_url="unix://$endpoint"
      ;;
    http)
      endpoint="http://127.0.0.1:$((19000 + trial + control_port % 100))/stream.mjpg"
      output_url="$endpoint"
      bind_scope='127.0.0.1'
      ;;
    *) return 2 ;;
  esac

  case "$codec" in
    h264)
      publisher_codec='libx264'
      publisher_options=(-preset ultrafast -tune zerolatency)
      ;;
    hevc)
      publisher_codec='libx265'
      publisher_options=(-preset ultrafast -x265-params 'log-level=error:pools=1:frame-threads=1')
      ;;
    *) return 2 ;;
  esac

  started_at=$(node -e 'process.stdout.write(String(Date.now()))')
  node "$runtime_dir/gateway.js" "$mode" "$endpoint" "$started_at" \
    "$prefix.metrics.json" "$prefix.ready" "$FRAME_QUEUE_LIMIT" "$MAX_PARTIAL_JPEG_BYTES" \
    >"$prefix.gateway.log" 2>&1 &
  gateway_pid=$!
  pids+=("$gateway_pid")
  wait_for_file "$prefix.ready"
  if [[ $mode == unix || $mode == fifo ]]; then
    socket_mode=$(stat -c '%a:%U:%G' "$endpoint")
  fi

  local output_options=()
  [[ $mode == http ]] && output_options=(-listen 1)
  ffmpeg -hide_banner -nostdin -loglevel warning -y \
    -rtsp_flags listen -rtsp_transport "$transport" \
    -min_port "$UDP_MIN_PORT" -max_port "$UDP_MAX_PORT" \
    -timeout 5000000 -i "rtsp://127.0.0.1:$control_port/spike" \
    -map 0:v:0 -an -vf 'fps=10,scale=320:-2' -c:v mjpeg -q:v 5 \
    -flush_packets 1 -f image2pipe "${output_options[@]}" "$output_url" \
    >"$prefix.converter.log" 2>&1 &
  converter_pid=$!
  pids+=("$converter_pid")
  sleep 0.35

  ffmpeg -hide_banner -nostdin -loglevel warning -re \
    -f lavfi -i 'testsrc=size=320x180:rate=10' -t "$TRIAL_SECONDS" -an \
    -c:v "$publisher_codec" "${publisher_options[@]}" -pix_fmt yuv420p \
    -f rtsp -rtsp_transport "$transport" \
    -min_port $((UDP_MIN_PORT + 10)) -max_port $((UDP_MAX_PORT + 10)) \
    "rtsp://127.0.0.1:$control_port/spike" \
    >"$prefix.publisher.log" 2>&1 &
  publisher_pid=$!
  pids+=("$publisher_pid")

  (
    while kill -0 "$converter_pid" 2>/dev/null && kill -0 "$gateway_pid" 2>/dev/null; do
      process_sample "$converter_pid" "$gateway_pid" "$prefix.samples"
      sleep 0.2
    done
  ) &
  sampler_pid=$!
  pids+=("$sampler_pid")

  if [[ $transport == udp ]]; then
    local udp_deadline=$((SECONDS + 3))
    (( udp_deadline > trial_deadline )) && udp_deadline=$trial_deadline
    while (( SECONDS < udp_deadline )); do
      udp_ports=$(converter_udp_ports "$converter_pid" 2>/dev/null || true)
      [[ -n $udp_ports ]] && break
      sleep 0.1
    done
    [[ -n $udp_ports ]] || udp_ports='none'
    if [[ $udp_ports != "$UDP_MIN_PORT,$UDP_MAX_PORT" ]]; then
      echo "ERROR: converter-owned UDP media ports missing (mode=$mode, codec=$codec, trial=$trial)" >&2
      stop_all_tracked
      return 1
    fi
  fi

  if ! wait_until_stopped "$trial_deadline" \
    "$publisher_pid" "$converter_pid" "$gateway_pid" "$sampler_pid"; then
    echo "ERROR: trial deadline exceeded (mode=$mode, transport=$transport, codec=$codec, trial=$trial)" >&2
    stop_all_tracked
    return 1
  fi

  reap_pid "$publisher_pid" publisher_status
  reap_pid "$converter_pid" converter_status
  reap_pid "$gateway_pid" gateway_status
  reap_pid "$sampler_pid" sampler_status

  if (( publisher_status != 0 )); then
    echo "ERROR: RTSP publisher exited nonzero (status=$publisher_status, mode=$mode, transport=$transport, codec=$codec, trial=$trial)" >&2
    return 1
  fi
  validate_converter_status "$converter_status" "$mode" "$transport" "$codec" "$trial" || return 1
  if (( gateway_status != 0 )); then
    echo "ERROR: gateway exited nonzero (status=$gateway_status, mode=$mode, transport=$transport, codec=$codec, trial=$trial)" >&2
    return 1
  fi
  if (( sampler_status != 0 )); then
    echo "ERROR: sampler exited nonzero (status=$sampler_status, mode=$mode, transport=$transport, codec=$codec, trial=$trial)" >&2
    return 1
  fi

  [[ -s $prefix.metrics.json ]] || {
    echo "ERROR: no gateway metrics for $mode/$transport/$codec trial $trial" >&2
    sed -n '1,80p' "$prefix.converter.log" >&2
    sed -n '1,80p' "$prefix.gateway.log" >&2
    return 1
  }

  node - "$prefix.metrics.json" "$prefix.samples" "$mode" "$transport" "$codec" \
    "$trial" "$socket_mode" "$bind_scope" "$udp_ports" <<'NODE'
const fs = require('node:fs');
const [metricsPath, samplesPath, mode, transport, codec, trial, permissions, bindScope, udpPorts] = process.argv.slice(2);
const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
const samples = fs.existsSync(samplesPath)
  ? fs.readFileSync(samplesPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/).map(Number))
  : [];
const max = (column) => samples.length ? Math.max(...samples.map((row) => row[column])) : 0;
if (metrics.error || metrics.frames < 5 || metrics.dropped < 1 || metrics.maxQueue > 2) process.exitCode = 1;
console.log([
  'RESULT', mode, transport, codec, trial,
  `frames=${metrics.frames}`, `dropped=${metrics.dropped}`, `queue=${metrics.maxQueue}`,
  `latency_ms=${metrics.firstFrameLatencyMs}`,
  `converter_rss_kib=${max(0)}`, `converter_cpu_pct=${max(1).toFixed(1)}`,
  `gateway_rss_kib=${max(2)}`, `gateway_cpu_pct=${max(3).toFixed(1)}`,
  `total_rss_kib=${max(4)}`, `total_cpu_pct=${max(5).toFixed(1)}`,
  `permissions=${permissions}`, `bind=${bindScope}`, `udp_ports=${udpPorts}`,
].join(' '));
NODE

  rm -f "$endpoint" "$prefix.ready"
  if kill -0 "$converter_pid" 2>/dev/null || kill -0 "$gateway_pid" 2>/dev/null; then
    echo "ERROR: data-plane process survived teardown for $mode/$transport/$codec trial $trial" >&2
    return 1
  fi
  return 0
}

echo '# RTSP runtime spike raw report'
echo
echo "Run identity: $(id -un) uid=$(id -u) gid=$(id -g) groups=$(id -G | tr ' ' ',')"
echo "Kernel: $(uname -srmo)"
echo "FFmpeg: $(ffmpeg -hide_banner -version | sed -n '1p')"
echo "Memory before: $(awk '/MemTotal|MemAvailable/ {printf "%s=%sKiB ", $1, $2}' /proc/meminfo)"
echo "Configured frame queue limit: $FRAME_QUEUE_LIMIT"
echo "Configured partial-JPEG byte limit: $MAX_PARTIAL_JPEG_BYTES"
echo "Configured whole-trial timeout: $TRIAL_TIMEOUT_SECONDS seconds"
echo "Configured UDP media range: $UDP_MIN_PORT-$UDP_MAX_PORT"
echo

run_negative_proofs
echo

trial=0
for mode in fifo http unix; do
  trial=$((trial + 1))
  run_trial "$mode" tcp h264 "$trial" $((18550 + trial))
done

# Re-run the selected Unix-socket contract over UDP and with HEVC input.
trial=$((trial + 1))
run_trial unix udp h264 "$trial" $((18550 + trial))
trial=$((trial + 1))
run_trial unix tcp hevc "$trial" $((18550 + trial))
trial=$((trial + 1))
run_trial unix udp hevc "$trial" $((18550 + trial))

tls_help=$(ffmpeg -hide_banner -h protocol=tls 2>&1)
echo 'TLS_FINGERPRINT_CAPABILITY DEFER no behavioral fingerprint fixture is available'

if grep -q -- '-tls_verify' <<<"$tls_help" && grep -q -- '-verifyhost' <<<"$tls_help"; then
  echo 'TLS_STRICT_CA_HOSTNAME_CAPABILITY PASS tls_verify and verifyhost available'
else
  echo 'TLS_STRICT_CA_HOSTNAME_CAPABILITY FAIL strict certificate verification options missing'
  exit 1
fi

echo "Memory after: $(awk '/MemTotal|MemAvailable/ {printf "%s=%sKiB ", $1, $2}' /proc/meminfo)"
echo 'CLEANUP_CONTRACT process trap sends TERM, waits a bounded interval, sends KILL if needed, and removes the private runtime directory'
