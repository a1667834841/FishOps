// Agent 原生自动化入口：ego CLI 已打开目录窗口后，用 cua_repl 分两轮执行。
// 第一轮：let egoInstallApp = await cua.getApp("ego lite");
// 第二轮：执行下列脚本。只选择固定构建目录，不读取本地凭据。
await egoInstallApp.pressKey('super+shift+g')
const pathState = await egoInstallApp.getAXState({ emit: false, disableDiffing: true })
const pathField = pathState.match(/^\s*(\d+) 文本栏 .*ID: PathTextField/m)
if (!pathField) throw new Error('未找到原生目录路径输入框')
await egoInstallApp.setValue(Number(pathField[1]), agentInstallDirectory)
await egoInstallApp.pressKey('Return')
const directoryState = await egoInstallApp.getAXState({ emit: false, disableDiffing: true })
if (!directoryState.includes('Value: agent-extension')) throw new Error('目录窗口尚未定位到固定插件目录')
const confirm = directoryState.match(/^\s*(\d+) 按钮 选择, ID: OKButton/m)
if (!confirm) throw new Error('未找到插件目录确认按钮')
await egoInstallApp.click(Number(confirm[1]))
await egoInstallApp.getAXState()
