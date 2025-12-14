import { memo, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, Code, Image, Eye, Check } from 'lucide-react';
import type { ToolSelection, ToolName } from '@taucad/chat';
import { toolName, toolMode } from '@taucad/chat/constants';
import { useIsMobile } from '#hooks/use-mobile.js';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from '#components/ui/drawer.js';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.js';
import { Label } from '#components/ui/label.js';
import { Switch } from '#components/ui/switch.js';
import { cn } from '#utils/ui.utils.js';

type ToolSelectorMode = 'auto' | 'none' | 'any' | 'custom';

type ToolMetadata = {
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

type ChatToolSelectorProperties = {
  readonly value?: ToolSelection;
  readonly onValueChange?: (value: ToolSelection) => void;
  readonly children: (properties: {
    selectedMode: ToolSelectorMode;
    selectedTools: ToolName[];
    toolMetadata: Partial<Record<ToolName, ToolMetadata>>;
  }) => ReactNode;
};

const toolMetadata: Partial<Record<ToolName, ToolMetadata>> = {
  [toolName.webSearch]: {
    label: 'Web Search',
    description: 'Search the web for information',
    icon: Globe,
  },
  [toolName.webBrowser]: {
    label: 'Web Browser',
    description: 'Browse and analyze web pages',
    icon: Eye,
  },
  [toolName.fileEdit]: {
    label: 'File Edit',
    description: 'Edit and create files',
    icon: Code,
  },
  [toolName.imageAnalysis]: {
    label: 'Image Analysis',
    description: 'Analyze images',
    icon: Image,
  },
};

const modeOptions: Array<{
  value: ToolSelectorMode;
  label: string;
  description: string;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Let AI decide which tools to use',
  },
  {
    value: 'none',
    label: 'None',
    description: "Don't use any tools",
  },
  {
    value: 'any',
    label: 'Any',
    description: 'Require tool use (all available)',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Make these tools available',
  },
];

const getModeFromValue = (value?: ToolSelection): ToolSelectorMode => {
  if (!value || value === toolMode.auto) {
    return 'auto';
  }

  if (value === toolMode.none) {
    return 'none';
  }

  if (value === toolMode.any) {
    return 'any';
  }

  if (Array.isArray(value)) {
    return 'custom';
  }

  return 'auto';
};

const getToolsFromValue = (value?: ToolSelection): ToolName[] => {
  if (Array.isArray(value)) {
    return value;
  }

  return [];
};

export const ChatToolSelector = memo(function ({
  value,
  onValueChange,
  children,
}: ChatToolSelectorProperties): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const isMobile = useIsMobile();
  const mode = getModeFromValue(value);
  const selectedTools = getToolsFromValue(value);

  const handleModeChange = useCallback(
    (newMode: ToolSelectorMode) => {
      switch (newMode) {
        case 'auto': {
          onValueChange?.(toolMode.auto);
          break;
        }

        case 'none': {
          onValueChange?.(toolMode.none);
          break;
        }

        case 'any': {
          onValueChange?.(toolMode.any);
          break;
        }

        case 'custom': {
          // Default to all tools when switching to custom
          onValueChange?.([toolName.webSearch, toolName.fileEdit]);
          break;
        }

        default: {
          const exhaustiveCheck: never = newMode;
          throw new Error(`Unknown mode: ${exhaustiveCheck as string}`);
        }
      }
    },
    [onValueChange],
  );

  const handleToolToggle = useCallback(
    (tool: ToolName) => {
      const currentTools = Array.isArray(value) ? value : [];
      const isCurrentlySelected = currentTools.includes(tool);

      if (isCurrentlySelected) {
        const newTools = currentTools.filter((t) => t !== tool);
        // If no tools selected, switch back to auto
        if (newTools.length === 0) {
          onValueChange?.(toolMode.auto);
        } else {
          onValueChange?.(newTools);
        }
      } else {
        const newTools = [...currentTools, tool];
        onValueChange?.(newTools);
      }
    },
    [value, onValueChange],
  );

  const content = (
    <div className="flex flex-col gap-4 p-2">
      {/* Mode Selection */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-muted-foreground">Tool Mode</span>
        <div className="flex flex-col gap-1">
          {modeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(
                'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors',
                'hover:bg-accent',
                mode === option.value && 'bg-accent',
              )}
              onClick={() => {
                handleModeChange(option.value);
              }}
            >
              <div className="flex flex-col items-start gap-0">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </div>
              {mode === option.value ? <Check className="size-4 text-primary" /> : null}
            </button>
          ))}
        </div>
      </div>

      {/* Tool Toggles (only in custom mode) */}
      {mode === 'custom' ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted-foreground">Select Tools</span>
          <div className="flex flex-col gap-2">
            {Object.entries(toolMetadata).map(([key, metadata]) => {
              const toolKey = key as ToolName;
              const Icon = metadata.icon;
              const isSelected = selectedTools.includes(toolKey);

              return (
                <div key={toolKey} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-accent">
                  <Label htmlFor={`tool-${toolKey}`} className="flex cursor-pointer items-center gap-2">
                    <Icon className="size-4" />
                    <span>{metadata.label}</span>
                  </Label>
                  <Switch
                    id={`tool-${toolKey}`}
                    checked={isSelected}
                    onCheckedChange={() => {
                      handleToolToggle(toolKey);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={setIsOpen}>
        <DrawerTrigger asChild>{children({ selectedMode: mode, selectedTools, toolMetadata })}</DrawerTrigger>
        <DrawerContent>
          <DrawerTitle className="sr-only">Tool Selection</DrawerTitle>
          <DrawerDescription className="sr-only">Select the tool mode and individual tools to use.</DrawerDescription>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>{children({ selectedMode: mode, selectedTools, toolMetadata })}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        {content}
      </PopoverContent>
    </Popover>
  );
});
