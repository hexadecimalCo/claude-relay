> [中文版](./README.zh-TW.md)

# Claude Relay — Cross-Machine Chat via MCP

A lightweight WebSocket relay system that enables two Claude CLI instances to communicate across machines via MCP, allowing real-time cross-device conversations between users through their own Claude agents.

## Architecture

```
User A's Machine                Network                    User B's Machine
+------------------+        +------------------+        +------------------+
| Claude CLI       |        |  Relay Server    |        | Claude CLI       |
|   ↓              |        |  (WebSocket)     |        |   ↓              |
| MCP Bridge       |←WSS→  |  Room Manager    |  ←WSS→| MCP Bridge       |
| (stdio server)   |        |  Message Router  |        | (stdio server)   |
+------------------+        +------------------+        +------------------+
```

## Prerequisites

- **Node.js** >= 18 (required on both machines)
- **Claude CLI** (required on both machines)
- **ngrok** (only needed by the host, to expose the relay server)

## Installation

There are two ways to install — pick whichever suits your setup.

### Option A: npm (recommended)

No need to clone anything. Just configure `~/.claude.json`:

**Relay Server (Host only):**

```bash
npx @hexadecimalcoltd/claude-relay-server
# or with custom port
npx @hexadecimalcoltd/claude-relay-server --port 3000
```

**MCP Bridge (both users):**

Add to `~/.claude.json`:

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

### Option B: Clone the repo

```bash
git clone https://github.com/hexadecimalCo/claude-relay.git
cd claude-relay
```

Then follow the manual setup below.

---

## Quick Start (Host / User A)

### 1. Start the Relay Server

**npm:**
```bash
npx @hexadecimalcoltd/claude-relay-server
```

**From source:**
```bash
cd relay-server
npm install
node index.js
```

Defaults to port `8080`. To use a custom port:

```bash
node index.js --port 3000
# or
node index.js -p 3000
# or
PORT=3000 node index.js
```

### 2. Expose to the Internet (optional)

If the other person is not on the same local network, use ngrok:

```bash
# Make sure the port matches step 1
ngrok http 8080
```

Note down the public URL (e.g. `https://abc123.ngrok.io`).

### 3. Configure Your MCP

Add the following to `~/.claude.json` (if the file already has other settings, merge `claude-relay` into the existing `mcpServers`):

**If installed via npm:**
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

**If cloned from source:**
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

> **Note:** `RELAY_URL` should be `ws://localhost:8080` since you're the host (adjust the port to match step 1).

### 4. Send the Following to the Other Person

- Your ngrok public URL (e.g. `wss://abc123.ngrok.io`)
- If they don't use npm: also send the `claude-relay/` folder

---

## Quick Start (Guest / User B)

### 1. Install

**npm (just need the URL from the host):**

Add to `~/.claude.json`:
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

**From source (if you received the folder):**

```bash
chmod +x setup.sh
./setup.sh
```

Then paste the printed config into `~/.claude.json` and fill in the `RELAY_URL`.

> **Note:** Use `wss://` (with TLS) for ngrok URLs, not `ws://`.

### 2. Verify

Restart Claude CLI — you should see `claude-relay` listed as a loaded MCP server.

---

## Usage

### Step 1: Create a Room (User A)

Tell Claude:

> Create a chat room, my nickname is Alice

Claude will call `create_room` and return a pairing code:

> Room created! Pairing code is **482917**. Share this with the other person.

### Step 2: Share the Pairing Code

Send the 6-digit code to User B via Slack, LINE, or any channel.

### Step 3: Join the Room (User B)

Tell Claude:

> Join chat room, pairing code 482917, my nickname is Bob

### Step 4: Chat

**Send a message** — just tell Claude what to say:

> Tell them: let's discuss the API design

**Receive messages** — ask Claude to check:

> Check for new messages

**Leave the room:**

> Leave the chat room

---

## Security

| Mechanism | Description |
|-----------|-------------|
| One-time pairing code | Invalidated immediately after use |
| 2-person room limit | No third party can join a full room |
| In-memory only | Messages are never written to disk |
| Auto-cleanup | Idle rooms are destroyed after 30 minutes |
| Rate limiting | Max 5 rooms per IP, 100 messages per person per minute |
| WSS encryption | TLS via ngrok or Caddy/nginx |

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_room` | Create a room and get a pairing code |
| `join_room` | Join a room using a pairing code |
| `send_message` | Send a message to the room |
| `receive_messages` | Pull new messages (pull-based) |
| `leave_room` | Leave and close the room |
