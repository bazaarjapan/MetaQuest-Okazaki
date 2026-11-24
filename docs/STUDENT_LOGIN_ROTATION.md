# 生徒の4桁パスワードの一括再発行

全員のパスワードを更新する依頼があるときは、発行済みの生徒IDごとに新しい数字4桁を用意します。パスワードは先頭の0も含めて4文字です。生徒はこれまでのIDと新しいパスワードで入り直せます。作品や名前は同じ生徒のものとして引き継がれます。

1. 新しい4桁パスワードに対応したWorkerをデプロイします。ローカルWranglerの接続先を確認し、本番Workerと同じ `STUDENT_PIN_PEPPER` をローカルプロセスの環境変数に設定します。この値や生徒のパスワードはコマンド履歴やログに記録しないでください。
2. リポジトリ外の、新しいローカル専用フォルダーに計画と配布用ファイルを準備します。

   ```powershell
   $rotationFolder = Join-Path $env:LOCALAPPDATA 'OkazakiWeb\student-pins-YYYYMMDD'
   node scripts/reset-student-logins.mjs --output $rotationFolder
   ```

   この段階は本番D1の読み取りだけです。Windowsではフォルダーと既存ファイルにアクセスできるのは現在の利用者とSYSTEMのみです。

3. 同じフォルダーを指定して適用します。

   ```powershell
   node scripts/reset-student-logins.mjs --output $rotationFolder --apply
   ```

   計画時の生徒枠・ID・認証情報がすべて一致した時だけ1回の更新を実行します。各生徒の以前のセッションは同じ更新で失効します。先生のGoogleログインや、パスワードを使わない旧Googleアカウントは対象外です。

4. `verification.json` の対象生徒数、`remainingPreviousStudentSessions: 0`、`loginIdsChanged: false` を確認します。各生徒には `生徒ログイン配布用.txt` から本人のIDとパスワードを渡します。表計算で `生徒ログイン配布用.csv` を読み込む場合、パスワード列を「文字列」に指定すると先頭の0を保てます。

更新結果が不明な場合は、同じフォルダーで手順3を再実行します。適用済みなら同じ配布用ファイルを検証し、生徒が入り直した後のセッションを保ちます。計画後に名簿やパスワードに変更があった場合は配布を止め、適用結果を確認してください。

IDも新しくする明示的な依頼の場合に限り、手順2・3の両方で `--rotate-ids` を指定します。`private-plan.json` と配布用ファイルにはパスワードが入ります。先生がアクセス制限された場所で管理してください。
