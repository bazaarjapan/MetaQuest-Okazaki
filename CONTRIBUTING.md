# 開発・レビュー・Codexによる公開の手順

このリポジトリはWeb版の`OkazakiWeb`をルートとしています。Unity APK版、元のPLATEAUダウンロード、個人の認証情報は管理対象外です。

## 変更の進め方

通常の変更は次の順序で進めます。

1. Issueに目的・変更範囲・受入条件・確認方法を記載します。
2. `main`からIssue単位の短命ブランチを作ります。命名は`codex/<Issue番号>-<短い説明>`です。例：Issue #1は`codex/1-cloudflare-cicd`。
3. 実装し、対象に応じたテストとブラウザー確認を行います。関係のない変更を同じPRに混ぜません。
4. PRを作成し、対象Issue、変更概要、検証結果、実機未確認などの残りのゲートを記載します。
5. PRのコメント欄へ`@codex review`を投稿してレビューを依頼します。指摘を修正し、変更後のHEADで再度検証します。
6. 最終HEADの`CI` → `Verify`が成功し、レビューの未解決事項がなくなったらsquash mergeします。普段の開発で`main`へ直接pushしてレビューを省略しません。
7. 公開が依頼範囲に含まれる場合だけ、Codexがマージ済み`main`を確認・再検証してCloudflareへ公開します。`main`へのpushだけでは公開しません。CIや開発ルールを整える作業を、アプリの本番公開依頼とみなしません。

ローカルの操作例です。ブランチ名は作業するIssueに合わせて変更してください。

```powershell
git switch main
git pull --ff-only
git switch -c codex/1-cloudflare-cicd
```

作業前後に既存の変更を確認し、他の人の変更や関係のないファイルを上書きしないでください。`main`へのマージは履歴を残すsquash mergeとし、強制pushで履歴を書き換えません。

### CodexのレビューBotが利用できない場合

Botの未接続・権限不足などでレビューを実行できない場合は、その理由をPRに記載し、別の担当者または実装担当と分離したローカルのレビューエージェントによる独立レビューを行います。結果をPRコメントへ投稿してください。

- レビューした最終HEADのコミットSHA。
- レビュー担当と確認したファイル・観点。
- 指摘、対応結果、残るリスク。
- テストコマンドと結果、未確認の実機・操作ゲート。

これはローカル独立レビューであり、`@codex review` Botが合格したことにはしません。レビュー後にコードを変えた場合は、変更したHEADをもう一度レビュー・検証します。

## ローカル検証

Node.js 22を使用します。依存関係は`package-lock.json`に合わせてインストールします。

```powershell
npm ci
npm test
npm run check:assets
npm run build
npm run check:production
```

UIや操作を変えた場合は、PC・スマートフォン表示と必要なXRエミュレーター確認を追加します。ブラウザー検証の実行例と各テストの対象は[README](README.md#検証)を参照してください。本番の`dist`にはIWERや`testxr`用の開発コードを入れません。

PC・エミュレーターの合格は、実機Questの性能・装着快適性や学校ネットワークでの動作の保証ではありません。結果は[VALIDATION.md](VALIDATION.md)に記録し、コミット、ビルド、公開ID、実機確認を区別します。

## GitHub Actionsの構成

ワークフロー名は`CI`、ジョブの表示名は`Verify`です。GitHub Actionsは検証だけを担当し、本番公開やCloudflareへの認証は行いません。

| 起動条件 | `Verify` | 本番公開 |
|---|---|---|
| PR（対象ブランチを限定しない） | 実行 | しない |
| `main`へのpush | 実行 | しない |
| `workflow_dispatch` | 選択したブランチで実行 | しない |

`Verify`はNode.js 22で`npm ci`、`npm test`、`npm run check:assets`、`npm run build`、`npm run check:production`を実行します。`main`ではビルドした`dist`を検証済みアーティファクトとして保存し、Codexが確認・利用できます。取得する場合は、成功したActions実行とマージ済みコミットSHAが一致することを確認してください。

CIの合格は公開の合格ではありません。新しいコミットをpush・mergeしても、Codexが公開するまで公開サイトは前の版のままです。

## Codexによる本番公開

公開がユーザーの依頼範囲に含まれる場合に、Codexが次の順序で実行します。

1. PRがsquash merge済みで、レビュー指摘へ対応していることを確認します。Botへの依頼コメントだけをレビュー完了とはしません。
2. マージ済み`main`とリモート`main`のコミットが一致し、作業ツリーがcleanであることを確認します。未コミットの変更を勝手に消したり、別ブランチを本番へ公開したりしません。
3. マージ後の最終`main`の`CI` → `Verify`が成功していることを確認します。PRの古いHEADの成功で代用しません。
4. 同じ`main`でNode.js 22を使い、ローカルのテスト・アセット検証・本番ビルド・開発コード混入チェックを実施します。
5. 公開先が意図したWorker・ドメインであることを確認し、検証済みのローカル`dist`を`npm run deploy`で配信します。同時に別の公開を実行しません。
6. `scripts/verify-deployed.mjs`で公開ファイルのSHA-256を配信した`dist`と全件照合し、CSP・WebXRの権限ヘッダー・存在しないURLの404も確認します。必要な公開ページの操作確認を追加します。
7. コミットSHA、PR、Actions実行、Cloudflareの公開ID、公開検証結果、残る実機ゲートをIssue・PRへ記録し、確認できた範囲で公開完了を報告します。

```powershell
npm ci
npm test
npm run check:assets
npm run build
npm run check:production
npm run deploy
node scripts/verify-deployed.mjs https://metaquest001.gigach.net
```

Cloudflare認証は公開を担当するCodexの実行環境で管理します。GitHub Actions用のCloudflare Secret登録は不要です。OAuth・refresh token、API Token、Cookieなどの認証値をリポジトリ、Issue、PRコメント、ログ、スクリーンショットへ貼り付けないでください。認証できない場合は状況を報告し、許可されていない認証情報の流用や権限拡大は行いません。

### マージ・公開前の確認

- ブランチ保護で`Verify`を必須チェックにする運用を推奨します。チェック名は実際のActions表示と一致させます。
- PRの変更がレビュー対象の最終HEADと同じであることを確認します。
- 公開が依頼範囲に含まれることを確認し、Codexによる配信後に公開サイトの主要な操作を確認します。
- 公開検証に失敗した場合はIssueへ記録し、原因を確認します。検証失敗を隠して完了にしません。復旧や以前の版への戻しは、対象を明確にして管理者の判断で行います。

## 登録しないもの

`.gitignore`の除外を維持し、`node_modules/`、`dist/`、`.cache/`、`.wrangler/`、`test-results/`、`.env`などを登録しません。秘密キー、元資料ZIP、個人情報、巨大な検証動画も含めません。公開に必要な変換済み`public/city`・`public/region`のデータは管理対象ですが、モデルを更新する場合はサイズと出典・加工記録も確認してください。

エージェントで作業するときは[AGENTS.md](AGENTS.md)も読んで、同じIssue・PR・レビュー・CIの手順を守ってください。
