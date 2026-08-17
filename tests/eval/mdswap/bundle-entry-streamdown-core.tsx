import React from 'react';
import { Streamdown } from 'streamdown';
export const StreamdownCoreBundleProbe = ({ content }: { content: string }) => <Streamdown mode="streaming">{content}</Streamdown>;
