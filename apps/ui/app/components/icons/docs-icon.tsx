import { icons } from 'lucide-react';
import { createElement } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SvgIcon } from '#components/icons/svg-icon.js';
import type { IconId as SvgIconId } from '#components/icons/svg-icon.js';
import { cn } from '#utils/ui.utils.js';

type IconNamespace = 'lucide' | 'lib';

type IconId = string;

type ParsedIconString = {
  readonly namespace: IconNamespace;
  readonly id: IconId;
  /** Optional Tailwind class(es) appended after the first whitespace (e.g. `text-blue`, `text-[#00ff00]`). */
  readonly iconClassName?: string | undefined;
};

/**
 * Parses `namespace:icon-id` optionally followed by arbitrary Tailwind class strings.
 *
 * The tail must appear as a literal substring in scanned sources (including `apps/ui/content/docs/**`)
 * so Tailwind JIT emits utilities. Tau's `@theme inline` resets `--color-*: initial`; use theme tokens
 * (`text-blue`, `text-foreground`), semantic colors (`text-feature`), or arbitrary brackets (`text-[#00ff00]`).
 *
 * Examples: `lucide:ban`, `lib:openscad`, `lucide:blocks text-blue`, `lucide:flame text-[#00ff00]`
 *
 * @throws Error if icon string format is invalid
 */
function parseIconString(iconString: string): ParsedIconString {
  const trimmed = iconString.trim();
  if (!trimmed) {
    throw new Error('Icon string is required. Format: "namespace:icon-id" (e.g., "lucide:file" or "lib:openscad")');
  }

  const wsMatch = /\s+/.exec(trimmed);
  const head = wsMatch === null ? trimmed : trimmed.slice(0, wsMatch.index);
  const iconClassNameRaw = wsMatch === null ? undefined : trimmed.slice(wsMatch.index + wsMatch[0].length);

  const iconClassNameTrimmed = iconClassNameRaw?.trim();
  const iconClassName =
    iconClassNameTrimmed !== undefined && iconClassNameTrimmed !== '' ? iconClassNameTrimmed : undefined;

  const colonIndex = head.indexOf(':');
  if (colonIndex <= 0) {
    throw new Error(
      `Invalid icon format: "${iconString}". Expected "namespace:icon-id" with optional Tailwind classes after whitespace (e.g., "lucide:file" or "lucide:blocks text-blue")`,
    );
  }

  const namespaceRaw = head.slice(0, colonIndex);
  const id = head.slice(colonIndex + 1).trim();

  if (namespaceRaw !== 'lucide' && namespaceRaw !== 'lib') {
    throw new Error(
      `Invalid namespace: "${namespaceRaw}". Must be "lucide" or "lib" (e.g., "lucide:file" or "lib:openscad")`,
    );
  }

  if (!id) {
    throw new Error(`Icon ID cannot be empty. Format: "${namespaceRaw}:icon-id" (e.g., "${namespaceRaw}:file")`);
  }

  return { namespace: namespaceRaw as IconNamespace, id, iconClassName };
}

/**
 * DocIcon component that resolves icons from different namespaces
 *
 * Priority system:
 * 1. lucide: Resolve from Lucide icons
 * 2. lib: Resolve from SvgIcon sprite
 *
 * @param props - The icon props
 * @param props.iconString - Icon identifier plus optional Tailwind classes after whitespace.
 *                           Examples: `lucide:ban`, `lib:openscad`, `lucide:blocks text-blue`, `lib:openscad text-feature`
 * @param props.className - Optional CSS class name
 */
export function DocsIcon({
  iconString,
  className,
}: {
  readonly iconString: string;
  readonly className?: string;
}): React.JSX.Element {
  const { namespace, id, iconClassName } = parseIconString(iconString);

  const mergedClassName = cn(className, iconClassName);

  // Lucide icons
  if (namespace === 'lucide') {
    const LucideIconComponent = getLucideIcon(id);
    return createElement(LucideIconComponent, { className: mergedClassName });
  }

  // Library icons (SvgIcon sprite)
  return <SvgIcon id={id as SvgIconId} className={mergedClassName} />;
}

/**
 * Get Lucide icon component from icon name
 * Converts kebab-case to PascalCase (e.g., "ban" -> "Ban", "arrow-right" -> "ArrowRight").
 *
 * This conversion is done manually due to issues with the DynamicIcon component.
 *
 * @throws Error if icon is not found
 */
function getLucideIcon(iconName: string): LucideIcon {
  // Convert kebab-case to PascalCase
  const pascalCase = iconName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  const icon = icons[pascalCase as keyof typeof icons] as LucideIcon | undefined;

  if (!icon) {
    throw new Error(
      `Lucide icon "${iconName}" not found. Verify the icon exists at https://lucide.dev/icons/${iconName}`,
    );
  }

  return icon;
}
