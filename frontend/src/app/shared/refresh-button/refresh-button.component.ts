import { Component, input, output } from '@angular/core';

// Ad-hoc usage-collection control (task 026). Wears the shared .btn-pill
// recipe (styles.scss → the pick-or-act family, which names usage-refresh in
// its own docs); icon + "refresh" label, flips to "collecting…" + a spinning
// icon while the harvest is in flight.
@Component({
  selector: 'app-refresh-button',
  templateUrl: './refresh-button.component.html',
  styleUrl: './refresh-button.component.scss',
})
export class RefreshButtonComponent {
  busy = input(false);
  pressed = output<void>();
}
