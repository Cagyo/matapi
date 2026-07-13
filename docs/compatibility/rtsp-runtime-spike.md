# RTSP Runtime Feasibility — Raspberry Pi 3+

## Decision

**PASS with one compatibility restriction.** The target Pi can run one sandboxed
FFmpeg converter plus one Node gateway within the 512 MB total-process budget.
Self-signed RTSPS certificate fingerprint pinning is unavailable in the installed
FFmpeg TLS stack, so that source mode is deferred and must not be enabled.

Selected data plane: Unix socket

Backpressure limit: 2 frames

Self-signed fingerprint enforcement: DEFER

The selected contract is video-only raw JPEG frames over one private Unix stream
socket. One FFmpeg converter feeds one Node gateway; the gateway owns the bounded
two-frame drop-oldest queue and fans out to at most two viewers. Viewer slowness
does not create a per-viewer FFmpeg process or an unbounded frame queue.

## Target and method

Measured 2026-07-13 on `matapitest`, Debian GNU/Linux 13 (`trixie`), Linux
6.18.34, aarch64, four Cortex-A53 cores at up to 1.4 GHz. `/proc/meminfo`
reported 425,172 KiB total memory. The installed FFmpeg was
7.1.5-0+deb13u1+rpt1 with GnuTLS, native H.264 and HEVC decoders, RTSP TCP/UDP,
and `min_port`/`max_port` support.

The spike ran as the locked, no-login, no-home, unprivileged
`homeworker-stream` identity with only its primary group. A temporary FFmpeg
publisher generated a 320x180, 10 fps RTSP source on loopback. Exactly one other
FFmpeg process decoded that source and converted video to JPEG for the candidate
data plane. The temporary publisher is test infrastructure and is not included
in the selected runtime process totals.

The Node harness parsed complete JPEGs, intentionally stalled its simulated
viewer for 1.5 seconds, retained at most two frames, and counted dropped frames.
Latency below is publisher start to the first complete JPEG received by the
gateway; it is a startup-path measurement, not glass-to-glass camera latency.

## Fresh final run

| Data plane | RTSP media | Input | Frames / dropped | Startup latency | Converter + gateway peak RSS | Peak aggregate CPU | Boundary |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| FIFO | TCP | H.264 | 39 / 37 | 3,732 ms | 100,664 KiB (98.3 MiB) | 132.1% | `0600`, stream user/group |
| Loopback HTTP | TCP | H.264 | 39 / 37 | 3,739 ms | 104,468 KiB (102.0 MiB) | 132.4% | configured `127.0.0.1` only |
| Unix socket | TCP | H.264 | 39 / 37 | 3,800 ms | 100,336 KiB (98.0 MiB) | 86.0% | `0600`, stream user/group |
| Unix socket | UDP | H.264 | 39 / 37 | 4,180 ms | 99,144 KiB (96.8 MiB) | 77.8% | converter-owned RTP sockets at 24000–24001 |
| Unix socket | TCP | H.265 | 36 / 34 | 4,418 ms | 98,704 KiB (96.4 MiB) | 128.0% | `0600`, stream user/group |
| Unix socket | UDP | H.265 | 36 / 34 | 4,507 ms | 99,916 KiB (97.6 MiB) | 127.1% | converter-owned RTP sockets at 24000–24001 |

Every trial reached the gateway, hit a maximum queue depth of exactly two, and
dropped old frames under the artificial stall. Every converter and gateway had
exited before its trial returned. The harness then removed its private runtime
directory. Available system memory was 247,212 KiB before and 230,392 KiB after
the fresh final run; no inference is made from that noisy system-wide delta.

The selected runtime peak of 100,336 KiB is 19.1% of the 512 MiB process budget,
which represents approximately 413 MiB of abstract 512 MiB process-budget headroom;
it is not a claim about physically available RAM for the worker or operating
system. CPU briefly exceeded one core during software conversion, but stayed
within the Pi's four-core capacity. The measured 3.7–4.5 second first-frame
startup is acceptable under the bounded 30-second startup contract, but later
implementation should expose it as a metric and must not tighten that timeout
without target-Pi evidence.

## Compatibility result

Each source must explicitly select its input compatibility settings; do not
probe by weakening security or silently changing transport.

| Source setting | Result | Required runtime behavior |
| --- | --- | --- |
| `rtsp`, hostname or IP, TCP, H.264 | PASS | Default transport; video-only; bounded timeouts |
| `rtsp`, hostname or IP, UDP, H.264 | PASS | Configure a dedicated two-port RTP/RTCP range; the spike observed both ports |
| `rtsp`, hostname or IP, TCP, H.265 | PASS | Native HEVC decode; same one-converter contract |
| `rtsp`, hostname or IP, UDP, H.265 | PASS | Native HEVC decode with both configured RTP/RTCP ports observed |
| `rtsps`, CA-trusted certificate, hostname/IP matching its SAN | PASS by installed capability | Set `tls_verify=1`, set `verifyhost`, use the system or configured CA file, and retain bounded timeouts |
| `rtsps`, self-signed certificate pinned by fingerprint | DEFER | Do not expose this mode; installed FFmpeg has no fingerprint/pinned-public-key option |
| Any TLS mode that accepts every certificate | FORBIDDEN | No trust-any-certificate option or fallback |

The installed TLS protocol exposes `ca_file`, `tls_verify`, and `verifyhost`, but
the spike has no behavioral expected-fingerprint/mismatched-fingerprint fixture.
It therefore reports DEFER unconditionally and can never infer pinning PASS from
FFmpeg help keywords or ordinary CA-file verification.

## Ownership and cleanup contract

- The Node live-session owner creates a per-session directory under the private
  stream runtime root with owner/group `homeworker-stream` and mode `0700`.
- The Node gateway creates the Unix stream socket inside that directory with
  mode `0600`, starts listening before it starts FFmpeg, and accepts exactly the
  one identity-tracked converter connection.
- The gateway parses raw JPEG boundaries and retains no more than two frames in
  one shared drop-oldest queue. A partial JPEG is capped at 2,097,152 bytes and
  fails closed on overflow. It serves at most two viewers from the shared queue.
- The session owner tracks the exact FFmpeg child identity. Stop/expiry/error
  sends `SIGTERM`, waits at most four seconds, sends `SIGKILL` only if required,
  waits for the child, closes the Unix listener, unlinks the socket, and removes
  the per-session directory.
- Startup is bounded to eight seconds and the entire spike trial to 15 seconds;
  planned runtime startup remains 30 seconds. RTSP socket I/O is bounded to five
  seconds. No process, listener, socket, or runtime file may survive a failed
  start or completed stop, and every converter exit status must be zero.
- The script itself refuses root and any identity other than
  `homeworker-stream`; it uses `umask 077` and a trap implementing the same
  bounded teardown.

## Reproduction

Run the checked-in script as the intended account. It writes all artifacts to a
private temporary directory, prints raw measured results to standard output, and
removes the directory on every exit path.

```bash
sudo -n -u homeworker-stream scripts/verify-rtsp-runtime.sh
```

The script depends only on installed system tools (`ffmpeg`, Node, `ps`, `ss`,
and POSIX utilities). It does not read application configuration, databases, or
secrets, and it does not install packages, modify the firewall, or start a
persistent service.

The script also runs three deliberate negative proofs before measuring data
planes: converter status 23 is rejected, a 60-second child is stopped and reaped
at a one-second proof deadline, and a malformed partial JPEG fails at the byte
limit. UDP evidence is joined from the tracked converter's `/proc/<pid>/fd`
socket inodes to `/proc/net/udp`/`udp6`, so unrelated system listeners cannot
satisfy the configured media-range check.
