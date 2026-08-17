import React from 'react';
import { MarkdownRenderer } from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';
export const NeoBundleProbe = ({ content }: { content: string }) => <MarkdownRenderer content={content} components={{}} isStreaming />;
