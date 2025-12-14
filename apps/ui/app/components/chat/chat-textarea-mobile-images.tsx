import { memo, useState } from 'react';
import { X } from 'lucide-react';
import { Dialog, DialogContent } from '#components/ui/dialog.js';
import { cn } from '#utils/ui.utils.js';

type ChatTextareaMobileImagesProperties = {
  readonly images: string[];
  readonly onRemoveImage: (index: number) => void;
};

/**
 * Mobile image preview component for the chat textarea.
 * Displays compact thumbnails that open in a full-screen dialog when tapped.
 */
export const ChatTextareaMobileImages = memo(function ({
  images,
  onRemoveImage,
}: ChatTextareaMobileImagesProperties): React.JSX.Element | undefined {
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | undefined>(undefined);

  if (images.length === 0) {
    return undefined;
  }

  const selectedImage = selectedImageIndex === undefined ? undefined : images[selectedImageIndex];

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {images.map((image, index) => (
          <div key={image} className="relative">
            {/* Thumbnail - tap to open dialog */}
            <button
              type="button"
              className="size-8 overflow-hidden rounded-xs border focus:ring-2 focus:ring-primary focus:outline-none"
              onClick={() => {
                setSelectedImageIndex(index);
              }}
            >
              <img src={image} alt={`Uploaded ${index + 1}`} className="size-full object-cover" />
            </button>
            {/* Remove button */}
            <button
              type="button"
              className={cn(
                'absolute -top-1 -right-1 flex size-4 items-center justify-center',
                'rounded-full border bg-background text-muted-foreground',
                'hover:text-destructive focus:ring-1 focus:ring-primary focus:outline-none',
              )}
              onClick={(event) => {
                event.stopPropagation();
                onRemoveImage(index);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Full-screen image dialog */}
      <Dialog
        open={selectedImageIndex !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedImageIndex(undefined);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-[90vw] overflow-hidden p-0 sm:max-w-[90vw]">
          {selectedImage ? (
            <img src={selectedImage} alt="Full size preview" className="size-full object-contain" />
          ) : undefined}
        </DialogContent>
      </Dialog>
    </>
  );
});
