import { Component, input } from '@angular/core';
import { FileLink } from '../../services/models';

// How a link (a symlink) is marked in the Files tab (task 269, the owner's pick
// from the options sheet): the icon of what it points at with a small arrow in
// its lower-left corner, the way Finder marks an alias; then the projected name;
// then, unless `showTarget` is off, the target in muted monospace. A broken link
// draws the arrow and the target red, with "(missing)".
//
// The host is `display: contents`, so the icon, the name and the target sit in
// the caller's own row and its gap. Used by the tree row and the link panel's
// heading. Its own component because files.component.scss is at its 8 kB budget.
@Component({
  selector: 'app-link-mark',
  templateUrl: './link-mark.component.html',
  styleUrl: './link-mark.component.scss',
})
export class LinkMarkComponent {
  /** The icon to draw (what the link points at). */
  src = input.required<string>();
  link = input.required<FileLink>();
  showTarget = input(true);
}
