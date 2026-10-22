/**
 * 测试注册入口：把分析用的 resolve-hook 注册到 Node 模块解析流程。
 */
import { registerHooks } from 'node:module'
import { resolve } from './resolve-hook.mjs'

registerHooks({ resolve })
