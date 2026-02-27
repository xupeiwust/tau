import { cn } from '#utils/ui.utils.js';

type DockviewCrossDropOverlayProperties = {
  readonly label: string;
  readonly visible: boolean;
};

/**
 * Full-area overlay shown when a tab is dragged from another dockview instance.
 * Renders a centered label on top of dockview's built-in green drop indicator.
 */
export function DockviewCrossDropOverlay({
  label,
  visible,
}: DockviewCrossDropOverlayProperties): React.JSX.Element | undefined {
  if (!visible) {
    return undefined;
  }

  return (
    <div className={cn('pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center')}>
      <span className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-lg">
        {label}
      </span>
    </div>
  );
}
