/**
 * 测试注册入口：把采集用的 resolve-hook 注册到 Node 模块解析流程。
 * 用法：node --import ./extension/src/capture/test/register.mjs --test ...
 */
import { registerHooks } from 'node:module'
import { resolve } from './resolve-hook.mjs'

registerHooks({ resolve })
