#!/usr/bin/python3
"""Fixture harness for scripts/live-stream-policy-inspector.

The Vitest suite pipes one JSON fixture on stdin and reads one JSON envelope on
stdout. Network state, the device-backed interface set, and the fixed summary
path are injected here so the inspector itself keeps accepting nothing but its
two closed commands.
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


def load(path):
    loader = importlib.machinery.SourceFileLoader("live_stream_policy_inspector", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class UnexpectedSubprocess(BaseException):
    """Raised outside the Exception hierarchy so the inspector cannot swallow it."""


class RecordingSubprocess:
    """Stands in for the subprocess module, recording and answering every call."""

    def __init__(self, real, responses=()):
        self._real = real
        self._responses = list(responses)
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
        if not self._responses:
            raise UnexpectedSubprocess(list(arguments))
        response = self._responses.pop(0)
        if "size" in response:
            body = b"[" + b" " * (response["size"] - 2) + b"]"
        else:
            body = response.get("stdout", "[]").encode("utf-8")
        return self._real.CompletedProcess(arguments, response.get("returncode", 0), body, b"")


def inject_network_state(module, fixture):
    links = fixture.get("links", [])
    routes = fixture.get("routes", [])
    devices = set(fixture.get("physicalDevices", []))
    module.read_link_state = lambda: ([("link", json.dumps(links))], links)
    module.read_route_state = lambda: ([("route4", json.dumps(routes))], routes)
    module.collect_physical_devices = lambda: devices


def capture(module, argv):
    out = io.StringIO()
    err = io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = module.main(argv)
    raw = out.getvalue()
    try:
        parsed = json.loads(raw)
    except ValueError:
        parsed = None
    return {"exitCode": code, "stdout": parsed, "stdoutRaw": raw, "stderr": err.getvalue()}


def build_summary(module, spec, discovered):
    if "raw" in spec:
        return spec["raw"]
    networks = spec.get("networks", discovered)
    version = spec.get("version", module.POLICY_VERSION)
    worker_uid = spec.get("workerUid", 1001)
    stream_uid = spec.get("streamUid", 1002)
    first = spec.get("udpPortFirst", 24000)
    last = spec.get("udpPortLast", 24001)
    entries = [module.EligibleNetwork(entry["family"], entry["cidr"], entry["interface"]) for entry in networks]
    payload = {
        "version": version,
        "workerUid": worker_uid,
        "streamUid": stream_uid,
        "networks": [{"family": entry.family, "cidr": entry.cidr, "interface": entry.interface} for entry in entries],
        "udpPortFirst": first,
        "udpPortLast": last,
        "digest": module.policy_digest(version, worker_uid, stream_uid, entries, first, last),
    }
    payload.update(spec.get("overrides", {}))
    for key in spec.get("omit", []):
        payload.pop(key, None)
    return json.dumps(payload)


def install_summary(module, spec, root, discovered):
    target = Path(root) / "live-stream-policy.summary.json"
    module.EXPECTED_SUMMARY_OWNER_UID = os.getuid() + 1 if spec.get("ownerMismatch") else os.getuid()
    module.SUMMARY_PATH = target
    if spec.get("missing"):
        return
    if spec.get("symlink"):
        real = Path(root) / "real.json"
        real.write_text(build_summary(module, spec, discovered), encoding="utf-8")
        os.chmod(real, spec.get("mode", 0o644))
        os.symlink(real, target)
        return
    target.write_text(build_summary(module, spec, discovered), encoding="utf-8")
    os.chmod(target, spec.get("mode", 0o644))
    if spec.get("hardlink"):
        os.link(target, Path(root) / "extra.json")


def fake_sys_class_net(module, root, entries):
    net = Path(root) / "net"
    net.mkdir()
    backing = Path(root) / "backing"
    backing.mkdir()
    for entry in entries:
        device = net / entry["name"]
        device.mkdir()
        (device / "type").write_text("{}\n".format(entry.get("type", 1)), encoding="utf-8")
        if entry.get("device", True):
            os.symlink(backing, device / "device")
    module.SYS_CLASS_NET = net


def run(module, mode, fixture):
    # Every mode replaces the subprocess module, so no scenario can reach the
    # host network even if a future refactor moves a call site.
    recorder = RecordingSubprocess(module.subprocess, fixture.get("responses", []))
    module.subprocess = recorder
    if mode == "constants":
        return {
            "ipBinary": module.IP_BINARY,
            "ipEnvironment": module.IP_ENVIRONMENT,
            "ipTimeoutSeconds": module.IP_TIMEOUT_SECONDS,
            "summaryPath": str(module.SUMMARY_PATH),
            "sysClassNet": str(module.SYS_CLASS_NET),
            "summaryOwnerUid": module.EXPECTED_SUMMARY_OWNER_UID,
            "summaryMode": module.EXPECTED_SUMMARY_MODE,
            "policyVersion": module.POLICY_VERSION,
            "maxOutputBytes": module.MAX_OUTPUT_BYTES,
            "commands": sorted(module.VALID_COMMANDS),
        }
    if mode == "contract":
        entries = [module.EligibleNetwork(4, "192.168.1.0/24", "eth0")]
        valid = {
            "version": module.POLICY_VERSION,
            "workerUid": 1001,
            "streamUid": 1002,
            "networks": module.projection(entries),
            "udpPortFirst": 24000,
            "udpPortLast": 24001,
            "digest": module.policy_digest(module.POLICY_VERSION, 1001, 1002, entries, 24000, 24001),
        }
        result = {"policyFields": list(module.POLICY_FIELDS), "policyKeys": sorted(module.POLICY_KEYS)}
        parsed = module.parse_policy_document(valid)
        result["parsed"] = {"digest": parsed[6], "networks": module.projection(parsed[3])}
        try:
            module.parse_policy_document({**valid, "streamGid": 1002})
            result["unknownField"] = "accepted"
        except module.PolicyDocumentInvalid as error:
            result["unknownField"] = str(error)
        # The drift the shared parser exists to prevent: a field admitted to the
        # contract every verifier accepts, but forgotten in the digest payload
        # those verifiers compare. It must fail loudly rather than silently stop
        # being covered.
        module.POLICY_FIELDS = module.POLICY_FIELDS + ("streamGid",)
        module.POLICY_KEYS = frozenset(module.POLICY_FIELDS) | {"digest"}
        try:
            module.policy_digest(module.POLICY_VERSION, 1001, 1002, entries, 24000, 24001)
            result["forgottenField"] = "digested"
        except KeyError as error:
            result["forgottenField"] = "refused:" + str(error.args[0])
        # The positive half: a field added to both the list and the payload
        # changes the digest and is accepted, so the guard above catches drift
        # rather than freezing the contract.
        module.policy_payload = lambda version, worker_uid, stream_uid, networks, first, last: {
            "version": version,
            "workerUid": worker_uid,
            "streamUid": stream_uid,
            "networks": module.projection(networks),
            "udpPortFirst": first,
            "udpPortLast": last,
            "streamGid": 4242,
        }
        extended_digest = module.policy_digest(module.POLICY_VERSION, 1001, 1002, entries, 24000, 24001)
        result["extendedDigestChanged"] = extended_digest != valid["digest"]
        extended = {**valid, "streamGid": 4242, "digest": extended_digest}
        try:
            result["extendedAccepted"] = module.parse_policy_document(extended)[6] == extended_digest
        except module.PolicyDocumentInvalid as error:
            result["extendedAccepted"] = str(error)
        return result
    if mode == "ip":
        result = {}
        try:
            link_payloads, links = module.read_link_state()
            route_payloads, routes = module.read_route_state()
            result["links"] = links
            result["routes"] = routes
            result["journalLabels"] = [label for label, _raw in link_payloads + route_payloads]
        except module.Unavailable as error:
            result["unavailable"] = str(error)
        result["calls"] = recorder.calls
        return result
    if mode == "command":
        result = capture(module, fixture["argv"])
        result["subprocessCalls"] = len(recorder.calls)
        return result
    if mode == "discover":
        inject_network_state(module, fixture)
        return capture(module, ["discover"])
    if mode == "verify":
        inject_network_state(module, fixture)
        try:
            discovered = [
                {"family": entry.family, "cidr": entry.cidr, "interface": entry.interface}
                for entry in module.current_networks()
            ]
        except Exception:
            discovered = []
        with tempfile.TemporaryDirectory(prefix="lspi-") as root:
            install_summary(module, fixture.get("summary", {}), root, discovered)
            return capture(module, ["verify-installed"])
    if mode == "physical-devices":
        with tempfile.TemporaryDirectory(prefix="lspi-") as root:
            fake_sys_class_net(module, root, fixture["entries"])
            return {"devices": sorted(module.collect_physical_devices())}
    raise AssertionError(mode)


if __name__ == "__main__":
    inspector = load(sys.argv[1])
    payload = json.loads(sys.stdin.read() or "{}")
    print(json.dumps(run(inspector, sys.argv[2], payload), separators=(",", ":")))
