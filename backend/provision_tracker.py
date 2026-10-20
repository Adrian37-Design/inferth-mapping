"""One-step provisioning for a new Xcela tracker.

Generates the tracker's signing secret, registers it with the platform
(platform admin token required), and writes jwt-secret.txt for the
SPIFFS upload — the same step already done when flashing the tracker.

Usage:
    python provision_tracker.py <IMEI> --token <platform admin JWT>
    python provision_tracker.py <IMEI> --token <JWT> --server https://www.inferthmapping.co.zw

The generated file lands in provisioned/<IMEI>/jwt-secret.txt. Copy it into
the sketch's data/ folder and upload to the tracker's SPIFFS as usual.
The secret is never printed. Re-running for the same IMEI rotates the secret.
"""

import argparse
import json
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Provision a tracker secret and register it with the platform")
    parser.add_argument("imei", help="Tracker IMEI exactly as shown on the Devices page")
    parser.add_argument("--server", default="https://www.inferthmapping.co.zw")
    parser.add_argument("--token", required=True, help="Platform admin JWT (log in and copy it from the browser session)")
    parser.add_argument("--out", default="provisioned", help="Output directory for jwt-secret.txt")
    args = parser.parse_args()

    secret = secrets.token_hex(36)  # 72 chars — fits the firmware's jwt_secret[73] buffer

    request = urllib.request.Request(
        f"{args.server.rstrip('/')}/tracker-secrets/{args.imei.strip()}",
        data=json.dumps({"secret": secret}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {args.token}"},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                print(f"Registration failed: HTTP {response.status}")
                return 1
    except urllib.error.HTTPError as exc:
        print(f"Registration failed: HTTP {exc.code} {exc.read().decode()[:200]}")
        return 1
    except urllib.error.URLError as exc:
        print(f"Registration failed: {exc.reason}")
        return 1

    out_dir = Path(args.out) / args.imei.strip()
    out_dir.mkdir(parents=True, exist_ok=True)
    secret_file = out_dir / "jwt-secret.txt"
    secret_file.write_text(secret)

    print(f"Registered {args.imei} with the platform.")
    print(f"Secret file: {secret_file}")
    print("Copy it into the sketch's data/ folder and upload to the tracker's SPIFFS.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
