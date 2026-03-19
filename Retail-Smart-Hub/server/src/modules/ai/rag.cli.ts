import path from 'node:path';
import { evaluateKnowledgeRetrieval, rebuildKnowledgeIndex } from './rag.service';

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      continue;
    }
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : 'true';
    args.set(key, value);
    if (value !== 'true') {
      index += 1;
    }
  }
  return args;
}

async function run() {
  const [command = 'rebuild', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === 'rebuild') {
    const force = args.get('force') === 'true';
    const incremental = args.get('incremental') !== 'false';
    const result = await rebuildKnowledgeIndex({ force, incremental });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'eval') {
    const datasetRaw = args.get('dataset') || './public/templates/rag-eval-sample.json';
    const datasetPath = path.isAbsolute(datasetRaw) ? datasetRaw : path.resolve(process.cwd(), datasetRaw);
    const k = Number(args.get('k') ?? 3);
    const result = await evaluateKnowledgeRetrieval({
      datasetPath,
      k: Number.isFinite(k) ? k : 3,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('Usage:');
  console.log('  node dist-server/modules/ai/rag.cli.js rebuild --incremental true');
  console.log('  node dist-server/modules/ai/rag.cli.js eval --dataset ./public/templates/rag-eval-sample.json --k 3');
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
