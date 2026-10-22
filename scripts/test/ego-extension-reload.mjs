#!/usr/bin/env node
/**
 * 显式重载 Ego 中已安装的隔离扩展。
 *
 * 只点击当前扩展详情页的“重新加载”按钮，不安装、不切换页面、不关闭浏览器。
 * 必须有 FISHOPS_BROWSER_RELOAD=1 和环境级 Ego 验收开关；失败时不伪装成已加载新构建。
 */
import { spawnSync } from 'node:child_process'

if (process.env.FISHOPS_BROWSER_RELOAD !== '1' || process.env.FISHOPS_LIVE_SMOKE !== '1') {
  console.error('需要显式允许浏览器重载；未操作浏览器。')
  process.exit(2)
}

const script = `
const task = await taskSpace("FishOps Agent API E2E");
const page = task.page("p1");
const url = await page.url();
if (!url.includes("chrome://extensions")) {
  await page.goto("chrome://extensions/?id=pmlecohkjekeejfmpbfaoboghajchcjm");
}
let clicked = false;
for (let attempt = 0; attempt < 40; attempt++) {
  clicked = await page.evaluate(() => {
  const manager = document.querySelector("extensions-manager")?.shadowRoot;
  const detail = manager?.querySelector("extensions-detail-view")?.shadowRoot;
  const button = detail?.querySelector("#dev-reload-button");
  if (!button) return false;
  button.click();
  return true;
  });
  if (clicked) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!clicked) throw new Error("reload-button-missing");
await new Promise(resolve => setTimeout(resolve, 2000));
console.log("reloaded");
`

try {
  const result = spawnSync('ego-browser', ['nodejs', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // ego-browser 将脚本 console 输出写入 stderr，不能只看 stdout。
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0 || !output.includes('reloaded')) throw new Error('reload-not-confirmed')
} catch {
  console.error('扩展重载未确认；未继续业务冒烟。')
  process.exit(1)
}
console.log('扩展重载已确认。')
