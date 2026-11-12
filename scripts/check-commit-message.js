import { readFileSync } from 'node:fs';

const messageFile = process.argv[2];
if (!messageFile) {
  console.error('用法：node scripts/check-commit-message.js <提交消息文件>');
  process.exit(1);
}

const subject = readFileSync(messageFile, 'utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u)[0];
const format = /^(feat|fix|docs|refactor|perf|test|build|ci|chore|style|revert)(\([a-z0-9-]+\))?!?: \S.*$/u;
if (!format.test(subject)) {
  console.error('提交标题须符合 <type>(<scope>): <摘要>，scope 可省略；破坏性变更在冒号前加 !。');
  console.error('允许类型：feat、fix、docs、refactor、perf、test、build、ci、chore、style、revert。');
  console.error('示例：fix(playback): 修复时间轴跳转后目标位置');
  process.exitCode = 1;
}
