import React, { useState } from 'react';
import type { CronRunsOn } from '@shared/contract';
import { ChevronDown, ChevronUp, Cloud, Monitor } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';

interface CronRunsOnSelectorProps {
  value: CronRunsOn;
  onChange: (value: CronRunsOn) => void;
  readOnly?: boolean;
}

export const CronRunsOnPill: React.FC<{ runsOn: CronRunsOn; localLabel: string; cloudLabel: string }> = ({
  runsOn,
  localLabel,
  cloudLabel,
}) => (
  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${runsOn === 'cloud'
    ? 'border-badge-info/30 bg-blue-500/10 text-badge-info'
    : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`} data-testid={`cron-runs-on-pill-${runsOn}`}>
    {runsOn === 'cloud' ? <Cloud className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
    {runsOn === 'cloud' ? cloudLabel : localLabel}
  </span>
);

export const CronRunsOnSelector: React.FC<CronRunsOnSelectorProps> = ({ value, onChange, readOnly = false }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const [expanded, setExpanded] = useState(false);
  const locations: Array<{ value: CronRunsOn; icon: React.ReactNode; title: string; points: string[] }> = [
    {
      value: 'local',
      icon: <Monitor className="h-4 w-4" />,
      title: cc.locationLocal,
      points: [cc.localPointFiles, cc.localPointApproval, cc.localPointApp],
    },
    {
      value: 'cloud',
      icon: <Cloud className="h-4 w-4" />,
      title: cc.locationCloud,
      points: [cc.cloudPointOffline, cc.cloudPointIsolated, cc.cloudPointAutonomous],
    },
  ];
  const comparisonRows = [
    [cc.compareNeedsApp, cc.compareNeedsAppLocal, cc.compareNeedsAppCloud],
    [cc.compareLocalAccess, cc.compareLocalAccessLocal, cc.compareLocalAccessCloud],
    [cc.compareEnvironment, cc.compareEnvironmentLocal, cc.compareEnvironmentCloud],
    [cc.comparePermissions, cc.comparePermissionsLocal, cc.comparePermissionsCloud],
    [cc.compareMinimum, cc.compareMinimumLocal, cc.compareMinimumCloud],
  ];

  return (
    <section className="space-y-2" data-testid="cron-runs-on-selector">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-zinc-200">{cc.executionLocationTitle}</div>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="inline-flex items-center gap-1 text-xs text-badge-info hover:text-badge-info"
          aria-expanded={expanded}
        >
          {expanded ? cc.locationDifferenceHide : cc.locationDifferenceShow}
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {locations.map((location) => {
          const selected = value === location.value;
          return (
            <button
              key={location.value}
              type="button"
              disabled={readOnly}
              onClick={() => onChange(location.value)}
              className={`rounded-xl border p-3 text-left transition-colors ${selected
                ? 'border-badge-info/50 bg-blue-500/10'
                : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700'} disabled:cursor-default`}
              data-testid={`cron-runs-on-${location.value}`}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                <span className={selected ? 'text-badge-info' : 'text-zinc-500'}>{location.icon}</span>
                {location.title}
              </div>
              <ul className="mt-2 space-y-1 text-xs text-zinc-500">
                {location.points.map((point) => <li key={point}>· {point}</li>)}
              </ul>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500">{cc.locationImmutable}</p>
      {expanded && (
        <div className="overflow-hidden rounded-lg border border-zinc-800" data-testid="cron-location-comparison">
          <table className="w-full text-xs">
            <thead className="bg-zinc-950/80 text-left text-zinc-500">
              <tr>
                <th className="px-3 py-2" />
                <th className="px-3 py-2">{cc.locationLocal}</th>
                <th className="px-3 py-2">{cc.locationCloud}</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map(([label, local, cloud]) => (
                <tr key={label} className="border-t border-zinc-800 bg-zinc-900/40">
                  <td className="px-3 py-2 text-zinc-400">{label}</td>
                  <td className="px-3 py-2 text-zinc-300">{local}</td>
                  <td className="px-3 py-2 text-zinc-300">{cloud}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export default CronRunsOnSelector;
