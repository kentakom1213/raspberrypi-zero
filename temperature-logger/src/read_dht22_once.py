import json
import sys
import time

import adafruit_dht
import board


def get_board_pin(pin_name: str):
    try:
        return getattr(board, pin_name)
    except AttributeError:
        raise ValueError(f"unknown GPIO pin: {pin_name}")


def main() -> int:
    pin_name = sys.argv[1] if len(sys.argv) >= 2 else "D4"
    retries = int(sys.argv[2]) if len(sys.argv) >= 3 else 3
    delay_seconds = float(sys.argv[3]) if len(sys.argv) >= 4 else 3.0

    pin = get_board_pin(pin_name)
    dht = adafruit_dht.DHT22(pin)

    try:
        last_error = None

        for _ in range(retries):
            try:
                temperature = dht.temperature
                humidity = dht.humidity

                if temperature is None or humidity is None:
                    raise RuntimeError("failed to read DHT22 data")

                print(
                    json.dumps(
                        {
                            "temperature": float(temperature),
                            "humidity": float(humidity),
                        }
                    )
                )

                return 0

            except RuntimeError as e:
                last_error = e
                print(f"read error: {e}", file=sys.stderr, flush=True)
                time.sleep(delay_seconds)

        print(f"failed to read DHT22 after retries: {last_error}", file=sys.stderr)
        return 1

    finally:
        dht.exit()


if __name__ == "__main__":
    raise SystemExit(main())
