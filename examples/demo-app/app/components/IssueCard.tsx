import flagsmith from '@flagsmith/flagsmith';
import type { Issue } from '../../lib/types';

export function IssueCard({ issue }: { issue: Issue }) {
  const open = () => {
    flagsmith.trackEvent('issue_opened');
    void flagsmith.flushEvents();
    window.open(issue.url, '_blank', 'noopener');
  };
  return (
    <article className="issue-card">
      <span className="repo">{issue.repo}</span>
      <h3>{issue.title}</h3>
      <button onClick={open}>Open on GitHub</button>
    </article>
  );
}
