import { memo, useMemo } from 'react';
import type React from 'react';
import { ChevronRight, RefreshCcw } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { useChatActions, useChatSelector } from '#hooks/use-chat.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { CodeViewer } from '#components/code/code-viewer.js';
import { cn } from '#utils/ui.utils.js';
import { ChatErrorUnauthorized } from '#routes/builds_.$id/chat-error-unauthorized.js';
import { ChatErrorServiceUnavailable } from '#routes/builds_.$id/chat-error-service-unavailable.js';

type ParsedError = {
  code?: string;
  error?: string;
  statusCode?: number;
  path?: string;
  requestId?: string;
};

/**
 * Checks if the error indicates a network/connectivity issue.
 * This includes browser fetch failures and connection refused errors.
 */
function isNetworkError(message: string): boolean {
  const networkErrorPatterns = [
    'Failed to fetch', // Browser fetch API network error
    'NetworkError', // Generic network error
    'net::ERR_CONNECTION_REFUSED', // Chrome connection refused
    'net::ERR_NETWORK_CHANGED', // Chrome network changed
    'net::ERR_INTERNET_DISCONNECTED', // Chrome no internet
    'net::ERR_NAME_NOT_RESOLVED', // Chrome DNS failure
    'Load failed', // Safari network error
    'Network request failed', // React Native / some polyfills
    'ECONNREFUSED', // Node.js connection refused
    'ETIMEDOUT', // Connection timeout
    'ENOTFOUND', // DNS lookup failed
  ];

  return networkErrorPatterns.some((pattern) => message.includes(pattern));
}

function parseErrorMessage(message: string): { parsed: ParsedError | undefined; formatted: string } {
  try {
    const parsed = JSON.parse(message) as ParsedError;
    return { parsed, formatted: JSON.stringify(parsed, null, 2) };
  } catch {
    return { parsed: undefined, formatted: message };
  }
}

export const ChatError = memo(function ({
  isOpen = false,
  onOpenChange,
  className,
}: {
  readonly isOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
}): React.ReactNode {
  const error = useChatSelector((state) => state.error);
  const { regenerate } = useChatActions();

  const { parsed, formatted } = useMemo(() => {
    if (!error) {
      return { parsed: undefined, formatted: '' };
    }

    return parseErrorMessage(error.message);
  }, [error]);

  if (!error) {
    return null;
  }

  // Handle UNAUTHORIZED errors with dedicated component
  if (parsed?.code === 'UNAUTHORIZED') {
    return (
      <div className={cn('size-full', className)}>
        <ChatErrorUnauthorized />
      </div>
    );
  }

  // Handle network/connectivity errors with dedicated component
  if (isNetworkError(error.message)) {
    return (
      <div className={cn('size-full', className)}>
        <ChatErrorServiceUnavailable />
      </div>
    );
  }

  return (
    <div className={cn('size-full', className)}>
      <Collapsible
        open={isOpen}
        className={cn(
          'group/collapsible flex flex-col justify-center rounded-md border border-destructive/20 bg-destructive/10 text-sm',
        )}
        onOpenChange={onOpenChange}
      >
        <CollapsibleTrigger asChild>
          <div className="flex w-full cursor-pointer items-center justify-between gap-2 p-2">
            <ChevronRight className="size-4 transition-transform duration-300 ease-in-out group-data-[state=open]/collapsible:rotate-90" />
            <div className="flex w-full items-center justify-between">
              <p>Unable to send the message.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  regenerate();
                }}
              >
                <RefreshCcw className="size-3.5" />
                Retry
              </Button>
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-x-scroll px-2 pb-2">
          <CodeViewer text={formatted} language="json" className="text-xs whitespace-pre-wrap" />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
