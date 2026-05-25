import json
import subprocess
import sys
from pathlib import Path


class DHT22Reader:
    def __init__(
        self,
        pin_name: str,
        retries: int = 3,
        delay_seconds: float = 3.0,
    ) -> None:
        self.pin_name = pin_name
        self.retries = retries
        self.delay_seconds = delay_seconds
        self.script_path = Path(__file__).resolve().parent / "read_dht22_once.py"

    def read(self) -> tuple[float, float]:
        timeout_seconds = self.retries * self.delay_seconds + 15

        result = subprocess.run(
            [
                sys.executable,
                str(self.script_path),
                self.pin_name,
                str(self.retries),
                str(self.delay_seconds),
            ],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )

        if result.returncode != 0:
            message = result.stderr.strip() or result.stdout.strip()
            raise RuntimeError(f"DHT22 read subprocess failed: {message}")

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"failed to parse DHT22 output: {result.stdout.strip()}"
            ) from e

        return float(data["temperature"]), float(data["humidity"])

    def close(self) -> None:
        pass
