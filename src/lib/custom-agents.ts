/** Arguments are split on whitespace; quoting is not supported. */
export function splitAgentArgs(value: string): string[] {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

/** A custom agent id that no other custom agent has, derived from its name. */
export function customAgentId(name: string, taken: readonly string[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const base = `custom-${slug || 'agent'}`;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
