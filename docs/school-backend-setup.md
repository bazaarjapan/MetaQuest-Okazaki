# 学校向け共有ワールド：バックエンド構築手順（開発中）

2026-10-01 時点の作業用資料です。サーバーコードとローカル検証は用意していますが、Google ログイン用の公開 Web クライアント ID と先生の許可情報は未提供です。**本番公開済み、30人共同作業 MVP 完成という意味ではありません。** Google ログイン・共有 STL・複数アバターの画面接続は次の実装です。パスキーは [Issue #8](https://github.com/bazaarjapan/MetaQuest-Okazaki/issues/8) の別機能で、まだ実装していません。

## 1. データの保存先と権限

| 接続名 | 用途・設定するリソース |
| --- | --- |
| `DB` | 専用 D1 `okazaki-school-worlds`。ID `a6dae057-d386-42a8-b37e-1298ee4656e5`。ユーザー、ログインセッション、参加者、STL 情報、先生の保存スナップショットを格納 |
| `STL_BUCKET` | private R2 `okazaki-school-assets`。STL 原本を格納。公開バケットや誰でも読める URL にしない |
| `SCHOOL_ROOMS` | Durable Object `SchoolRoom`。教室ごとの接続、アバターの姿勢、編集順序、作業中のワールドを同期・永続化 |
| `ASSETS` | 既存の `dist` 静的アセット。岡崎駅周辺 PLATEAU のモデルを配信し、配置判定でも同じ原本の SHA-256 を検証 |

D1 と R2 の専用リソースは作成済みです。Worker への本番接続、最新 SQL 適用、本番での読み書き確認は、それぞれ別の検証が必要です。入口コードは `worker/index.mjs`、テーブル定義は `migrations/0001_school_worlds.sql` です。

先生だけが、自分のワールドを作成・保存・復元できます。生徒は参加コードで入室し、自分の STL だけを使って自分のオブジェクトを作成・変更・削除します。他の生徒の作品は閲覧できますが編集できません。先生にも生徒の所有者を偽装する編集権限はありません。先生の「保存」は教室全体のチェックポイントです。

上限は先生1人＋生徒30人、1人につき1ワールド10ファイル・計25 MiB、1 STL 6 MiB／20,000三角形、1ワールド120オブジェクト／計200,000三角形です。共有配置は、実地形と建物を検証できる岡崎駅の中心モデル範囲に限定します。未知の地形や建物上には配置できません。

## 2. Google ログインの準備

1. Google Cloud の Google Auth Platform で OAuth クライアントを作成します。種類は **Web application** です。
2. Authorized JavaScript origins に **`https://metaquest001.gigach.net`** を登録します。パスや末尾の `/` は付けません。
3. アプリ名、サポート先、プライバシーポリシー等の同意画面を設定します。学校アカウントと個人 Gmail の両方を想定した利用範囲にし、学校側のログイン制限も確認します。
4. 発行された `...apps.googleusercontent.com` を `GOOGLE_CLIENT_ID` に設定します。

クライアント ID は公開識別子で、ブラウザから取得できる設計です。この実装は Google Identity Services の ID トークンをサーバーで検証する方式で、**OAuth クライアントシークレットは不要**です。Google Drive や Gmail のデータ取得権限は要求しません。GIS 読込み、CSP、ポップアップ／FedCM の確認は、ログイン UI 接続時に行います。詳細は [Google 公式セットアップ](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) を参照してください。

先生は、サーバー側の `TEACHER_GOOGLE_SUBS` または `TEACHER_GOOGLE_EMAILS` の許可リストで指定します。変更されにくい Google `sub` による指定を推奨します。メール指定は署名検証後の Gmail／Google Workspace の権威あるメールに限り使用されます。生徒のブラウザから送られた `role` や `ownerId` で先生にはなれません。

先生の個人情報はコード、PR、公開資料に書かず、ローカル管理する Cloudflare の secret へ登録します。例として `npx wrangler secret put TEACHER_GOOGLE_SUBS` を使用し、値は対話入力します。認証用の値を GitHub Secrets やログへコピーしません。

## 3. Worker 接続と SQL の適用

本番接続時の Wrangler 設定で、`main` を `worker/index.mjs`、`APP_ORIGIN` を `https://metaquest001.gigach.net` とし、上表の `DB`／`STL_BUCKET`／`SCHOOL_ROOMS`／`ASSETS` を設定します。`SchoolRoom` は SQLite-backed Durable Object として作成します。設定ファイルを編集しただけで接続や公開が完了したとは扱いません。

開発ブランチの `wrangler.jsonc` には、専用リソースの接続、`/api/*` の Worker 優先処理、SQLite `SchoolRoom` の `exports` 宣言を用意しています。Google ID と先生許可情報は空のままで、未設定時の学校 API は `school_not_configured` として拒否します。架空の本番ログインを入れません。`npm run check:worker` は `--dry-run` のバンドル確認だけで、公開・DO作成・本番D1変更をしません。DOの初回本番作成は将来のレビュー済み公開で行う変更であり、過去の静的版へ単純に戻せるとは限りません。

SQLite テーブルを適用する前に、対象 D1 の名前・ID と未適用 migration を確認します。設定が揃った後の確認・適用コマンドは次のとおりです。

```powershell
npx wrangler d1 migrations list okazaki-school-worlds --remote
npx wrangler d1 migrations apply okazaki-school-worlds --remote
```

`--remote` は本番データベースへの操作です。空でない既存データベースではバックアップと変更内容を確認してから適用し、適用済み migration の書換えやリソースの再作成で既存データを失わないようにします。[D1 migration 公式コマンド](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply) と [Durable Object の作成・移行](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) を参照してください。DO の `exports` 方式と legacy `migrations` 方式を混在させません。

## 4. API の流れ

| API | 役割 |
| --- | --- |
| `GET /api/config` | 接続設定の有無、公開クライアント ID、上限を返す。`configured:false` は授業利用の準備未完了 |
| `GET /api/session` → `POST /api/auth/google` | nonce／CSRF を取得し、Google credential を交換。署名・発行元・対象クライアント・有効期限・nonce を検証して HttpOnly セッションを発行 |
| `POST /api/auth/logout`、`PATCH /api/avatar` | 当該ブラウザのログアウト、本人のアバター名・色の変更 |
| `GET/POST /api/worlds`、`POST /api/worlds/join` | 参加ワールド一覧、先生の作成、配布コードによる参加 |
| `GET /api/worlds/{worldId}/state`、`GET …/socket` | 現在のワールド取得、WebSocket 同期。socket は同一 Origin の接続のみ |
| `POST/GET …/assets`、`GET …/assets/{assetId}` | STL 原本の登録・一覧・private 取得。登録時と配置時に厳密検証 |
| `POST …/save`、`POST …/restore` | 先生だけのスナップショット保存・復元。復元には `snapshotId` と最新 `revision` が必要 |

`…` は `/api/worlds/{worldId}` です。認証後の書込みにはセッションの `X-CSRF-Token` が必要です。WebSocket は pose と本人の `object.create`／`object.update`／`object.delete` を扱い、revision 競合、重複依頼、所有者違反、速度超過をサーバーで拒否します。Google の同じ `sub` で再ログインすると同じユーザー・アバター・STL 所有権に戻ります。

## 5. 検証と完成の判断

```powershell
node --test tests/school-backend.test.mjs
npm run test:school-runtime
npm run check:worker
```

前者は Node＋ローカル SQLite の17テストです。実際に生成した RSA 鍵で JWT 署名を検証しますが、**実 Google アカウントでログインした証明ではありません**。後者はローカル workerd、D1／R2 と31本の TCP WebSocket を用いる別の統合検証です。ローカルの試験用セッションを使い、本番の認証、Cloudflare 本番、Quest での性能を代替しません。最終結果は当該コミットの実行ログと PR に記録します。

完成には、少なくとも次の確認が残っています。

- Google 公開クライアント ID と先生の許可情報の設定。
- ログイン UI、共有ワールド、STL 操作画面、複数アバターの接続とブラウザ検証。
- 本番 Cloudflare 上で認証、private STL、先生の保存・復元、教室隔離を通しで確認。
- 学校ネットワークで先生＋生徒30人の参加、再接続、端末のフレームレート／Quest 実機操作を確認。
- パスキーは別 Issue として実装・検証。Google ログインが動いてもパスキー完成にはならない。

公開は既定の **Issue → PR → レビュー → CI → squash merge** の後、Codex が検証済み main をローカルから公開します。GitHub Actions は検証だけで、自動公開しません。コミット SHA、PR、最終 CI、本番バージョン、公開後の検証結果が揃うまで、本番完成と報告しません。
