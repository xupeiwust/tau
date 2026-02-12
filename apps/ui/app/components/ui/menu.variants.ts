import { cva } from 'class-variance-authority';

/**
 * Shared item styling for all menu-like components (dropdown-menu, context-menu, command, select).
 * Compact macOS-inspired design with primary focus highlight.
 */
export const menuItemVariants = cva(
  "relative flex cursor-default items-center gap-2 rounded-md px-3 py-1 text-[13px] outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
  {
    variants: {
      variant: {
        default: '',
        destructive:
          'text-destructive focus:bg-destructive/10 focus:text-destructive dark:focus:bg-destructive/20 *:[svg]:text-destructive!',
      },
      inset: {
        true: 'pl-8', // For items with left indicator (checkbox/radio)
        false: '',
      },
      focusable: {
        true: 'focus:bg-neutral/30 focus:text-foreground focus:[&_svg]:text-foreground',
        false: '', // For cmdk which uses data-[selected=true] instead of focus
      },
    },
    defaultVariants: {
      variant: 'default',
      inset: false,
      focusable: true,
    },
  },
);

/**
 * Content container styling for menu popover/dropdown containers.
 * Instant open/close (no animation) by default for a snappy feel.
 */
export const menuContentVariants = cva(
  'z-50 min-w-32 overflow-hidden rounded-[13px] border border-foreground/10 bg-popover p-0.75 text-popover-foreground shadow-md',
  {
    variants: {
      animated: {
        true: 'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        false: '',
      },
    },
    defaultVariants: {
      animated: false,
    },
  },
);

/**
 * Shared open-state styling for sub-menu triggers.
 */
export const menuSubTriggerOpenClass =
  'data-[state=open]:bg-neutral/30 data-[state=open]:text-foreground data-[state=open]:[&_svg]:text-foreground';

/**
 * Shared shortcut styling for keyboard shortcut hints.
 */
export const menuShortcutClass = 'ml-auto text-[11px] tracking-normal text-muted-foreground';

/**
 * Label styling for menu section headers.
 */
export const menuLabelVariants = cva('px-3 py-1 text-xs font-medium text-muted-foreground', {
  variants: {
    inset: {
      true: 'pl-8',
      false: '',
    },
  },
  defaultVariants: {
    inset: false,
  },
});

/**
 * Separator styling for menu dividers.
 */
export const menuSeparatorVariants = cva('mx-0 my-0.75 h-px bg-border');
