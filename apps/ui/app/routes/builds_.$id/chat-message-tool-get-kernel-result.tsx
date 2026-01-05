import type { UIToolInvocation } from 'ai';
import { CheckCircle, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { Button } from '#components/ui/button.js';

export function ChatMessageToolGetKernelResult({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.getKernelResult]>;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);

  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>Checking kernel status...</span>
        </div>
      );
    }

    case 'output-available': {
      const { output } = part;
      const { status, kernelErrors, message } = output;

      const hasErrors = kernelErrors && kernelErrors.length > 0;

      if (status === 'ready' && !hasErrors) {
        return (
          <div className="flex items-center gap-2 text-sm text-success">
            <CheckCircle className="size-4" />
            <span>{message ?? 'Kernel compilation successful'}</span>
          </div>
        );
      }

      return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="group flex h-auto w-full justify-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive hover:bg-destructive/20"
            >
              <XCircle className="size-4 shrink-0" />
              <span className="text-left text-sm">{message ?? `Found ${kernelErrors?.length ?? 0} error(s)`}</span>
            </Button>
          </CollapsibleTrigger>
          {hasErrors ? (
            <CollapsibleContent className="mt-2">
              <div className="space-y-2 rounded-md border bg-neutral/10 p-3 text-xs">
                {kernelErrors.map((error, index) => {
                  const { location } = error;
                  const key = `${location?.startLineNumber ?? index}-${error.message}`;

                  return (
                    <div key={key} className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                      <div className="flex-1">
                        {location ? (
                          <span className="mr-2 font-mono text-muted-foreground">
                            {location.fileName}:{location.startLineNumber}:{location.startColumn}
                          </span>
                        ) : null}
                        <span className="font-mono">{error.message}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          ) : null}
        </Collapsible>
      );
    }

    case 'output-error': {
      return (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="size-4" />
          <span>Failed to check kernel status: {part.errorText}</span>
        </div>
      );
    }
  }
}
