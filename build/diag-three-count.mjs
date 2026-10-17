import fs from 'node:fs'
const s = fs.readFileSync('D:/dsh-modeler/lib/client.js', 'utf8')
const count = (n) => s.split(n).length - 1
for (const n of ['__THREE__', 'Multiple instances', 'REVISION =', 'class WebGLRenderer', 'PerspectiveCamera']) {
  console.log('  ' + JSON.stringify(n).padEnd(26), count(n))
}
const re = /node_modules[\/\\]+three[\/\\][^"'\n]{0,60}/g
const hits = new Set()
let m
while ((m = re.exec(s))) hits.add(m[0].slice(0, 72))
console.log('\nbundle 里出现的 three 路径标记：')
;[...hits].slice(0, 10).forEach((h) => console.log('   ', h))
if (!hits.size) console.log('    （无 —— esbuild 已把路径注释去掉，改用特征串判断）')

// 用 three 内部的唯一常量判断有几份
const marks = ['WebGLRenderer', 'OrbitControls', 'SphereGeometry', 'MeshStandardMaterial']
console.log('\n关键类定义出现次数（每个类一份 three 只应出现一次）:')
for (const k of marks) {
  const defs = (s.match(new RegExp('class ' + k + '\\b', 'g')) || []).length
  console.log('  class ' + k.padEnd(24), defs)
}
