import time

import adafruit_dht
import board


def get_board_pin(pin_name: str):
    try:
        return getattr(board, pin_name)
    except AttributeError:
        raise ValueError(f"unknown GPIO pin: {pin_name}")


class DHT22Reader:
    def __init__(
        self,
        pin_name: str,
        retries: int = 3,
        delay_seconds: float = 3.0,
    ) -> None:
        pin = get_board_pin(pin_name)
        self.dht = adafruit_dht.DHT22(pin)
        self.retries = retries
        self.delay_seconds = delay_seconds

    def read(self) -> tuple[float, float]:
        last_error = None

        for _ in range(self.retries):
            try:
                temperature = self.dht.temperature
                humidity = self.dht.humidity

                if temperature is None or humidity is None:
                    raise RuntimeError("failed to read DHT22 data")

                return float(temperature), float(humidity)

            except RuntimeError as e:
                last_error = e
                print(f"read error: {e}", flush=True)
                time.sleep(self.delay_seconds)

        raise RuntimeError(f"failed to read DHT22 after retries: {last_error}")

    def close(self) -> None:
        self.dht.exit()
