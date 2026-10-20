/** "1 comment", "2 comments"; the noun must take a plain "s" plural. */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
