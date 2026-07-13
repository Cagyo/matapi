#!/usr/bin/python3
import importlib.machinery
import importlib.util
import json
import os
import socket
import stat
import sys
import tempfile
import time
from pathlib import Path


def load(path):
    loader = importlib.machinery.SourceFileLoader("live_stream_ffmpeg_runner", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def run(module, name):
    session = "01901f4c-b7f4-4c6a-a787-3f8a442c85d2"
    with tempfile.TemporaryDirectory(prefix="lsr-", dir="/tmp") as root:
        config_root = Path(root) / "config"
        output_root = Path(root) / "output"
        config_root.mkdir(mode=0o730)
        os.chmod(config_root, 0o2730)
        output_root.mkdir(mode=0o770)
        sock = socket.socket(socket.AF_UNIX)
        socket_path = output_root / (session + ".sock")
        sock.bind(str(socket_path)); os.chmod(socket_path, 0o660)
        module.CONFIG_ROOT = config_root; module.OUTPUT_ROOT = output_root
        module.EXPECTED_CONFIG_OWNER_UID = os.getuid()
        module.EXPECTED_CONFIG_PARENT_MODE = stat.S_IMODE(config_root.lstat().st_mode)
        module.EXPECTED_SHARED_GID = config_root.lstat().st_gid
        module.EXPECTED_STREAM_UID = os.getuid() + 1
        module.EXPECTED_CA_OWNER_UID = os.getuid()
        ca_root = Path(root) / "ca"
        ca_root.mkdir(mode=0o755)
        ca_file = ca_root / "camera.pem"
        ca_file.write_text("test-ca", encoding="utf-8")
        os.chmod(ca_file, 0o644)
        module.CA_ROOTS = (ca_root,)
        url = "rtsp://user:p%40ss@192.168.1.20/live?x=it's-one-arg-$(reboot);still-one-arg"
        value = {"version": 1, "sessionId": session, "inputUrl": url, "tlsServerName": None, "transport": "tcp", "tlsMode": "none", "profile": "eco", "udpPortFirst": 24000, "udpPortLast": 24001, "outputSocket": str(socket_path), "expiresAtUnixMs": int(time.time() * 1000) + 30_000, "ownerUid": os.getuid(), "caFile": None}
        if name == "unknown": value["command"] = "reboot"
        if name == "wrong-output": value["outputSocket"] = "/tmp/attacker.sock"
        if name == "hostname": value["inputUrl"] = "rtsp://user:pass@camera.local/live"
        if name == "strict-ca":
            value["inputUrl"] = "rtsps://user:pass@192.168.1.20/live"
            value["tlsMode"] = "strict"
            value["tlsServerName"] = "camera.local"
            value["caFile"] = str(ca_file)
        config_path = config_root / (session + ".json")
        if name == "duplicate":
            config_path.write_text(json.dumps(value)[:-1] + ',"profile":"quality"}\n', encoding="utf-8")
        else:
            config_path.write_text(json.dumps(value) + "\n", encoding="utf-8")
        os.chmod(config_path, 0o640)
        try:
            config, hostname = module.load(session)
            input_fd = 9
            argv = module.arguments(config, hostname, input_fd)
            concat = module.ffconcat_document(config, hostname)
            result = {"ok": True, "configRemoved": not config_path.exists(), "inputArg": argv[argv.index("-i") + 1], "argvContainsSecret": any("user:p%40ss" in part for part in argv), "concat": concat, "shellPresent": any(part in ("sh", "bash", "-c") for part in argv), "output": argv[-1]}
        except SystemExit:
            result = {"ok": False, "configPresent": config_path.exists()}
        sock.close()
        return result


if __name__ == "__main__":
    print(json.dumps(run(load(sys.argv[1]), sys.argv[2]), separators=(",", ":")))
