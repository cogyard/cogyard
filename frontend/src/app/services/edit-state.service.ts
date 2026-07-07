// Dirty-buffer state for the Files tab's edit mode. Every navigation
// in this app flows through AppComponent's router methods, so those methods (and
// the files component's own wt/file clicks via them) consult confirmDiscard()
// before moving — an unsaved edit prompts instead of being silently dropped.
import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class EditStateService {
  dirty = signal(false);

  // true = proceed (clean, or the user agreed to discard).
  confirmDiscard(): boolean {
    if (!this.dirty()) return true;
    const ok = confirm('Unsaved changes — discard them?');
    if (ok) this.dirty.set(false);
    return ok;
  }
}
