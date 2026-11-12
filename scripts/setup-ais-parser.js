import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.runtime', 'ais-parser');
const manifest = JSON.parse(await readFile(path.join(root, 'server/ais-java/dependencies.json'), 'utf8'));
await mkdir(path.join(runtime, 'lib'), { recursive: true });
await mkdir(path.join(runtime, 'classes'), { recursive: true });
for (const dependency of manifest.dependencies) {
  const url = 'https://repo.maven.apache.org/maven2/' + dependency.artifact;
  const target = path.join(runtime, 'lib', path.basename(dependency.artifact));
  let bytes;
  try { bytes = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== dependency.sha256) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`下载 AIS 依赖失败：HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== dependency.sha256) throw new Error(`AIS 依赖 SHA-256 不匹配：${path.basename(target)}`);
    await writeFile(target, bytes);
  }
}
const candidates = [process.env.JAVAC_BIN, process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'javac.exe'), 'C:/Program Files/Java/jdk1.8.0_151/bin/javac.exe'].filter(Boolean);
let compiler = 'javac';
for (const candidate of candidates) { try { await access(candidate); compiler = candidate; break; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
const compilation = spawnSync(compiler, ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', path.join(runtime, 'lib', '*'), '-d', path.join(runtime, 'classes'), path.join(root, 'server/ais-java/AisBridge.java')], { encoding: 'utf8', windowsHide: true });
if (compilation.error || compilation.status !== 0) throw new Error(`编译 AIS 适配失败：${compilation.error?.message ?? compilation.stderr}`);
console.log('AIS 适配已准备：DMA AisLib 2.8.8；未启动采集器，未连接数据库。');
