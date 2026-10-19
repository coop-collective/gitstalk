import { snapshot } from './snapshot.ts';

const root = process.argv[2];
if (root === undefined) throw new Error('A checkout path is required');
// This is a machine-readable response, not a log. The runner owns selection and cached evidence.
process.stdout.write(JSON.stringify(snapshot(root)));
