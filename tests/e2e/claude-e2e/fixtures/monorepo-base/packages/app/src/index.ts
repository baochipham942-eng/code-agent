import { greet, add, VERSION } from '@monorepo/shared'

console.log(greet('World'))
console.log(`2 + 3 = ${add(2, 3)}`)
console.log(`Shared version: ${VERSION}`)
