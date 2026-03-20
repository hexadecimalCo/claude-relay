import crypto from "node:crypto";

const MAX_ROOMS_PER_IP = 5;
const MAX_MESSAGES_PER_MINUTE = 100;
const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds
const MAX_PARTICIPANTS = 2;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_NICKNAME_LENGTH = 32;

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, string>} pairingCode → roomId */
    this.pairingCodes = new Map();
    /** @type {Map<string, number>} ip → room count */
    this.ipRoomCount = new Map();
    /** @type {Map<string, { count: number, resetAt: number }>} peerId → rate limit */
    this.messageRates = new Map();

    this._cleanupTimer = setInterval(() => this.cleanupStale(), CLEANUP_INTERVAL_MS);
  }

  _sanitizeNickname(nickname) {
    if (typeof nickname !== "string" || nickname.trim().length === 0) {
      throw new Error("Nickname cannot be empty");
    }
    // Strip control chars, trim, and limit length
    const clean = nickname.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, MAX_NICKNAME_LENGTH);
    if (clean.length === 0) {
      throw new Error("Nickname contains only invalid characters");
    }
    return clean;
  }

  createRoom(peerId, nickname, ip) {
    nickname = this._sanitizeNickname(nickname);

    // Prevent creating a room while already in one
    const existingRoom = this.findPeerRoom(peerId);
    if (existingRoom) {
      throw new Error("Already in a room. Leave the current room first.");
    }

    // Rate limit: max rooms per IP
    const currentCount = this.ipRoomCount.get(ip) || 0;
    if (currentCount >= MAX_ROOMS_PER_IP) {
      throw new Error(`Rate limit: max ${MAX_ROOMS_PER_IP} rooms per IP`);
    }

    const roomId = crypto.randomUUID();
    const pairingCode = String(crypto.randomInt(100000, 999999));

    const room = {
      id: roomId,
      pairingCode,
      participants: new Map([[peerId, { nickname, joinedAt: Date.now() }]]),
      messages: [],
      seq: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      creatorIp: ip,
    };

    this.rooms.set(roomId, room);
    this.pairingCodes.set(pairingCode, roomId);
    this.ipRoomCount.set(ip, currentCount + 1);

    return { roomId, pairingCode };
  }

  joinRoom(pairingCode, peerId, nickname) {
    nickname = this._sanitizeNickname(nickname);

    // Prevent joining while already in a room
    const existingRoom = this.findPeerRoom(peerId);
    if (existingRoom) {
      throw new Error("Already in a room. Leave the current room first.");
    }

    const roomId = this.pairingCodes.get(pairingCode);
    if (!roomId) {
      throw new Error("Invalid or expired pairing code");
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error("Room no longer exists");
    }

    if (room.participants.size >= MAX_PARTICIPANTS) {
      throw new Error("Room is full");
    }

    if (room.participants.has(peerId)) {
      throw new Error("Already in this room");
    }

    // One-time use: delete pairing code immediately
    this.pairingCodes.delete(pairingCode);
    room.pairingCode = null;

    room.participants.set(peerId, { nickname, joinedAt: Date.now() });
    room.lastActivity = Date.now();

    // Notify existing participants
    const joinMsg = {
      seq: ++room.seq,
      from: "system",
      text: `[${nickname}] has joined the room`,
      timestamp: Date.now(),
    };
    room.messages.push(joinMsg);

    return { roomId, participants: this._getParticipantList(room) };
  }

  addMessage(roomId, peerId, text) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");
    if (!room.participants.has(peerId)) throw new Error("Not in this room");

    // Validate message length
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("Message cannot be empty");
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
    }

    // Rate limit: messages per minute
    this._checkMessageRate(peerId);

    const participant = room.participants.get(peerId);
    const msg = {
      seq: ++room.seq,
      from: peerId,
      nickname: participant.nickname,
      text,
      timestamp: Date.now(),
    };

    room.messages.push(msg);
    room.lastActivity = Date.now();

    return { seq: msg.seq };
  }

  getMessages(roomId, peerId, sinceSeq) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");
    if (!room.participants.has(peerId)) throw new Error("Not in this room");

    const messages = room.messages.filter((m) => m.seq > sinceSeq);
    return { messages, latestSeq: room.seq };
  }

  leaveRoom(roomId, peerId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const participant = room.participants.get(peerId);
    if (!participant) return;

    room.participants.delete(peerId);

    // Add leave message
    const leaveMsg = {
      seq: ++room.seq,
      from: "system",
      text: `[${participant.nickname}] has left the room`,
      timestamp: Date.now(),
    };
    room.messages.push(leaveMsg);

    // Destroy room if empty
    if (room.participants.size === 0) {
      this._destroyRoom(roomId, room);
    }
  }

  /** Find which room a peer is in */
  findPeerRoom(peerId) {
    for (const [roomId, room] of this.rooms) {
      if (room.participants.has(peerId)) return roomId;
    }
    return null;
  }

  cleanupStale() {
    const now = Date.now();
    for (const [roomId, room] of this.rooms) {
      if (now - room.lastActivity > ROOM_TTL_MS) {
        this._destroyRoom(roomId, room);
      }
    }
  }

  _destroyRoom(roomId, room) {
    // Clean up pairing code if still active
    if (room.pairingCode) {
      this.pairingCodes.delete(room.pairingCode);
    }
    // Decrement IP room count
    if (room.creatorIp) {
      const count = this.ipRoomCount.get(room.creatorIp) || 1;
      if (count <= 1) {
        this.ipRoomCount.delete(room.creatorIp);
      } else {
        this.ipRoomCount.set(room.creatorIp, count - 1);
      }
    }
    this.rooms.delete(roomId);
  }

  _checkMessageRate(peerId) {
    const now = Date.now();
    let rate = this.messageRates.get(peerId);

    if (!rate || now > rate.resetAt) {
      rate = { count: 0, resetAt: now + 60_000 };
      this.messageRates.set(peerId, rate);
    }

    rate.count++;
    if (rate.count > MAX_MESSAGES_PER_MINUTE) {
      throw new Error(`Rate limit: max ${MAX_MESSAGES_PER_MINUTE} messages per minute`);
    }
  }

  _getParticipantList(room) {
    return Array.from(room.participants.entries()).map(([id, p]) => ({
      peerId: id,
      nickname: p.nickname,
    }));
  }

  destroy() {
    clearInterval(this._cleanupTimer);
  }
}

export default RoomManager;
