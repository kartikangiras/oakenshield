import { MatchedIssues } from './MatchedIssues';

export function ConnectWall({ onConnect, signedIn = false }: { onConnect: () => void; signedIn?: boolean }) {
  if (signedIn) return <MatchedIssues />;
  return (
    <section className="connect-wall">
      <p>Connect GitHub and we will match issues to the languages you already use.</p>
      <button className="primary" onClick={onConnect}>Connect GitHub</button>
      <a className="skip" href="/?browse=1">Browse without connecting</a>
    </section>
  );
}
