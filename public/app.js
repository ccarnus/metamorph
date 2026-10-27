const $ = id => document.getElementById(id);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z"/><path d="m8 12 3 3 5-6"/>',
  settings: '<path d="m10 3-1 3-3 1-3 3v4l3 1 1 3 3 3h4l1-3 3-1 3-3v-4l-3-1-1-3-3-3z"/><circle cx="12" cy="12" r="3"/>',
  moon: '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4"/>',
  pen: '<path d="m15 4 5 5-10 10-7 2 2-7zM13 6l5 5M3 21l4-4"/>',
  book: '<path d="M12 6C8 3 3 4 3 4v15s5-1 9 2c4-3 9-2 9-2V4s-5-1-9 2v15"/>',
  code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6m-4-15-2 18"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  arrowUp: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  leaf: '<path d="M19 3C7 2 2 8 5 15c7 6 16 0 14-12ZM5 20 15 9"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
};
function icon(name) {
  const span = document.createElement('span');
  span.dataset.icon = name;
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
  return span;
}
document.querySelectorAll('[data-icon]').forEach(el => el.replaceChildren(...icon(el.dataset.icon).childNodes));

const storeKey = 'metamorph.workspace.v1';
let workspace = { chats: [], settings: { temperature: 0.7, system: '', model: '', theme: 'light' } };
try {
  const saved = JSON.parse(localStorage.getItem(storeKey));
  if (saved) {
    if (!Array.isArray(saved.chats) || !saved.settings ||
        !saved.chats.every(c => typeof c.id === 'string' && typeof c.title === 'string' && Number.isFinite(c.updated) &&
          Array.isArray(c.messages) && c.messages.every(m => ['user', 'assistant'].includes(m.role) &&
            typeof m.content === 'string' && (m.thinking === undefined || typeof m.thinking === 'string'))) ||
        !Number.isFinite(saved.settings.temperature) || saved.settings.temperature < 0 || saved.settings.temperature > 2 ||
        typeof saved.settings.system !== 'string' || typeof saved.settings.model !== 'string' ||
        !['light', 'dark'].includes(saved.settings.theme)) throw new Error('Saved workspace has an invalid format.');
    workspace = saved;
  }
} catch (error) {
  showError(`Could not load saved conversations: ${error.message} Starting a new workspace.`);
}
let activeId = null;
let busy = false;
let controller = null;
let availableModels = [];
let toastTimer;
let storageWarned = false;
const mobileLayout = matchMedia('(max-width: 700px)');

function persist() {
  try { localStorage.setItem(storeKey, JSON.stringify(workspace)); }
  catch (error) {
    if (!storageWarned) { showError(`Could not save conversations in this browser: ${error.message}`); storageWarned = true; }
  }
}
function showError(message) { $('error-text').textContent = message; $('error-banner').hidden = false; }
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}
async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401 && path !== '/api/login') showLogin();
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: `Request failed (${response.status}).` }));
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return response;
}
function applyTheme() {
  document.documentElement.dataset.theme = workspace.settings.theme;
  const dark = workspace.settings.theme === 'dark';
  $('theme-button').replaceChildren(icon(dark ? 'sun' : 'moon'));
  $('theme-button').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
}
applyTheme();

function activeChat() { return workspace.chats.find(c => c.id === activeId); }
function toggleSidebar(open) {
  document.querySelector('.app').toggleAttribute('data-sidebar-open', open);
  $('menu-button').setAttribute('aria-expanded', String(open));
  $('scrim').hidden = !open;
  $('sidebar').inert = mobileLayout.matches && !open;
}
mobileLayout.addEventListener('change', () => toggleSidebar(false));
toggleSidebar(false);
function renderHistory() {
  const query = $('search').value.toLowerCase().trim();
  const chats = [...workspace.chats].sort((a, b) => b.updated - a.updated).filter(c =>
    c.title.toLowerCase().includes(query) || c.messages.some(m => m.content.toLowerCase().includes(query)));
  $('history-count').textContent = workspace.chats.length;
  $('history').replaceChildren();
  if (!chats.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = query ? 'No conversations found.' : 'A fresh start.\nYour conversations will feel at home here.';
    $('history').append(empty);
    return;
  }
  let group = '';
  for (const chat of chats) {
    const today = new Date().toDateString() === new Date(chat.updated).toDateString();
    const nextGroup = today ? 'Today' : 'Earlier';
    if (group !== nextGroup) {
      const label = document.createElement('div');
      label.className = 'history-group';
      label.textContent = nextGroup;
      $('history').append(label);
      group = nextGroup;
    }
    const row = document.createElement('div');
    row.className = `history-item${chat.id === activeId ? ' active' : ''}`;
    const open = document.createElement('button');
    open.className = 'history-open';
    open.disabled = busy;
    const title = document.createElement('span');
    title.className = 'history-name';
    title.textContent = chat.title;
    open.append(icon('chat'), title);
    open.title = chat.title;
    if (chat.id === activeId) open.setAttribute('aria-current', 'page');
    open.onclick = () => { activeId = chat.id; renderConversation(); renderHistory(); toggleSidebar(false); };
    const remove = document.createElement('button');
    remove.className = 'history-delete';
    remove.setAttribute('aria-label', `Delete ${chat.title}`);
    remove.append(icon('trash'));
    remove.disabled = busy;
    remove.onclick = () => {
      if (!confirm(`Delete “${chat.title}”? This cannot be undone.`)) return;
      workspace.chats = workspace.chats.filter(c => c.id !== chat.id);
      if (activeId === chat.id) { activeId = null; renderConversation(); }
      persist(); renderHistory();
    };
    row.append(open, remove);
    $('history').append(row);
  }
}

// Build the supported Markdown subset from text nodes, never model-provided HTML.
function inline(text, parent) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    const el = document.createElement(match[0].startsWith('`') ? 'code' : 'strong');
    el.textContent = match[0].startsWith('`') ? match[0].slice(1, -1) : match[0].slice(2, -2);
    parent.append(el);
    offset = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
function renderMarkdown(text, target) {
  target.replaceChildren();
  const lines = text.split('\n');
  let plainLines = [];
  const flushPlain = () => {
    const plain = plainLines.join('\n');
    plainLines = [];
    for (const block of plain.split(/\n\s*\n/)) {
      if (!block.trim()) continue;
      const heading = /^(#{1,6}) (.+)$/.exec(block.trim());
      const lines = block.trim().split('\n');
      if (heading) {
        const el = document.createElement(heading[1].length <= 2 ? 'h3' : 'h4');
        inline(heading[2], el); target.append(el);
      } else if (lines.every(l => /^\s*([-*]|\d+\.) /.test(l))) {
        const list = document.createElement(/^\s*\d/.test(lines[0]) ? 'ol' : 'ul');
        for (const line of lines) { const li = document.createElement('li'); inline(line.replace(/^\s*([-*]|\d+\.) /, ''), li); list.append(li); }
        target.append(list);
      } else {
        const p = document.createElement('p'); inline(block, p); target.append(p);
      }
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(.*)$/.exec(lines[i]);
    if (!fence) { plainLines.push(lines[i]); continue; }
    flushPlain();
    const codeLines = [];
    for (i++; i < lines.length && !/^```[ \t]*$/.test(lines[i]); i++) codeLines.push(lines[i]);
    const codeText = codeLines.join('\n');
    const box = document.createElement('div'); box.className = 'code-block';
    const header = document.createElement('div'); header.className = 'code-header';
    const label = document.createElement('span'); label.textContent = fence[1].trim() || 'Code';
    const copy = document.createElement('button'); copy.textContent = 'Copy code'; copy.onclick = () => copyText(codeText);
    const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = codeText; pre.append(code);
    header.append(label, copy); box.append(header, pre); target.append(box);
  }
  flushPlain();
}
async function copyText(text) {
  try {
    if (!navigator.clipboard) throw new Error('Clipboard requires HTTPS or localhost.');
    await navigator.clipboard.writeText(text); toast('Copied to clipboard');
  } catch (error) { showError(`Could not copy: ${error.message} You can select and copy the text manually.`); }
}
function messageElement(message, index, chat) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  const label = document.createElement('div'); label.className = 'message-label';
  if (message.role === 'user') {
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = 'Y';
    label.append(avatar, document.createTextNode('You'));
  } else {
    const image = document.createElement('img'); image.src = '/favicon.svg'; image.alt = '';
    const model = document.createElement('span'); model.className = 'message-model'; model.textContent = message.model || '';
    label.append(image, document.createTextNode('Metamorph'), model);
  }
  article.append(label);
  if (message.thinking) {
    const details = document.createElement('details'); details.className = 'thinking';
    const summary = document.createElement('summary'); summary.textContent = 'Model reasoning';
    const pre = document.createElement('pre'); pre.textContent = message.thinking;
    details.append(summary, pre); article.append(details);
  }
  const content = document.createElement('div'); content.className = 'message-content';
  if (message.role === 'user') content.textContent = message.content;
  else if (message.content) renderMarkdown(message.content, content);
  else {
    const pending = document.createElement('span'); pending.className = busy ? 'pending' : '';
    pending.textContent = busy ? (message.thinking ? 'Thinking' : 'Getting things ready') : (message.interrupted ? 'Response interrupted.' : 'No response text returned.');
    content.append(pending);
  }
  article.append(content);
  if (message.role === 'assistant' && !busy) {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const copy = document.createElement('button'); copy.append(icon('copy'), 'Copy'); copy.onclick = () => copyText(message.content);
    actions.append(copy);
    if (index === chat.messages.length - 1) {
      const retry = document.createElement('button'); retry.append(icon('refresh'), 'Regenerate');
      retry.onclick = () => generate(chat, true);
      actions.append(retry);
    }
    if (message.interrupted) { const note = document.createElement('span'); note.className = 'message-model'; note.textContent = 'Interrupted'; actions.append(note); }
    article.append(actions);
  }
  return article;
}
function renderConversation() {
  const chat = activeChat();
  const expandedReasoning = new Set(
    [...$('messages').children].flatMap((el, index) => el.querySelector('details')?.open ? [index] : []));
  $('welcome').hidden = Boolean(chat?.messages.length);
  $('chat-title').textContent = chat?.title || 'New conversation';
  document.title = chat ? `${chat.title} — Metamorph` : 'Metamorph — A little space for big ideas';
  $('messages').replaceChildren(...(chat?.messages.map((m, i) => messageElement(m, i, chat)) || []));
  for (const index of expandedReasoning) {
    const details = $('messages').children[index]?.querySelector('details');
    if (details) details.open = true;
  }
}
function scrollBottom(force = false) {
  const container = $('conversation-scroll');
  if (force || container.scrollHeight - container.scrollTop - container.clientHeight < 180) container.scrollTop = container.scrollHeight;
}
function updateComposer() {
  $('send-button').disabled = !busy && (!$('prompt').value.trim() || !$('model').value);
  $('send-button').replaceChildren(icon(busy ? 'stop' : 'arrowUp'));
  $('send-button').setAttribute('aria-label', busy ? 'Stop response' : 'Send message');
  $('model').disabled = busy || !availableModels.length;
  $('new-chat').disabled = busy;
  $('clear-history').disabled = busy;
  $('logout').disabled = busy;
}
function resizePrompt() {
  $('prompt').style.height = 'auto';
  $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 180)}px`;
  updateComposer();
}
async function loadModels() {
  try {
    const data = await (await api('/api/models')).json();
    availableModels = data.models.filter(m => !Array.isArray(m.capabilities) || m.capabilities.includes('completion'));
    $('model').replaceChildren();
    for (const m of availableModels) {
      const option = document.createElement('option'); option.value = m.name; option.textContent = m.name; $('model').append(option);
    }
    if (!availableModels.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = 'No models installed'; $('model').append(option);
      throw new Error('No chat models found. Run “ollama pull qwen3:8b” on the server, then retry in settings.');
    }
    if (availableModels.some(m => m.name === workspace.settings.model)) $('model').value = workspace.settings.model;
    workspace.settings.model = $('model').value; persist();
    $('connection').className = 'connection online';
    $('connection').lastElementChild.textContent = 'Ollama connected';
    $('connection').title = `${availableModels.length} models available`;
  } catch (error) {
    $('connection').className = 'connection offline';
    $('connection').lastElementChild.textContent = 'Disconnected';
    $('connection').title = 'Click to retry connection';
    showError(error.message);
  }
  updateComposer();
}
async function generate(chat, regenerate = false) {
  if (busy) return;
  if (!$('model').value) { showError('Choose an available model first.'); return; }
  const previous = regenerate ? chat.messages.pop() : null;
  const assistant = { role: 'assistant', content: '', thinking: '', model: $('model').value };
  const history = chat.messages.map(({ role, content }) => ({ role, content }));
  if (workspace.settings.system.trim()) history.unshift({ role: 'system', content: workspace.settings.system.trim() });
  chat.messages.push(assistant);
  busy = true;
  controller = new AbortController();
  $('error-banner').hidden = true;
  updateComposer(); renderHistory(); renderConversation(); scrollBottom(true);
  let completed = false;
  let lastRender = 0;
  const processLine = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.error) throw new Error(event.error);
    if (event.message?.content) assistant.content += event.message.content;
    if (event.message?.thinking) assistant.thinking += event.message.thinking;
    if (event.done) completed = true;
    if (Date.now() - lastRender > 70 || event.done) {
      const shouldScroll = $('conversation-scroll').scrollHeight - $('conversation-scroll').scrollTop - $('conversation-scroll').clientHeight < 180;
      renderConversation(); scrollBottom(shouldScroll); lastRender = Date.now();
    }
  };
  try {
    const response = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: assistant.model, messages: history, temperature: workspace.settings.temperature }),
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) processLine(line);
      if (done) { if (buffer.trim()) processLine(buffer); break; }
    }
    if (!completed) throw new Error('The response ended unexpectedly. Try regenerating it.');
  } catch (error) {
    assistant.interrupted = true;
    if (error.name === 'AbortError') toast('Response stopped');
    else showError(error.message);
    if (previous && !assistant.content && !assistant.thinking) chat.messages[chat.messages.length - 1] = previous;
  } finally {
    busy = false; controller = null;
    chat.updated = Date.now();
    persist(); updateComposer(); renderConversation(); renderHistory(); scrollBottom();
    $('prompt').focus();
  }
}
$('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) { controller?.abort(); return; }
  const content = $('prompt').value.trim();
  if (!content || !$('model').value) return;
  let chat = activeChat();
  if (!chat) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    chat = { id, title: content.slice(0, 58), updated: Date.now(), messages: [] };
    workspace.chats.push(chat); activeId = chat.id;
  }
  chat.messages.push({ role: 'user', content });
  $('prompt').value = ''; resizePrompt(); persist();
  generate(chat);
});
$('prompt').addEventListener('input', resizePrompt);
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
    event.preventDefault();
    if (!busy) $('chat-form').requestSubmit();
  }
});
$('new-chat').onclick = () => {
  if (busy) return;
  activeId = null; $('prompt').value = ''; resizePrompt(); renderConversation(); renderHistory(); toggleSidebar(false); $('prompt').focus();
};
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); if (!busy && !$('login-dialog').open && !$('settings-dialog').open) $('new-chat').click();
  }
  if (event.key === 'Escape') toggleSidebar(false);
});
document.querySelectorAll('.suggestion').forEach(button => {
  button.onclick = () => { $('prompt').value = button.dataset.prompt; resizePrompt(); $('prompt').focus(); };
});
$('search').oninput = renderHistory;
$('menu-button').onclick = () => toggleSidebar(!document.querySelector('.app').hasAttribute('data-sidebar-open'));
$('scrim').onclick = () => toggleSidebar(false);
$('dismiss-error').onclick = () => { $('error-banner').hidden = true; };
$('model').onchange = () => { workspace.settings.model = $('model').value; persist(); updateComposer(); };
$('theme-button').onclick = () => { workspace.settings.theme = workspace.settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); persist(); };
$('connection').tabIndex = 0;
$('connection').setAttribute('role', 'button');
$('connection').setAttribute('aria-label', 'Refresh Ollama connection');
$('connection').onclick = loadModels;
$('connection').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); loadModels(); } };
$('settings-button').onclick = () => {
  $('system-prompt').value = workspace.settings.system;
  $('temperature').value = workspace.settings.temperature;
  $('temperature-value').value = workspace.settings.temperature;
  $('settings-dialog').showModal(); toggleSidebar(false);
};
$('temperature').oninput = () => { $('temperature-value').value = $('temperature').value; };
$('save-settings').onclick = () => {
  workspace.settings.system = $('system-prompt').value;
  workspace.settings.temperature = Number($('temperature').value);
  persist(); $('settings-dialog').close(); toast('Workspace settings saved');
  if (!availableModels.length) loadModels();
};
$('clear-history').onclick = () => {
  if (busy || !confirm('Delete all conversations in this browser? This cannot be undone.')) return;
  workspace.chats = []; activeId = null; persist(); renderHistory(); renderConversation(); $('settings-dialog').close(); toast('Conversations cleared');
};
function showLogin() { if (!$('login-dialog').open) $('login-dialog').showModal(); }
$('login-dialog').addEventListener('cancel', event => event.preventDefault());
$('login-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true; $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
    $('password').value = ''; $('login-dialog').close(); $('error-banner').hidden = true; await loadModels();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST' }); $('settings-dialog').close(); showLogin(); }
  catch (error) { showError(error.message); }
};
renderHistory(); renderConversation(); updateComposer();
try {
  const session = await (await api('/api/session')).json();
  $('logout').hidden = !session.passwordRequired;
  if (!session.authenticated) showLogin(); else await loadModels();
} catch (error) { showError(error.message); }
