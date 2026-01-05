import type { UIToolInvocation } from 'ai';
import { Trash2, LoaderCircle, Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { Badge } from '#components/ui/badge.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';

export function ChatMessageToolDeleteFile({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.deleteFile]>;
}): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const targetFile = input?.targetFile ?? 'file';

      return (
        <Badge variant="outline">
          <AnimatedShinyText className="flex max-w-full flex-row items-center gap-2">
            <LoaderCircle className="size-3 animate-spin text-inherit" />
            <span className="truncate">Deleting {targetFile}...</span>
          </AnimatedShinyText>
        </Badge>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { targetFile } = input;
      const { success } = output;

      return (
        <Badge variant={success ? 'outline' : 'destructive'} className="flex items-center gap-2">
          {success ? (
            <>
              <Check className="size-3 text-success" />
              <Trash2 className="size-3" />
              <span className="truncate">Deleted {targetFile}</span>
            </>
          ) : (
            <>
              <X className="size-3" />
              <span className="truncate">Failed to delete {targetFile}</span>
            </>
          )}
        </Badge>
      );
    }

    case 'output-error': {
      return (
        <Badge variant="destructive">
          <span>Failed to delete file</span>
        </Badge>
      );
    }
  }
}
