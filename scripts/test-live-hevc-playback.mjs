// Verify the real HEVC work that was falsely rejected by the old codec gate.
process.argv[2] ||= '7691678881368211365';
process.env.PLAYBACK_EXPECTED_CODEC = 'hevc';
await import('./test-live-playback.mjs');
