import { useCallback } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { Columns2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { DockviewPaneAction } from '#components/panes/dockview-pane-action.js';

/**
 * Right-side header action for Dockview groups.
 *
 * Renders a "split right" button in the tab bar that duplicates the active
 * panel into a new group to the right of the current one. The button is
 * visible on hover via the `.dv-pane-action` CSS (opacity transition on
 * group hover).
 */
export function DockviewSplitAction({ containerApi, group }: IDockviewHeaderActionsProps): React.JSX.Element {
  const handleSplit = useCallback(() => {
    containerApi.addGroup({
      referenceGroup: group,
      direction: 'right',
    });
  }, [containerApi, group]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DockviewPaneAction aria-label="Split right" onClick={handleSplit}>
          <Columns2 className="size-3.5" />
        </DockviewPaneAction>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        <p>Split right</p>
      </TooltipContent>
    </Tooltip>
  );
}
