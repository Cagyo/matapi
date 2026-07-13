#!/usr/bin/env bash
set -Eeuo pipefail

readonly REQUIRED_USER='homeworker-stream'
readonly FRAME_QUEUE_LIMIT=2
readonly TRIAL_SECONDS=4
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

stop_pid() {
  local pid=$1
  local deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

untrack_pid() {
  local target=$1 pid
  local remaining=()
  for pid in "${pids[@]:-}"; do
    [[ $pid == "$target" ]] || remaining+=("$pid")
  done
  pids=("${remaining[@]}")
}

cleanup() {
  local pid
  for pid in "${pids[@]:-}"; do
    [[ -n $pid ]] && stop_pid "$pid"
  done
  rm -rf "$runtime_dir"
}
trap cleanup EXIT INT TERM

cat >"$runtime_dir/gateway.js" <<'NODE'
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const [mode, endpoint, startedAtText, metricsPath, readyPath, queueLimitText] = process.argv.slice(2);
const startedAt = Number(startedAtText);
const queueLimit = Number(queueLimitText);
let bytes = Buffer.alloc(0);
let frames = 0;
let dropped = 0;
let maxQueue = 0;
let firstFrameAt = null;
let blockedUntil = null;
let completed = false;
let closeListener = () => {};
const queue = [];

const viewer = setInterval(() => {
  if (blockedUntil !== null && Date.now() >= blockedUntil) queue.shift();
}, 200);

function ingest(chunk) {
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
  closeListener();
  if (error || frames === 0) process.exitCode = 1;
}

function consume(stream) {
  stream.on('data', ingest);
  stream.on('end', () => setTimeout(() => finish(), 250));
  stream.on('error', finish);
}

if (mode === 'fifo') {
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

run_trial() {
  local mode=$1 transport=$2 codec=$3 trial=$4 control_port=$5
  local prefix="$runtime_dir/${mode}-${transport}-${codec}-${trial}"
  local endpoint output_url publisher_codec publisher_options
  local gateway_pid converter_pid publisher_pid sampler_pid started_at
  local socket_mode='n/a' bind_scope='n/a' udp_ports='n/a'

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
    "$prefix.metrics.json" "$prefix.ready" "$FRAME_QUEUE_LIMIT" \
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
    while (( SECONDS < udp_deadline )); do
      udp_ports=$(ss -H -lun | awk -v min="$UDP_MIN_PORT" -v max="$UDP_MAX_PORT" '
        {sub(/^.*:/, "", $4); if ($4 >= min && $4 <= max) seen[$4]=1}
        END {if (seen[min] && seen[max]) printf "%s,%s", min, max}')
      [[ -n $udp_ports ]] && break
      sleep 0.1
    done
    [[ -n $udp_ports ]] || udp_ports='none'
  fi

  if ! wait "$publisher_pid"; then
    untrack_pid "$publisher_pid"
    echo "ERROR: RTSP publisher failed for $mode/$transport/$codec trial $trial" >&2
    sed -n '1,100p' "$prefix.publisher.log" >&2
    sed -n '1,100p' "$prefix.converter.log" >&2
    return 1
  fi
  untrack_pid "$publisher_pid"
  wait "$converter_pid" || true
  untrack_pid "$converter_pid"
  if ! wait "$gateway_pid"; then
    untrack_pid "$gateway_pid"
    echo "ERROR: gateway failed for $mode/$transport/$codec trial $trial" >&2
    sed -n '1,100p' "$prefix.gateway.log" >&2
    sed -n '1,100p' "$prefix.converter.log" >&2
    return 1
  fi
  untrack_pid "$gateway_pid"
  stop_pid "$sampler_pid"
  untrack_pid "$sampler_pid"

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
echo "Configured UDP media range: $UDP_MIN_PORT-$UDP_MAX_PORT"
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
if grep -Eiq '(fingerprint|pinnedpubkey|pin-sha256)' <<<"$tls_help"; then
  echo 'TLS_FINGERPRINT_CAPABILITY PASS explicit fingerprint option present'
else
  echo 'TLS_FINGERPRINT_CAPABILITY DEFER no explicit fingerprint option in installed FFmpeg TLS protocol'
fi

if grep -q -- '-tls_verify' <<<"$tls_help" && grep -q -- '-verifyhost' <<<"$tls_help"; then
  echo 'TLS_STRICT_CA_HOSTNAME_CAPABILITY PASS tls_verify and verifyhost available'
else
  echo 'TLS_STRICT_CA_HOSTNAME_CAPABILITY FAIL strict certificate verification options missing'
  exit 1
fi

echo "Memory after: $(awk '/MemTotal|MemAvailable/ {printf "%s=%sKiB ", $1, $2}' /proc/meminfo)"
echo 'CLEANUP_CONTRACT process trap sends TERM, waits a bounded interval, sends KILL if needed, and removes the private runtime directory'
