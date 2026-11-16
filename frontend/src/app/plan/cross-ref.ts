// A task in another project, as words: depends_on's `cogyard#166` reads
// "cogyard #166" (owner, 2026-10-07). Shared by the Plan tab's waiting boxes and
// its card (./plan-card), so the two can't spell it differently.
export const isCross = (id: string) => id.includes('#');
export const crossLabel = (project: string, id: string | number) => `${project} #${id}`;
export const crossRef = (ref: string) => { const [project, id] = ref.split('#'); return crossLabel(project, id); };
