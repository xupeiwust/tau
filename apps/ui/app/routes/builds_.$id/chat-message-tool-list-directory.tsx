import type { UIToolInvocation } from 'ai';
import { Folder, FolderOpen, File, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { Badge } from '#components/ui/badge.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';

export function ChatMessageToolListDirectory({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.listDirectory]>;
}): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const path = input?.path || '/';

      return (
        <Badge variant="outline">
          <AnimatedShinyText className="flex max-w-full flex-row items-center gap-2">
            <LoaderCircle className="size-3 animate-spin text-inherit" />
            <span className="truncate">Listing {path}...</span>
          </AnimatedShinyText>
        </Badge>
      );
    }

    case 'output-available': {
      const { output } = part;
      const { entries, path } = output;

      // Sort entries: directories first, then files
      const sortedEntries = [...entries].sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'dir' ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      });

      return (
        <div className="overflow-hidden rounded-md border bg-neutral/10">
          <div className="flex h-7 w-full flex-row items-center gap-1 pr-1 pl-2 text-xs text-muted-foreground">
            <FolderOpen className="size-3" />
            <span className="truncate">{path || '/'}</span>
            <span className="ml-auto text-xs opacity-60">({entries.length} items)</span>
          </div>
          <div className="max-h-40 overflow-y-auto border-t">
            {sortedEntries.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">(empty directory)</div>
            ) : (
              <div className="space-y-0.5 p-2">
                {sortedEntries.map((entry) => (
                  <div key={entry.name} className="flex items-center gap-2 px-1 text-xs">
                    {entry.type === 'dir' ? (
                      <Folder className="size-3 text-warning" />
                    ) : (
                      <File className="size-3 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    case 'output-error': {
      return (
        <Badge variant="destructive">
          <span>Failed to list directory</span>
        </Badge>
      );
    }
  }
}
