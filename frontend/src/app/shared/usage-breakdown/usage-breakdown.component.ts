import { Component, input, computed } from '@angular/core';
import { UsageBucket } from '../../services/models';

// Per-model token + cost table. Values come straight from the
// ledger (priced at collection time) — never recomputed here.
@Component({
  selector: 'app-usage-breakdown',
  imports: [],
  templateUrl: './usage-breakdown.component.html',
  styleUrl: './usage-breakdown.component.scss',
})
export class UsageBreakdownComponent {
  models = input.required<Record<string, UsageBucket>>();

  rows = computed(() => {
    return Object.entries(this.models() || {}).map(([model, b]) => {
      const t = b.tokens;
      const cacheWrite = (t.cacheWrite5m || 0) + (t.cacheWrite1h || 0);
      const total = (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + cacheWrite;
      return {
        model,
        input: t.input || 0, output: t.output || 0,
        cacheRead: t.cacheRead || 0, cacheWrite,
        total, cost: b.costUSD || 0,
      };
    }).sort((a, z) => z.cost - a.cost);
  });

  totals = computed(() => {
    const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    for (const r of this.rows()) {
      acc.input += r.input; acc.output += r.output; acc.cacheRead += r.cacheRead;
      acc.cacheWrite += r.cacheWrite; acc.total += r.total; acc.cost += r.cost;
    }
    return acc;
  });

  // Full token counts, thousands-separated (no k/M abbreviation).
  fmtTok(n: number): string {
    if (!n) return '—';
    return n.toLocaleString('en-US');
  }

  // Whole dollars, thousands-separated. Sub-dollar → "<$1" (rounding to "$0"
  // would read as nothing spent).
  fmtCost(n: number): string {
    if (!n || n <= 0) return '—';
    if (n < 0.5) return '<$1';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
}
