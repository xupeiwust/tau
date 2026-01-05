import type { UIToolInvocation } from 'ai';
import { Search, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { Badge } from '#components/ui/badge.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';

export function ChatMessageToolGrep({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.grep]>;
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
            <span className="truncate">Searching for "{pattern}"...</span>
          </AnimatedShinyText>
        </Badge>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { pattern } = input;
      const { matches, totalMatches, truncated } = output;

      // Group matches by file
      const matchesByFile = new Map<string, typeof matches>();
      for (const match of matches) {
        if (!matchesByFile.has(match.file)) {
          matchesByFile.set(match.file, []);
        }

        matchesByFile.get(match.file)!.push(match);
      }

      return (
        <div className="overflow-hidden rounded-md border bg-neutral/10">
          <div className="flex h-7 w-full flex-row items-center gap-1 pr-1 pl-2 text-xs text-muted-foreground">
            <Search className="size-3" />
            <span className="truncate font-mono">/{pattern}/</span>
            <span className="ml-auto text-xs opacity-60">
              {totalMatches} match{totalMatches === 1 ? '' : 'es'}
              {truncated ? ' (truncated)' : ''}
            </span>
          </div>
          <div className="max-h-40 overflow-y-auto border-t">
            {matches.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches found</div>
            ) : (
              <div className="space-y-1 p-2">
                {[...matchesByFile.entries()].slice(0, 5).map(([file, fileMatches]) => (
                  <div key={file} className="text-xs">
                    <div className="font-medium text-foreground/80">{file}</div>
                    {fileMatches.slice(0, 3).map((match) => (
                      <div key={`${match.file}:${match.line}`} className="flex gap-2 pl-2 text-muted-foreground">
                        <span className="shrink-0 font-mono opacity-60">{match.line}:</span>
                        <span className="truncate font-mono">{match.content.trim()}</span>
                      </div>
                    ))}
                    {fileMatches.length > 3 ? (
                      <div className="pl-2 text-xs opacity-60">... {fileMatches.length - 3} more matches</div>
                    ) : undefined}
                  </div>
                ))}
                {matchesByFile.size > 5 ? (
                  <div className="text-xs opacity-60">... {matchesByFile.size - 5} more files</div>
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
          <span>Search failed</span>
        </Badge>
      );
    }
  }
}
