import { execFile } from 'child_process';

let cachedFonts: string[] | null = null;

export async function getSystemMonospaceFonts(): Promise<string[]> {
  if (cachedFonts) return cachedFonts;

  try {
    const fonts = await queryFcList();
    cachedFonts = fonts;
    return fonts;
  } catch (e) {
    console.warn('[system-fonts] Failed to query fonts:', e);
    cachedFonts = [];
    return [];
  }
}

function queryFcList(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('fc-list', [':spacing=mono', 'family'], { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      const families = new Set<string>();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // fc-list outputs comma-separated names: primary family first, then aliases
        // for weight variants (e.g. "BlexMono Nerd Font,BlexMono Nerd Font Light").
        // Taking only the first name collapses all weight variants into one entry.
        const primary = trimmed.split(',')[0].trim();
        if (primary && !primary.startsWith('.')) families.add(primary);
      }
      resolve([...families].sort((a, b) => a.localeCompare(b)));
    });
  });
}
