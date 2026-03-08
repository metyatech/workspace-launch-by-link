# Workspace Launch by Link

Webリンクから VS Code ワークスペースを起動し、内容をサーバーとリアルタイム同期する拡張機能です。

## 使い方

1. 拡張機能をインストール
2. Web 側に以下の形式のリンクを配置

```
vscode://Kodai-Yamamoto-SIW.workspace-launch-by-link/start?server=https%3A%2F%2Fexample.com&ownerId=alice&workspaceId=week1
```

- server: サーバーのベース URL（必須）
- ownerId/workspaceId: 任意の識別子

## サーバー API

- GET /manifest
  - クエリ: ownerId, workspaceId, token
  - 返却: JSON 配列
  ```json
  [
    { "path": "src/", "type": "directory" },
    { "path": "src/main.py", "type": "file", "contentBase64": "cHJpbnQoJ0hlbGxvJyk=", }
  ]
  ```

- POST /event/fileSnapshot
  - body: { path, isBinary, content(base64), ownerId, workspaceId }
- POST /event/create | /event/delete | /event/rename
  - body: { path | oldPath/newPath, ownerId, workspaceId }
- POST /event/heartbeat
  - body: { ts, ownerId, workspaceId }

## 動作

- 初回: manifest を取得してテンプレートを展開し、`.vscode/workspace-launch-by-link.json` を作成後、そのフォルダを新しいウィンドウで開きます。
- 監視: 以降はマーカーを検出して自動で監視・送信を開始します。
- 送信失敗時: 画面左下にエラーを出し、成功まで指数バックオフで無限リトライ。成功でエラーは消えます。

## 開発

### スクリプト

- `npm run compile`: TypeScript のコンパイル
- `npm run lint`: ESLint によるコードチェック
- `npm run format`: Prettier によるコード整形
- `npm run test`: Vitest によるテスト実行
- `npm run verify`: Lint, Format, Compile, Test を一括実行（推奨）
- `npm run package`: `vsce` によるパッケージ作成

### ローカル動作テスト手順

1. 依存インストールとビルド
  - `npm install`
  - `npm run compile`
2. モックサーバー起動
  - `npm run mock-server`
  - 表示される `http://localhost:8787` を控えます
3. 拡張機能をデバッグ実行
  - VS Code でこのフォルダを開き、F5 で「拡張機能の開発ホスト」を起動
4. 開発ホスト側で URI を実行
  - コマンドパレットで「URI を開く」を選び、次を貼り付け
  - `vscode://Kodai-Yamamoto-SIW.workspace-launch-by-link/start?server=http%3A%2F%2Flocalhost%3A8787&ownerId=alice&workspaceId=demo`
  - 新しいウィンドウでテンプレートが展開されます
5. ファイルを編集/作成/削除/リネーム
  - モックサーバーのターミナルに `/event/*` が届く様子が表示されます
  - `http://localhost:8787/_events` でも確認できます

注意: 送信に失敗した場合、左下ステータスバーにエラー表示が出ます。サーバー復帰後は自動で成功し、表示は消えます。

## ライセンス

[MIT](LICENSE)
