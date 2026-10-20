# temperature-logger

Python 3.11 以上の 32 bit Raspberry Pi OS で動作します．SQLite は Python 標準ライブラリの `sqlite3` を使います．既存の `.env` と DHT22 設定はそのまま使います．DB は既定で `data/readings.db` に作成し，測定データを自動削除しません．測定値を約 60 秒ごとに先に DB へ確定してから Ambient へ送信します．送信に失敗した行は次回以降に再送します．

Ambient への再送には [公式の一括送信 API](https://ambidata.io/blog/2016/07/08/second/) を使い，測定時刻を Unix ミリ秒で指定します．[公式の制限](https://ambidata.io/refs/spec/) により，チャネルあたり送信間隔は最低 5 秒，登録件数は 1 日 3,000 件です．長い通信障害の後は未送信件数が残る場合があります．応答を受けてから DB に送信済みを記録するため，その間にプロセスが停止すると同じ行を再送する可能性があります．

## CSV から初期 DB を作る

CSV の `created` は `Asia/Tokyo` の現地時刻として扱います．CSV は UTF-8 BOM 付きで，`created`，`気温 (℃)`，`湿度 (%)` 列を名前で読みます．追加列は無視します．日時の形式は `YYYY/M/D H:M:S.fff` です．Ambient CSV ではミリ秒の先頭の 0 が省略されるため，`.84` は 84 ミリ秒，`.4` は 4 ミリ秒として読みます．

```sh
cd temperature-logger
python3 import_csv.py --timezone Asia/Tokyo --output /path/to/readings-import.db /path/to/data*.csv > /path/to/import-report.json
```

指定した CSV を直接読み，1 つの DB を作ります．同じ時刻・気温・湿度の組を重複と見なし，取り込んだ行は Ambient 送信済みとして記録します．不正行は飛ばし，ファイル名・行番号・理由・元の値を JSON に記録します．レポートにはファイルごとの読み込み・登録・重複・不正件数，合計，最古・最新日時，`integrity_check` が含まれます．出力 DB が既にある場合は失敗し，上書きしません．

## API

既存の `GET /health` は `temperature`，`humidity`，`sent_at`，`last_error` を返します．`sent_at` は互換性のため名前を維持し，最終測定時刻を表します．Web UI もこれを最終測定として表示します．

`GET /api/readings` は従来どおり，直近 `chart.max_points` 件の `time`，`temperature`，`humidity` の配列を時刻順に返します．期間検索では `start_ms` 以上，`end_ms` 未満の Unix ミリ秒を指定します．返却行には `measured_at_ms` も含みます．`limit` の既定値は 1,000，最大は 10,000 件です．

```text
GET /api/readings?start_ms=1780239600000&end_ms=1780326000000&limit=1000
```

`GET /api/stats` は指定期間の件数，気温・湿度それぞれの平均・最小・最大を `summary` に返します．`interval=hour` または `interval=day` を付けると，JST の時間・日境界で集計した `buckets` も返します．空期間の件数は 0，統計値は `null` です．

```text
GET /api/stats?start_ms=1780239600000&end_ms=1780326000000&interval=hour
```

## Ubuntu から Raspberry Pi へ転送する

以下は手順です．このリポジトリの作業では SSH 接続，転送，サービス停止，DB 置換を実行しません．接続先と既存 DB の状態を確認し，転送先への書き込みを許可してから進めてください．特にサービス停止と DB 置換は，その直前に改めて確認してください．

1. Ubuntu 上でインポートレポートを確認し，`integrity_check` が `ok` であることを確かめます．`ssh powell@<pi-host>` で接続先を読み取り専用で確認し，`systemctl status temperature-logger.service`，`ls -la /home/powell/raspberrypi-zero/temperature-logger/data` で既存 DB と稼働状態を確認します．
2. 転送先への書き込みを承認した後，転送先の `data` ディレクトリに一意な名前のステージングディレクトリを `mktemp -d` で作り，`scp /path/to/readings-import.db powell@<pi-host>:<ステージングディレクトリ>/readings.db` で転送します．事前にそのファイルが存在しないことを確認します．Pi 上の Python でステージング DB に `PRAGMA integrity_check` を実行し，`ok` を確認します．
3. サービス停止を承認した後，Pi で `sudo systemctl stop temperature-logger.service` を実行します．`systemctl is-active temperature-logger.service` で停止を確認します．既存の `data/readings.db` があれば，Python の `sqlite3.Connection.backup()` で時刻付きの別ファイルへ完全なバックアップを作り，そのバックアップにも `PRAGMA integrity_check` を実行します．WAL ファイルだけを無視した単純なファイルコピーは使いません．
4. 既存 DB にインポート後の測定値がある場合は，既存 DB をステージング DB に接続し，`INSERT OR IGNORE` で `readings` の全列を合流します．`ambient_sent_at_ms` も保持します．スキーマが一致しない場合は置換を中止します．合流後の件数と `PRAGMA integrity_check` を確認し，ステージング DB をチェックポイントします．
5. DB 置換を承認した後，既存 DB の `-wal` と `-shm` が残っていないことを確認し，同じファイルシステム上のステージング DB を `data/readings.db` へ原子的に移動します．サービスの実行ユーザー `powell` が読み書きできる所有権・権限を確認してから `sudo systemctl start temperature-logger.service` を実行します．`/health` と `/api/readings`，サービスログを確認します．問題があればサービスを停止し，バックアップから復元します．

既存 DB がない場合でも，サービスを止める操作と DB を配置する操作の確認は省略しません．
