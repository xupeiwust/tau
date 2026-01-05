import type { UIToolInvocation } from 'ai';
import { Files, LoaderCircle, File } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { Badge } from '#components/ui/badge.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';

export function ChatMessageToolGlobSearch({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.globSearch]>;
}): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const pattern = input?.pattern ?? 'pattern';

      return (
        <Badge variant="outline">
          <AnimatedShinyText className="flex max-w-full flex-row items-center gap-2">
            <LoaderCircle className="size-3 animate-spin text-inherit" />
            <span className="truncate">Finding files matching "{pattern}"...</span>
          </AnimatedShinyText>
        </Badge>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { pattern } = input;
      const { files, totalFiles } = output;

      return (
        <div className="overflow-hidden rounded-md border bg-neutral/10">
          <div className="flex h-7 w-full flex-row items-center gap-1 pr-1 pl-2 text-xs text-muted-foreground">
            <Files className="size-3" />
            <span className="truncate font-mono">{pattern}</span>
            <span className="ml-auto text-xs opacity-60">
              {totalFiles} file{totalFiles === 1 ? '' : 's'}
            </span>
          </div>
          <div className="max-h-32 overflow-y-auto border-t">
            {files.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No files found</div>
            ) : (
              <div className="space-y-0.5 p-2">
                {files.slice(0, 10).map((file) => (
                  <div key={file} className="flex items-center gap-2 px-1 text-xs">
                    <File className="size-3 text-muted-foreground" />
                    <span className="truncate font-mono">{file}</span>
                  </div>
                ))}
                {files.length > 10 ? (
                  <div className="px-1 text-xs opacity-60">... {files.length - 10} more files</div>
                ) : undefined}
              </div>
            )}
          </div>
        </div>
      );
    }

    case 'output-error': {
      return (
        <Badge variant="destructive">
          <span>File search failed</span>
        </Badge>
      );
    }
  }
}
