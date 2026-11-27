import type { FlagsmithAlert } from '../lib/api.ts';
import { navigate } from '../lib/hooks.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';
import { TimeAgo, cx } from './ui.tsx';

const KIND_ICON: Record<FlagsmithAlert['kind'], IconName> = {
  'config-change': 'sliders',
  'segment-change': 'users',
  'flag-deleted': 'octagon',
  'experiment-started': 'play',
  'experiment-ended': 'check',
  recheck: 'refresh',
};

export function alertTarget(a: FlagsmithAlert): string | undefined {
  if (a.checkIds?.length) return a.checkIds.length === 1 ? `/checks/${a.checkIds[0]}` : '/checks?q=&verdict=block';
  if (a.experimentId !== undefined) return `/experiments/${a.experimentId}`;
  return undefined;
}

/** One Flagsmith alert: what changed, where it came from, and where to look. */
export function AlertRow({ a, compact = false, onOpen }: { a: FlagsmithAlert; compact?: boolean; onOpen?: () => void }) {
  const tone = a.severity === 'block' ? 'v-block' : a.severity === 'warn' ? 'v-warn' : 'v-info';
  const target = alertTarget(a);
  return (
    <div
      className={cx('feed-item', 'alert-row')}
      style={{ cursor: target ? 'pointer' : 'default', padding: compact ? '10px 14px' : undefined }}
      onClick={() => { if (target) { onOpen?.(); navigate(target); } }}
    >
      <span className={cx('feed-badge', tone)}><Icon name={KIND_ICON[a.kind]} size={14} strokeWidth={2.1} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="feed-title" style={{ whiteSpace: 'normal' }}>{a.title}</div>
        <div className={cx("small muted", compact && "clamp-2")} style={{ marginTop: 2 }}>{a.detail}</div>
        <div className="row small faint" style={{ marginTop: 4, gap: 8 }}>
          <span className="chip" style={{ height: 20, fontSize: 12 }}>{a.origin === 'simulated' ? 'Simulated' : a.eventType ?? 'Flagsmith'}</span>
          {a.flagKey && <span className="mono">{a.flagKey}</span>}
        </div>
      </div>
      <TimeAgo iso={a.at} className="small faint" />
    </div>
  );
}
