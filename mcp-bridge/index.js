#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import "dotenv/config";

const RELAY_URL = process.env.RELAY_URL || "ws://localhost:8080";
const MAX_RECONNECT_DELAY_MS = 10_000;

// --- State ---
let ws = null;
let peerId = null;
let currentRoomId = null;
let lastSeq = 0;
/** @type {Array<object>} buffered push messages */
const pendingMessages = [];
/** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
const pendingRequests = new Map();
let reqCounter = 0;
let connectPromise = null;
let reconnectAttempts = 0;

// --- WebSocket Client ---

function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    ws = new WebSocket(RELAY_URL);

    ws.on("open", () => {
      reconnectAttempts = 0;
      // Wait for welcome message
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Welcome message
      if (msg.action === "welcome") {
        peerId = msg.peerId;
        resolve();
        return;
      }

      // Response to a request we sent
      if (msg._reqId && pendingRequests.has(msg._reqId)) {
        const pending = pendingRequests.get(msg._reqId);
        clearTimeout(pending.timer);
        pendingRequests.delete(msg._reqId);
        if (msg.action === "error") {
          pending.reject(new Error(msg.message));
        } else {
          pending.resolve(msg);
        }
        return;
      }

      // Push message (new_message, peer_joined, peer_left)
      if (msg.action === "new_message" || msg.action === "peer_joined" || msg.action === "peer_left") {
        pendingMessages.push(msg);
        if (msg.seq && msg.seq > lastSeq) {
          lastSeq = msg.seq;
        }
      }
    });

    ws.on("close", () => {
      ws = null;
      peerId = null;
      connectPromise = null;

      // Auto-reconnect if we were in a room
      if (currentRoomId) {
        const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
        reconnectAttempts++;
        setTimeout(() => connectWs().catch(() => {}), delay);
      }
    });

    ws.on("error", (err) => {
      connectPromise = null;
      reject(err);
    });
  });

  return connectPromise;
}

function sendRequest(data) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("Not connected to relay server"));
    }

    const _reqId = `req_${++reqCounter}`;
    const timer = setTimeout(() => {
      pendingRequests.delete(_reqId);
      reject(new Error("Request timed out"));
    }, 15_000);

    pendingRequests.set(_reqId, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...data, _reqId }));
  });
}

// --- MCP Server ---

const server = new McpServer({
  name: "claude-relay",
  version: "1.0.0",
});

server.tool(
  "create_room",
  "Create a chat room and get a pairing code to share with the other person",
  { nickname: z.string().describe("Your display name in the chat") },
  async ({ nickname }) => {
    if (currentRoomId) {
      return {
        content: [{ type: "text", text: `Error: Already in room ${currentRoomId}. Use leave_room first.` }],
        isError: true,
      };
    }

    await connectWs();
    const res = await sendRequest({ action: "create_room", nickname });
    currentRoomId = res.roomId;
    lastSeq = 0;
    pendingMessages.length = 0;

    return {
      content: [
        {
          type: "text",
          text: `Room created!\n\nPairing code: **${res.pairingCode}**\nRoom ID: ${res.roomId}\n\nShare the pairing code with the other person so they can join.`,
        },
      ],
    };
  }
);

server.tool(
  "join_room",
  "Join an existing chat room using a pairing code",
  {
    pairing_code: z.string().describe("The 6-digit pairing code from the room creator"),
    nickname: z.string().describe("Your display name in the chat"),
  },
  async ({ pairing_code, nickname }) => {
    if (currentRoomId) {
      return {
        content: [{ type: "text", text: `Error: Already in room ${currentRoomId}. Use leave_room first.` }],
        isError: true,
      };
    }

    await connectWs();
    const res = await sendRequest({ action: "join_room", pairingCode: pairing_code, nickname });
    currentRoomId = res.roomId;
    lastSeq = 0;
    pendingMessages.length = 0;

    const participantList = res.participants.map((p) => `- ${p.nickname}`).join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Joined room successfully!\n\nRoom ID: ${res.roomId}\nParticipants:\n${participantList}\n\nYou can now send and receive messages.`,
        },
      ],
    };
  }
);

server.tool(
  "send_message",
  "Send a message to the chat room",
  { message: z.string().describe("The message to send") },
  async ({ message }) => {
    if (!currentRoomId) {
      return {
        content: [{ type: "text", text: "Error: Not in a room. Use create_room or join_room first." }],
        isError: true,
      };
    }

    await connectWs();
    const res = await sendRequest({ action: "send_message", roomId: currentRoomId, text: message });

    return {
      content: [{ type: "text", text: `Message sent (seq: ${res.seq})` }],
    };
  }
);

server.tool(
  "receive_messages",
  "Check for new messages in the chat room. Call this periodically to see if the other person has replied.",
  {},
  async () => {
    if (!currentRoomId) {
      return {
        content: [{ type: "text", text: "Error: Not in a room. Use create_room or join_room first." }],
        isError: true,
      };
    }

    // First, drain any buffered push messages
    const buffered = pendingMessages.splice(0);

    // Also do a pull request to catch anything we might have missed
    try {
      await connectWs();
      const res = await sendRequest({
        action: "get_messages",
        roomId: currentRoomId,
        sinceSeq: lastSeq,
      });

      if (res.latestSeq > lastSeq) {
        lastSeq = res.latestSeq;
      }

      // Merge: use pulled messages but avoid duplicates
      const seenSeqs = new Set(buffered.map((m) => m.seq));
      for (const m of res.messages) {
        if (!seenSeqs.has(m.seq)) {
          buffered.push(m);
        }
      }
    } catch {
      // If pull fails, still return buffered messages
    }

    // Sort by seq
    buffered.sort((a, b) => (a.seq || 0) - (b.seq || 0));

    if (buffered.length === 0) {
      return {
        content: [{ type: "text", text: "No new messages." }],
      };
    }

    const formatted = buffered
      .map((m) => {
        if (m.action === "peer_joined") {
          return `[system] ${m.nickname} joined the room`;
        }
        if (m.action === "peer_left") {
          return `[system] A peer left the room`;
        }
        if (m.from === "system") {
          return `[system] ${m.text}`;
        }
        return `[${m.nickname}] ${m.text}`;
      })
      .join("\n");

    return {
      content: [{ type: "text", text: formatted }],
    };
  }
);

server.tool(
  "leave_room",
  "Leave the current chat room",
  {},
  async () => {
    if (!currentRoomId) {
      return {
        content: [{ type: "text", text: "Not in a room." }],
      };
    }

    try {
      await connectWs();
      await sendRequest({ action: "leave_room", roomId: currentRoomId });
    } catch {
      // Best effort
    }

    const leftRoom = currentRoomId;
    currentRoomId = null;
    lastSeq = 0;
    pendingMessages.length = 0;

    return {
      content: [{ type: "text", text: `Left room ${leftRoom}.` }],
    };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
