// Phone browsers may deny storage. Drafts still work for this page in that case.
export function readLocal(key: string): string {
  try {
    return localStorage.getItem(`parallel-mobile:${key}`) ?? '';
  } catch {
    return '';
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(`parallel-mobile:${key}`, value);
    else localStorage.removeItem(`parallel-mobile:${key}`);
  } catch {
    // Storage is optional; don't prevent replying when it is unavailable.
  }
}
