import React from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { cjk } from '@streamdown/cjk';
export const StreamdownFullBundleProbe = ({ content }: { content: string }) => <Streamdown mode="streaming" plugins={{ code, math, mermaid, cjk }}>{content}</Streamdown>;
