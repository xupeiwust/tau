import { memo } from 'react';
import type { ChatTextareaProperties } from '#components/chat/chat-textarea-types.js';
import { useChatTextareaLogic } from '#components/chat/chat-textarea-types.js';
import { ChatTextareaDesktop } from '#components/chat/chat-textarea-desktop.js';
import { ChatTextareaMobile } from '#components/chat/chat-textarea-mobile.js';
import { useIsMobile } from '#hooks/use-mobile.js';

/**
 * Main chat textarea component that conditionally renders either the
 * desktop or mobile version based on the `useIsMobile()` hook.
 *
 * All logic is shared via the `useChatTextareaLogic` hook.
 */
export const ChatTextarea = memo(function ({
  ref,
  onSubmit,
  enableAutoFocus = true,
  onEscapePressed,
  onBlur,
  className,
  enableContextActions = true,
  enableKernelSelector = true,
  mode = 'main',
}: ChatTextareaProperties): React.JSX.Element {
  const isMobile = useIsMobile();
  const logic = useChatTextareaLogic({
    ref,
    onSubmit,
    enableAutoFocus,
    onEscapePressed,
    onBlur,
    mode,
  });

  if (isMobile) {
    return (
      <ChatTextareaMobile
        className={className}
        enableAutoFocus={enableAutoFocus}
        enableContextActions={enableContextActions}
        enableKernelSelector={enableKernelSelector}
        // State
        isDragging={logic.isDragging}
        showContextMenu={logic.showContextMenu}
        contextSearchQuery={logic.contextSearchQuery}
        selectedMenuIndex={logic.selectedMenuIndex}
        isSubmitting={logic.isSubmitting}
        inputText={logic.inputText}
        images={logic.images}
        selectedToolChoice={logic.selectedToolChoice}
        status={logic.status}
        selectedModel={logic.selectedModel}
        formattedCancelKeyCombination={logic.formattedCancelKeyCombination}
        // Refs
        textareaReference={logic.textareaReference}
        fileInputReference={logic.fileInputReference}
        containerReference={logic.containerReference}
        // Handlers
        handleSubmit={logic.handleSubmit}
        handleCancelClick={logic.handleCancelClick}
        handleTextareaKeyDown={logic.handleTextareaKeyDown}
        handleDragOver={logic.handleDragOver}
        handleDragLeave={logic.handleDragLeave}
        handleDrop={logic.handleDrop}
        handleFileSelect={logic.handleFileSelect}
        handleFileChange={logic.handleFileChange}
        handleTextChange={logic.handleTextChange}
        handleContextMenuSelect={logic.handleContextMenuSelect}
        handleContextImageAdd={logic.handleContextImageAdd}
        handleAddText={logic.handleAddText}
        handleAddImage={logic.handleAddImage}
        handleTextareaBlur={logic.handleTextareaBlur}
        handlePointerDown={logic.handlePointerDown}
        focusInput={logic.focusInput}
        removeImage={logic.removeImage}
        setShowContextMenu={logic.setShowContextMenu}
        setAtSymbolPosition={logic.setAtSymbolPosition}
        setContextSearchQuery={logic.setContextSearchQuery}
        setSelectedMenuIndex={logic.setSelectedMenuIndex}
        setDraftToolChoice={logic.setDraftToolChoice}
      />
    );
  }

  return (
    <ChatTextareaDesktop
      className={className}
      enableAutoFocus={enableAutoFocus}
      enableContextActions={enableContextActions}
      enableKernelSelector={enableKernelSelector}
      // State
      isDragging={logic.isDragging}
      showContextMenu={logic.showContextMenu}
      contextSearchQuery={logic.contextSearchQuery}
      selectedMenuIndex={logic.selectedMenuIndex}
      isSubmitting={logic.isSubmitting}
      inputText={logic.inputText}
      images={logic.images}
      selectedToolChoice={logic.selectedToolChoice}
      status={logic.status}
      selectedModel={logic.selectedModel}
      formattedCancelKeyCombination={logic.formattedCancelKeyCombination}
      // Refs
      textareaReference={logic.textareaReference}
      fileInputReference={logic.fileInputReference}
      containerReference={logic.containerReference}
      // Handlers
      handleSubmit={logic.handleSubmit}
      handleCancelClick={logic.handleCancelClick}
      handleTextareaKeyDown={logic.handleTextareaKeyDown}
      handleDragOver={logic.handleDragOver}
      handleDragLeave={logic.handleDragLeave}
      handleDrop={logic.handleDrop}
      handleFileSelect={logic.handleFileSelect}
      handleFileChange={logic.handleFileChange}
      handleTextChange={logic.handleTextChange}
      handleContextMenuSelect={logic.handleContextMenuSelect}
      handleContextImageAdd={logic.handleContextImageAdd}
      handleAddText={logic.handleAddText}
      handleAddImage={logic.handleAddImage}
      handleTextareaBlur={logic.handleTextareaBlur}
      handlePointerDown={logic.handlePointerDown}
      focusInput={logic.focusInput}
      removeImage={logic.removeImage}
      setDraftToolChoice={logic.setDraftToolChoice}
      setShowContextMenu={logic.setShowContextMenu}
      setAtSymbolPosition={logic.setAtSymbolPosition}
      setContextSearchQuery={logic.setContextSearchQuery}
      setSelectedMenuIndex={logic.setSelectedMenuIndex}
    />
  );
});
