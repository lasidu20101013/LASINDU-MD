// ═══════════════════════════════════════════
//  WhatsApp Web Clone — Frontend (Full Features)
// ═══════════════════════════════════════════

const socket = io({ autoConnect: false });

// ─── State ───
let currentJid = null;
let chats = [];
let messageCache = {};
let ownerKey = '';
let typingTimer = null;
let replyToMsg = null;
let contextMsg = null;
let forwardMsg = null;
let deleteMsg = null;
let mediaRecorder = null;
let recordingInterval = null;
let recordingStartTime = 0;
let filterUnread = false;
const participantColors = {};
let colorIndex = 0;
const defaultAvatar = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 212 212"><path fill="#6a7175" d="M106 0C47.5 0 0 47.5 0 106s47.5 106 106 106 106-47.5 106-106S164.5 0 106 0z"/><path fill="#cfd4d6" d="M106 45c20.9 0 37.8 16.9 37.8 37.8S126.9 120.7 106 120.7 68.2 103.8 68.2 82.8 85.1 45 106 45zM106 132c28.2 0 75 14.1 75 42.2V189H31v-14.8c0-28.1 46.8-42.2 75-42.2z"/></svg>'
);

// Common emojis
const EMOJIS = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','☹️','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊','💋','💌','💘','💝','💖','💗','💓','💞','💕','💟','❣️','💔','❤️‍🔥','❤️‍🩹','❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💯','💢','💥','💫','💦','💨','🕳️','💣','💬','👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄'];

// ─── DOM Helpers ───
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const screens = {
  login: $('#login-screen'),
  qr: $('#qr-screen'),
  loading: $('#loading-screen'),
  chat: $('#chat-screen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toast(msg, duration = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, duration);
}

// ─── Login ───
$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  ownerKey = $('#password-input').value;
  if (!ownerKey) return;
  $('#login-btn').textContent = 'Connecting...';
  $('#login-btn').disabled = true;
  $('#login-error').style.display = 'none';
  socket.connect();
  socket.emit('auth', ownerKey);
});

socket.on('auth-success', (data) => {
  if (data.connectionStatus === 'connected') {
    showScreen('loading');
    setTimeout(() => { showScreen('chat'); socket.emit('get-chats'); }, 800);
  } else if (data.connectionStatus === 'qr' && data.qr) {
    showScreen('qr'); showQR(data.qr);
  } else {
    showScreen('qr');
  }
});

socket.on('auth-failed', () => {
  $('#login-error').style.display = 'block';
  $('#login-btn').textContent = 'Login';
  $('#login-btn').disabled = false;
  socket.disconnect();
});

// ─── Link Tab Switching ───
function switchLinkTab(tab) {
  document.querySelectorAll('.link-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  if (tab === 'qr') {
    $('#tab-qr').classList.add('active');
    $('#qr-tab-content').classList.add('active');
  } else {
    $('#tab-pairing').classList.add('active');
    $('#pairing-tab-content').classList.add('active');
  }
}
window.switchLinkTab = switchLinkTab;

// ─── Pairing Code ───
$('#pairing-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const phone = $('#phone-number-input').value.replace(/[\s\-]/g, '');
  if (!phone || phone.length < 10) {
    $('#pairing-error').textContent = 'Enter a valid phone number with country code (e.g. 94771234567)';
    $('#pairing-error').style.display = 'block';
    return;
  }
  $('#pairing-btn').textContent = 'Requesting...';
  $('#pairing-btn').disabled = true;
  $('#pairing-error').style.display = 'none';
  $('#pairing-code-display').style.display = 'none';
  socket.emit('request-pairing-code', phone);
});

socket.on('pairing-code', (code) => {
  $('#pairing-btn').textContent = 'Get Code';
  $('#pairing-btn').disabled = false;
  // Format code with dash for readability (e.g. 1234-5678)
  const formatted = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
  $('#pairing-code-text').textContent = formatted;
  $('#pairing-code-display').style.display = 'block';
});

// ─── QR ───
function showQR(dataUrl) {
  $('#qr-img').src = dataUrl;
  $('#qr-img').style.display = 'block';
  $('.qr-loading').style.display = 'none';
}
socket.on('qr', (dataUrl) => { showScreen('qr'); showQR(dataUrl); });

// ─── Connection ───
socket.on('connection-status', (data) => {
  if (data.status === 'connected') {
    showScreen('loading');
    setTimeout(() => { showScreen('chat'); socket.emit('get-chats'); }, 1000);
  } else if (data.status === 'qr') {
    showScreen('qr');
  } else if (data.status === 'disconnected' && data.reason === 'logged_out') {
    showScreen('qr');
    $('.qr-loading').style.display = 'flex';
    $('#qr-img').style.display = 'none';
  } else if (data.status === 'logged_out') {
    currentJid = null; chats = []; messageCache = {};
    showScreen('qr');
  }
});

// ─── Chats ───
socket.on('chats-list', (chatList) => {
  chats = chatList;
  renderChatList();
});
socket.on('chats-changed', () => socket.emit('get-chats'));

function renderChatList(filter = '') {
  const list = $('#chat-list');
  list.innerHTML = '';
  let filtered = filter
    ? chats.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
    : chats;
  if (filterUnread) filtered = filtered.filter(c => c.unreadCount > 0);

  for (const chat of filtered) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === currentJid ? ' active' : '');
    item.dataset.jid = chat.id;
    const avatar = chat.profilePic || defaultAvatar;
    const time = chat.timestamp ? formatTime(chat.timestamp) : '';
    const unread = chat.unreadCount > 0
      ? `<span class="unread-badge">${chat.unreadCount > 99 ? '99+' : chat.unreadCount}</span>` : '';
    const timeClass = chat.unreadCount > 0 ? 'chat-item-time unread' : 'chat-item-time';

    let icons = '';
    if (chat.pinned) icons += '<span class="pin-icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="#8696a0" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg></span>';
    if (chat.muted) icons += '<span class="mute-icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="#8696a0" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg></span>';

    let lastMsgText = escapeHtml(chat.lastMessage || '');
    if (chat.lastMsgFrom && chat.isGroup) {
      lastMsgText = `<span class="msg-from">${escapeHtml(chat.lastMsgFrom)}:</span> ${lastMsgText}`;
    }

    item.innerHTML = `
      <img class="avatar" src="${escapeAttr(avatar)}" alt="" onerror="this.src='${defaultAvatar}'">
      <div class="chat-item-content">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(chat.name)}</span>
          <span class="${timeClass}">${time}</span>
        </div>
        <div class="chat-item-bottom">
          <span class="chat-item-msg">${lastMsgText}</span>
          <div class="chat-item-icons">${icons}</div>
          ${unread}
        </div>
      </div>
    `;
    item.addEventListener('click', () => openChat(chat));
    list.appendChild(item);
  }
}

$('#search-input').addEventListener('input', (e) => renderChatList(e.target.value));

// Filter unread
$('#btn-filter').addEventListener('click', () => {
  filterUnread = !filterUnread;
  $('#btn-filter').classList.toggle('active', filterUnread);
  renderChatList($('#search-input').value);
});

// ─── Open Chat ───
function openChat(chat) {
  currentJid = chat.id;
  closeAllPopups();

  $$('.chat-item').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`.chat-item[data-jid="${CSS.escape(chat.id)}"]`);
  if (item) item.classList.add('active');

  $('#no-chat').style.display = 'none';
  $('#active-chat').style.display = 'flex';
  $('#chat-screen').classList.add('chat-open');

  const avatar = chat.profilePic || defaultAvatar;
  $('#chat-avatar').src = avatar;
  $('#chat-avatar').onerror = function() { this.src = defaultAvatar; };
  $('#chat-name').textContent = chat.name;
  $('#chat-status-text').textContent = chat.isGroup ? 'Group' : 'click here for contact info';

  const container = $('#messages');
  container.innerHTML = '<div class="messages-loading"><div class="spinner"></div></div>';

  if (messageCache[chat.id]?.length) renderMessages(chat.id, messageCache[chat.id]);
  socket.emit('get-messages', chat.id);
  socket.emit('mark-read', chat.id);
  chat.unreadCount = 0;
  renderChatList($('#search-input').value);

  if (!chat.isGroup) socket.emit('subscribe-presence', chat.id);

  cancelReply();
  setTimeout(() => $('#msg-input').focus(), 100);
}

// ─── Messages ───
socket.on('chat-messages', ({ jid, messages }) => {
  messageCache[jid] = messages;
  if (jid === currentJid) renderMessages(jid, messages);
});

socket.on('new-message', (msg) => {
  if (!msg) return;
  const jid = msg.remoteJid;
  if (!messageCache[jid]) messageCache[jid] = [];
  if (!messageCache[jid].find(m => m.id === msg.id)) messageCache[jid].push(msg);
  if (jid === currentJid) { appendMessage(msg); scrollToBottom(); socket.emit('mark-read', jid); }
  socket.emit('get-chats');
});

socket.on('message-sent', (msg) => {
  if (!msg) return;
  const jid = msg.remoteJid;
  if (!messageCache[jid]) messageCache[jid] = [];
  if (!messageCache[jid].find(m => m.id === msg.id)) messageCache[jid].push(msg);
  if (jid === currentJid) { appendMessage(msg); scrollToBottom(); }
});

socket.on('messages-status', (updates) => {
  for (const upd of updates) {
    const statusEl = document.querySelector(`[data-msg-id="${upd.id}"] .msg-status`);
    if (statusEl) {
      statusEl.className = 'msg-status ' + getStatusClass(upd.status);
      statusEl.innerHTML = getStatusIcon(upd.status);
    }
  }
});

socket.on('message-deleted', ({ id }) => {
  const el = document.querySelector(`[data-msg-id="${id}"]`);
  if (el) {
    const bubble = el.querySelector('.message-bubble');
    if (bubble) bubble.innerHTML = '<div class="msg-deleted"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12 2H4l-1 1v10l1 1h8l1-1V3l-1-1zM7 12H5V6h2v6zm4 0H9V6h2v6z"/></svg> This message was deleted</div>';
  }
});

socket.on('message-reaction', ({ msgId, reaction }) => {
  if (currentJid) {
    const cached = messageCache[currentJid]?.find(m => m.id === msgId);
    if (cached) {
      if (!cached.reactions) cached.reactions = [];
      const existing = cached.reactions.findIndex(r => r.key === reaction.key);
      if (existing >= 0) {
        if (reaction.text) cached.reactions[existing] = reaction;
        else cached.reactions.splice(existing, 1);
      } else if (reaction.text) {
        cached.reactions.push(reaction);
      }
      renderReactions(msgId, cached.reactions);
    }
  }
});

function renderMessages(jid, messages) {
  const container = $('#messages');
  container.innerHTML = '';
  let lastDate = '';
  for (const msg of messages) {
    const msgDate = formatDate(msg.timestamp);
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${msgDate}</span>`;
      container.appendChild(sep);
    }
    appendMessage(msg, container, false);
  }
  scrollToBottom(false);
}

function appendMessage(msg, container = null, animate = true) {
  container = container || $('#messages');
  const loading = container.querySelector('.messages-loading');
  if (loading) loading.remove();
  if (container.querySelector(`[data-msg-id="${msg.id}"]`)) return;

  const row = document.createElement('div');
  row.className = `message-row ${msg.fromMe ? 'sent' : 'received'}`;
  row.dataset.msgId = msg.id;
  if (!animate) row.style.animation = 'none';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  let html = '';

  // Hover menu
  html += `<div class="msg-hover-actions" onclick="showContextMenu(event, '${msg.id}')">
    <svg viewBox="0 0 18 18"><path fill="currentColor" d="M3.5 7.5a2 2 0 100 4 2 2 0 000-4zm5 0a2 2 0 100 4 2 2 0 000-4zm5 0a2 2 0 100 4 2 2 0 000-4z"/></svg>
  </div>`;

  // Group participant name
  if (!msg.fromMe && msg.participant && currentJid?.endsWith('@g.us')) {
    const name = msg.pushName || msg.participant.split('@')[0];
    const color = getParticipantColor(msg.participant);
    html += `<div class="msg-participant ${color}">${escapeHtml(name)}</div>`;
  }

  // Quoted message
  if (msg.quotedMsg) {
    html += `<div class="msg-quoted">
      <div class="msg-quoted-name">${escapeHtml(msg.quotedMsg.participant?.split('@')[0] || (msg.quotedMsg.fromMe ? 'You' : ''))}</div>
      <div class="msg-quoted-text">${escapeHtml(msg.quotedMsg.text || '📷 Media')}</div>
    </div>`;
  }

  // Link preview
  if (msg.linkPreview) {
    html += `<div class="msg-link-preview" onclick="window.open('${escapeAttr(msg.linkPreview.url || '')}','_blank')">
      <div class="msg-link-preview-title">${escapeHtml(msg.linkPreview.title || '')}</div>
      <div class="msg-link-preview-desc">${escapeHtml(msg.linkPreview.description || '')}</div>
      <div class="msg-link-preview-url">${escapeHtml(msg.linkPreview.url || '')}</div>
    </div>`;
  }

  // Media types
  if (msg.type === 'image') {
    html += `<div class="msg-media" data-msg-id="${msg.id}">
      <div class="msg-media-placeholder" onclick="downloadMedia('${msg.id}','${msg.remoteJid}')">📷 Photo — tap to load</div>
    </div>`;
  } else if (msg.type === 'video') {
    html += `<div class="msg-media" data-msg-id="${msg.id}">
      <div class="msg-media-placeholder" onclick="downloadMedia('${msg.id}','${msg.remoteJid}')">🎥 Video — tap to load</div>
    </div>`;
  } else if (msg.type === 'ptt' || msg.type === 'audio') {
    const dur = msg.mediaInfo?.seconds || 0;
    html += `<div class="msg-ptt">
      <button class="ptt-play-btn" onclick="downloadMedia('${msg.id}','${msg.remoteJid}')">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="ptt-waveform" data-msg-id="${msg.id}">`;
    const waveform = msg.waveform || [];
    for (let i = 0; i < 30; i++) {
      const h = waveform[i] ? Math.max(4, (waveform[i] / 255) * 28) : (4 + Math.random() * 12);
      html += `<div class="ptt-bar" style="height:${h}px"></div>`;
    }
    html += `</div><span class="ptt-duration">${formatDuration(dur)}</span></div>`;
  } else if (msg.type === 'document') {
    const fname = msg.fileName || msg.text || 'Document';
    const ext = fname.split('.').pop().toLowerCase();
    const iconClass = ext === 'pdf' ? 'pdf' : ext === 'doc' || ext === 'docx' ? 'doc' : ext === 'xls' || ext === 'xlsx' ? 'xls' : 'default';
    html += `<div class="msg-document" onclick="downloadMedia('${msg.id}','${msg.remoteJid}')">
      <div class="msg-doc-icon ${iconClass}"><svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg></div>
      <div class="msg-doc-info"><div class="msg-doc-name">${escapeHtml(fname)}</div><div class="msg-doc-size">${msg.mediaInfo?.fileSize ? formatFileSize(msg.mediaInfo.fileSize) : ''}</div></div>
    </div>`;
  } else if (msg.type === 'sticker') {
    html += `<div class="msg-media" data-msg-id="${msg.id}">
      <div class="msg-media-placeholder" onclick="downloadMedia('${msg.id}','${msg.remoteJid}')">🏷️ Sticker</div>
    </div>`;
  } else if (msg.type === 'location' || msg.type === 'liveLocation') {
    const lat = msg.mediaInfo?.lat || 0;
    const lng = msg.mediaInfo?.lng || 0;
    html += `<div class="msg-location">
      <div class="msg-location-map" onclick="window.open('https://maps.google.com/?q=${lat},${lng}','_blank')">
        <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/></svg>
      </div>
      ${msg.text ? `<div class="msg-location-name">${escapeHtml(msg.text)}</div>` : ''}
    </div>`;
  } else if (msg.type === 'contact' || msg.type === 'contactsArray') {
    const contacts = msg.contacts || [{ name: msg.text || 'Contact' }];
    for (const c of contacts) {
      html += `<div class="msg-contact">
        <div class="msg-contact-avatar"><svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>
        <span>${escapeHtml(c.name || 'Contact')}</span>
      </div>`;
    }
  } else if (msg.type === 'poll') {
    html += `<div class="msg-poll">
      <div class="msg-poll-question">📊 ${escapeHtml(msg.pollQuestion || msg.text || 'Poll')}</div>`;
    if (msg.pollOptions) {
      for (const opt of msg.pollOptions) {
        html += `<div class="poll-option">${escapeHtml(opt)}</div>`;
      }
    }
    html += '</div>';
  }

  // Text
  if (msg.text && msg.type === 'text') {
    html += `<div class="msg-text">${linkify(escapeHtml(msg.text))}</div>`;
  } else if (msg.text && ['image','video','document','sticker'].includes(msg.type)) {
    html += `<div class="msg-text">${linkify(escapeHtml(msg.text))}</div>`;
  }

  // Starred icon
  const starredHtml = msg.starred ? '<span class="msg-starred-icon"><svg viewBox="0 0 16 16"><path d="M8 .5l2.47 5 5.53.8-4 3.9.94 5.5L8 13.1l-4.94 2.6.94-5.5-4-3.9 5.53-.8z"/></svg></span>' : '';

  // Footer
  const time = formatMessageTime(msg.timestamp);
  let statusHtml = '';
  if (msg.fromMe) statusHtml = `<span class="msg-status ${getStatusClass(msg.status)}">${getStatusIcon(msg.status)}</span>`;
  html += `<div class="msg-footer">${starredHtml}<span class="msg-time">${time}</span>${statusHtml}</div>`;

  // Reactions
  if (msg.reactions?.length) {
    html += '<div class="msg-reactions">';
    const grouped = {};
    for (const r of msg.reactions) {
      if (!r.text) continue;
      if (!grouped[r.text]) grouped[r.text] = { emoji: r.text, count: 0, mine: false };
      grouped[r.text].count++;
      if (r.mine) grouped[r.text].mine = true;
    }
    for (const g of Object.values(grouped)) {
      html += `<div class="msg-reaction${g.mine ? ' mine' : ''}" onclick="reactToMessage('${msg.id}','${g.emoji}')">${g.emoji}${g.count > 1 ? `<span class="msg-reaction-count">${g.count}</span>` : ''}</div>`;
    }
    html += '</div>';
  }

  bubble.innerHTML = html;

  // Context menu on long press / right click
  bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, msg.id); });

  row.appendChild(bubble);
  container.appendChild(row);
}

function renderReactions(msgId, reactions) {
  const el = document.querySelector(`[data-msg-id="${msgId}"] .msg-reactions`);
  if (!el) return;
  const grouped = {};
  for (const r of reactions) {
    if (!r.text) continue;
    if (!grouped[r.text]) grouped[r.text] = { emoji: r.text, count: 0, mine: false };
    grouped[r.text].count++;
    if (r.mine) grouped[r.text].mine = true;
  }
  let html = '';
  for (const g of Object.values(grouped)) {
    html += `<div class="msg-reaction${g.mine ? ' mine' : ''}" onclick="reactToMessage('${msgId}','${g.emoji}')">${g.emoji}${g.count > 1 ? `<span class="msg-reaction-count">${g.count}</span>` : ''}</div>`;
  }
  el.innerHTML = html;
}

function scrollToBottom(smooth = true) {
  const c = $('#messages');
  if (smooth) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
  else c.scrollTop = c.scrollHeight;
}

// ─── Send Message ───
$('#msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('#send-btn').addEventListener('click', sendMessage);

// Toggle send/voice button
$('#msg-input').addEventListener('input', () => {
  const hasText = $('#msg-input').value.trim().length > 0;
  $('#send-btn').style.display = hasText ? 'flex' : 'none';
  $('#btn-voice').style.display = hasText ? 'none' : 'flex';

  if (!currentJid) return;
  socket.emit('typing', { jid: currentJid, composing: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit('typing', { jid: currentJid, composing: false }), 2000);
});

function sendMessage() {
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text || !currentJid) return;

  const data = { jid: currentJid, text };
  if (replyToMsg) {
    data.quotedId = replyToMsg.id;
    cancelReply();
  }
  socket.emit('send-message', data);
  input.value = '';
  $('#send-btn').style.display = 'none';
  $('#btn-voice').style.display = 'flex';
  socket.emit('typing', { jid: currentJid, composing: false });
}

// ─── Reply ───
function setReply(msgId) {
  const msg = messageCache[currentJid]?.find(m => m.id === msgId);
  if (!msg) return;
  replyToMsg = msg;
  $('#reply-name').textContent = msg.fromMe ? 'You' : (msg.pushName || msg.participant?.split('@')[0] || '');
  $('#reply-text').textContent = msg.text || '📷 Media';
  $('#reply-bar').style.display = 'flex';
  $('#msg-input').focus();
}

function cancelReply() {
  replyToMsg = null;
  $('#reply-bar').style.display = 'none';
}
$('#btn-cancel-reply').addEventListener('click', cancelReply);

// ─── Context Menu ───
function showContextMenu(e, msgId) {
  e.preventDefault(); e.stopPropagation();
  closeAllPopups();
  contextMsg = messageCache[currentJid]?.find(m => m.id === msgId);
  if (!contextMsg) return;

  const menu = $('#msg-context-menu');
  // Update star label
  const starItem = menu.querySelector('[data-action="star"]');
  if (starItem) starItem.textContent = contextMsg.starred ? 'Unstar' : 'Star';

  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 250);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

$('#msg-context-menu').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMsg) return;

  switch (action) {
    case 'reply': setReply(contextMsg.id); break;
    case 'react': showReactionPicker(contextMsg.id); break;
    case 'forward': showForwardModal(contextMsg.id); break;
    case 'star': toggleStar(contextMsg.id); break;
    case 'copy':
      if (contextMsg.text) { navigator.clipboard.writeText(contextMsg.text); toast('Copied'); }
      break;
    case 'delete': showDeleteModal(contextMsg); break;
  }
  $('#msg-context-menu').style.display = 'none';
  contextMsg = null;
});

// ─── Reactions ───
function showReactionPicker(msgId) {
  const picker = $('#reaction-picker');
  const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const rect = msgEl.getBoundingClientRect();
  picker.style.display = 'flex';
  picker.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  picker.style.top = (rect.top - 44) + 'px';
  picker.dataset.msgId = msgId;
}

$$('.reaction-emoji').forEach(el => {
  el.addEventListener('click', () => {
    const msgId = $('#reaction-picker').dataset.msgId;
    const emoji = el.dataset.emoji;
    reactToMessage(msgId, emoji);
    $('#reaction-picker').style.display = 'none';
  });
});

function reactToMessage(msgId, emoji) {
  socket.emit('react-message', { jid: currentJid, messageId: msgId, emoji });
}

// ─── Forward ───
function showForwardModal(msgId) {
  forwardMsg = msgId;
  const list = $('#forward-chat-list');
  list.innerHTML = '';
  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'forward-chat-item';
    item.innerHTML = `
      <img class="avatar" src="${escapeAttr(chat.profilePic || defaultAvatar)}" alt="" onerror="this.src='${defaultAvatar}'">
      <span class="forward-chat-item-name">${escapeHtml(chat.name)}</span>
    `;
    item.addEventListener('click', () => {
      socket.emit('forward-message', { fromJid: currentJid, toJid: chat.id, messageId: forwardMsg });
      $('#forward-modal').style.display = 'none';
      toast('Forwarded');
    });
    list.appendChild(item);
  }
  $('#forward-modal').style.display = 'flex';
}

$('#btn-close-forward').addEventListener('click', () => { $('#forward-modal').style.display = 'none'; });
$('#forward-modal .modal-backdrop').addEventListener('click', () => { $('#forward-modal').style.display = 'none'; });
$('#forward-search-input').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  $$('#forward-chat-list .forward-chat-item').forEach(el => {
    el.style.display = el.querySelector('.forward-chat-item-name').textContent.toLowerCase().includes(q) ? 'flex' : 'none';
  });
});

// ─── Delete ───
function showDeleteModal(msg) {
  deleteMsg = msg;
  $('#btn-delete-everyone').style.display = msg.fromMe ? 'block' : 'none';
  $('#delete-modal').style.display = 'flex';
}
$('#btn-cancel-delete').addEventListener('click', () => { $('#delete-modal').style.display = 'none'; });
$('#delete-modal .modal-backdrop').addEventListener('click', () => { $('#delete-modal').style.display = 'none'; });
$('#btn-delete-me').addEventListener('click', () => {
  if (deleteMsg) socket.emit('delete-message', { jid: currentJid, messageId: deleteMsg.id, forEveryone: false });
  const el = document.querySelector(`[data-msg-id="${deleteMsg?.id}"]`);
  if (el) el.remove();
  $('#delete-modal').style.display = 'none';
  deleteMsg = null;
});
$('#btn-delete-everyone').addEventListener('click', () => {
  if (deleteMsg) socket.emit('delete-message', { jid: currentJid, messageId: deleteMsg.id, forEveryone: true });
  const el = document.querySelector(`[data-msg-id="${deleteMsg?.id}"]`);
  if (el) el.remove();
  $('#delete-modal').style.display = 'none';
  deleteMsg = null;
});

// ─── Star ───
function toggleStar(msgId) {
  const msg = messageCache[currentJid]?.find(m => m.id === msgId);
  if (msg) msg.starred = !msg.starred;
  socket.emit('star-message', { jid: currentJid, messageId: msgId, star: msg?.starred });
  toast(msg?.starred ? 'Starred' : 'Unstarred');
}

// ─── Emoji Picker ───
let emojiPickerOpen = false;
$('#btn-emoji').addEventListener('click', () => {
  emojiPickerOpen = !emojiPickerOpen;
  if (emojiPickerOpen) { openEmojiPicker(); } else { $('#emoji-picker').style.display = 'none'; }
});

function openEmojiPicker() {
  const grid = $('#emoji-grid');
  grid.innerHTML = '';
  for (const e of EMOJIS) {
    const span = document.createElement('span');
    span.className = 'emoji-item';
    span.textContent = e;
    span.addEventListener('click', () => {
      const input = $('#msg-input');
      input.value += e;
      input.focus();
      input.dispatchEvent(new Event('input'));
    });
    grid.appendChild(span);
  }
  $('#emoji-picker').style.display = 'flex';
}

$('#emoji-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  // Simple: just show all for now (emoji search by name would need a map)
  $$('#emoji-grid .emoji-item').forEach(el => {
    el.style.display = q ? (el.textContent.includes(q) ? '' : 'none') : '';
  });
});

// ─── Attach Menu ───
let attachOpen = false;
$('#btn-attach').addEventListener('click', () => {
  attachOpen = !attachOpen;
  $('#attach-menu').style.display = attachOpen ? 'flex' : 'none';
});

$$('.attach-option').forEach(el => {
  el.addEventListener('click', () => {
    const type = el.dataset.type;
    $('#attach-menu').style.display = 'none';
    attachOpen = false;
    switch (type) {
      case 'image': $('#file-input-image').click(); break;
      case 'document': $('#file-input-doc').click(); break;
      case 'poll': openPollModal(); break;
      case 'contact': toast('Contact sharing coming soon'); break;
    }
  });
});

// File handlers
$('#file-input-image').addEventListener('change', (e) => handleFileUpload(e, 'auto'));
$('#file-input-doc').addEventListener('change', (e) => handleFileUpload(e, 'document'));

function handleFileUpload(e, forceType) {
  const file = e.target.files[0];
  if (!file || !currentJid) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    let type = forceType;
    if (type === 'auto') {
      if (file.type.startsWith('image/')) type = 'image';
      else if (file.type.startsWith('video/')) type = 'video';
      else type = 'document';
    }
    socket.emit('send-media', {
      jid: currentJid, type, data: base64,
      mimetype: file.type, fileName: file.name, caption: ''
    });
    toast('Sending...');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// ─── Voice Recording ───
$('#btn-voice').addEventListener('click', startRecording);
$('#btn-cancel-voice').addEventListener('click', cancelRecording);
$('#btn-send-voice').addEventListener('click', sendRecording);

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/ogg; codecs=opus' });
      mediaRecorder._blob = blob;
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start();
    recordingStartTime = Date.now();
    $('#voice-recording').style.display = 'flex';
    $('.input-area').style.display = 'none';
    socket.emit('recording', { jid: currentJid, recording: true });
    recordingInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - recordingStartTime) / 1000);
      $('#recording-time').textContent = formatDuration(sec);
    }, 1000);
  } catch {
    toast('Microphone access denied');
  }
}

function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(recordingInterval);
  $('#voice-recording').style.display = 'none';
  $('.input-area').style.display = 'flex';
  socket.emit('recording', { jid: currentJid, recording: false });
}

function sendRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  clearInterval(recordingInterval);
  setTimeout(() => {
    const blob = mediaRecorder._blob;
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      const seconds = Math.floor((Date.now() - recordingStartTime) / 1000);
      socket.emit('send-media', {
        jid: currentJid, type: 'audio', data: base64,
        mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds
      });
    };
    reader.readAsDataURL(blob);
    $('#voice-recording').style.display = 'none';
    $('.input-area').style.display = 'flex';
  }, 300);
}

// ─── Media Download ───
function downloadMedia(messageId, jid) {
  const placeholder = document.querySelector(`[data-msg-id="${messageId}"] .msg-media-placeholder`);
  if (placeholder) placeholder.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px"></div>';
  const playBtn = document.querySelector(`[data-msg-id="${messageId}"] .ptt-play-btn`);
  if (playBtn) playBtn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px"></div>';
  socket.emit('download-media', { messageId, jid });
}

socket.on('media-data', ({ messageId, data, mimetype }) => {
  const dataUrl = `data:${mimetype};base64,${data}`;
  const mediaDiv = document.querySelector(`.msg-media[data-msg-id="${messageId}"]`);
  if (mediaDiv) {
    if (mimetype.startsWith('image/') && mimetype !== 'image/webp') {
      mediaDiv.innerHTML = `<img src="${dataUrl}" alt="Photo" onclick="openMediaModal(this.src,'image')">`;
    } else if (mimetype === 'image/webp') {
      mediaDiv.innerHTML = `<img src="${dataUrl}" alt="Sticker" style="max-width:160px;max-height:160px">`;
    } else if (mimetype.startsWith('video/')) {
      mediaDiv.innerHTML = `<video src="${dataUrl}" controls style="max-width:330px;max-height:330px;border-radius:6px"></video>`;
    } else if (mimetype.startsWith('audio/')) {
      mediaDiv.innerHTML = `<audio src="${dataUrl}" controls style="width:280px"></audio>`;
    } else {
      const a = document.createElement('a'); a.href = dataUrl; a.download = 'file'; a.click();
      const ph = mediaDiv.querySelector('.spinner')?.parentElement;
      if (ph) ph.innerHTML = '📄 Downloaded';
    }
    return;
  }
  // PTT waveform player
  const waveDiv = document.querySelector(`.ptt-waveform[data-msg-id="${messageId}"]`);
  if (waveDiv) {
    const row = waveDiv.closest('.message-row');
    const pttDiv = row?.querySelector('.msg-ptt');
    if (pttDiv) {
      pttDiv.innerHTML = `<audio src="${dataUrl}" controls style="width:240px;height:36px"></audio>`;
    }
  }
});

// ─── Media Modal ───
function openMediaModal(src, type) {
  const viewer = $('#media-viewer');
  if (type === 'image') viewer.innerHTML = `<img src="${src}" alt="Photo">`;
  else viewer.innerHTML = `<video src="${src}" controls autoplay></video>`;
  $('#media-modal').style.display = 'flex';
}
$('#modal-close').addEventListener('click', () => { $('#media-modal').style.display = 'none'; $('#media-viewer').innerHTML = ''; });
$('#media-modal .modal-backdrop').addEventListener('click', () => { $('#media-modal').style.display = 'none'; $('#media-viewer').innerHTML = ''; });

// ─── Presence ───
socket.on('presence-update', ({ id, presences }) => {
  if (id !== currentJid) return;
  const statusEl = $('#chat-status-text');
  const entries = Object.values(presences || {});
  if (!entries.length) return;
  const p = entries[0];
  if (p.lastKnownPresence === 'composing') { statusEl.textContent = 'typing...'; statusEl.className = 'status-text online'; }
  else if (p.lastKnownPresence === 'recording') { statusEl.textContent = 'recording audio...'; statusEl.className = 'status-text online'; }
  else if (p.lastKnownPresence === 'available') { statusEl.textContent = 'online'; statusEl.className = 'status-text online'; }
  else {
    statusEl.textContent = p.lastSeen ? 'last seen ' + formatLastSeen(p.lastSeen) : '';
    statusEl.className = 'status-text';
  }
});

// ─── Search in Chat ───
$('#btn-search-msg').addEventListener('click', () => {
  const bar = $('#search-in-chat');
  bar.style.display = bar.style.display === 'none' ? 'block' : 'none';
  if (bar.style.display === 'block') $('#search-msg-input').focus();
});
$('#btn-close-search').addEventListener('click', () => { $('#search-in-chat').style.display = 'none'; });

$('#search-msg-input').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  if (!q) { $('#search-results-count').textContent = ''; return; }
  const msgs = messageCache[currentJid] || [];
  const results = msgs.filter(m => m.text?.toLowerCase().includes(q));
  $('#search-results-count').textContent = results.length ? `${results.length} result(s)` : 'No results';
  if (results.length) {
    const last = results[results.length - 1];
    const el = document.querySelector(`[data-msg-id="${last.id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

// ─── Sidebar Menu ───
$('#btn-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#sidebar-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
});

$('#sidebar-menu').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  $('#sidebar-menu').style.display = 'none';
  switch (action) {
    case 'new-group': openNewGroupModal(); break;
    case 'starred-msgs': toast('Starred messages'); break;
    case 'archived': toast('Archived chats'); break;
    case 'settings': openSettings(); break;
    case 'logout':
      if (confirm('Logout from WhatsApp? You will need to scan QR again.')) socket.emit('logout-wa');
      break;
  }
});

// ─── Chat Header Menu ───
$('#btn-chat-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#chat-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
});

$('#chat-menu').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  $('#chat-menu').style.display = 'none';
  switch (action) {
    case 'contact-info': openInfoPanel(); break;
    case 'select-messages': toast('Select messages mode'); break;
    case 'mute-chat':
      socket.emit('mute-chat', { jid: currentJid, mute: true });
      toast('Chat muted'); break;
    case 'disappearing': openDisappearingModal(); break;
    case 'clear-chat':
      if (confirm('Clear all messages?')) { socket.emit('clear-chat', { jid: currentJid }); $('#messages').innerHTML = ''; }
      break;
    case 'delete-chat':
      if (confirm('Delete this chat?')) { socket.emit('delete-chat', { jid: currentJid }); goBack(); }
      break;
    case 'pin-chat':
      socket.emit('pin-chat', { jid: currentJid, pin: true }); toast('Chat pinned'); break;
    case 'block-contact':
      if (confirm('Block this contact?')) { socket.emit('block-contact', { jid: currentJid, block: true }); toast('Blocked'); }
      break;
  }
});

// ─── Info Panel ───
$('#chat-header-info').addEventListener('click', openInfoPanel);
$('#chat-avatar').addEventListener('click', openInfoPanel);

function openInfoPanel() {
  const chat = chats.find(c => c.id === currentJid);
  if (!chat) return;
  const panel = $('#info-panel');
  const isGroup = currentJid.endsWith('@g.us');

  $('#info-panel-title').textContent = isGroup ? 'Group info' : 'Contact info';
  $('#info-avatar').src = chat.profilePic || defaultAvatar;
  $('#info-avatar').onerror = function() { this.src = defaultAvatar; };
  $('#info-name').textContent = chat.name;
  $('#info-phone').textContent = isGroup ? '' : currentJid.split('@')[0];
  $('#info-about').textContent = '';
  $('#info-group-desc').style.display = isGroup ? 'block' : 'none';
  $('#info-participants').style.display = isGroup ? 'block' : 'none';
  $('#btn-block-from-info').style.display = isGroup ? 'none' : 'block';
  $('#btn-leave-group').style.display = isGroup ? 'block' : 'none';

  if (isGroup) {
    socket.emit('get-group-info', currentJid);
  }

  panel.style.display = 'flex';
}

socket.on('group-info', (info) => {
  if (!info) return;
  $('#info-desc-text').textContent = info.desc || 'No description';
  const list = $('#participants-list');
  list.innerHTML = '';
  $('#participants-label').textContent = `${info.participants?.length || 0} participants`;
  for (const p of (info.participants || [])) {
    const item = document.createElement('div');
    item.className = 'participant-item';
    const name = p.id.split('@')[0];
    const adminBadge = p.admin ? `<span class="participant-admin">${p.admin === 'superadmin' ? 'Group creator' : 'Admin'}</span>` : '';
    item.innerHTML = `
      <img class="avatar" src="${defaultAvatar}" alt="">
      <span class="participant-name">${escapeHtml(name)}</span>
      ${adminBadge}
    `;
    list.appendChild(item);
  }
});

$('#btn-close-info').addEventListener('click', () => { $('#info-panel').style.display = 'none'; });
$('#btn-block-from-info').addEventListener('click', () => {
  if (confirm('Block this contact?')) {
    socket.emit('block-contact', { jid: currentJid, block: true });
    toast('Blocked');
    $('#info-panel').style.display = 'none';
  }
});
$('#btn-leave-group').addEventListener('click', () => {
  if (confirm('Exit this group?')) {
    socket.emit('leave-group', { jid: currentJid });
    toast('Left group');
    $('#info-panel').style.display = 'none';
    goBack();
  }
});

// Disappearing messages
$('#btn-toggle-disappearing').addEventListener('click', openDisappearingModal);

function openDisappearingModal() {
  $('#disappearing-modal').style.display = 'flex';
}
$('#btn-cancel-disappearing').addEventListener('click', () => { $('#disappearing-modal').style.display = 'none'; });
$('#disappearing-modal .modal-backdrop').addEventListener('click', () => { $('#disappearing-modal').style.display = 'none'; });
$('#btn-save-disappearing').addEventListener('click', () => {
  const val = document.querySelector('input[name="disappearing"]:checked').value;
  socket.emit('toggle-disappearing', { jid: currentJid, duration: parseInt(val) });
  $('#disappearing-status').textContent = val === '0' ? 'Off' : val === '86400' ? '24 hours' : val === '604800' ? '7 days' : '90 days';
  $('#disappearing-modal').style.display = 'none';
  toast('Disappearing messages updated');
});

// ─── Settings ───
function openSettings() {
  socket.emit('get-my-profile');
  $('#settings-panel').style.display = 'flex';
}
$('#btn-close-settings').addEventListener('click', () => { $('#settings-panel').style.display = 'none'; });

socket.on('my-profile', (profile) => {
  if (!profile) return;
  $('#settings-name').textContent = profile.name || '';
  $('#settings-about').textContent = profile.status || '';
  $('#settings-avatar').src = profile.imgUrl || defaultAvatar;
  $('#edit-name').value = profile.name || '';
  $('#edit-about').value = profile.status || '';
});

$('#btn-save-name').addEventListener('click', () => {
  const name = $('#edit-name').value.trim();
  if (name) { socket.emit('update-profile-name', { name }); toast('Name updated'); }
});
$('#btn-save-about').addEventListener('click', () => {
  const status = $('#edit-about').value.trim();
  socket.emit('update-profile-status', { status });
  toast('About updated');
});
$('#settings-avatar').addEventListener('click', () => { $('#file-input-pp').click(); });
$('#file-input-pp').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    socket.emit('update-profile-pic', { data: base64 });
    toast('Profile picture updated');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// ─── New Group ───
let selectedGroupMembers = [];

function openNewGroupModal() {
  selectedGroupMembers = [];
  $('#new-group-name').value = '';
  $('#selected-members').innerHTML = '';
  $('#group-member-search').value = '';
  renderGroupContacts();
  $('#new-group-modal').style.display = 'flex';
}

function renderGroupContacts(filter = '') {
  const list = $('#group-contacts-list');
  list.innerHTML = '';
  const contacts = chats.filter(c => !c.isGroup && (filter ? c.name.toLowerCase().includes(filter.toLowerCase()) : true));
  for (const c of contacts) {
    const item = document.createElement('div');
    item.className = 'forward-chat-item';
    const selected = selectedGroupMembers.includes(c.id);
    item.style.opacity = selected ? '0.5' : '1';
    item.innerHTML = `
      <img class="avatar" src="${escapeAttr(c.profilePic || defaultAvatar)}" alt="" onerror="this.src='${defaultAvatar}'">
      <span class="forward-chat-item-name">${escapeHtml(c.name)}</span>
    `;
    item.addEventListener('click', () => {
      if (!selected) {
        selectedGroupMembers.push(c.id);
        renderSelectedMembers();
        renderGroupContacts($('#group-member-search').value);
      }
    });
    list.appendChild(item);
  }
}

function renderSelectedMembers() {
  const container = $('#selected-members');
  container.innerHTML = '';
  for (const jid of selectedGroupMembers) {
    const chat = chats.find(c => c.id === jid);
    const chip = document.createElement('span');
    chip.className = 'selected-member';
    chip.textContent = chat?.name || jid.split('@')[0];
    chip.addEventListener('click', () => {
      selectedGroupMembers = selectedGroupMembers.filter(m => m !== jid);
      renderSelectedMembers();
      renderGroupContacts($('#group-member-search').value);
    });
    container.appendChild(chip);
  }
}

$('#group-member-search').addEventListener('input', (e) => renderGroupContacts(e.target.value));
$('#btn-close-new-group').addEventListener('click', () => { $('#new-group-modal').style.display = 'none'; });
$('#new-group-modal .modal-backdrop').addEventListener('click', () => { $('#new-group-modal').style.display = 'none'; });

$('#btn-create-group-confirm').addEventListener('click', () => {
  const name = $('#new-group-name').value.trim();
  if (!name) { toast('Enter a group name'); return; }
  if (!selectedGroupMembers.length) { toast('Add at least one member'); return; }
  socket.emit('create-group', { name, members: selectedGroupMembers });
  $('#new-group-modal').style.display = 'none';
  toast('Creating group...');
});
socket.on('group-created', () => { toast('Group created!'); socket.emit('get-chats'); });

// ─── Poll ───
function openPollModal() {
  $('#poll-question').value = '';
  $('#poll-options').innerHTML = `
    <input type="text" class="modal-input poll-option-input" placeholder="Option 1">
    <input type="text" class="modal-input poll-option-input" placeholder="Option 2">
  `;
  $('#poll-multi-select').checked = false;
  $('#poll-modal').style.display = 'flex';
}
$('#btn-close-poll').addEventListener('click', () => { $('#poll-modal').style.display = 'none'; });
$('#poll-modal .modal-backdrop').addEventListener('click', () => { $('#poll-modal').style.display = 'none'; });

$('#btn-add-poll-option').addEventListener('click', () => {
  const count = $$('.poll-option-input').length;
  if (count >= 12) { toast('Maximum 12 options'); return; }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'modal-input poll-option-input';
  input.placeholder = `Option ${count + 1}`;
  $('#poll-options').appendChild(input);
});

$('#btn-send-poll').addEventListener('click', () => {
  const question = $('#poll-question').value.trim();
  const options = [...$$('.poll-option-input')].map(i => i.value.trim()).filter(Boolean);
  if (!question) { toast('Enter a question'); return; }
  if (options.length < 2) { toast('Add at least 2 options'); return; }
  socket.emit('create-poll', {
    jid: currentJid, question, options,
    multiSelect: $('#poll-multi-select').checked
  });
  $('#poll-modal').style.display = 'none';
  toast('Poll sent');
});

// ─── Back Button ───
$('#btn-back').addEventListener('click', goBack);

function goBack() {
  $('#chat-screen').classList.remove('chat-open');
  currentJid = null;
  $('#active-chat').style.display = 'none';
  $('#no-chat').style.display = 'flex';
  $('#info-panel').style.display = 'none';
}

// ─── Close popups on outside click ───
document.addEventListener('click', (e) => {
  if (!e.target.closest('#sidebar-menu') && !e.target.closest('#btn-menu')) $('#sidebar-menu').style.display = 'none';
  if (!e.target.closest('#chat-menu') && !e.target.closest('#btn-chat-menu')) $('#chat-menu').style.display = 'none';
  if (!e.target.closest('#msg-context-menu')) $('#msg-context-menu').style.display = 'none';
  if (!e.target.closest('#reaction-picker')) $('#reaction-picker').style.display = 'none';
  if (!e.target.closest('#emoji-picker') && !e.target.closest('#btn-emoji')) {
    $('#emoji-picker').style.display = 'none'; emojiPickerOpen = false;
  }
  if (!e.target.closest('#attach-menu') && !e.target.closest('#btn-attach')) {
    $('#attach-menu').style.display = 'none'; attachOpen = false;
  }
});

function closeAllPopups() {
  $('#sidebar-menu').style.display = 'none';
  $('#chat-menu').style.display = 'none';
  $('#msg-context-menu').style.display = 'none';
  $('#reaction-picker').style.display = 'none';
  $('#emoji-picker').style.display = 'none';
  $('#attach-menu').style.display = 'none';
  emojiPickerOpen = false;
  attachOpen = false;
}

// ─── Errors ───
socket.on('error-msg', (msg) => {
  console.error('Server:', msg);
  toast('Error: ' + msg);
  // Also show error in pairing section if it's open
  if ($('#pairing-tab-content').classList.contains('active')) {
    $('#pairing-error').textContent = msg;
    $('#pairing-error').style.display = 'block';
    $('#pairing-btn').textContent = 'Get Code';
    $('#pairing-btn').disabled = false;
  }
});
socket.on('disconnect', () => console.log('Disconnected'));
socket.on('connect_error', () => console.log('Connection error'));

// ═══════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function formatTime(timestamp) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diff = now - date;
  if (diff < 86400000 && date.getDate() === now.getDate()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 172800000) return 'Yesterday';
  if (diff < 604800000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yd = new Date(now); yd.setDate(yd.getDate() - 1);
  if (date.toDateString() === yd.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatMessageTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeen(timestamp) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'today at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function getStatusClass(status) {
  switch (status) {
    case 4: case 'READ': return 'read';
    case 3: case 'DELIVERY_ACK': return 'delivered';
    case 2: case 'SERVER_ACK': return 'sent';
    default: return 'sent';
  }
}

function getStatusIcon(status) {
  switch (status) {
    case 4: case 'READ': return '✓✓';
    case 3: case 'DELIVERY_ACK': return '✓✓';
    case 2: case 'SERVER_ACK': return '✓';
    default: return '✓';
  }
}

function getParticipantColor(participant) {
  if (!participantColors[participant]) {
    colorIndex = (colorIndex % 8) + 1;
    participantColors[participant] = `pcolor-${colorIndex}`;
  }
  return participantColors[participant];
}

// Make functions global for onclick handlers
window.downloadMedia = downloadMedia;
window.openMediaModal = openMediaModal;
window.showContextMenu = showContextMenu;
window.reactToMessage = reactToMessage;
