const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  proto,
  initAuthCreds,
  BufferJSON,
  getContentType
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');

// Custom in-memory store (compatible with Baileys v6+)
function makeInMemoryStore({ logger }) {
  const store = {
    chats: {
      _data: new Map(),
      all() { return Array.from(this._data.values()); },
      get(id) { return this._data.get(id); },
      upsert(chat) { this._data.set(chat.id, { ...this._data.get(chat.id), ...chat }); },
    },
    contacts: {},
    messages: {},
    bind(ev) {
      ev.on('chats.upsert', (chats) => {
        for (const chat of chats) store.chats.upsert(chat);
      });
      ev.on('chats.update', (updates) => {
        for (const update of updates) {
          const existing = store.chats.get(update.id);
          if (existing) store.chats.upsert({ ...existing, ...update });
        }
      });
      ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
          store.contacts[contact.id] = { ...store.contacts[contact.id], ...contact };
        }
      });
      ev.on('contacts.update', (updates) => {
        for (const update of updates) {
          if (store.contacts[update.id]) Object.assign(store.contacts[update.id], update);
        }
      });
      ev.on('messages.upsert', ({ messages: msgs, type }) => {
        for (const msg of msgs) {
          const jid = msg.key.remoteJid;
          if (!jid) continue;
          if (!store.messages[jid]) store.messages[jid] = { array: [] };
          const idx = store.messages[jid].array.findIndex(m => m.key.id === msg.key.id);
          if (idx >= 0) store.messages[jid].array[idx] = msg;
          else store.messages[jid].array.push(msg);
        }
      });
      ev.on('messages.update', (updates) => {
        for (const { key, update } of updates) {
          const jid = key.remoteJid;
          if (store.messages[jid]) {
            const idx = store.messages[jid].array.findIndex(m => m.key.id === key.id);
            if (idx >= 0) Object.assign(store.messages[jid].array[idx], update);
          }
        }
      });
    }
  };
  return store;
}

// ─── Config ───
const PORT = process.env.PORT || 3000;
const OWNER_KEY = process.env.OWNER_KEY || 'admin123';
const MONGODB_URI = process.env.MONGODB_URI || '';

// ─── State ───
let sock = null;
let currentQR = null;
let connectionState = 'disconnected';
let connectedUser = null;
let authCollection = null;
let db = null;
let store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
const ppCache = new Map();
const PP_CACHE_TTL = 30 * 60 * 1000;
const starredMessages = new Set();

// ─── Express + Socket.io ───
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// ─── MongoDB Auth State ───
async function useMongoDBAuthState(collection) {
  const readData = async (id) => {
    try {
      const doc = await collection.findOne({ _id: id });
      if (!doc || !doc.value) return null;
      return JSON.parse(doc.value, BufferJSON.reviver);
    } catch { return null; }
  };
  const writeData = async (id, value) => {
    const data = JSON.stringify(value, BufferJSON.replacer);
    await collection.updateOne(
      { _id: id },
      { $set: { value: data, updatedAt: new Date() } },
      { upsert: true }
    );
  };
  const removeData = async (id) => { await collection.deleteOne({ _id: id }); };
  const creds = (await readData('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value)
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  };
}

// ─── Helpers ───
async function getProfilePic(jid) {
  const cached = ppCache.get(jid);
  if (cached && Date.now() - cached.time < PP_CACHE_TTL) return cached.url;
  try {
    const url = await sock.profilePictureUrl(jid, 'preview');
    ppCache.set(jid, { url, time: Date.now() });
    return url;
  } catch {
    ppCache.set(jid, { url: null, time: Date.now() });
    return null;
  }
}

function getMessageText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return '📷 ' + message.imageMessage.caption;
  if (message.imageMessage) return '📷 Photo';
  if (message.videoMessage?.caption) return '🎥 ' + message.videoMessage.caption;
  if (message.videoMessage) return '🎥 Video';
  if (message.audioMessage) return message.audioMessage.ptt ? '🎤 Voice message' : '🎵 Audio';
  if (message.documentMessage) return '📄 ' + (message.documentMessage.fileName || 'Document');
  if (message.stickerMessage) return '🏷️ Sticker';
  if (message.contactMessage) return '👤 Contact';
  if (message.locationMessage) return '📍 Location';
  if (message.pollCreationMessage || message.pollCreationMessageV3) return '📊 Poll';
  if (message.reactionMessage) return message.reactionMessage.text || '❤️';
  if (message.protocolMessage) return '';
  return '';
}

function formatMessage(msg) {
  if (!msg || !msg.message) return null;
  const content = msg.message;
  if (content.protocolMessage || content.senderKeyDistributionMessage) return null;
  if (msg.key.remoteJid === 'status@broadcast') return null;

  let type = 'text';
  let text = '';
  let mediaInfo = null;
  let quotedMsg = null;
  let pollData = null;
  let reactions = [];
  let linkPreview = null;

  if (content.conversation) {
    text = content.conversation;
  } else if (content.extendedTextMessage) {
    text = content.extendedTextMessage.text || '';
    if (content.extendedTextMessage.contextInfo?.quotedMessage) {
      quotedMsg = {
        id: content.extendedTextMessage.contextInfo?.stanzaId || '',
        text: getMessageText(content.extendedTextMessage.contextInfo.quotedMessage),
        participant: content.extendedTextMessage.contextInfo.participant || ''
      };
    }
    // Link preview
    if (content.extendedTextMessage.matchedText) {
      linkPreview = {
        url: content.extendedTextMessage.matchedText,
        title: content.extendedTextMessage.title || '',
        description: content.extendedTextMessage.description || '',
        canonicalUrl: content.extendedTextMessage.canonicalUrl || ''
      };
    }
  } else if (content.imageMessage) {
    type = 'image';
    text = content.imageMessage.caption || '';
    mediaInfo = {
      mimetype: content.imageMessage.mimetype,
      size: content.imageMessage.fileLength,
      width: content.imageMessage.width,
      height: content.imageMessage.height
    };
    if (content.imageMessage.contextInfo?.quotedMessage) {
      quotedMsg = {
        id: content.imageMessage.contextInfo?.stanzaId || '',
        text: getMessageText(content.imageMessage.contextInfo.quotedMessage),
        participant: content.imageMessage.contextInfo.participant || ''
      };
    }
  } else if (content.videoMessage) {
    type = 'video';
    text = content.videoMessage.caption || '';
    mediaInfo = {
      mimetype: content.videoMessage.mimetype,
      size: content.videoMessage.fileLength,
      seconds: content.videoMessage.seconds,
      gifPlayback: content.videoMessage.gifPlayback || false
    };
  } else if (content.audioMessage) {
    type = content.audioMessage.ptt ? 'ptt' : 'audio';
    mediaInfo = {
      mimetype: content.audioMessage.mimetype,
      seconds: content.audioMessage.seconds,
      waveform: content.audioMessage.waveform ? Array.from(content.audioMessage.waveform) : null
    };
  } else if (content.documentMessage) {
    type = 'document';
    text = content.documentMessage.fileName || 'Document';
    mediaInfo = {
      mimetype: content.documentMessage.mimetype,
      size: content.documentMessage.fileLength,
      fileName: content.documentMessage.fileName,
      pageCount: content.documentMessage.pageCount
    };
  } else if (content.stickerMessage) {
    type = 'sticker';
    mediaInfo = {
      mimetype: content.stickerMessage.mimetype,
      isAnimated: content.stickerMessage.isAnimated || false
    };
  } else if (content.contactMessage || content.contactsArrayMessage) {
    type = 'contact';
    if (content.contactsArrayMessage) {
      text = content.contactsArrayMessage.displayName || `${content.contactsArrayMessage.contacts?.length || 0} contacts`;
      mediaInfo = { contacts: content.contactsArrayMessage.contacts?.map(c => ({ name: c.displayName, vcard: c.vcard })) };
    } else {
      text = content.contactMessage.displayName || 'Contact';
      mediaInfo = { vcard: content.contactMessage.vcard };
    }
  } else if (content.locationMessage || content.liveLocationMessage) {
    type = 'location';
    const loc = content.locationMessage || content.liveLocationMessage;
    text = loc.name || loc.address || 'Location';
    mediaInfo = {
      lat: loc.degreesLatitude,
      lng: loc.degreesLongitude,
      name: loc.name,
      address: loc.address,
      isLive: !!content.liveLocationMessage
    };
  } else if (content.pollCreationMessage || content.pollCreationMessageV3) {
    type = 'poll';
    const poll = content.pollCreationMessage || content.pollCreationMessageV3;
    pollData = {
      name: poll.name,
      options: poll.options?.map(o => ({ name: o.optionName })) || [],
      selectableCount: poll.selectableOptionsCount || 1
    };
    text = poll.name || 'Poll';
  } else if (content.reactionMessage) {
    return null; // Reactions handled separately
  }

  const ts = typeof msg.messageTimestamp === 'object'
    ? msg.messageTimestamp.low || msg.messageTimestamp.toNumber?.() || 0
    : Number(msg.messageTimestamp) || 0;

  return {
    id: msg.key.id,
    remoteJid: msg.key.remoteJid,
    fromMe: msg.key.fromMe || false,
    participant: msg.key.participant || null,
    pushName: msg.pushName || '',
    timestamp: ts,
    type, text, mediaInfo, quotedMsg, pollData, reactions, linkPreview,
    starred: starredMessages.has(msg.key.id),
    status: msg.status
  };
}

// ─── WhatsApp Connection ───
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMongoDBAuthState(authCollection);
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; }
  catch { version = [2, 3000, 1015901307]; }

  sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp Web Clone', 'Chrome', '120.0'],
    syncFullHistory: true,
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => {
      const msgs = store.messages[key.remoteJid];
      if (msgs) {
        const m = msgs.array.find(m => m.key.id === key.id);
        return m?.message || undefined;
      }
      return undefined;
    }
  });

  store.bind(sock.ev);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
        connectionState = 'qr';
        io.emit('qr', currentQR);
        io.emit('connection-status', { status: 'qr' });
      } catch (e) { console.error('QR error:', e); }
    }
    if (connection === 'close') {
      connectionState = 'disconnected';
      connectedUser = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      io.emit('connection-status', {
        status: 'disconnected',
        reason: code === DisconnectReason.loggedOut ? 'logged_out' : 'connection_lost'
      });
      if (shouldReconnect) {
        console.log('Reconnecting in 3s...');
        setTimeout(connectToWhatsApp, 3000);
      } else {
        await authCollection.deleteMany({});
        currentQR = null;
        store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
      }
    } else if (connection === 'open') {
      connectionState = 'connected';
      currentQR = null;
      connectedUser = {
        id: sock.user?.id,
        name: sock.user?.name || sock.user?.verifiedName || sock.user?.id?.split('@')[0] || ''
      };
      console.log('Connected as:', connectedUser.name);
      io.emit('connection-status', { status: 'connected', user: connectedUser });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Handle reactions
      if (msg.message?.reactionMessage) {
        io.emit('message-reaction', {
          key: msg.message.reactionMessage.key,
          reaction: msg.message.reactionMessage.text,
          from: msg.key.participant || msg.key.remoteJid,
          fromMe: msg.key.fromMe
        });
        continue;
      }
      const formatted = formatMessage(msg);
      if (formatted) io.emit('new-message', formatted);
    }
  });

  sock.ev.on('messages.update', (updates) => {
    const formatted = updates.map(u => ({
      id: u.key.id, remoteJid: u.key.remoteJid,
      fromMe: u.key.fromMe, status: u.update?.status
    })).filter(u => u.status);
    if (formatted.length) io.emit('messages-status', formatted);
  });

  sock.ev.on('messages.delete', (data) => {
    if (data.keys) {
      io.emit('messages-deleted', data.keys.map(k => ({
        id: k.id, remoteJid: k.remoteJid
      })));
    }
  });

  sock.ev.on('chats.upsert', () => io.emit('chats-changed'));
  sock.ev.on('chats.update', (updates) => {
    io.emit('chats-update', updates.map(u => ({
      id: u.id, pinned: u.pinned, archived: u.archived,
      mute: u.mute, unreadCount: u.unreadCount
    })));
    io.emit('chats-changed');
  });
  sock.ev.on('chats.delete', () => io.emit('chats-changed'));
  sock.ev.on('presence.update', (data) => io.emit('presence-update', data));
  sock.ev.on('contacts.upsert', () => io.emit('contacts-changed'));
  sock.ev.on('contacts.update', () => io.emit('contacts-changed'));

  // Group participant updates
  sock.ev.on('group-participants.update', (data) => {
    io.emit('group-update', data);
  });
}

// ─── Socket.io Handlers ───
io.on('connection', (socket) => {
  let authenticated = false;

  socket.on('auth', (password) => {
    if (password === OWNER_KEY) {
      authenticated = true;
      socket.emit('auth-success', {
        connectionStatus: connectionState,
        user: connectedUser, qr: currentQR
      });
    } else {
      socket.emit('auth-failed', 'Wrong password');
    }
  });

  // ─── Pairing Code ───
  socket.on('request-pairing-code', guard(async (phoneNumber) => {
    if (!sock) return socket.emit('error-msg', 'WhatsApp not initialized');
    try {
      // Clean phone number - remove spaces, dashes, plus sign
      const cleanNumber = phoneNumber.replace(/[\s\-\+]/g, '');
      if (!/^\d{10,15}$/.test(cleanNumber)) {
        return socket.emit('error-msg', 'Invalid phone number format');
      }
      const code = await sock.requestPairingCode(cleanNumber);
      socket.emit('pairing-code', code);
    } catch (e) {
      console.error('Pairing code error:', e);
      socket.emit('error-msg', 'Failed to get pairing code: ' + e.message);
    }
  }));

  function guard(fn) {
    return (...args) => {
      if (!authenticated) return socket.emit('error-msg', 'Not authenticated');
      fn(...args);
    };
  }

  // ─── Chat List ───
  socket.on('get-chats', guard(async () => {
    if (!sock || connectionState !== 'connected') return socket.emit('chats-list', []);
    try {
      const allChats = store.chats?.all?.() || [];
      const chatArray = Array.isArray(allChats) ? allChats : Object.values(allChats);
      chatArray.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0);
      });

      const formatted = [];
      for (const chat of chatArray.slice(0, 150)) {
        if (chat.id === 'status@broadcast') continue;
        const isGroup = chat.id.endsWith('@g.us');
        let name = chat.name || chat.subject || '';
        if (!name) {
          name = isGroup ? 'Group' : chat.id.split('@')[0];
          const contact = store.contacts?.[chat.id];
          if (contact) name = contact.name || contact.notify || contact.verifiedName || name;
        }
        let profilePic = null;
        try { profilePic = await getProfilePic(chat.id); } catch {}

        let lastMsg = '', lastMsgFrom = '';
        const msgs = store.messages[chat.id];
        if (msgs?.array?.length) {
          const last = msgs.array[msgs.array.length - 1];
          lastMsg = getMessageText(last.message);
          if (isGroup && !last.key.fromMe) {
            lastMsgFrom = last.pushName || last.key.participant?.split('@')[0] || '';
          }
        }

        formatted.push({
          id: chat.id, name, lastMessage: lastMsg, lastMsgFrom,
          timestamp: chat.conversationTimestamp || 0,
          unreadCount: chat.unreadCount || 0,
          profilePic, isGroup,
          pinned: chat.pinned || false,
          archived: chat.archived || false,
          muted: chat.mute ? true : false
        });
      }
      socket.emit('chats-list', formatted);
    } catch (e) {
      console.error('get-chats error:', e);
      socket.emit('chats-list', []);
    }
  }));

  // ─── Messages ───
  socket.on('get-messages', guard(async (jid) => {
    if (!sock) return;
    try {
      const msgs = store.messages[jid];
      let messages = [];
      if (msgs?.array?.length) {
        messages = msgs.array.slice(-100).map(formatMessage).filter(Boolean);
      }
      if (!messages.length) {
        try {
          const fetched = await sock.fetchMessageHistory(50, { remoteJid: jid }, {});
          messages = (fetched || []).map(formatMessage).filter(Boolean);
        } catch {}
      }
      socket.emit('chat-messages', { jid, messages });
    } catch (e) {
      console.error('get-messages error:', e);
      socket.emit('chat-messages', { jid, messages: [] });
    }
  }));

  // ─── Send Text ───
  socket.on('send-message', guard(async ({ jid, text, quotedId }) => {
    if (!sock || !text?.trim()) return;
    try {
      let quoted = null;
      if (quotedId) {
        const msgs = store.messages[jid];
        quoted = msgs?.array?.find(m => m.key.id === quotedId);
      }
      const sent = await sock.sendMessage(jid, { text: text.trim() }, { quoted });
      const formatted = formatMessage(sent);
      if (formatted) socket.emit('message-sent', formatted);
    } catch (e) { socket.emit('error-msg', 'Failed to send message'); }
  }));

  // ─── Send Media ───
  socket.on('send-media', guard(async ({ jid, type, data, caption, mimetype, fileName, quotedId }) => {
    if (!sock) return;
    try {
      const buffer = Buffer.from(data, 'base64');
      let msgContent = {};
      let quoted = null;
      if (quotedId) {
        const msgs = store.messages[jid];
        quoted = msgs?.array?.find(m => m.key.id === quotedId);
      }

      if (type === 'image') {
        msgContent = { image: buffer, caption: caption || undefined };
      } else if (type === 'video') {
        msgContent = { video: buffer, caption: caption || undefined };
      } else if (type === 'audio' || type === 'ptt') {
        msgContent = { audio: buffer, mimetype: mimetype || 'audio/ogg; codecs=opus', ptt: true };
      } else if (type === 'document') {
        msgContent = { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'file' };
      } else if (type === 'sticker') {
        msgContent = { sticker: buffer };
      }
      const sent = await sock.sendMessage(jid, msgContent, { quoted });
      const formatted = formatMessage(sent);
      if (formatted) socket.emit('message-sent', formatted);
    } catch (e) { socket.emit('error-msg', 'Failed to send media'); }
  }));

  // ─── Download Media ───
  socket.on('download-media', guard(async ({ messageId, jid }) => {
    if (!sock) return;
    try {
      const msgs = store.messages[jid];
      if (!msgs) return socket.emit('error-msg', 'Message not found');
      const msg = msgs.array.find(m => m.key.id === messageId);
      if (!msg) return socket.emit('error-msg', 'Message not found');

      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage
      });
      const c = msg.message;
      const mimetype = c?.imageMessage?.mimetype || c?.videoMessage?.mimetype ||
        c?.audioMessage?.mimetype || c?.documentMessage?.mimetype ||
        c?.stickerMessage?.mimetype || 'application/octet-stream';

      socket.emit('media-data', { messageId, jid, data: buffer.toString('base64'), mimetype });
    } catch (e) {
      console.error('download-media error:', e);
      socket.emit('error-msg', 'Failed to download media');
    }
  }));

  // ─── React to Message ───
  socket.on('react-message', guard(async ({ jid, msgId, emoji }) => {
    if (!sock) return;
    try {
      const msgs = store.messages[jid];
      const msg = msgs?.array?.find(m => m.key.id === msgId);
      if (!msg) return;
      await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
    } catch (e) { socket.emit('error-msg', 'Failed to react'); }
  }));

  // ─── Delete Message ───
  socket.on('delete-message', guard(async ({ jid, msgId, forEveryone }) => {
    if (!sock) return;
    try {
      const msgs = store.messages[jid];
      const msg = msgs?.array?.find(m => m.key.id === msgId);
      if (!msg) return;
      if (forEveryone && msg.key.fromMe) {
        await sock.sendMessage(jid, { delete: msg.key });
      } else {
        await sock.chatModify({ clear: { messages: [{ id: msgId, fromMe: msg.key.fromMe, timestamp: msg.messageTimestamp }] } }, jid);
      }
      socket.emit('message-deleted-local', { jid, msgId });
    } catch (e) { socket.emit('error-msg', 'Failed to delete'); }
  }));

  // ─── Forward Message ───
  socket.on('forward-message', guard(async ({ fromJid, msgId, toJid }) => {
    if (!sock) return;
    try {
      const msgs = store.messages[fromJid];
      const msg = msgs?.array?.find(m => m.key.id === msgId);
      if (!msg) return;
      await sock.sendMessage(toJid, { forward: msg });
      socket.emit('message-forwarded', { fromJid, msgId, toJid });
    } catch (e) { socket.emit('error-msg', 'Failed to forward'); }
  }));

  // ─── Star Message ───
  socket.on('star-message', guard(async ({ msgId, star }) => {
    if (star) starredMessages.add(msgId);
    else starredMessages.delete(msgId);
    socket.emit('message-starred', { msgId, starred: star });
  }));

  // ─── Mark Read ───
  socket.on('mark-read', guard(async (jid) => {
    if (!sock) return;
    try {
      const msgs = store.messages[jid];
      if (msgs?.array?.length) {
        const lastMsg = msgs.array[msgs.array.length - 1];
        await sock.readMessages([lastMsg.key]);
      }
    } catch {}
  }));

  // ─── Pin Chat ───
  socket.on('pin-chat', guard(async ({ jid, pin }) => {
    if (!sock) return;
    try {
      await sock.chatModify({ pin: pin }, jid);
      socket.emit('chat-pinned', { jid, pinned: pin });
    } catch (e) { socket.emit('error-msg', 'Failed to pin chat'); }
  }));

  // ─── Archive Chat ───
  socket.on('archive-chat', guard(async ({ jid, archive }) => {
    if (!sock) return;
    try {
      await sock.chatModify({ archive }, jid);
      socket.emit('chat-archived', { jid, archived: archive });
    } catch (e) { socket.emit('error-msg', 'Failed to archive'); }
  }));

  // ─── Mute Chat ───
  socket.on('mute-chat', guard(async ({ jid, mute }) => {
    if (!sock) return;
    try {
      const duration = mute ? 8 * 60 * 60 : null; // 8 hours or unmute
      await sock.chatModify({ mute: duration }, jid);
      socket.emit('chat-muted', { jid, muted: mute });
    } catch (e) { socket.emit('error-msg', 'Failed to mute'); }
  }));

  // ─── Clear Chat ───
  socket.on('clear-chat', guard(async (jid) => {
    if (!sock) return;
    try {
      await sock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: jid } }] }, jid);
      socket.emit('chat-cleared', jid);
    } catch (e) { socket.emit('error-msg', 'Failed to clear chat'); }
  }));

  // ─── Delete Chat ───
  socket.on('delete-chat', guard(async (jid) => {
    if (!sock) return;
    try {
      await sock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: jid } }] }, jid);
      socket.emit('chat-deleted', jid);
    } catch (e) { socket.emit('error-msg', 'Failed to delete chat'); }
  }));

  // ─── Block/Unblock ───
  socket.on('block-contact', guard(async ({ jid, block }) => {
    if (!sock) return;
    try {
      if (block) await sock.updateBlockStatus(jid, 'block');
      else await sock.updateBlockStatus(jid, 'unblock');
      socket.emit('contact-blocked', { jid, blocked: block });
    } catch (e) { socket.emit('error-msg', 'Failed to block/unblock'); }
  }));

  // ─── Contact/Group Info ───
  socket.on('get-contact-info', guard(async (jid) => {
    if (!sock) return;
    try {
      const isGroup = jid.endsWith('@g.us');
      let info = {};
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(jid);
          const participants = [];
          for (const p of (meta.participants || [])) {
            let pName = p.id.split('@')[0];
            const contact = store.contacts?.[p.id];
            if (contact) pName = contact.name || contact.notify || contact.verifiedName || pName;
            let pp = null;
            try { pp = await getProfilePic(p.id); } catch {}
            participants.push({
              id: p.id, name: pName, admin: p.admin || null, profilePic: pp
            });
          }
          info = {
            name: meta.subject, desc: meta.desc || '',
            owner: meta.owner || '', creation: meta.creation || 0,
            participants, isGroup: true,
            profilePic: await getProfilePic(jid),
            disappearing: meta.ephemeralDuration || 0
          };
        } catch { info = { name: jid, isGroup: true }; }
      } else {
        const contact = store.contacts?.[jid];
        info = {
          name: contact?.name || contact?.notify || contact?.verifiedName || jid.split('@')[0],
          isGroup: false, profilePic: await getProfilePic(jid),
          phone: jid.split('@')[0]
        };
        try {
          const status = await sock.fetchStatus(jid);
          info.about = status?.status;
        } catch {}
      }
      socket.emit('contact-info', { jid, info });
    } catch {}
  }));

  // ─── Group Management ───
  socket.on('create-group', guard(async ({ name, participants }) => {
    if (!sock) return;
    try {
      const group = await sock.groupCreate(name, participants);
      socket.emit('group-created', { id: group.id, name });
    } catch (e) { socket.emit('error-msg', 'Failed to create group'); }
  }));

  socket.on('update-group-subject', guard(async ({ jid, subject }) => {
    if (!sock) return;
    try {
      await sock.groupUpdateSubject(jid, subject);
      socket.emit('group-subject-updated', { jid, subject });
    } catch (e) { socket.emit('error-msg', 'Failed to update group'); }
  }));

  socket.on('update-group-desc', guard(async ({ jid, desc }) => {
    if (!sock) return;
    try {
      await sock.groupUpdateDescription(jid, desc);
    } catch (e) { socket.emit('error-msg', 'Failed to update description'); }
  }));

  socket.on('add-group-member', guard(async ({ jid, participant }) => {
    if (!sock) return;
    try {
      await sock.groupParticipantsUpdate(jid, [participant], 'add');
    } catch (e) { socket.emit('error-msg', 'Failed to add member'); }
  }));

  socket.on('remove-group-member', guard(async ({ jid, participant }) => {
    if (!sock) return;
    try {
      await sock.groupParticipantsUpdate(jid, [participant], 'remove');
    } catch (e) { socket.emit('error-msg', 'Failed to remove member'); }
  }));

  socket.on('promote-member', guard(async ({ jid, participant }) => {
    if (!sock) return;
    try {
      await sock.groupParticipantsUpdate(jid, [participant], 'promote');
    } catch (e) { socket.emit('error-msg', 'Failed to promote member'); }
  }));

  socket.on('demote-member', guard(async ({ jid, participant }) => {
    if (!sock) return;
    try {
      await sock.groupParticipantsUpdate(jid, [participant], 'demote');
    } catch (e) { socket.emit('error-msg', 'Failed to demote member'); }
  }));

  socket.on('leave-group', guard(async (jid) => {
    if (!sock) return;
    try {
      await sock.groupLeave(jid);
      socket.emit('group-left', jid);
    } catch (e) { socket.emit('error-msg', 'Failed to leave group'); }
  }));

  // ─── Disappearing Messages ───
  socket.on('toggle-disappearing', guard(async ({ jid, duration }) => {
    if (!sock) return;
    try {
      await sock.sendMessage(jid, { disappearingMessagesInChat: duration || false });
      socket.emit('disappearing-set', { jid, duration });
    } catch (e) { socket.emit('error-msg', 'Failed to set disappearing messages'); }
  }));

  // ─── Create Poll ───
  socket.on('create-poll', guard(async ({ jid, name, options, multiSelect }) => {
    if (!sock) return;
    try {
      const sent = await sock.sendMessage(jid, {
        poll: {
          name, values: options,
          selectableCount: multiSelect ? 0 : 1
        }
      });
      const formatted = formatMessage(sent);
      if (formatted) socket.emit('message-sent', formatted);
    } catch (e) { socket.emit('error-msg', 'Failed to create poll'); }
  }));

  // ─── Status/Stories ───
  socket.on('get-statuses', guard(async () => {
    // Status updates come via messages.upsert with status@broadcast
    // We'll collect them when they arrive
    socket.emit('statuses-list', []);
  }));

  // ─── Update Profile ───
  socket.on('update-profile-name', guard(async (name) => {
    if (!sock) return;
    try {
      await sock.updateProfileName(name);
      socket.emit('profile-updated', { name });
    } catch (e) { socket.emit('error-msg', 'Failed to update name'); }
  }));

  socket.on('update-profile-status', guard(async (status) => {
    if (!sock) return;
    try {
      await sock.updateProfileStatus(status);
      socket.emit('profile-updated', { about: status });
    } catch (e) { socket.emit('error-msg', 'Failed to update status'); }
  }));

  socket.on('update-profile-pic', guard(async (data) => {
    if (!sock) return;
    try {
      const buffer = Buffer.from(data, 'base64');
      await sock.updateProfilePicture(sock.user.id, buffer);
      socket.emit('profile-updated', { profilePic: true });
    } catch (e) { socket.emit('error-msg', 'Failed to update picture'); }
  }));

  socket.on('get-my-profile', guard(async () => {
    if (!sock) return;
    try {
      const jid = sock.user.id;
      let about = '';
      try { const s = await sock.fetchStatus(jid); about = s?.status || ''; } catch {}
      let profilePic = null;
      try { profilePic = await getProfilePic(jid); } catch {}
      socket.emit('my-profile', {
        id: jid, name: sock.user.name || sock.user.verifiedName || '',
        about, profilePic
      });
    } catch {}
  }));

  // ─── Typing ───
  socket.on('typing', guard(async ({ jid, composing }) => {
    if (!sock) return;
    try { await sock.sendPresenceUpdate(composing ? 'composing' : 'paused', jid); } catch {}
  }));

  socket.on('recording', guard(async ({ jid }) => {
    if (!sock) return;
    try { await sock.sendPresenceUpdate('recording', jid); } catch {}
  }));

  socket.on('subscribe-presence', guard(async (jid) => {
    if (!sock) return;
    try { await sock.presenceSubscribe(jid); } catch {}
  }));

  // ─── Search Messages ───
  socket.on('search-messages', guard(async ({ jid, query }) => {
    if (!sock || !query) return;
    try {
      const msgs = store.messages[jid];
      if (!msgs?.array) return socket.emit('search-results', { jid, results: [] });
      const results = msgs.array
        .map(formatMessage)
        .filter(m => m && m.text && m.text.toLowerCase().includes(query.toLowerCase()))
        .reverse()
        .slice(0, 30);
      socket.emit('search-results', { jid, results });
    } catch { socket.emit('search-results', { jid, results: [] }); }
  }));

  // ─── Logout/Reconnect ───
  socket.on('logout-wa', guard(async () => {
    if (!sock) return;
    try {
      await sock.logout();
      connectionState = 'disconnected';
      connectedUser = null;
      store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
      await authCollection.deleteMany({});
      io.emit('connection-status', { status: 'logged_out' });
    } catch (e) { socket.emit('error-msg', 'Failed to logout'); }
  }));

  socket.on('reconnect-wa', guard(async () => {
    if (connectionState === 'disconnected') await connectToWhatsApp();
  }));
});

// ─── Profile pic proxy ───
app.get('/api/pp/:jid', async (req, res) => {
  if (req.query.key !== OWNER_KEY) return res.status(401).end();
  try {
    const url = await getProfilePic(req.params.jid);
    res.json({ url: url || null });
  } catch { res.json({ url: null }); }
});

// ─── Start ───
async function main() {
  if (!MONGODB_URI) {
    console.error('MONGODB_URI required!');
    process.exit(1);
  }
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('whatsapp_web');
  authCollection = db.collection('wa_auth_state');
  console.log('MongoDB connected.');
  console.log('Connecting to WhatsApp...');
  await connectToWhatsApp();
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
