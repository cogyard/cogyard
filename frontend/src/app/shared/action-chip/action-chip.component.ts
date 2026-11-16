import { Component, computed, input } from '@angular/core';

// ONE rendering for "how a chat touched a task" (task 155) — the Tasks tab's
// CHATS box rows and the transcript window's header.
//
// Before this, the chips (.chat-role) borrowed the STATUS colours for a
// different meaning: COMMITTED wore the Idle green, CLAIMED the Claimed blue,
// CREATED the orange accent. Since task 154 those hues mean task status and
// nothing else, so green-meaning-committed two inches from green-meaning-idle
// was a contradiction. An action chip has NO hue: neutral grey, and the SAME
// worked-on ring the #NN chip wears (the Cleanup page's "Action" key) when the
// chat did work on the task — claimed, created, committed, edited — and plain
// when it only looked the task up.
//
// `mentioned` is the engine's wire name for "looked up" (core/task-chats.mjs);
// it is accepted as-is and DISPLAYED as "looked up", so callers pass the row's
// role straight through.
export type ActionKind = 'claimed' | 'created' | 'committed' | 'edited' | 'looked-up' | 'mentioned';

@Component({
  selector: 'app-action-chip',
  templateUrl: './action-chip.component.html',
  styleUrl: './action-chip.component.scss',
})
export class ActionChipComponent {
  kind = input.required<ActionKind>();

  readonly worked = computed(() => !['looked-up', 'mentioned'].includes(this.kind()));
  readonly word = computed(() => (this.worked() ? this.kind() : 'looked up'));
}
