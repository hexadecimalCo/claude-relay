> [English](./README.md)

# Claude Relay — MCP 跨機器對話系統

讓兩個人類使用者各自開啟 Claude CLI，透過各自的 Claude 實例進行跨機器即時討論。

## 架構

```
User A 的機器                     網路                        User B 的機器
+------------------+        +------------------+        +------------------+
| Claude CLI       |        |  Relay Server    |        | Claude CLI       |
|   ↓              |        |  (WebSocket)     |        |   ↓              |
| MCP Bridge       |←WSS→  |  Room Manager    |  ←WSS→| MCP Bridge       |
| (stdio server)   |        |  Message Router  |        | (stdio server)   |
+------------------+        +------------------+        +------------------+
```

## 前置需求

- **Node.js** >= 18（兩台機器都需要）
- **Claude CLI**（兩台機器都需要）
- **ngrok**（僅發起方需要，用於暴露 relay server 給外網）

## 安裝方式

兩種方式擇一，依你的環境選擇。

### 方式 A：npm（推薦）

不需要 clone 任何東西，直接設定即可。

**Relay Server（僅 Host）：**

```bash
npx @hexadecimalcoltd/claude-relay-server
# 自訂 port
npx @hexadecimalcoltd/claude-relay-server --port 3000
```

**MCP Bridge（雙方都要設定）：**

在 `~/.claude.json` 加入：

```json
{
  "mcpServers": {
    "claude-relay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hexadecimalcoltd/claude-relay-bridge"],
      "env": {
        "RELAY_URL": "ws://localhost:8080"
      }
    }
  }
}
```

### 方式 B：Clone repo

```bash
git clone https://github.com/hexadecimalCo/claude-relay.git
cd claude-relay
```

接著照下方手動設定。

---

## 快速開始（發起方 / User A）

### 1. 啟動 Relay Server

**npm：**
```bash
npx @hexadecimalcoltd/claude-relay-server
```

**從原始碼：**
```bash
cd relay-server
npm install
node index.js
```

預設跑在 port `8080`。可自訂 port：

```bash
node index.js --port 3000
# 或
node index.js -p 3000
# 或
PORT=3000 node index.js
```

### 2. 暴露給外網（可選）

如果對方不在同一個區域網路，需要用 ngrok 暴露：

```bash
# port 要跟上面啟動的一致
ngrok http 8080
```

記下 ngrok 給你的公開 URL（如 `https://abc123.ngrok.io`）。

### 3. 設定自己的 MCP

在 `~/.claude.json` 加入（如果檔案已有其他設定，把 `claude-relay` 加進現有的 `mcpServers` 裡）：

**npm 安裝：**
```json
{
  "mcpServers": {
    "claude-relay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hexadecimalcoltd/claude-relay-bridge"],
      "env": {
        "RELAY_URL": "ws://localhost:8080"
      }
    }
  }
}
```

**從原始碼：**
```json
{
  "mcpServers": {
    "claude-relay": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-bridge/index.js"],
      "env": {
        "RELAY_URL": "ws://localhost:8080"
      }
    }
  }
}
```

> **注意**：因為是本機，`RELAY_URL` 用 `ws://localhost:8080` 即可（port 要跟步驟 1 一致）。

### 4. 把以下東西傳給對方

- 你的 ngrok 公開 URL（如 `wss://abc123.ngrok.io`）
- 如果對方不用 npm：也傳 `claude-relay/` 資料夾給他

---

## 快速開始（接收方 / User B）

### 1. 安裝

**npm（只需要 Host 給的 URL）：**

在 `~/.claude.json` 加入：
```json
{
  "mcpServers": {
    "claude-relay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hexadecimalcoltd/claude-relay-bridge"],
      "env": {
        "RELAY_URL": "wss://abc123.ngrok.io"
      }
    }
  }
}
```

**從原始碼（收到資料夾的情況）：**

```bash
chmod +x setup.sh
./setup.sh
```

把印出的設定貼到 `~/.claude.json`，並填入 `RELAY_URL`。

> **注意**：ngrok URL 用 `wss://`（有 TLS），不是 `ws://`。

### 2. 驗證

重新開啟 Claude CLI，應該能在啟動時看到 `claude-relay` MCP server 已載入。

---

## 使用方式

### 第一步：建立聊天室（User A）

對 Claude 說：

> 幫我建立聊天室，暱稱叫 Alice

Claude 會呼叫 `create_room` 並回覆配對碼：

> 聊天室已建立！配對碼是 **482917**，把這個碼傳給對方就能加入。

### 第二步：分享配對碼

透過 Slack、LINE、或任何管道把 6 位數配對碼告訴 User B。

### 第三步：加入聊天室（User B）

對 Claude 說：

> 加入聊天室，配對碼 482917，我的暱稱是 Bob

### 第四步：開始對話

**發送訊息** — 直接告訴 Claude 你想說的話：

> 跟對方說：我們來討論一下 API 的設計

**接收訊息** — 請 Claude 檢查新訊息：

> 看看有沒有新訊息

**離開聊天室**：

> 離開聊天室

---

## 安全說明

| 機制 | 說明 |
|------|------|
| 配對碼一次性使用 | 加入後立即失效，無法被重複使用 |
| 房間限制 2 人 | 第三方無法加入已滿的房間 |
| 訊息不落地 | 所有資料只存在記憶體中，不寫入磁碟 |
| 自動清理 | 閒置超過 30 分鐘的房間自動銷毀 |
| 速率限制 | 每 IP 最多 5 個房間，每人每分鐘最多 100 則訊息 |
| WSS 加密 | 搭配 ngrok 或 Caddy/nginx 時自動使用 TLS 加密 |

## MCP Tools 一覽

| Tool | 功能 |
|------|------|
| `create_room` | 建立房間，取得配對碼 |
| `join_room` | 用配對碼加入房間 |
| `send_message` | 發送訊息給聊天室 |
| `receive_messages` | 拉取新訊息（pull-based） |
| `leave_room` | 離開並關閉聊天室 |
