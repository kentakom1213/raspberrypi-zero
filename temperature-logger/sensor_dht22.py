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
        delay_seconds: float = 2.0,
        use_pulseio: bool = False,
    ) -> None:
        self.pin_name = pin_name
        self.pin = get_board_pin(pin_name)
        self.retries = retries
        self.delay_seconds = delay_seconds
        self.use_pulseio = use_pulseio
        self.dht = None

        self.reset()

    def reset(self) -> None:
        self.close()

        self.dht = adafruit_dht.DHT22(
            self.pin,
            use_pulseio=self.use_pulseio,
        )

    def read_once(self) -> tuple[float, float]:
        if self.dht is None:
            self.reset()

        temperature = self.dht.temperature
        humidity = self.dht.humidity

        if temperature is None or humidity is None:
            raise RuntimeError("failed to read DHT22 data")

        return float(temperature), float(humidity)

    def read(self) -> tuple[float, float]:
        last_error = None

        for _ in range(self.retries):
            try:
                return self.read_once()

            except RuntimeError as e:
                last_error = e
                time.sleep(self.delay_seconds)

            except OSError as e:
                # Lost access to message queue や [Errno 22] Invalid argument のような
                # 低レベルのエラーは，DHT22 オブジェクトを作り直して復帰を試みる．
                last_error = e
                self.reset()
                time.sleep(self.delay_seconds)

        raise RuntimeError(f"failed to read DHT22 after retries: {last_error}")

    def close(self) -> None:
        if self.dht is not None:
            try:
                self.dht.exit()
            except Exception:
                pass
            finally:
                self.dht = None
