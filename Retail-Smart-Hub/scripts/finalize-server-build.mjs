import fs from 'node:fs';
import path from 'node:path';

const distServerDir = path.resolve(process.cwd(), 'dist-server');
const bundledSkillsSourceDir = path.resolve(process.cwd(), 'server', 'src', 'modules', 'ai', 'skills-builtin');
const bundledSkillsTargetDir = path.resolve(process.cwd(), 'dist-server', 'modules', 'ai', 'skills-builtin');

function copyDirectoryRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

fs.mkdirSync(distServerDir, { recursive: true });
fs.writeFileSync(
  path.join(distServerDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);

if (fs.existsSync(bundledSkillsSourceDir)) {
  fs.mkdirSync(path.dirname(bundledSkillsTargetDir), { recursive: true });
  copyDirectoryRecursive(bundledSkillsSourceDir, bundledSkillsTargetDir);
  console.log(
    `[finalize-server-build] copied bundled skills -> ${path.relative(process.cwd(), bundledSkillsTargetDir)}`,
  );
}
