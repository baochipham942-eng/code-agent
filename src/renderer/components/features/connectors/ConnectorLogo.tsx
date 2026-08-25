import React from 'react';
import braveLogo from '../../../assets/brand/connectors/brave.svg';
import context7Logo from '../../../assets/brand/connectors/context7.svg';
import exaLogo from '../../../assets/brand/connectors/exa.svg';
import excelLogo from '../../../assets/brand/connectors/excel.svg';
import figmaLogo from '../../../assets/brand/connectors/figma.svg';
import firecrawlLogo from '../../../assets/brand/connectors/firecrawl.svg';
import githubLogo from '../../../assets/brand/connectors/github.svg';
import playwrightLogo from '../../../assets/brand/connectors/playwright.svg';
import supabaseLogo from '../../../assets/brand/connectors/supabase.svg';
import tavilyLogo from '../../../assets/brand/connectors/tavily.svg';
import tencentDocsLogo from '../../../assets/brand/connectors/tencent-docs.svg';
import tmeetLogo from '../../../assets/brand/connectors/tmeet.svg';

const CONNECTOR_LOGO_ASSETS: Readonly<Record<string, string>> = {
  brave: braveLogo,
  context7: context7Logo,
  exa: exaLogo,
  excel: excelLogo,
  figma: figmaLogo,
  firecrawl: firecrawlLogo,
  github: githubLogo,
  playwright: playwrightLogo,
  supabase: supabaseLogo,
  tavily: tavilyLogo,
  'tencent-docs': tencentDocsLogo,
  tmeet: tmeetLogo,
};

const LIGHT_PLATE_LOGOS = new Set(['github']);

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
  if (!source) return <>{fallback}</>;

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className} ${
        id && LIGHT_PLATE_LOGOS.has(id) ? 'rounded-sm bg-white p-0.5' : ''
      }`}
    >
      <img
        src={source}
        alt={displayName}
        data-testid={`connector-logo-${id}`}
        className="h-full w-full object-contain"
      />
    </span>
  );
};
