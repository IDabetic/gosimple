/**
 * Removes wall-clock measurements from a JSON response on stdin.
 *
 * The determinism guarantee covers everything the engine decides: which
 * documents match, how they score, and in what order. It cannot cover how
 * long the machine took to work it out, so `durationMs` is stripped before
 * two runs are compared. Leaving it in would make the check fail for a
 * reason that tells us nothing.
 */
const input = await new Promise((resolve, reject) => {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (buffer += chunk));
  process.stdin.on('end', () => resolve(buffer));
  process.stdin.on('error', reject);
});

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'durationMs')
        .map(([key, nested]) => [key, strip(nested)]),
    );
  }
  return value;
}

process.stdout.write(JSON.stringify(strip(JSON.parse(input)), null, 2) + '\n');
