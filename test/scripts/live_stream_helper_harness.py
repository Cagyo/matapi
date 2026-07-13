#!/usr/bin/python3
import importlib.machinery
import importlib.util
import json
import sys
import tempfile
from pathlib import Path


def load_helper(path):
    loader = importlib.machinery.SourceFileLoader("live_stream_net_helper", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class FakeNft:
    def __init__(self):
        self.scripts = []

    def apply(self, script):
        self.scripts.append(script)


def policy(helper):
    return helper.Policy({
        "version": 1,
        "workerUid": 501,
        "streamUid": 997,
        "allowedCidrs": ["192.168.0.0/16", "fd00::/64"],
        "udpPortFirst": 24000,
        "udpPortLast": 24001,
    })


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


def rejected(helper, engine, value):
    try:
        engine.handle(value)
    except helper.Reject as error:
        return {"ok": False, "reason": error.reason}
    raise AssertionError("request accepted")


def run(helper, name):
    now = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as root:
        store = helper.StateStore(Path(root) / "state.json")
        nft = FakeNft()
        engine = helper.Engine(policy(helper), store, nft, now_ms=lambda: now, lease_id=iter(["11" * 16, "22" * 16, "33" * 16]).__next__)
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
            restarted = helper.Engine(policy(helper), store, FakeNft(), now_ms=lambda: now, lease_id=lambda: "22" * 16)
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
                "11" * 16: {"sessionId": request()["sessionId"], "addresses": ["192.168.1.20"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now - 1},
                "22" * 16: {"sessionId": request()["sessionId"], "addresses": ["192.168.1.21"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000},
            }, "usedNonces": {"ab" * 32: now - 1, "cd" * 32: now + 30_000}}
            store.save(state)
            recovered_nft = FakeNft()
            recovered = helper.Engine(policy(helper), store, recovered_nft, now_ms=lambda: now)
            return {"expiredPresent": "11" * 16 in recovered.state["leases"], "livePresent": "22" * 16 in recovered.state["leases"], "kernelTimeouts": "timeout 30s" in recovered_nft.scripts[-1]}
        if name == "nft-policy":
            engine.handle(request())
            return {"text": nft.scripts[-1]}
        if name == "same-uid-policy":
            try:
                helper.Policy({"version": 1, "workerUid": 501, "streamUid": 501, "allowedCidrs": ["192.168.0.0/16"], "udpPortFirst": 24000, "udpPortLast": 24001})
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason}
            raise AssertionError("same uid policy accepted")
        if name == "subsecond-timeout":
            leases = {"aa" * 16: {"sessionId": request()["sessionId"], "addresses": ["192.168.1.20"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 999}}
            at_999 = helper.render_nft(997, leases, now)
            leases["aa" * 16]["expiresAtUnixMs"] = now + 1000
            at_1000 = helper.render_nft(997, leases, now)
            return {"subsecondAllowed": "192.168.1.20" in at_999, "oneSecond": "timeout 1s" in at_1000}
        if name == "loopback-exact":
            loopback_policy = helper.Policy({"version": 1, "workerUid": 501, "streamUid": 997, "allowedCidrs": ["127.0.0.0/8"], "udpPortFirst": 24000, "udpPortLast": 24001})
            loopback_nft = FakeNft(); loopback = helper.Engine(loopback_policy, store, loopback_nft, now_ms=lambda: now, lease_id=lambda: "99" * 16)
            loopback.handle(request(addresses=["127.0.0.1"], rtspControlPorts=[8554]))
            text = loopback_nft.scripts[-1]
            return {"exact": "127.0.0.1 . 8554" in text, "blanket": 'oifname "lo" accept' in text}
        if name == "set-name-collision":
            first_id = "abcdefabcdef" + "1" * 20
            second_id = "abcdefabcdef" + "2" * 20
            collision_engine = helper.Engine(policy(helper), store, nft, now_ms=lambda: now, lease_id=iter([first_id, second_id]).__next__)
            collision_engine.handle(request())
            collision_engine.handle(request(nonceHash="cd" * 32, addresses=["192.168.1.21"]))
            text = nft.scripts[-1]
            return {"first": "l_{}_4_tcp".format(first_id) in text, "second": "l_{}_4_tcp".format(second_id) in text}
        if name == "policy-narrowing":
            store.save({"version": 1, "leases": {"66" * 16: {"sessionId": request()["sessionId"], "addresses": ["192.168.1.20"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}}, "usedNonces": {"ab" * 32: now + 30_000}})
            narrowed = helper.Policy({"version": 1, "workerUid": 501, "streamUid": 997, "allowedCidrs": ["10.0.0.0/8"], "udpPortFirst": 24000, "udpPortLast": 24001})
            recovered_nft = FakeNft(); recovered = helper.Engine(narrowed, store, recovered_nft, now_ms=lambda: now)
            return {"leases": len(recovered.state["leases"]), "staleRule": "192.168.1.20" in recovered_nft.scripts[-1]}
        if name == "corrupt-recovery":
            valid = {"sessionId": request()["sessionId"], "addresses": ["192.168.1.21"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            corrupt = {"sessionId": request()["sessionId"], "addresses": "192.168.1.99", "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            store.save({"version": 1, "leases": {"77" * 16: valid, "88" * 16: corrupt, "not-a-lease": valid}, "usedNonces": {"bad": now + 30_000, "ef" * 32: True}})
            recovered_nft = FakeNft()
            try:
                helper.Engine(policy(helper), store, recovered_nft, now_ms=lambda: now)
            except helper.Reject as error:
                return {"ok": False, "reason": error.reason, "nftApplied": bool(recovered_nft.scripts)}
            raise AssertionError("corrupt nonce state accepted")
        if name == "corrupt-lease-recovery":
            valid = {"sessionId": request()["sessionId"], "addresses": ["192.168.1.21"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            corrupt = {"sessionId": request()["sessionId"], "addresses": "192.168.1.99", "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now + 30_000}
            store.save({"version": 1, "leases": {"77" * 16: valid, "88" * 16: corrupt, "not-a-lease": valid}, "usedNonces": {}})
            recovered_nft = FakeNft(); recovered = helper.Engine(policy(helper), store, recovered_nft, now_ms=lambda: now)
            return {"leases": list(recovered.state["leases"]), "corruptRule": "192.168.1.99" in recovered_nft.scripts[-1]}
        if name == "expired-next-grant":
            store.save({"version": 1, "leases": {"44" * 16: {"sessionId": request()["sessionId"], "addresses": ["192.168.1.99"], "rtspControlPorts": [554], "transport": "tcp", "udpMediaPorts": None, "expiresAtUnixMs": now - 1}}, "usedNonces": {}})
            next_nft = FakeNft()
            next_engine = helper.Engine(policy(helper), store, next_nft, now_ms=lambda: now, lease_id=lambda: "55" * 16)
            next_engine.handle(request())
            return {"expiredRendered": "192.168.1.99" in next_nft.scripts[-1], "newRendered": "192.168.1.20" in next_nft.scripts[-1]}
        if name == "ipv6-ula-policy":
            ula = helper.Policy({"version": 1, "workerUid": 501, "streamUid": 997, "allowedCidrs": ["fd00::/8"], "udpPortFirst": 24000, "udpPortLast": 24001})
            return {"address": ula.address("fd12::20")}
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
    helper = load_helper(sys.argv[1])
    print(json.dumps(run(helper, sys.argv[2]), separators=(",", ":")))
