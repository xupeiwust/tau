import type { UIToolInvocation } from 'ai';
import { ChevronRight } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { Button } from '#components/ui/button.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';

export function ChatMessageToolReasoning({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.reasoning]>;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  // Capture start time when component mounts (tool call begins)
  const startTimeRef = useRef<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Update elapsed time while in streaming/input states
  useEffect(() => {
    if (part.state === 'input-streaming' || part.state === 'input-available') {
      const interval = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      return () => {
        clearInterval(interval);
      };
    }

    return undefined;
  }, [part.state]);

  const isThinking = part.state === 'input-streaming' || part.state === 'input-available';
  const thinking = part.input?.thinking ?? '';

  // Calculate final duration when output is available
  const finalDurationSeconds =
    part.state === 'output-available' && part.output.durationMs
      ? Math.round(part.output.durationMs / 1000)
      : elapsedSeconds;

  // Format duration display
  const formatDuration = (seconds: number): string => {
    if (seconds < 1) {
      return '<1 second';
    }

    if (seconds === 1) {
      return '1 second';
    }

    return `${seconds} seconds`;
  };

  if (part.state === 'output-error') {
    return <div className="text-sm text-muted-foreground italic">Reasoning failed: {part.errorText}</div>;
  }

  // Get the label text based on state
  const getLabel = (): string => {
    if (isThinking) {
      return 'Thinking...';
    }

    return `Thought for ${formatDuration(finalDurationSeconds)}`;
  };

  // Determine if content should be visible
  const hasContent = thinking.trim() !== '';
  const shouldBeOpen = isThinking ? hasContent : isOpen;

  return (
    <Collapsible className="group/collapsible" open={shouldBeOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="-ml-2 font-medium text-foreground/60 hover:bg-transparent hover:text-foreground/80 dark:hover:bg-transparent"
        >
          <ChevronRight className="transition-transform duration-300 ease-in-out group-data-[state=open]/collapsible:rotate-90" />
          {getLabel()}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <div className="border-l border-foreground/20 pl-5 text-sm whitespace-pre-wrap text-foreground/60 italic">
          {thinking.trim()}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
