import type { TeamMessage } from "../types.js";

export class MessageQueue {
  private messages: TeamMessage[] = [];
  private maxMessages = 100;

  push(message: TeamMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  drain(): TeamMessage[] {
    const out = [...this.messages];
    this.messages = [];
    return out;
  }

  peek(): TeamMessage[] {
    return [...this.messages];
  }

  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  clear(): void {
    this.messages = [];
  }
}
