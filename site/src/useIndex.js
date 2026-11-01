import { useEffect, useState } from 'react';

// The index is built from the experiment records by tools/leaderboard/build-index.mjs.
async function fetchIndex() {
  const response = await fetch('/data/leaderboard.json');
  if (!response.ok) throw new Error('no leaderboard index was found');
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data?.entries)) throw new Error('the leaderboard index is not valid');
  return data;
}

export function useIndex() {
  const [index, setIndex] = useState({ status: 'loading' });
  useEffect(() => {
    fetchIndex().then(
      data => setIndex({ status: 'ready', runs: data.entries }),
      error => setIndex({ status: 'error', message: error.message }),
    );
  }, []);
  return index;
}
