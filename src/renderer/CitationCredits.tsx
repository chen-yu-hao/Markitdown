import { useEffect, useState } from 'react';
import './citation-credits.css';

export default function CitationCredits({ startup = false, paused = false }: { startup?: boolean; paused?: boolean }) {
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (!startup || paused || finished) return;
    const timer = setTimeout(() => setFinished(true), 10_000);
    return () => clearTimeout(timer);
  }, [startup, paused, finished]);
  if (startup && (paused || finished)) return null;
  return <aside className={`citation-credits${startup ? ' citation-startup-credit' : ''}`} aria-label="citeproc-js attribution" role={startup ? 'status' : undefined}>
    <span>(c) Frank Bennett</span>
    <span>citeproc-js implements the Citation Style Language</span>
    <a href="https://citationstyles.org/" onClick={event => { event.preventDefault(); void window.markedown.openExternal('https://citationstyles.org/'); }}>https://citationstyles.org/</a>
  </aside>;
}
