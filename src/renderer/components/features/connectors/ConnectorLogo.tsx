import React from 'react';
import amapLogo from '../../../assets/brand/connectors/amap.png';
import braveLogo from '../../../assets/brand/connectors/brave.svg';
import context7Logo from '../../../assets/brand/connectors/context7.svg';
import deepwikiLogo from '../../../assets/brand/connectors/deepwiki.png';
import exaLogo from '../../../assets/brand/connectors/exa.svg';
import excelLogo from '../../../assets/brand/connectors/excel.svg';
import feishuLogo from '../../../assets/brand/connectors/feishu.png';
import figmaLogo from '../../../assets/brand/connectors/figma.svg';
import firecrawlLogo from '../../../assets/brand/connectors/firecrawl.svg';
import githubLogo from '../../../assets/brand/connectors/github.svg';
import googleCalendarLogo from '../../../assets/brand/connectors/google-calendar.png';
import notionLogo from '../../../assets/brand/connectors/notion.png';
import playwrightLogo from '../../../assets/brand/connectors/playwright.svg';
import puppeteerLogo from '../../../assets/brand/connectors/puppeteer.png';
import supabaseLogo from '../../../assets/brand/connectors/supabase.svg';
import tavilyLogo from '../../../assets/brand/connectors/tavily.svg';
import tencentDocsLogo from '../../../assets/brand/connectors/tencent-docs.svg';
import tencentMapLogo from '../../../assets/brand/connectors/tencent-map.png';
import tencentSurveyLogo from '../../../assets/brand/connectors/tencent-survey.png';
import tencentWeiyunLogo from '../../../assets/brand/connectors/tencent-weiyun.png';
import tmeetLogo from '../../../assets/brand/connectors/tmeet.png';

const CONNECTOR_LOGO_ASSETS: Readonly<Record<string, string>> = {
  amap: amapLogo,
  brave: braveLogo,
  context7: context7Logo,
  deepwiki: deepwikiLogo,
  exa: exaLogo,
  excel: excelLogo,
  feishu: feishuLogo,
  figma: figmaLogo,
  firecrawl: firecrawlLogo,
  github: githubLogo,
  'google-calendar': googleCalendarLogo,
  notion: notionLogo,
  playwright: playwrightLogo,
  puppeteer: puppeteerLogo,
  supabase: supabaseLogo,
  tavily: tavilyLogo,
  'tencent-docs': tencentDocsLogo,
  'tencent-map': tencentMapLogo,
  'tencent-survey': tencentSurveyLogo,
  'tencent-weiyun': tencentWeiyunLogo,
  tmeet: tmeetLogo,
};

const LIGHT_PLATE_LOGOS = new Set(['deepwiki', 'github', 'notion', 'puppeteer']);

interface ConnectorLogoProps {
  id?: string;
  displayName: string;
  fallback: React.ReactNode;
  className?: string;
}

export const ConnectorLogo: React.FC<ConnectorLogoProps> = ({
  id,
  displayName,
  fallback,
  className = 'h-4 w-4',
}) => {
  const source = id ? CONNECTOR_LOGO_ASSETS[id] : undefined;

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className} ${
        source && id && LIGHT_PLATE_LOGOS.has(id) ? 'rounded-sm bg-white p-0.5' : ''
      }`}
    >
      {source
        ? (
          <img
            src={source}
            alt={displayName}
            data-testid={`connector-logo-${id}`}
            className="h-full w-full object-contain"
          />
        )
        : fallback}
    </span>
  );
};
