# RTSP local-network camera setup — target-Pi acceptance

This is an operator-run release gate on real hardware, not an automated test,
and it cannot be automated: it exists to prove things about a physical network,
a privileged installer, and what an administrator actually sees in a Telegram
chat. **A green repository test run does not prove any of it.**

Run it on a Raspberry Pi on the LAN the cameras live on, with at least one real
RTSP camera. Use a throwaway Telegram bot and a throwaway private chat — every
step here is performed by an administrator in a private chat, and step 9 reads
that chat's history back.

> **Handling rule for the whole procedure.** Use a *disposable* camera password.
> You are about to paste it into Telegram on purpose, and step 9 checks that it
> did not survive anywhere. Change it on the camera when you are done.

## Evidence header

Fill this in before you start; it is the record.

- Operator:
- Date/time and timezone:
- Raspberry Pi model / RAM / Raspberry Pi OS release / `dpkg --print-architecture`:
- Kernel / `node -v` (must be 22.x):
- Home Worker commit:
- Camera make/model and firmware:
- LAN the Pi is directly attached to (interface + CIDR):
- A second subnet reachable only *through* the router (interface + CIDR), if one exists:
- Steps 1–9: pass / fail each, with the observation that decided it

## Preparation

1. Install Home Worker on a host with **no** prior RTSP feature installation and
   no hand-written `RTSP_*` entries in its `.env`. If you are reusing a host,
   record that fact — steps 1 and 8 mean different things on a fresh install
   than on a reinstall.
2. Note the install directory (`INSTALL_DIR`) and the database path
   (`DATABASE_PATH`, default `./data/dev.db`). You need both in step 9.
3. Confirm you are an administrator in the test chat, and that a second,
   non-administrator account is available for step 3.
4. Start a PM2 log tail you can review later:
   `pm2 logs home-worker --lines 0 > /tmp/acceptance-pm2.log &`

---

## 1. Install RTSP without editing a single environment variable by hand

**Do.** From the bot: Home → ⋯ More → 🛠 Admin tools → 🔧 Features → RTSP
→ Install. Confirm. Do not open an editor at any point, and do not run
`scripts/install-feature.sh` yourself.

**Observe.**
- The bot reports the install starting, then that a restart is required.
- The installer wrote the policy keys itself. Read *only* those keys — never
  print the whole file, it holds the bot token:
  `grep -E '^RTSP_(ALLOWED_CIDRS|POLICY_DIGEST|UDP_PORT_FIRST|UDP_PORT_LAST)=' "$INSTALL_DIR/.env"`
- `/usr/lib/home-worker/live-stream-policy-inspector` exists and is root-owned.

**Pass** when all four `RTSP_*` keys are present and you typed none of them.
**Fail** if any key is missing, or if the install could only be completed by
editing a file.

## 2. The policy describes directly-attached LANs, and nothing else

**Do.** Compare what the worker believes with what the machine has:

```bash
ip -brief address
sudo /usr/lib/home-worker/live-stream-policy-inspector verify-installed
```

Then open the bot: Camera → 📡 RTSP Sources, and read the policy block at the
top of the overview.

**Observe.**
- The CIDRs listed on the screen are exactly the networks the Pi is *directly*
  attached to — one per non-loopback interface with an address.
- A subnet that is only reachable *through* the router is **absent**. So are
  loopback, container/bridge and VPN ranges unless the Pi genuinely holds an
  address on them.
- The screen says "Local network only" and states that cameras can be reached on
  those networks "and nowhere else".
- The inspector printed a verdict and *nothing else* — no policy file contents,
  no UID inventory, no environment.

**Pass** when the screen, the `.env` value from step 1 and `ip -brief address`
agree, with no extra network.
**Fail** on any network the Pi is not directly attached to, or any mismatch
between the three.

## 3. Restart and readiness are visible, and the gate holds

**Do.** Restart the worker (`pm2 restart home-worker`). Then, as the
administrator, open Camera → 📡 RTSP Sources. Then repeat from the
*non-administrator* account.

**Observe.**
- Before the restart, RTSP reported "restart required" and Sources refused to
  open with a feature notice rather than an empty menu.
- After the restart, RTSP reports ready and Sources opens.
- The non-administrator account cannot see or reach the RTSP Sources entry, and
  a direct `/camera` entry gives it the same refusal.

**Pass** when readiness state is legible at every point and the
non-administrator is refused at both entry points.
**Fail** if the screen ever offers to change a camera network it cannot
describe, or a non-administrator reaches any part of it.

## 4. Create a camera and watch it live

**Do.** Sources → ➕ Add RTSP camera → ➕ Create RTSP camera. Reply to the
prompt with a name. Read the privacy notice that follows, then reply to the
credential prompt with the camera's full RTSP address including its disposable
credentials. When the source is stored, open the camera and start the live view.

**Observe.**
- The name prompt and the credential prompt are each a ForceReply, and each says
  to reply to *that exact message*.
- The privacy notice appears **before** the credential prompt and names the
  accepted schemes, the networks in force, that the address may carry a
  password, that Telegram is not a secret channel, that the message will be
  deleted, and the ten-minute window.
- **Your credential message disappears from the chat**, and it does so before
  the bot reports any result.
- The stored source renders as status and quality/transport wording — never a
  URL, a username, a host, or a camera identifier.
- Live view plays.

**Pass** when the credential message is gone and the live view works.
**Fail** if the reply message survives in the chat, if any screen echoes the
address back, or if the result is reported before the deletion is attempted.

## 5. An address outside the policy is refused

**Do.** Add a second source whose address is outside every listed network — a
public host, or a camera on the routed-but-not-attached subnet from step 2.

**Observe.**
- The attempt is refused with copy about the local-network policy, offering
  *change the address* and *back*.
- The refusal names no host, no address and no diagnostic text.
- Nothing was stored: return to the overview and confirm no new row appeared.

**Pass** when the refusal is specific about the policy and silent about the
address.
**Fail** if the address is echoed, if a row appears, or if the refusal is a
generic error.

## 6. Exercise the rest of the lifecycle

Run each of these and record it separately.

1. **Wrong credentials.** Add a source with a bad password on a reachable
   camera. Expect an authentication-flavoured refusal with *change the address*
   — and confirm the failed attempt stored nothing.
2. **Timeout.** Point a source at an address inside the policy where nothing
   answers. Expect a timeout refusal offering *retry* and *change the address*,
   after a bounded wait rather than a hang.
3. **Prompt expiry.** Open a credential prompt and leave it for more than ten
   minutes, then reply to it. Expect the expiry message naming ten minutes, and
   **the reply still deleted**. Nothing is installed.
4. **Cancel.** Open a credential prompt and press Cancel. The prompt message is
   *retracted from the chat*, not merely ignored. Now reply to where it was: the
   reply is deleted and nothing is installed.
5. **Test.** On a working source, press Test. Expect a progress notice then a
   result, with no address in either.
6. **Replace.** Replace a working source's address with another working one.
   Confirm live view uses the new address and the old stream is stopped.
7. **Concurrent replace.** Open the same source's detail in two chats (or open
   it, then change it from the other, then act on the first). The stale one is
   refused with a *back*-only recovery — it must not overwrite the newer state.
8. **Removal.** Remove a source and confirm the row disappears, the camera stops
   streaming, and the confirmation could not be replayed: press the same
   confirm control a second time and observe it refuse rather than remove
   something else.

**Pass** when every one of the eight behaves as described.
**Fail** on any silent success, any echoed address, or any stale control that
still mutates.

## 7. Simulate policy drift

**Do.** Change the Pi's network so the installed policy stops describing it —
move it to a different subnet, or change the router's LAN range, or bring up/down
an interface. Do **not** reinstall yet. Restart the worker and open Sources.

**Observe.**
- The overview shows the stale warning: the camera network policy no longer
  describes this network, reinstall RTSP to refresh it.
- The reinstall control is offered *from that screen* and is reachable even
  though RTSP is not usable.
- Reading is still honest: no source is reported as verified against the new
  network.
- Attempting to add or change a source is refused rather than half-completed.

**Pass** when drift is announced, the escape hatch is reachable, and nothing
claims verification it does not have.
**Fail** if the screen still presents the old networks as current, or if the
reinstall control is behind the readiness gate it exists to clear.

## 8. Reinstall, and keep every source

**Do.** From the stale screen, reinstall RTSP. Restart when asked.

**Observe.**
- The install completes and RTSP reports ready again.
- The policy block now describes the *new* network (repeat step 2's comparison).
- **Every camera and source from steps 4 and 6 is still listed**, with its
  credentials intact: open a live view without re-entering an address.
- Sources whose address is outside the new network are shown as needing
  attention rather than deleted.

**Pass** when the policy is refreshed and not one source was lost.
**Fail** on any missing camera, any source that has to be re-entered, or a
"partial state uncertain" state that a second reinstall does not clear.

## 9. Scan everywhere a secret could have landed

Do this **last**, after every step above, and with the disposable password in
hand as `PW`. Set `URL_RE='rtsp[s]?://[^[:space:]]*@'`.

Check each of these. Every one must come back empty.

1. **PM2 logs** — the live tail and the rotated files:
   `grep -nEi "$URL_RE|$PW" /tmp/acceptance-pm2.log ~/.pm2/logs/*.log`
2. **The journal**, including the privileged installer and the stream units:
   `sudo journalctl -u homeworker-feature-install -u homeworker-stream-net -u 'homeworker-ffmpeg-stream@*' --since '-1 day' | grep -nEi "$URL_RE|$PW"`
   Also confirm no ffmpeg child stderr reached the journal at all — the stream
   unit sends output to `null` precisely because ffmpeg echoes the credentialed
   URL verbatim.
3. **The database.** Dump it and search:
   `sqlite3 "$DATABASE_PATH" .dump | grep -nEi "$URL_RE|$PW"`
   Then look at the three tables by hand:
   - `camera_live_sources` — metadata only, no address column holding a
     credential;
   - `camera_live_credentials` — ciphertext only; the plaintext password must
     not appear anywhere in the dump;
   - `telegram_camera_source_prompts` — identities, phase, operation, camera id,
     display name, lifecycle. **No URL, no address, no password.** Confirm the
     rows from steps 4–6 are terminal (`consumed`/`expired`), that the *name*
     prompts are gone entirely, and that credential tombstones carry a
     `retain_until` roughly 24 hours after they ended.
4. **Config export.** Run `/export_config` in the chat, download the document,
   and search it the same way. Live sources must appear as camera name plus a
   credential-free summary.
5. **Telegram message history.** Scroll the whole chat. Every credential reply
   from steps 4 and 6 is gone. If any survived, the bot must have said so — a
   silent survivor is a failure, an announced one is a Telegram refusal and is
   recorded as such.
6. **Callback data.** Long-press / inspect the inline keyboards on the overview,
   a detail screen and a removal confirmation. Buttons carry short opaque
   selectors and integer revisions — never a camera name, camera id, host, or
   address.
7. **Error text.** Re-read every refusal you collected in steps 5–7. None quotes
   an address, a host, a username, a process diagnostic, or a policy digest.

**Pass** only when all seven come back clean.
**Fail** on a single hit — and record where, because the location is the finding.

Finally: change the camera password.

---

## Release record

One row per Pi model / OS combination the release owner chooses to support. The
project claims no matrix beyond the rows recorded here.

| Date / operator | Pi model / RAM | Raspberry Pi OS release | Architecture | Kernel | Node | Camera model | Steps 1–8 | Step 9 secret scan | Evidence link |
|---|---|---|---|---|---|---|---|---|---|
| _not run_ | | | | | | | | | |

Attach sanitized command output, Telegram screenshots with the address blurred,
and the `telegram_camera_source_prompts` row listing from step 9.3. **Do not
attach** `.env` contents, bot tokens, chat ids, camera passwords, RTSP URLs, or
raw journal excerpts from the privileged installer.
