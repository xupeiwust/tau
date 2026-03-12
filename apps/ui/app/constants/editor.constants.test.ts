import { describe, it, expect } from 'vitest';
import { panelIds, desktopPanelIds, allotmentPanelOrder, defaultPanelState } from '#constants/editor.constants.js';

describe('editor constants – panel consistency', () => {
  it('allotmentPanelOrder should contain every panel from panelIds', () => {
    for (const id of panelIds) {
      expect(allotmentPanelOrder).toContain(id);
    }
  });

  it('desktopPanelIds should be a subset of panelIds', () => {
    for (const id of desktopPanelIds) {
      expect(panelIds).toContain(id);
    }
  });

  it('defaultPanelState.openPanels should have an entry for every desktop panel', () => {
    for (const id of desktopPanelIds) {
      expect(defaultPanelState.openPanels).toHaveProperty(id);
    }
  });

  it('defaultPanelState.panelSizes should have an entry for every panel', () => {
    for (const id of panelIds) {
      expect(defaultPanelState.panelSizes).toHaveProperty(id);
    }
  });
});
