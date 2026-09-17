---
description: Claude が書いたコードを GPT-6-Astra（ChatGPT、Codex CLI 経由）に渡して独立したクロスプロバイダーレビューを受け、指摘を修正します。
argument-hint: "[--base <branch> | --commit <sha> | --files <paths> | --files-from-commit <sha>] [レビュアーへの追加指示]"
---

# Astra Review

クロスプロバイダーのセカンドオピニオン。Claude がコードを書き、GPT-6-Astra（OpenAI。ローカルにインストールした Codex CLI と ChatGPT ログインで動作）がコンテキストを共有せずにレビューします。Claude は Astra の指摘を修正し、Astra が PASS を返すかラウンド上限に達するまで再実行します。

## 目的

- 同一モデルのレビュアーでは見落としがちな問題を捕捉する。
- 書き込みは Claude のみ。Astra は読み取り専用サンドボックスで動き、パッチではなく構造化された判定だけを返す。
- コミットやプッシュのゲートに使える機械可読な判定（PASS/FAIL、重大度付きの指摘）を出力する。

## 前提条件

- Codex CLI がインストール済みで、ChatGPT でログイン済み: `codex login`
- アカウントで `gpt-6-astra` が使えること（`ECC_ASTRA_MODEL` で上書き可能）
- このコマンドの実行は、差分を OpenAI に送信することへの同意とみなします。共有できないコードには使わないでください。

## 使い方

```
/astra-review                          # コミットされていない変更（デフォルト）
/astra-review --base main              # このブランチの main との差分すべて
/astra-review --commit HEAD~1          # 1 コミット
/astra-review --files src/a.ts src/b.ts
/astra-review --files-from-commit HEAD~1  # --commit レビュー後の修正ラウンド
/astra-review SQL 層を重点的に見て      # 自由記述はレビュアーへの追加指示になる
```

## ワークフロー

### ステップ 1: スコープの決定

`$ARGUMENTS` を解析します。フラグ（`--base`、`--commit`、`--files`、`--files-from-commit`）がスコープを決め、残りのテキストは `--instructions` として渡します。フラグがなければコミットされていない変更をレビューします。

送信前に、何がマシンの外へ出るかを確認します：

```bash
ASTRA=""
for candidate in "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/scripts/astra-review.js" \
                 "./.claude/scripts/astra-review.js" \
                 "$HOME/.claude/scripts/astra-review.js" \
                 "./scripts/astra-review.js"; do   # plugin, project-local, global, the ECC repo itself
  [ -f "$candidate" ] && ASTRA="$candidate" && break
done
[ -n "$ASTRA" ] || { echo "astra-review.js not found; install ECC commands-core"; exit 2; }
node "$ASTRA" --dry-run [scope flags] | head -40
```

出力が "Nothing to review" ならそこで止め、ユーザーに伝えます。

### ステップ 2: レビューの実行

```bash
node "$ASTRA" --consent-to-openai [scope flags] \
  --instructions "<追加指示があれば>" \
  --output "$(mktemp -d)/astra-review.json"   # private dir, never a shared predictable path
```

スクリプトは Markdown レポートを出力し、終了コード 0（PASS）、1（FAIL）、2（エラー）で終了します。終了コード 2 の場合はエラーをそのまま報告して止めます。主な原因: Codex 未インストール、未ログイン、アカウントでモデルが使えない、タイムアウト。

### ステップ 3: 判定ゲート

- **PASS** かつ MEDIUM の指摘なし: 報告して終了。
- **PASS** かつ MEDIUM/LOW の指摘あり: 一覧を示し、明らかに正しいものは修正して終了。
- **FAIL**（CRITICAL または HIGH あり）: ステップ 4 へ。

### ステップ 4: 修正サイクル（最大 3 ラウンド）

1. すべての CRITICAL / HIGH の指摘をファイルと行番号付きで表示する。
2. 変更する前に各指摘をコードと照合して検証する。Astra が間違うこともある。誤検知なら理由を一行添えてスキップする。
3. 確認できた指摘を修正する。指摘された箇所だけを変え、ついでのリファクタリングはしない。
4. プロジェクトのテストを実行する。
5. ステップ 2 を再実行する。レビュアーは前のラウンドを覚えていない。2 ラウンド目以降のスコープ:
   - デフォルトと `--base`: そのまま。どちらも作業ツリーを差分に含めるので修正も対象になる。
   - `--commit <sha>`: `--files-from-commit <sha>` に切り替える。そのコミットが触ったファイルの現在の内容をレビューする（削除されたパスは除外、マージコミットやルートコミットでも動く）。`--commit` を再実行すると修正前の差分を再送してしまう。

3 ラウンド後も CRITICAL / HIGH が残る場合は止めて、残りをユーザーに引き渡します。プッシュはしません。

### ステップ 5: 報告

```
ASTRA VERDICT: [PASS / FAIL (escalated)]
Model:      gpt-6-astra
Scope:      [uncommitted | base main | commit sha | N files]
Rounds:     [N]/3

Fixed:          [修正した指摘（file:line）]
False positive: [スキップした指摘と理由]
Remaining:      [未解決の CRITICAL/HIGH があれば]
```

## 補足

- スクリプトはプラグインルート配下の `scripts/astra-review.js`、ライブラリは `scripts/lib/astra-review/` にあります。git がレビュー対象のプロジェクトを見るように、必ずそのプロジェクトのディレクトリから実行してください。
- `--base <branch>` は `<branch>` と HEAD のマージベースから作業ツリーまでの差分と、未追跡ファイルを対象にします。ブランチ上のコミット済み・未コミットの両方が含まれます。
- 200 KB を超える差分は切り詰められ、レビュアーには一覧のファイルを読み取り専用ツールで直接読むよう指示します。
- レビュアー側では Web 検索を無効化し、ユーザーレベルの Codex 設定を読み込まず、`codex mcp list` が報告するすべての MCP サーバーを名前指定で無効化します（空の `mcp_servers` テーブルでは無効化されません）。Codex プロセスには PATH / HOME 系の環境変数だけを渡します。環境変数の API キーは転送されません。
- プッシュのゲートにするには `git push` の前に実行し、終了コード 1 ならプッシュしないでください。独立したレビュアーを 2 つ使いたい場合は `/santa-loop` と組み合わせます。
- Codex がない場合は `/code-review` にフォールバックし、クロスプロバイダーレビューが行われなかったことを明示します。
