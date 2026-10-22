# temperature-logger

Python 3.11 以上の 32 bit Raspberry Pi OS で動作します．SQLite は Python 標準ライブラリの `sqlite3` を使います．既存の `.env` と DHT22 設定はそのまま使います．DB は既定で `data/readings.db` に作成し，測定データを自動削除しません．測定値を約 60 秒ごとに先に DB へ確定してから Ambient へ送信します．送信に失敗した行は次回以降に再送します．

Ambient への再送には [公式の一括送信 API](https://ambidata.io/blog/2016/07/08/second/) を使い，測定時刻を Unix ミリ秒で指定します．[公式の制限](https://ambidata.io/refs/spec/) により，チャネルあたり送信間隔は最低 5 秒，登録件数は 1 日 3,000 件です．長い通信障害の後は未送信件数が残る場合があります．応答を受けてから DB に送信済みを記録するため，その間にプロセスが停止すると同じ行を再送する可能性があります．

## CSV から初期 DB を作る

CSV の `created` は `Asia/Tokyo` の現地時刻として扱います．CSV は UTF-8 BOM 付きで，`created`，`気温 (℃)`，`湿度 (%)` 列を名前で読みます．追加列は無視します．日時の形式は `YYYY/M/D H:M:S.fff` です．Ambient CSV ではミリ秒の先頭の 0 が省略されるため，`.84` は 84 ミリ秒，`.4` は 4 ミリ秒として読みます．

```sh
cd temperature-logger
python3 import_csv.py --timezone Asia/Tokyo --output /path/to/readings-import.db /path/to/data*.csv > /path/to/import-report.json
```

指定した CSV を直接読み，1 つの DB を作ります．同じ時刻・気温・湿度の組を重複と見なし，取り込んだ行は Ambient 送信済みとして記録します．不正行は飛ばし，ファイル名・行番号・理由・元の値を JSON に記録します．レポートにはファイルごとの読み込み・登録・重複・不正件数，合計，最古・最新日時，`integrity_check` が含まれます．日次・時間別集計も SQL で作成します．出力 DB が既にある場合は失敗し，上書きしません．

## API

Raspberry Pi は測定・Ambient 送信と Flask API 専用です．Cloudflare Tunnel が同じ Pi 上で動作し，Workers VPC Service の接続先は `127.0.0.1:8000` とします．従来の Flask HTTP 公開ホスト名が残っていれば Cloudflare Dashboard で削除してください（SSH の Access/Tunnel は維持）．公開画面は `temp.pwll.dev` の Workers が配信します．Pi に変更をデプロイする際は `temperature-logger.service` の再起動後に `/health` と Workers 経由の画面を確認してください．


既存の `GET /health` は `temperature`，`humidity`，`sent_at`，`last_error` を返します．`sent_at` は互換性のため名前を維持し，最終測定時刻を表します．Web UI もこれを最終測定として表示します．

`GET /api/readings` は従来どおり，直近 `chart.max_points` 件の `time`，`temperature`，`humidity` の配列を時刻順に返します．期間検索では `start_ms` 以上，`end_ms` 未満の Unix ミリ秒を指定します．返却行には `measured_at_ms` も含みます．`limit` の既定値は 1,000，最大は 10,000 件です．

```text
GET /api/readings?start_ms=1780239600000&end_ms=1780326000000&limit=1000
```

`GET /api/stats` は指定期間の件数，気温・湿度それぞれの平均・最小・最大を `summary` に返します．従来の `start_ms` 以上・`end_ms` 未満という指定，`interval=hour|day`，`summary` と `buckets` の形式は維持します．`interval` 指定時の `buckets` は従来どおり測定がある区間だけです．

新しい `group_by=hour|day|week|month` は `from`・`to` にタイムゾーン付き ISO 8601 日時を両方指定します（または `start_ms`・`end_ms` を両方指定します）．`from` を含み `to` を含みません．`interval` と `group_by` は同時指定できません．`group_by` の `buckets` は欠測区間も返し，その区間は `count=0`，平均・最小・最大が `null` です．各行の `bucket_start_ms` は JST の区間開始時刻です．週は月曜日開始，月は毎月1日開始です．表示範囲は最大 10,000 区間です．

```text
GET /api/stats?start_ms=1780239600000&end_ms=1780326000000&interval=hour
GET /api/stats?group_by=week&from=2026-10-05T00:00:00%2B09:00&to=2026-11-02T00:00:00%2B09:00
```

Cloudflare Workers Static Assets が `/` の現在の温湿度，`/stats` の日別（直近30日）・週別（直近26週）・月別（直近12か月）の統計ページを配信します．Raspberry Pi の Flask は API 専用で，`/`，`/stats`，`/static/*` を配信せず，ループバックの `127.0.0.1:8000` のみで待ち受けます．静的ソース `src/static/` は Workers ビルドが参照するため削除しません．いずれも JST の暦を基準とし，進行中の期間を表示します．統計ページの集計単位・指標・開始日を URL の `group_by`・`metric`・`start` に保持します．

トップページの独立した気温・湿度グラフは `1h`・`6h`・`24h`・`7d` を切り替えられます．最初の3期間は `/api/readings`，7日間は `/api/stats?interval=hour` の時間別平均を使います．両グラフは Unix ミリ秒の数値軸を共有し，JST で表示します．測定間隔が5分以上，または時間別データが90分以上空いた箇所には欠測を入れます．表示期間は URL の `range` に保持し，60秒ごとに再取得します．最終測定から3分以上経過した値は停止の可能性を明示します．

## 日次・時間別集計

`readings` は唯一の正本で，JST 日付ごとの `daily_stats` と時間ごとの `hourly_stats` は再生成可能な集計です．新しい測定値は `readings`・`hourly_stats`・`daily_stats` に同一トランザクションで記録します．平均値は合計を件数で割って算出します．`PRAGMA user_version=1` は日次集計，`2` は日次・時間別集計の初期再構築が完了した印です．既存 DB に新コードだけを適用した場合，時間別 API は再構築完了まで生データから正確に計算します．通常起動時に全件再集計は行いません．

時間別集計には `hourly_stats`，日・週・月別には `daily_stats` を使います．任意時刻の期間指定では，完全に含まれる時間・日を集計表から読み，端の不完全な区間だけ `readings` を読むため，`summary` と `buckets` の精度を保てます．DB の整合性確認は API リクエスト中には行いません．

初回の時間別集計はサービス停止中に Pi の既存 DB 上で明示的に実行します．再実行すると `hourly_stats` を全件再構築します．`DELETE` と再集計 `INSERT` は単一トランザクションなので，失敗時は元の集計へロールバックします．`readings` は変更しません．

```sh
cd /home/powell/raspberrypi-zero/temperature-logger
.venv/bin/python rebuild_daily_stats.py
.venv/bin/python rebuild_daily_stats.py --check
.venv/bin/python rebuild_hourly_stats.py
.venv/bin/python rebuild_hourly_stats.py --check
```

`--db /path/to/readings.db` で対象 DB を指定できます．検証は測定件数，時間・日別の件数と統計値，`PRAGMA integrity_check` を比較し，不一致なら終了コード `1` を返します．

### デプロイと復元

運用中の DB を Ubuntu 側の古い DB で置換しません．Pi での手順は次のとおりです．

1. Pi の Git 状態，サービス，DB 件数を確認します．稼働中に Python 標準の `sqlite3.Connection.backup()` で一意な名前のバックアップを作り，バックアップの `integrity_check` を確認します．単純なファイルコピーは WAL の未反映データを落とすため使いません．
2. `temperature-logger.service` を停止し，停止を確認します．停止直後にもバックアップを取り，停止直前までの測定値を保全します．
3. Pi で `git pull --ff-only origin main` し，必要なら `rebuild_daily_stats.py`，続けて `rebuild_hourly_stats.py` を実行します．両方の `--check` が成功し，DB 件数と `integrity_check` が正常であることを確かめます．
4. サービスを起動し，`/health`，`/api/readings`，`/api/stats`，新しい測定と Ambient 送信を確認します．
5. 再集計に失敗した場合，サービスを起動せず原因を調べます．トランザクションにより既存の `readings` と以前の集計は保持されます．旧コードに戻す場合は，サービス停止中に旧コミットへ一時的に切り替えてから起動します．旧コードは追加の `hourly_stats` を参照しません．DB 自体を復元する必要がある場合は，サービス停止中に停止後バックアップを `sqlite3.Connection.backup()` で一時 DB に複製し，整合性・WAL の状態を確認してから既存 DB と入れ替えます．

### 応答時間の測定

同じ条件で各 URL を初回と2回目に呼び，`curl` の `time_total`（HTTP 応答完了まで）を記録します．次の日時は 2026-10-20 時点の例です．Pi で稼働中のアプリに対し，マイグレーション前後で同じ URL を使います．

```sh
curl -sS -o /dev/null -w '%{time_total}\n' 'http://127.0.0.1:8000/api/stats?group_by=day&from=2026-09-21T00:00:00%2B09:00&to=2026-10-21T00:00:00%2B09:00'
curl -sS -o /dev/null -w '%{time_total}\n' 'http://127.0.0.1:8000/api/stats?group_by=week&from=2026-04-27T00:00:00%2B09:00&to=2026-10-26T00:00:00%2B09:00'
curl -sS -o /dev/null -w '%{time_total}\n' 'http://127.0.0.1:8000/api/stats?group_by=month&from=2025-11-01T00:00:00%2B09:00&to=2026-11-01T00:00:00%2B09:00'
curl -sS -o /dev/null -w '%{time_total}\n' 'http://127.0.0.1:8000/api/stats?from=2025-11-01T00:00:00%2B09:00&to=2026-11-01T00:00:00%2B09:00'
```
