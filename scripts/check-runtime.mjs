/** 部署与验证必须使用与版本文件一致的 Node。 */
import { readFileSync } from 'node:fs'
const expected=readFileSync(new URL('../.node-version',import.meta.url),'utf8').trim()
if(process.versions.node!==expected){console.error(`需要 Node ${expected}，当前为 ${process.versions.node}。请切换运行时后重试。`);process.exitCode=2}
