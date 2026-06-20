import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const tilingLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/components/TilingLayout.tsx'),
  'utf8',
);

function hasRule(selector: string): boolean {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`).test(css);
}

function declarationsFor(selector: string): Record<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);

  return Object.fromEntries(
    match[1]
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const separatorIndex = declaration.indexOf(':');
        return [
          declaration.slice(0, separatorIndex).trim(),
          declaration.slice(separatorIndex + 1).trim(),
        ];
      }),
  );
}

describe('tiling layout group divider styles', () => {
  it('keeps the group-between resize handle inside the dark group gap', () => {
    const groupWrapper = declarationsFor('.panel-group-wrapper');
    const groupBetweenHandle = declarationsFor('.group-between-handle');
    const islandsGroupBetweenHandle = declarationsFor(
      "html[data-look^='islands-'] .tiling-layout-strip > .group-between-handle",
    );

    expect(groupWrapper['margin-right']).toBe('0');
    expect(groupBetweenHandle.width).toBe('10px');
    expect(groupBetweenHandle.margin).toBe('0');
    expect(islandsGroupBetweenHandle.margin).toBe('0');
  });

  it('keeps inner group resize handles visible in expanded groups', () => {
    expect(hasRule('.resize-handle-h.group-inner-handle::before')).toBe(false);
  });

  it('fills inner group resize handle gaps with the group background', () => {
    const groupInnerHandle = declarationsFor('.resize-handle-h.group-inner-handle');
    const groupInnerHandleHover = declarationsFor('.resize-handle-h.group-inner-handle:hover');

    expect(groupInnerHandle.margin).toBe('0');
    expect(groupInnerHandle.position).toBe('relative');
    expect(groupInnerHandle['z-index']).toBe('3');
    expect(groupInnerHandle.background).toBe('inherit');
    expect(groupInnerHandleHover.background).toContain('color-mix');
  });
});

describe('tiling layout group collapse controls', () => {
  it('uses prominent arrow icons for collapse and expand controls', () => {
    const collapseIcon = declarationsFor('.panel-group-collapse-btn svg');
    const expandIcon = declarationsFor('.panel-group-expand-btn svg');

    expect(collapseIcon.width).toBe('16px');
    expect(collapseIcon.height).toBe('16px');
    expect(expandIcon.width).toBe('16px');
    expect(expandIcon.height).toBe('16px');
  });

  it('keeps the expand control as a side strip beside the visible collapsed panel', () => {
    const expandButton = declarationsFor('.panel-group-expand-btn');

    expect(expandButton.position).toBe('relative');
    expect(expandButton.width).toBe('18px');
    expect(expandButton['flex-shrink']).toBe('0');
    expect(expandButton.background).toBe('transparent');
  });

  it('uses the same color treatment for collapse and expand controls', () => {
    const collapseButton = declarationsFor('.panel-group-collapse-btn');
    const expandButton = declarationsFor('.panel-group-expand-btn');
    const collapseButtonHover = declarationsFor('.panel-group-collapse-btn:hover');
    const expandButtonHover = declarationsFor('.panel-group-expand-btn:hover');

    expect(expandButton.background).toBe(collapseButton.background);
    expect(collapseButton.color).toBe('var(--fg-subtle)');
    expect(expandButton.color).toBe(collapseButton.color);
    expect(expandButtonHover.filter).toBe(collapseButtonHover.filter);
    expect(expandButtonHover.color).toBe(collapseButtonHover.color);
    expect(tilingLayoutSource).not.toContain('style={{ color: info().color }}');
  });
});

describe('task panel active styles', () => {
  it('does not let panel group colors tint inactive task panels through opacity', () => {
    const taskColumn = declarationsFor('.task-column');

    expect(taskColumn.opacity).toBeUndefined();
  });

  it('draws a neutral gray overlay over inactive task panels', () => {
    const inactiveOverlay = declarationsFor('.task-column:not(.active)::before');

    expect(inactiveOverlay.content).toBe("''");
    expect(inactiveOverlay.background).toBe('rgba(128, 128, 128, 0.18)');
    expect(inactiveOverlay['pointer-events']).toBe('none');
  });

  it('does not draw an accent glow around the active task panel', () => {
    const activeTaskColumn = declarationsFor('.task-column.active');

    expect(activeTaskColumn['box-shadow']).toBeUndefined();
    expect(activeTaskColumn.opacity).toBe('1');
  });

  it('does not draw an accent outline around a collapsed active panel group', () => {
    expect(tilingLayoutSource).not.toContain('groupCollapsed() && groupHasActive()');
    expect(tilingLayoutSource).not.toContain('inset 0 0 0 2px ${theme.accent}');
  });
});
