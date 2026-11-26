import flagsmith from '@flagsmith/flagsmith';
import { useMatchedIssues } from '../../lib/issues';

export function MatchedIssues() {
  const issues = useMatchedIssues();
  return (
    <ul className="matched">
      {issues.map(issue => (
        <li key={issue.url}>
          <span>{issue.title}</span>
          <button
            onClick={() => {
              flagsmith.trackEvent('issue_opened');
              window.open(issue.url, '_blank', 'noopener');
            }}
          >
            Open issue
          </button>
        </li>
      ))}
    </ul>
  );
}
