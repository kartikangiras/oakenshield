'use client';
import flagsmith from '@flagsmith/flagsmith';
import { useExperiment } from '@flagsmith/flagsmith/react';
import { ConnectWall } from './components/ConnectWall';
import { IssueList } from './components/IssueList';
import { Skeleton } from './components/Skeleton';

export function Landing() {
  const flag = useExperiment('onboarding_flow'); // records the exposure
  if (!flag) return <Skeleton />;

  if (flag.enabled && flag.variant === 'github_first') {
    return (
      <main className="landing landing--connect">
        <h1>Find your first open-source issue in 10 seconds</h1>
        <ConnectWall onConnect={connect} />
      </main>
    );
  }

  return (
    <main className="landing">
      <h1>Find your first open-source issue in 10 seconds</h1>
      <IssueList onPersonalize={connect} />
    </main>
  );
}

async function connect() {
  await flagsmith.flushEvents(); // the exposure must leave before the redirect
  window.location.href = '/api/auth/signin/github';
}
