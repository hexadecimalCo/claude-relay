#!/usr/bin/env node
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import RoomManager from "./room-manager.js";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", short: "p" },
    ngrok: { type: "boolean", default: false },
  },
  strict: false,
});
const PORT = args.port || process.env.PORT || 8080;
const PING_INTERVAL_MS = 30_000;

const roomManager = new RoomManager();
/** @type {Map<string, import('ws').WebSocket>} peerId → ws */
const peers = new Map();

const wss = new WebSocketServer({ port: PORT });

function printMcpConfig(url) {
  console.log(`
     {
       "mcpServers": {
         "claude-relay": {
           "type": "stdio",
           "command": "npx",
           "args": ["-y", "@hexadecimalcoltd/claude-relay-bridge"],
           "env": { "RELAY_URL": "${url}" }
         }
       }
     }
`);
}

function printStartupMessage(ngrokUrl) {
  console.log(`
╔══════════════════════════════════════════════════╗
║          Claude Relay Server Started             ║
╚══════════════════════════════════════════════════╝

  Local:   ws://localhost:${PORT}`);

  if (ngrokUrl) {
    console.log(`  Public:  ${ngrokUrl}

  Share these with the other person:
     - MCP config for their ~/.claude.json:
`);
    printMcpConfig(ngrokUrl);
  } else {
    console.log(`
  Next steps:

  1. Expose to the internet:
     npx @hexadecimalcoltd/claude-relay-server --ngrok
     (or manually: ngrok http ${PORT})

  2. Share these with the other person:
     - The ngrok URL (e.g. wss://abc123.ngrok.io)
     - MCP config for their ~/.claude.json:
`);
    printMcpConfig("wss://<YOUR_NGROK_URL>");
  }

  console.log(`  Open Claude CLI and say:
     "Create a chat room, nickname Alice"
     Then share the pairing code with the other person.
`);
}

import { execFileSync } from "node:child_process";

function isNgrokInstalled() {
  try {
    execFileSync("ngrok", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (args.ngrok) {
  if (!isNgrokInstalled()) {
    console.error(`
╔══════════════════════════════════════════════════╗
║  ngrok is not installed                          ║
╚══════════════════════════════════════════════════╝

  Install ngrok first:

    macOS:   brew install ngrok
    Linux:   snap install ngrok
    Windows: choco install ngrok
    Other:   https://ngrok.com/download

  After installing, authenticate with your ngrok token:
    ngrok config add-authtoken <YOUR_TOKEN>

  Then try again:
    npx @hexadecimalcoltd/claude-relay-server --ngrok
`);
    process.exit(1);
  }

  const ngrokProc = spawn("ngrok", ["http", String(PORT), "--log", "stdout", "--log-format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let started = false;

  ngrokProc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const log = JSON.parse(line);
        if (log.url && log.url.startsWith("https://") && !started) {
          started = true;
          const wssUrl = log.url.replace("https://", "wss://");
          printStartupMessage(wssUrl);
        }
      } catch {
        // not JSON, ignore
      }
    }
  });

  ngrokProc.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[ngrok] ${msg}`);
  });

  ngrokProc.on("close", (code) => {
    if (code && code !== 0) {
      console.error(`\n  [ngrok] exited with code ${code}\n`);
    }
  });

  process.on("SIGINT", () => {
    ngrokProc.kill();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    ngrokProc.kill();
    process.exit(0);
  });
} else {
  printStartupMessage(null);
}

wss.on("connection", (ws, req) => {
  const peerId = randomUUID();
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;

  peers.set(peerId, ws);
  ws._peerId = peerId;
  ws._ip = ip;
  ws._alive = true;

  send(ws, { action: "welcome", peerId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { action: "error", message: "Invalid JSON" });
    }

    handleMessage(ws, peerId, ip, msg);
  });

  ws.on("pong", () => {
    ws._alive = true;
  });

  ws.on("close", () => {
    const roomId = roomManager.findPeerRoom(peerId);
    if (roomId) {
      roomManager.leaveRoom(roomId, peerId);
      broadcastToRoom(roomId, peerId, {
        action: "peer_left",
        peerId,
      });
    }
    peers.delete(peerId);
  });
});

function handleMessage(ws, peerId, ip, msg) {
  const { action, _reqId } = msg;
  const reply = (data) => send(ws, { ...data, _reqId });

  try {
    switch (action) {
      case "create_room": {
        const { nickname } = msg;
        if (!nickname) return reply({ action: "error", message: "nickname required" });
        const result = roomManager.createRoom(peerId, nickname, ip);
        reply({ action: "room_created", ...result });
        break;
      }

      case "join_room": {
        const { pairingCode, nickname } = msg;
        if (!pairingCode || !nickname) {
          return reply({ action: "error", message: "pairingCode and nickname required" });
        }
        const result = roomManager.joinRoom(pairingCode, peerId, nickname);
        reply({ action: "room_joined", ...result });

        // Notify existing participants
        broadcastToRoom(result.roomId, peerId, {
          action: "peer_joined",
          peerId,
          nickname,
          participants: result.participants,
        });
        break;
      }

      case "send_message": {
        const { roomId, text } = msg;
        if (!roomId || !text) {
          return reply({ action: "error", message: "roomId and text required" });
        }
        const result = roomManager.addMessage(roomId, peerId, text);
        reply({ action: "message_sent", seq: result.seq });

        // Push to other participants
        const room = roomManager.rooms.get(roomId);
        const participant = room?.participants.get(peerId);
        broadcastToRoom(roomId, peerId, {
          action: "new_message",
          seq: result.seq,
          from: peerId,
          nickname: participant?.nickname,
          text,
          timestamp: Date.now(),
        });
        break;
      }

      case "get_messages": {
        const { roomId, sinceSeq } = msg;
        if (!roomId) return reply({ action: "error", message: "roomId required" });
        const result = roomManager.getMessages(roomId, peerId, sinceSeq || 0);
        reply({ action: "messages", ...result });
        break;
      }

      case "leave_room": {
        const { roomId } = msg;
        if (!roomId) return reply({ action: "error", message: "roomId required" });
        roomManager.leaveRoom(roomId, peerId);
        reply({ action: "room_left", roomId });

        broadcastToRoom(roomId, peerId, {
          action: "peer_left",
          peerId,
        });
        break;
      }

      default:
        reply({ action: "error", message: `Unknown action: ${action}` });
    }
  } catch (err) {
    reply({ action: "error", message: err.message });
  }
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomId, excludePeerId, data) {
  const room = roomManager.rooms.get(roomId);
  if (!room) return;

  for (const [pid] of room.participants) {
    if (pid === excludePeerId) continue;
    const peerWs = peers.get(pid);
    if (peerWs) send(peerWs, data);
  }
}

// Ping/pong to detect dead connections
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) {
      ws.terminate();
      return;
    }
    ws._alive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(pingInterval);
  roomManager.destroy();
});
