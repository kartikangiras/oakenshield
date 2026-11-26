import flagsmith from '@flagsmith/flagsmith';
import { useIssues } from '../../lib/issues';
import { IssueCard } from './IssueCard';

export function IssueList({ onPersonalize }: { onPersonalize: () => void }) {
  const { issues, language, setLanguage } = useIssues();
  return (
    <section className="issue-list">
      <div className="toolbar">
        {['JavaScript', 'TypeScript', 'Python', 'Go', 'Java'].map(lang => (
          <button
            key={lang}
            className={lang === language ? 'chip chip--on' : 'chip'}
            onClick={() => {
              setLanguage(lang);
              flagsmith.trackEvent('filter_changed');
            }}
          >
            {lang}
          </button>
        ))}
        <button className="ghost" onClick={onPersonalize}>Personalize with GitHub</button>
      </div>
      {issues.map(issue => <IssueCard key={issue.url} issue={issue} />)}
    </section>
  );
}
