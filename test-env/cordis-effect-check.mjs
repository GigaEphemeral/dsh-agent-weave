// 快速验证：Cordis 4.0.2 根 Context 的 effect 注册/注销
import { Context } from '@deepseek-ai/cordis'

const ctx = new Context()
const order: string[] = []

const disposerA = ctx.effect(() => {
  order.push('a:setup')
  const t = setTimeout(() => {}, 1000)
  return () => {
    order.push('a:cleanup')
    clearTimeout(t)
  }
}, 'effect-a')

const disposerB = ctx.effect(() => {
  order.push('b:setup')
  const t = setInterval(() => {}, 1000)
  return () => {
    order.push('b:cleanup')
    clearInterval(t)
  }
}, 'effect-b')

console.log('after setup:', JSON.stringify(order))

// LIFO 释放（调用 disposer）
disposerB()
console.log('after dispose B:', JSON.stringify(order))
disposerA()
console.log('after dispose A:', JSON.stringify(order))

// 幂等：重复调用无副作用
disposerA()
console.log('after re-dispose A:', JSON.stringify(order))

console.log('PASS')
