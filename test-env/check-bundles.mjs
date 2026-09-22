// 检查 profile manifest 的 bundles 列表
import { readFileSync } from 'node:fs'

const prof = 'D:/dsharness/agentDev/softwareEngnieering/3pluginCode/test-env/dsh-home/profiles/weave-test'
const m = JSON.parse(readFileSync(`${prof}/package.json`, 'utf8'))
console.log('bundles:', JSON.stringify(m.dsh?.profile?.bundles))
console.log('dependencies:', JSON.stringify(m.dependencies))
