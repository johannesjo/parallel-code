import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/terminalFitManager', () => ({
  markDirty: vi.fn(),
}));

import {
  buildGroupPanelEntriesForTest,
  buildRenderSegmentsForTest,
  groupResizeHandleIndexForTest,
  groupPanelInnerHandleHiddenForTest,
  groupWrapperPaddingForTest,
  hiddenPanelContentStyleForTest,
  isPanelGroupCollapseControlVisibleForTest,
  isPanelGroupCollapsibleForTest,
  isGroupPanelHiddenForTest,
} from './TilingLayout';

describe('TilingLayout panel group collapse planning', () => {
  it('keeps the first task panel visible when a group is collapsed', () => {
    const entries = buildGroupPanelEntriesForTest({
      projectId: 'project-1',
      groupType: 'independent',
      panelIds: ['task-1', 'task-2'],
      color: '#334455',
      collapsed: true,
    });

    expect(entries.map((entry) => entry.id)).toEqual(['task-1', 'task-2']);
    expect(entries.filter((entry) => entry.type === 'panel').map((entry) => entry.hidden)).toEqual([
      false,
      true,
    ]);
    expect(entries.some((entry) => entry.type !== 'panel')).toBe(false);
  });

  it('does not add a collapsed placeholder for expanded groups', () => {
    const entries = buildGroupPanelEntriesForTest({
      projectId: 'project-1',
      groupType: 'independent',
      panelIds: ['task-1', 'task-2'],
      color: '#334455',
      collapsed: false,
    });

    expect(entries.map((entry) => entry.id)).toEqual(['task-1', 'task-2']);
    expect(entries.map((entry) => entry.hidden)).toEqual([false, false]);
  });

  it('derives hidden state from the current collapsed state', () => {
    const [, secondEntry] = buildGroupPanelEntriesForTest({
      projectId: 'project-1',
      groupType: 'independent',
      panelIds: ['task-1', 'task-2'],
      color: '#334455',
      collapsed: false,
    });

    expect(isGroupPanelHiddenForTest(secondEntry.groupInfo, false)).toBe(false);
    expect(isGroupPanelHiddenForTest(secondEntry.groupInfo, true)).toBe(true);
  });

  it('keeps the group background padding when collapsed', () => {
    expect(groupWrapperPaddingForTest(false)).toBe('0 6px');
    expect(groupWrapperPaddingForTest(true)).toBe('0 6px');
  });

  it('anchors the collapsed group resize handle to the visible first panel', () => {
    expect(groupResizeHandleIndexForTest(3, 5, false)).toBe(5);
    expect(groupResizeHandleIndexForTest(3, 5, true)).toBe(3);
  });

  it('hides handles between task panels while a group is collapsed', () => {
    expect(groupPanelInnerHandleHiddenForTest(false, false)).toBe(false);
    expect(groupPanelInnerHandleHiddenForTest(true, false)).toBe(true);
    expect(groupPanelInnerHandleHiddenForTest(true, true)).toBe(true);
  });

  it('supports deriving inner handle visibility after collapsed state changes', () => {
    let collapsed = false;
    const hideHandle = () => groupPanelInnerHandleHiddenForTest(collapsed, false);

    expect(hideHandle()).toBe(false);
    collapsed = true;
    expect(hideHandle()).toBe(true);
  });

  it('does not allow a single task panel group to collapse', () => {
    expect(isPanelGroupCollapsibleForTest(1)).toBe(false);
    expect(isPanelGroupCollapsibleForTest(2)).toBe(true);
  });

  it('hides the collapse control for a single task panel group', () => {
    expect(isPanelGroupCollapseControlVisibleForTest(false, false, true, 1)).toBe(false);
    expect(isPanelGroupCollapseControlVisibleForTest(false, false, true, 2)).toBe(true);
  });

  it('changes segment keys when a single slot becomes a grouped project panel', () => {
    const before = buildRenderSegmentsForTest([
      { id: 'task-1', groupInfo: undefined },
      { id: '__placeholder', groupInfo: undefined },
    ]);
    const after = buildRenderSegmentsForTest([
      {
        id: 'task-1',
        groupInfo: {
          projectId: 'project-1',
          groupType: 'independent',
          isFirst: true,
          isLast: false,
          panelCount: 2,
          color: '#334455',
        },
      },
      {
        id: 'task-2',
        groupInfo: {
          projectId: 'project-1',
          groupType: 'independent',
          isFirst: false,
          isLast: true,
          panelCount: 2,
          color: '#334455',
        },
      },
      { id: '__placeholder', groupInfo: undefined },
    ]);

    expect(before[0]).toMatchObject({ type: 'single', key: 'single:task-1' });
    expect(after[0]).toMatchObject({ type: 'group', key: 'group:project-1:independent' });
  });

  it('reuses unchanged render segment objects so collapsed groups do not remount panels', () => {
    const items = [
      {
        id: 'task-1',
        groupInfo: {
          projectId: 'project-1',
          groupType: 'independent' as const,
          isFirst: true,
          isLast: false,
          panelCount: 2,
          color: '#334455',
        },
      },
      {
        id: 'task-2',
        groupInfo: {
          projectId: 'project-1',
          groupType: 'independent' as const,
          isFirst: false,
          isLast: true,
          panelCount: 2,
          color: '#334455',
        },
      },
      { id: '__placeholder', groupInfo: undefined },
    ];

    const before = buildRenderSegmentsForTest(items);
    const after = buildRenderSegmentsForTest(items);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('preserves hidden panel content width so terminals are not resized to zero', () => {
    expect(hiddenPanelContentStyleForTest(true, 520)).toMatchObject({
      width: '520px',
      height: '100%',
      visibility: 'hidden',
      'pointer-events': 'none',
    });
    expect(hiddenPanelContentStyleForTest(false, 520)).toMatchObject({
      width: '100%',
      height: '100%',
    });
    expect(hiddenPanelContentStyleForTest(false, 520)).not.toHaveProperty('visibility');
    expect(hiddenPanelContentStyleForTest(false, 520)).not.toHaveProperty('pointer-events');
  });
});
