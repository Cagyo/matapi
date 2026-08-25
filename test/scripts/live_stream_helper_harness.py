#!/usr/bin/python3
"""Fixture harness for scripts/live-stream-net-helper.

The Vitest suite runs one scenario per process and reads one JSON envelope on
stdout. The root bundle inspector, the fixed public summary path, nftables, and
`ip route get` are all injected here, so the helper itself keeps accepting
nothing but its closed grant/revoke protocol.
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stderr
from pathlib import Path

WORKER_UID = 501
STREAM_UID = 997
NETWORKS = [
    {"family": 4, "cidr": "192.168.1.0/24", "interface": "eth0"},
    {"family": 6, "cidr": "fd00::/64", "interface": "eth0"},
]


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class UnexpectedSubprocess(BaseException):
    """Raised outside the Exception hierarchy so the helper cannot swallow it."""


class RecordingSubprocess:
    """Stands in for the subprocess module, recording and answering every call."""

    def __init__(self, real):
        self._real = real
        self.responses = []
        self.calls = []

    def __getattr__(self, name):
        return getattr(self._real, name)

    def run(self, arguments, **keywords):
        self.calls.append({
            "argv": list(arguments),
            "env": keywords.get("env"),
            "timeout": keywords.get("timeout"),
            "check": keywords.get("check"),
            "stdin": keywords.get("stdin") == self._real.DEVNULL,
            "stderr": keywords.get("stderr") == self._real.DEVNULL,
        })
        if not self.responses:
            raise UnexpectedSubprocess(list(arguments))
        response = self.responses.pop(0)
        body = response.get("stdout", "[]").encode("utf-8")
        return self._real.CompletedProcess(arguments, response.get("returncode", 0), body, b"")


class FakeNft:
    def __init__(self):
        self.scripts = []

    def apply(self, script):
        self.scripts.append(script)


class FakeRoutes:
    """Answers the interface question without ever consulting the host kernel."""

    def __init__(self, answers=None, default="eth0"):
        self.answers = answers or {}
        self.default = default
        self.queried = []

    def interface(self, address):
        self.queried.append(address)
        return self.answers.get(address, self.default)


def document(inspector, **overrides):
    """The canonical policy version 2 document, digested by the inspector."""
    networks = overrides.get("networks", NETWORKS)
    entries = [inspector.EligibleNetwork(**entry) for entry in networks]
    version = overrides.get("version", inspector.POLICY_VERSION)
    worker_uid = overrides.get("workerUid", WORKER_UID)
    stream_uid = overrides.get("streamUid", STREAM_UID)
    first = overrides.get("udpPortFirst", 24000)
    last = overrides.get("udpPortLast", 24001)
    value = {
        "version": version,
        "workerUid": worker_uid,
        "streamUid": stream_uid,
        "networks": inspector.projection(entries),
        "udpPortFirst": first,
        "udpPortLast": last,
        "digest": inspector.policy_digest(version, worker_uid, stream_uid, entries, first, last),
    }
    value.update(overrides.get("corrupt", {}))
    return value


def policy(helper, inspector, **overrides):
    return helper.Policy(document(inspector, **overrides), inspector)


def install_summary(inspector, root, value):
    target = Path(root) / "live-stream-policy.summary.json"
    target.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(target, 0o644)
    inspector.SUMMARY_PATH = target
    inspector.EXPECTED_SUMMARY_OWNER_UID = os.getuid()


def install_policy(root, value):
    target = Path(root) / "live-stream-policy.json"
    target.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
    return str(target)


def request(**changes):
    value = {
        "op": "grant",
        "sessionId": "01901f4c-b7f4-4c6a-a787-3f8a442c85d2",
        "nonceHash": "ab" * 32,
        "addresses": ["192.168.1.20"],
        "rtspControlPorts": [554],
        "transport": "tcp",
        "expiresAtUnixMs": 1_700_000_030_000,
    }
    value.update(changes)
    return value


def bound(address, interface="eth0"):
    return {"address": address, "interface": interface}


def rejected(helper, engine, value):
    try:
        engine.handle(value)
    except helper.Reject as error:
        return {"ok": False, "reason": error.reason}
    raise AssertionError("request accepted")


def route_reason(helper, inspector, recorder, response, address="192.168.1.20"):
    """Drive the real route backend against one canned `ip route get` answer."""
    recorder.responses.append(response)
    stderr = io.StringIO()
    with redirect_stderr(stderr):
        with tempfile.TemporaryDirectory() as root:
            store = helper.StateStore(Path(root) / "state.json")
            nft = FakeNft()
            engine = helper.Engine(
                policy(helper, inspector), store, nft, helper.RouteBackend(),
                now_ms=lambda: 1_700_000_000_000, lease_id=lambda: "11" * 16,
            )
            result = rejected(helper, engine, request(addresses=[address]))
            result["rendered"] = address in nft.scripts[-1]
    result["stderr"] = stderr.getvalue()
    result["argv"] = recorder.calls[-1]["argv"] if recorder.calls else []
    return result


def run(helper, inspector, name):
    now = 1_700_000_000_000
    # Every scenario replaces the subprocess module, so no test can reach the
    # host kernel even if a future refactor moves a call site.
    recorder = RecordingSubprocess(helper.subprocess)
    helper.subprocess = recorder
    with tempfile.TemporaryDirectory() as root:
        store = helper.StateStore(Path(root) / "state.json")
        nft = FakeNft()
        routes = FakeRoutes()
        engine = helper.Engine(policy(helper, inspector), store, nft, routes, now_ms=lambda: now, lease_id=iter(["11" * 16, "22" * 16, "33" * 16]).__next__)
        if name == "constants":
            return {
                "inspectorPath": helper.POLICY_INSPECTOR_PATH,
                "ipBinary": helper.IP_BINARY,
                "ipEnvironment": helper.IP_ENVIRONMENT,
                "routeTimeoutSeconds": helper.ROUTE_TIMEOUT_SECONDS,
            }
        if name == "unknown-key":
            return rejected(helper, engine, request(command="nft flush ruleset"))
        if name == "hostname":
            return rejected(helper, engine, request(addresses=["camera.local"]))
        if name == "public-address":
            return rejected(helper, engine, request(addresses=["8.8.8.8"]))
        if name == "out-of-cidr":
            return rejected(helper, engine, request(addresses=["10.0.0.2"]))
        if name == "expired":
            return rejected(helper, engine, request(expiresAtUnixMs=now))
        if name == "udp-bounds":
            return rejected(helper, engine, request(transport="udp", udpMediaPorts={"first": 1, "last": 65535}))
        if name == "injection":
            return rejected(helper, engine, request(sessionId="01901f4c-b7f4-7c6a-a787-3f8a442c85d2;reboot"))
        if name == "replay-restart":
            first = engine.handle(request())
            restarted = helper.Engine(policy(helper, inspector), store, FakeNft(), FakeRoutes(), now_ms=lambda: now, lease_id=lambda: "22" * 16)
            result = rejected(helper, restarted, request())
            result["preservedLease"] = first["leaseId"] in restarted.state["leases"]
            return result
        if name == "exact-revoke":
            first = engine.handle(request())
            second = engine.handle(request(nonceHash="cd" * 32, sessionId="01901f4c-b7f4-4c6a-a787-3f8a442c85d3"))
            try:
                engine.handle({"op": "revoke", "sessionId": "01901f4c-b7f4-4c6a-a787-3f8a442c85d3", "leaseId": first["leaseId"]})
                wrong = False
            except helper.Reject:
                wrong = True
            engine.handle({"op": "revoke", "sessionId": "01901f4c-b7f4-4c6a-a787-3f8a442c85d2", "leaseId": first["leaseId"]})
            return {"wrongPairRejected": wrong, "firstPresent": first["leaseId"] in engine.state["leases"], "secondPresent": second["leaseId"] in engine.state["leases"]}
        if name == "stale-recovery":
            state = {"version": 1, "leases": {
                "11" * 16: {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.20")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now - 1},
                "22" * 16: {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.21")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000},
            }, "usedNonces": {"ab" * 32: now - 1, "cd" * 32: now + 30_000}}
            store.save(state)
            recovered_nft = FakeNft()
            recovered = helper.Engine(policy(helper, inspector), store, recovered_nft, FakeRoutes(), now_ms=lambda: now)
            return {"expiredPresent": "11" * 16 in recovered.state["leases"], "livePresent": "22" * 16 in recovered.state["leases"], "kernelTimeouts": "timeout 30s" in recovered_nft.scripts[-1], "routeQueries": len(recovered.routes.queried)}
        if name == "nft-policy":
            engine.handle(request())
            return {"text": nft.scripts[-1]}
        if name == "same-uid-policy":
            try:
                policy(helper, inspector, streamUid=WORKER_UID)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("same uid policy accepted")
        if name == "version-one-policy":
            try:
                helper.Policy({"version": 1, "workerUid": WORKER_UID, "streamUid": STREAM_UID, "allowedCidrs": ["192.168.0.0/16"], "udpPortFirst": 24000, "udpPortLast": 24001}, inspector)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("version one policy accepted")
        if name == "subsecond-timeout":
            leases = {"aa" * 16: {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.20")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 999}}
            at_999 = helper.render_nft(STREAM_UID, leases, now)
            leases["aa" * 16]["expiresAtUnixMs"] = now + 1000
            at_1000 = helper.render_nft(STREAM_UID, leases, now)
            return {"subsecondAllowed": "192.168.1.20" in at_999, "oneSecond": "timeout 1s" in at_1000}
        if name == "exact-address-port":
            engine.handle(request(rtspControlPorts=[8554]))
            text = nft.scripts[-1]
            return {"exact": "192.168.1.20 . 8554" in text, "blanket": 'oifname "eth0" accept' in text}
        if name == "set-name-collision":
            first_id = "abcdefabcdef" + "1" * 20
            second_id = "abcdefabcdef" + "2" * 20
            collision_engine = helper.Engine(policy(helper, inspector), store, nft, routes, now_ms=lambda: now, lease_id=iter([first_id, second_id]).__next__)
            collision_engine.handle(request())
            collision_engine.handle(request(nonceHash="cd" * 32, addresses=["192.168.1.21"]))
            text = nft.scripts[-1]
            return {"first": "l_{}_0_4_tcp".format(first_id) in text, "second": "l_{}_0_4_tcp".format(second_id) in text}
        if name == "policy-narrowing":
            store.save({"version": 1, "leases": {"66" * 16: {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.20")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}}, "usedNonces": {"ab" * 32: now + 30_000}})
            narrowed = policy(helper, inspector, networks=[{"family": 4, "cidr": "10.0.0.0/8", "interface": "eth0"}])
            recovered_nft = FakeNft(); recovered = helper.Engine(narrowed, store, recovered_nft, FakeRoutes(), now_ms=lambda: now)
            return {"leases": len(recovered.state["leases"]), "staleRule": "192.168.1.20" in recovered_nft.scripts[-1]}
        if name == "interface-narrowing":
            store.save({"version": 1, "leases": {"66" * 16: {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.20", "wlan0")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}}, "usedNonces": {"ab" * 32: now + 30_000}})
            recovered_nft = FakeNft(); recovered = helper.Engine(policy(helper, inspector), store, recovered_nft, FakeRoutes(), now_ms=lambda: now)
            return {"leases": len(recovered.state["leases"]), "staleRule": "192.168.1.20" in recovered_nft.scripts[-1]}
        if name == "stale-inspector":
            # The helper updated while the root bundle asset was not republished:
            # the file imports cleanly and only the symbol is gone.
            source = Path(inspector.__file__ or sys.argv[2]).read_text(encoding="utf-8")
            results = {}
            stale = Path(root) / "stale-inspector"
            stale.write_text(source.replace("def parse_policy_document(", "def unused_parse("), encoding="utf-8")
            helper.POLICY_INSPECTOR_PATH = str(stale)
            try:
                helper.load_policy_inspector()
                raise AssertionError("stale inspector accepted")
            except helper.Reject as error:
                results["stale"] = error.reason
            helper.POLICY_INSPECTOR_PATH = str(Path(root) / "absent")
            try:
                helper.load_policy_inspector()
                raise AssertionError("missing inspector accepted")
            except helper.Reject as error:
                results["missing"] = error.reason
            return results
        if name == "legacy-state":
            # The one-time shape every already-installed box carries in /run.
            store.save({"version": 1, "leases": {"66" * 16: {"sessionId": request()["sessionId"], "addresses": ["192.168.1.20"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}}, "usedNonces": {"ab" * 32: now + 30_000}})
            recovered_nft = FakeNft()
            recovered = helper.Engine(policy(helper, inspector), store, recovered_nft, FakeRoutes(), now_ms=lambda: now, lease_id=lambda: "77" * 16)
            replay = rejected(helper, recovered, request())
            return {"leases": len(recovered.state["leases"]), "staleRule": "192.168.1.20" in recovered_nft.scripts[-1], "replayReason": replay["reason"]}
        if name == "loopback-policy":
            try:
                policy(helper, inspector, networks=[{"family": 4, "cidr": "127.0.0.0/8", "interface": "eth0"}])
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("loopback policy accepted")
        if name == "corrupt-recovery":
            valid = {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.21")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            corrupt = {"sessionId": request()["sessionId"], "addresses": "192.168.1.99", "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            store.save({"version": 1, "leases": {"77" * 16: valid, "88" * 16: corrupt, "not-a-lease": valid}, "usedNonces": {"bad": now + 30_000, "ef" * 32: True}})
            recovered_nft = FakeNft()
            try:
                helper.Engine(policy(helper, inspector), store, recovered_nft, FakeRoutes(), now_ms=lambda: now)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason, "nftApplied": bool(recovered_nft.scripts)}
            raise AssertionError("corrupt nonce state accepted")
        if name == "corrupt-lease-recovery":
            valid = {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.21")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            corrupt = {"sessionId": request()["sessionId"], "addresses": "192.168.1.99", "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            store.save({"version": 1, "leases": {"77" * 16: valid, "88" * 16: corrupt, "not-a-lease": valid}, "usedNonces": {}})
            recovered_nft = FakeNft(); recovered = helper.Engine(policy(helper, inspector), store, recovered_nft, FakeRoutes(), now_ms=lambda: now)
            return {"leases": list(recovered.state["leases"]), "corruptRule": "192.168.1.99" in recovered_nft.scripts[-1]}
        if name == "expired-next-grant":
            store.save({"version": 1, "leases": {"44" * 16: {"sessionId": request()["sessionId"], "addresses": [bound("192.168.1.99")], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now - 1}}, "usedNonces": {}})
            next_nft = FakeNft()
            next_engine = helper.Engine(policy(helper, inspector), store, next_nft, FakeRoutes(), now_ms=lambda: now, lease_id=lambda: "55" * 16)
            next_engine.handle(request())
            return {"expiredRendered": "192.168.1.99" in next_nft.scripts[-1], "newRendered": "192.168.1.20" in next_nft.scripts[-1]}
        if name == "ipv6-ula-policy":
            return {"address": policy(helper, inspector).address("fd00::20")}
        if name == "dual-family-render":
            engine.handle(request(addresses=["192.168.1.20", "fd00::20"], transport="udp", udpMediaPorts={"first": 24000, "last": 24001}))
            text = nft.scripts[-1]
            return {
                "v4Rule": 'meta skuid 997 oifname "eth0" ip daddr . tcp dport @l_{}_0_4_tcp accept'.format("11" * 16) in text,
                "v6Rule": 'meta skuid 997 oifname "eth0" ip6 daddr . tcp dport @l_{}_0_6_tcp accept'.format("11" * 16) in text,
                "v4Udp": 'meta skuid 997 oifname "eth0" ip daddr @l_{}_0_4_udp udp sport 24000-24001 accept'.format("11" * 16) in text,
                "v6Udp": 'meta skuid 997 oifname "eth0" ip6 daddr @l_{}_0_6_udp udp sport 24000-24001 accept'.format("11" * 16) in text,
                "v4Element": "192.168.1.20 . 554 timeout 30s" in text,
                "v6Element": "fd00::20 . 554 timeout 30s" in text,
            }
        if name == "multi-interface-render":
            multi = policy(helper, inspector, networks=[
                {"family": 4, "cidr": "10.0.0.0/8", "interface": "wlan0"},
                {"family": 4, "cidr": "192.168.1.0/24", "interface": "eth0"},
            ])
            multi_routes = FakeRoutes({"192.168.1.20": "eth0", "10.0.0.5": "wlan0"})
            multi_nft = FakeNft()
            multi_engine = helper.Engine(multi, store, multi_nft, multi_routes, now_ms=lambda: now, lease_id=lambda: "11" * 16)
            multi_engine.handle(request(addresses=["192.168.1.20", "10.0.0.5"]))
            text = multi_nft.scripts[-1]
            return {
                "eth0Rule": 'oifname "eth0" ip daddr . tcp dport @l_{}_0_4_tcp accept'.format("11" * 16) in text,
                "wlan0Rule": 'oifname "wlan0" ip daddr . tcp dport @l_{}_1_4_tcp accept'.format("11" * 16) in text,
                "eth0Element": "l_{}_0_4_tcp {{ type ipv4_addr . inet_service; flags timeout; elements = {{ 192.168.1.20 . 554 timeout 30s }}; }}".format("11" * 16) in text,
                "wlan0Element": "l_{}_1_4_tcp {{ type ipv4_addr . inet_service; flags timeout; elements = {{ 10.0.0.5 . 554 timeout 30s }}; }}".format("11" * 16) in text,
            }
        if name == "route-match":
            recorder.responses.append({"stdout": json.dumps([{"dst": "192.168.1.20", "dev": "eth0", "prefsrc": "192.168.1.10", "flags": []}])})
            real_nft = FakeNft()
            real = helper.Engine(policy(helper, inspector), store, real_nft, helper.RouteBackend(), now_ms=lambda: now, lease_id=lambda: "11" * 16)
            result = real.handle(request())
            return {
                "ok": result["ok"],
                "call": recorder.calls[-1],
                "oifname": 'oifname "eth0" ip daddr . tcp dport' in real_nft.scripts[-1],
            }
        if name == "route-other-interface":
            return route_reason(helper, inspector, recorder, {"stdout": json.dumps([{"dst": "192.168.1.20", "dev": "eth1", "flags": []}])})
        if name == "route-vpn":
            return route_reason(helper, inspector, recorder, {"stdout": json.dumps([{"dst": "192.168.1.20", "dev": "tun0", "flags": []}])})
        if name == "route-bridge":
            return route_reason(helper, inspector, recorder, {"stdout": json.dumps([{"dst": "192.168.1.20", "dev": "br0", "flags": []}])})
        if name == "route-gateway":
            return route_reason(helper, inspector, recorder, {"stdout": json.dumps([{"dst": "192.168.1.20", "gateway": "192.168.1.1", "dev": "eth0", "flags": []}])})
        if name == "route-malformed":
            return route_reason(helper, inspector, recorder, {"stdout": "Error: any valid prefix is expected rather than 192.168.1.20/x.\n"})
        if name == "route-unavailable":
            return route_reason(helper, inspector, recorder, {"returncode": 2, "stdout": ""})
        if name == "route-family":
            recorder.responses.append({"stdout": json.dumps([{"dst": "fd00::20", "dev": "eth0", "flags": []}])})
            real_nft = FakeNft()
            real = helper.Engine(policy(helper, inspector), store, real_nft, helper.RouteBackend(), now_ms=lambda: now, lease_id=lambda: "11" * 16)
            real.handle(request(addresses=["fd00::20"]))
            return {"argv": recorder.calls[-1]["argv"], "oifname": 'oifname "eth0" ip6 daddr . tcp dport' in real_nft.scripts[-1]}
        if name == "summary-match":
            value = document(inspector)
            install_summary(inspector, root, value)
            loaded = helper.load_verified_policy(install_policy(root, value), inspector)
            return {"digest": loaded.digest, "streamUid": loaded.stream_uid}
        if name == "summary-uid-mismatch":
            # A recreated `homeworker-stream` account changes the private policy
            # without changing any route, so nothing but this cross-check sees it.
            install_summary(inspector, root, document(inspector, streamUid=STREAM_UID + 1))
            path = install_policy(root, document(inspector))
            try:
                helper.load_verified_policy(path, inspector)
            except helper.Reject as error:
                # Both nft and `ip` run through the recorded subprocess module,
                # so an empty call list proves nothing was applied to the kernel.
                return {"ok": False, "reason": error.reason, "subprocessCalls": len(recorder.calls)}
            raise AssertionError("mismatched summary accepted")
        if name == "summary-udp-mismatch":
            install_summary(inspector, root, document(inspector, udpPortLast=24005))
            path = install_policy(root, document(inspector))
            try:
                helper.load_verified_policy(path, inspector)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("mismatched summary accepted")
        if name == "summary-missing":
            inspector.SUMMARY_PATH = Path(root) / "absent.json"
            path = install_policy(root, document(inspector))
            try:
                helper.load_verified_policy(path, inspector)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("missing summary accepted")
        if name == "corrupt-digest-policy":
            value = document(inspector)
            install_summary(inspector, root, value)
            path = install_policy(root, document(inspector, corrupt={"digest": "0" * 64}))
            try:
                helper.load_verified_policy(path, inspector)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("corrupt digest accepted")
        if name == "slow-client":
            class Slow:
                chunks = [b"{", b'"op"', b':"grant"}\\n']
                def settimeout(self, _value): pass
                def recv(self, _size):
                    clock[0] += 0.6
                    return self.chunks.pop(0)
            clock = [0.0]
            original = helper.time.monotonic
            helper.time.monotonic = lambda: clock[0]
            try:
                helper.read_capped_request(Slow(), 1.0)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            finally:
                helper.time.monotonic = original
            raise AssertionError("slow client accepted")
        if name == "broken-write":
            class Broken:
                def settimeout(self, _value): pass
                def sendall(self, _value): raise BrokenPipeError()
            return {"sent": helper.send_response(Broken(), {"ok": False, "reason": "peer"})}
        if name == "duplicate-key":
            try:
                helper.strict_json_loads('{"op":"grant","op":"revoke"}')
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("duplicate key accepted")
        raise AssertionError(name)


if __name__ == "__main__":
    helper = load("live_stream_net_helper", sys.argv[1])
    inspector = load("live_stream_policy_inspector", sys.argv[2])
    print(json.dumps(run(helper, inspector, sys.argv[3]), separators=(",", ":")))
