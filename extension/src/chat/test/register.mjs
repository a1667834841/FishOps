/**
 * 测试注册入口：把 resolve-hook 注册到 Node 的模块解析流程。
 * 用法：node --import ./extension/src/chat/test/register.mjs --test ...
 */
import { registerHooks } from 'node:module'
import { resolve } from './resolve-hook.mjs'

registerHooks({ resolve })
