import { CHAT_DISPLAY_MS, CHAT_HISTORY_LIMIT, CHAT_MAX_LENGTH, cleanChat, type ChatMessage } from '@shared/index';

interface Entry { message: ChatMessage; received: number }
export class ChatPanel {
  readonly element = document.createElement('section');
  open = false;
  private readonly entries: Entry[] = [];
  private readonly input: HTMLInputElement;
  private readonly log: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly abort = new AbortController();
  private feedRows: { row: HTMLElement; received: number }[] = [];
  constructor(private readonly send: (text: string) => void,
    private readonly changed: (open: boolean, resume: boolean) => void,
    private readonly connected: () => boolean) {
    this.element.id = 'world-chat';
    this.element.setAttribute('aria-label', 'World chat');
    this.element.innerHTML = `<div id="chat-feed" aria-live="polite"></div>
      <div id="chat-panel" hidden><header><strong>WORLD CHAT</strong><button id="chat-close" type="button" aria-label="Close chat">×</button></header>
      <div id="chat-log" role="log" aria-label="Message history"></div>
      <form id="chat-form"><input id="chat-input" type="text" autocomplete="off" aria-label="Chat message" placeholder="Say something…"><button type="submit">SEND</button></form>
      <small>Enter sends · Esc closes</small></div>
      <button id="chat-open" type="button">CHAT</button>`;
    document.body.append(this.element);
    this.input = this.element.querySelector('#chat-input')!;
    this.input.maxLength = CHAT_MAX_LENGTH * 2;
    this.log = this.element.querySelector('#chat-log')!;
    this.feed = this.element.querySelector('#chat-feed')!;
    const signal = this.abort.signal;
    this.element.querySelector('#chat-open')!.addEventListener('click', () => this.show(), { signal });
    this.element.querySelector('#chat-close')!.addEventListener('click', () => this.close(true), { signal });
    this.element.querySelector('#chat-form')!.addEventListener('submit', e => {
      e.preventDefault(); const text = cleanChat(this.input.value);
      if (text && this.connected()) this.send(text);
      this.input.value = ''; this.close(true);
    }, { signal });
    document.addEventListener('keydown', e => {
      if (this.open && e.code === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); this.close(true); return;
      }
      const target = e.target as HTMLElement | null;
      if (!this.open && e.code === 'KeyT' && !e.repeat && !e.ctrlKey && !e.metaKey &&
        !target?.matches('input,textarea,[contenteditable="true"]')) {
        e.preventDefault(); e.stopImmediatePropagation(); this.show();
      }
    }, { capture: true, signal });
  }
  show(): void {
    if (this.open || !this.connected()) return;
    this.open = true; this.element.classList.add('open');
    this.element.querySelector<HTMLElement>('#chat-panel')!.hidden = false;
    this.changed(true, false);
    this.renderLog(); this.input.focus(); this.log.scrollTop = this.log.scrollHeight;
  }
  close(resume = false): void {
    if (!this.open) return;
    this.open = false; this.element.classList.remove('open');
    this.element.querySelector<HTMLElement>('#chat-panel')!.hidden = true;
    this.input.blur(); this.changed(false, resume);
  }
  add(message: ChatMessage): void {
    if (this.entries.some(entry => entry.message.id === message.id)) return;
    this.entries.push({ message, received: message.history ? -Infinity : performance.now() });
    if (this.entries.length > CHAT_HISTORY_LIMIT) this.entries.shift();
    if (this.open) { const atEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40; this.renderLog(); if (atEnd) this.log.scrollTop = this.log.scrollHeight; }
    this.feed.replaceChildren(); this.feedRows = [];
    for (const entry of this.entries.slice(-6)) {
      const row = this.row(entry.message); this.feed.append(row);
      this.feedRows.push({ row, received: entry.received });
    }
    this.update();
  }
  private row(message: ChatMessage): HTMLElement {
    const row = document.createElement('div'); row.className = 'chat-line';
    const name = document.createElement('strong'); name.textContent = `${message.name}: `;
    row.append(name, document.createTextNode(message.text)); return row;
  }
  private renderLog(): void {
    this.log.replaceChildren(...this.entries.map(entry => this.row(entry.message)));
    if (!this.entries.length) this.log.textContent = 'No messages yet. Say hello.';
  }
  update(now = performance.now()): void {
    if (this.open) return;
    for (const { row, received } of this.feedRows) {
      const age = now - received;
      row.hidden = age >= CHAT_DISPLAY_MS;
      if (!row.hidden) row.style.opacity = String(Math.min(1, (CHAT_DISPLAY_MS - age) / 1000));
    }
  }
  dispose(): void { this.close(false); this.abort.abort(); this.element.remove(); }
}
