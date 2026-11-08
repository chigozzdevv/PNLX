import base64
import binascii
import hashlib
import json
import os
import re
import socketserver
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("PNLX_RISC0_WRAP_SOCKET", "/run/pnlx-risc0-wrap/prover.sock"))
PROJECT_ROOT = Path(os.environ.get("PNLX_RISC0_PROJECT_ROOT", "/home/ubuntu/PNLX"))
PROVER = Path(os.environ.get(
    "PNLX_RISC0_PROVER_BIN",
    str(PROJECT_ROOT / "risc0/batch-match/target/release/pnlx-risc0-batch-match-prover"),
))
WORK_ROOT = Path(os.environ.get("PNLX_RISC0_WRAP_ROOT", "/var/lib/pnlx-risc0-wrap"))
TIMEOUT_SECONDS = int(os.environ.get("PNLX_RISC0_WRAP_TIMEOUT_SECONDS", "1860"))
MAX_REQUEST_BYTES = 128 * 1024 * 1024
IMAGE_ID_PATTERN = re.compile(r"^0x[0-9a-fA-F]{64}$")
WRAP_LOCK = threading.Lock()


class WrapHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/wrap":
            self.send_json(404, {"error_code": "NOT_FOUND"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error_code": "INVALID_CONTENT_LENGTH"})
            return
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error_code": "REQUEST_SIZE_INVALID"})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error_code": "CONTENT_TYPE_INVALID"})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error_code": "INVALID_JSON"})
            return
        if not isinstance(payload, dict) or set(payload) != {"image_id", "receipt_b64"}:
            self.send_json(400, {"error_code": "INVALID_REQUEST"})
            return
        image_id = payload.get("image_id")
        receipt_b64 = payload.get("receipt_b64")
        if not isinstance(image_id, str) or not IMAGE_ID_PATTERN.fullmatch(image_id):
            self.send_json(400, {"error_code": "INVALID_IMAGE_ID"})
            return
        if not isinstance(receipt_b64, str) or not receipt_b64:
            self.send_json(400, {"error_code": "INVALID_RECEIPT"})
            return
        try:
            receipt = base64.b64decode(receipt_b64, validate=True)
        except (ValueError, binascii.Error):
            self.send_json(400, {"error_code": "INVALID_RECEIPT"})
            return
        if not receipt or base64.b64encode(receipt).decode("ascii") != receipt_b64:
            self.send_json(400, {"error_code": "INVALID_RECEIPT"})
            return
        if not PROVER.is_file() or not os.access(PROVER, os.X_OK):
            self.send_json(503, {"error_code": "PROVER_UNAVAILABLE"})
            return
        if not WRAP_LOCK.acquire(timeout=TIMEOUT_SECONDS):
            self.send_json(503, {"error_code": "WRAP_QUEUE_TIMEOUT"})
            return
        started = time.monotonic()
        try:
            response = self.run_wrap(receipt, image_id)
            response["duration_ms"] = int((time.monotonic() - started) * 1000)
            self.send_json(200, response)
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error_code": "WRAP_TIMEOUT"})
        except Exception:
            self.send_json(500, {"error_code": "CPU_WRAP_FAILED"})
        finally:
            WRAP_LOCK.release()

    def run_wrap(self, receipt, image_id):
        WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="wrap-", dir=WORK_ROOT) as temp_dir:
            work_dir = Path(temp_dir)
            os.chmod(work_dir, 0o700)
            receipt_path = work_dir / "receipt.json"
            output_dir = work_dir / "output"
            output_dir.mkdir(mode=0o700)
            receipt_path.write_bytes(receipt)
            os.chmod(receipt_path, 0o600)
            environment = os.environ.copy()
            environment["PNLX_EXPECTED_BATCH_MATCH_IMAGE_ID"] = image_id
            environment["RISC0_DEV_MODE"] = "0"
            environment["RISC0_PROVER"] = "local"
            subprocess.run(
                [str(PROVER), "--wrap", str(receipt_path), str(output_dir)],
                cwd=PROJECT_ROOT,
                env=environment,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=TIMEOUT_SECONDS,
                check=True,
            )
            metadata = json.loads((output_dir / "proof.json").read_text(encoding="utf-8"))
            journal = (output_dir / "journal.bin").read_bytes()
            seal = (output_dir / "seal.bin").read_bytes()
            journal_digest = "0x" + hashlib.sha256(journal).hexdigest()
            seal_digest = "0x" + hashlib.sha256(seal).hexdigest()
            if metadata.get("image_id", "").lower() != image_id.lower():
                raise ValueError("image id mismatch")
            if metadata.get("journal_digest", "").lower() != journal_digest:
                raise ValueError("journal digest mismatch")
            if metadata.get("seal_digest", "").lower() != seal_digest:
                raise ValueError("seal digest mismatch")
            return {
                "image_id": image_id.lower(),
                "journal_b64": base64.b64encode(journal).decode("ascii"),
                "journal_digest": journal_digest,
                "seal_b64": base64.b64encode(seal).decode("ascii"),
                "seal_digest": seal_digest,
            }

    def send_json(self, status, payload):
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format, *_args):
        return


class WrapServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 8


def main():
    if TIMEOUT_SECONDS <= 0:
        raise RuntimeError("invalid wrap timeout")
    SOCKET_PATH.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    SOCKET_PATH.unlink(missing_ok=True)
    with WrapServer(str(SOCKET_PATH), WrapHandler) as server:
        os.chmod(SOCKET_PATH, 0o660)
        server.serve_forever(poll_interval=1)


if __name__ == "__main__":
    main()
