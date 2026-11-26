// Left over from the weekly digest experiment, which has ended.
import flagsmith from '@flagsmith/flagsmith';
import { useExperiment } from '@flagsmith/flagsmith/react';

export function DigestPrompt() {
  const flag = useExperiment('digest_prompt');
  if (!flag?.enabled || flag.variant !== 'show-prompt') return null;
  return <button onClick={() => flagsmith.trackEvent('digest_subscribed')}>Email me new matches every week</button>;
}
