import { useEffect, useState } from 'react';

// The index built from real experiment records wins over the synthetic demo index when both exist.
async function fetchIndex() {
  for (const url of ['/data/leaderboard.json', '/data/leaderboard.mock.json']) {
    const response = await fetch(url);
    if (!response.ok) continue;
    const data = await response.json().catch(() => null);
    if (Array.isArray(data?.entries)) return data;
  }
  throw new Error('no leaderboard index was found');
}

export function useIndex() {
  const [index, setIndex] = useState({ status: 'loading' });
  useEffect(() => {
    fetchIndex().then(
      data => setIndex({ status: 'ready', runs: data.entries, synthetic: data.synthetic === true }),
      error => setIndex({ status: 'error', message: error.message }),
    );
  }, []);
  return index;
}
