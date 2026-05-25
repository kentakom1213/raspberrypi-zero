import time

import adafruit_dht
import board


def get_board_pin(pin_name: str):
    try:
        return getattr(board, pin_name)
    except AttributeError:
        raise ValueError(f"unknown GPIO pin: {pin_name}")


def read_dht22(
    pin_name: str,
    retries: int = 3,
    delay_seconds: float = 2.0,
) -> tuple[float, float]:
    pin = get_board_pin(pin_name)

    # Raspberry Pi では use_pulseio=False が必要になることがあります．
    dht = adafruit_dht.DHT22(pin, use_pulseio=False)

    try:
        last_error = None

        for _ in range(retries):
            try:
                temperature = dht.temperature
                humidity = dht.humidity

                if temperature is None or humidity is None:
                    raise RuntimeError("failed to read DHT22 data")

                return float(temperature), float(humidity)

            except RuntimeError as e:
                last_error = e
                time.sleep(delay_seconds)

        raise RuntimeError(f"failed to read DHT22 after retries: {last_error}")

    finally:
        dht.exit()
