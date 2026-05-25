import time

import board
import adafruit_dht


dht = adafruit_dht.DHT22(board.D4)

for _ in range(10):
    try:
        temperature = dht.temperature
        humidity = dht.humidity

        print(f"temperature = {temperature:.1f} C")
        print(f"humidity    = {humidity:.1f} %")
        print()
    except RuntimeError as e:
        print(f"read error: {e}")

    time.sleep(3)

dht.exit()
