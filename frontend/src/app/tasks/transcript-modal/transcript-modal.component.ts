import { Component, input, output, inject, effect, computed, HostListener } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { renderMarkdown } from '../../shared/markdown';
import { ApiService } from '../../services/api.service';
import { StoreService } from '../../services/store.service';
import { TaskChat, TaskTranscriptResponse } from '../../services/models';
import { ActionChipComponent } from '../../shared/action-chip/action-chip.component';

// The transcript popup (task 30) — extracted from TasksComponent so the Tasks
// tab's styles stay under budget and the viewer is a self-contained unit. Given
// the clicked chat, it lazy-loads the transcript (cached per session in the
// store) and renders it chat-bubble style: you right (grey bubble), Claude left
// (markdown). Dismiss with Escape, backdrop click, or the ✕ — all emit `close`.
@Component({
  selector: 'app-transcript-modal',
  imports: [ActionChipComponent],
  templateUrl: './transcript-modal.component.html',
  styleUrl: './transcript-modal.component.scss',
})
export class TranscriptModalComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private san = inject(DomSanitizer);

  chat = input.required<TaskChat>();
  close = output<void>();

  constructor() {
    // Lazy-load (and cache) the transcript whenever the shown chat changes.
    effect(() => {
      const c = this.chat();
      if (c?.sessionId) this.store.load(`transcript|${c.sessionId}`, this.api.taskTranscript(c.sessionId));
    });
  }

  transcript = computed<TaskTranscriptResponse | null>(() => {
    const c = this.chat();
    return c?.sessionId ? this.store.sig<TaskTranscriptResponse>(`transcript|${c.sessionId}`)() : null;
  });
  shortId(): string { const s = this.chat()?.sessionId; return s ? s.slice(0, 8) : '????????'; }
  // Render a turn's text as markdown (inline code, bold, lists) — same helper
  // as the task body. Cleaned (task 263): a turn can hold anything pasted into a chat.
  turnHtml(text: string): SafeHtml { return renderMarkdown(this.san, text || ''); }
  turnTime(ts: string | null): string {
    if (!ts) return '';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  @HostListener('document:keydown.escape') onEscape() { this.close.emit(); }
}
